import { atlasSceneNames, pickAtlasScene, type AtlasScene } from './atlas-scenes.ts'
import { createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards.ts'
import { loadingConcepts } from './loading-concepts.ts'
import { atlasZoom, tileBounds, tileForPosition } from './tile-geometry.ts'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'

const minimumFogZoom = 15
const landTargetThreshold = 0.75
const landSampleSize = 10
const sourceLandZoom = 15
const sourceLandTileSpan = 2 ** (atlasZoom - sourceLandZoom)
const waterLayerIds = ['water', 'water_stream', 'water_river']
const groundFogMotionSpeed = 1.1
const groundFogRadiusMultiplier = 1.045
const fogRadiusDuration = 180_000
const generatedRevealDuration = 1400
const generatedTileOpacity = 0.94
const fogPokeDuration = 900
const fogPokeExpansion = 0.16
const personalClearanceLimit = 3
const cityClearanceDuration = 180_000

const tileId = ({ x, y }) => `${atlasZoom}/${x}/${y}`
const sourceLandTileId = ({ x, y }) => `${sourceLandZoom}/${x}/${y}`
const tileFromId = id => {
  const [, x, y] = id.split('/').map(Number)
  return { x, y }
}

const isFullyVisible = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const canvas = map.getCanvas()
  return (
    northWest.x >= 0 &&
    northWest.y >= 0 &&
    southEast.x <= canvas.clientWidth &&
    southEast.y <= canvas.clientHeight
  )
}

const intersectsViewport = (map, tile, spill = 0) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const canvas = map.getCanvas()
  const tileSize = Math.max(southEast.x - northWest.x, southEast.y - northWest.y)
  const padding = tileSize * spill
  return (
    southEast.x + padding >= 0 &&
    southEast.y + padding >= 0 &&
    northWest.x - padding <= canvas.clientWidth &&
    northWest.y - padding <= canvas.clientHeight
  )
}

const visibleFogTiles = map => {
  if (map.getZoom() < minimumFogZoom) return []
  const bounds = map.getBounds()
  const northWest = tileForPosition({ lng: bounds.getWest(), lat: bounds.getNorth() })
  const southEast = tileForPosition({ lng: bounds.getEast(), lat: bounds.getSouth() })
  const tiles = []
  for (let y = northWest.y; y <= southEast.y; y += 1) {
    for (let x = northWest.x; x <= southEast.x; x += 1) {
      const tile = { x, y }
      if (intersectsViewport(map, tile)) tiles.push(tile)
    }
  }
  return tiles
}

const isFogged = tile => (((tile.x * 73856093) ^ (tile.y * 19349663)) & 1) === 0
const waitForRender = map => new Promise(resolve => map.once('render', resolve))
const seeded = value => {
  const noise = Math.sin(value * 12.9898) * 43758.5453
  return noise - Math.floor(noise)
}
const clampUnit = value => Math.max(0, Math.min(1, value))

const sourceLandTileRequests = new Map()
const loadSourceLandTile = async tile => {
  const sourceTile = {
    x: Math.floor(tile.x / sourceLandTileSpan),
    y: Math.floor(tile.y / sourceLandTileSpan),
  }
  const id = sourceLandTileId(sourceTile)
  if (sourceLandTileRequests.has(id)) return sourceLandTileRequests.get(id)

  const request = fetch(
    `/map-assets/saanseoi/hongkong-latest/${sourceLandZoom}/${sourceTile.x}/${sourceTile.y}.mvt`,
  )
    .then(async response => {
      if (!response.ok) throw new Error(`Could not load land tile ${id}.`)
      return new VectorTile(new Pbf(await response.arrayBuffer()))
    })
    .catch(error => {
      sourceLandTileRequests.delete(id)
      throw error
    })
  sourceLandTileRequests.set(id, request)
  return request
}

const vectorRingContainsPoint = (point, ring) => {
  let inside = false
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const current = ring[index]
    const prior = ring[previous]
    const crosses = current.y > point.y !== prior.y > point.y
    if (
      crosses &&
      point.x <
        ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) +
          current.x
    ) {
      inside = !inside
    }
  }
  return inside
}

const vectorFeatureContainsPoint = (feature, point) => {
  if (feature.type !== 3) return false
  return feature
    .loadGeometry()
    .reduce(
      (inside, ring) => (vectorRingContainsPoint(point, ring) ? !inside : inside),
      false,
    )
}

const vectorTileLandFraction = (sourceTile, tile) => {
  const earthLayer = sourceTile.layers.earth
  const waterLayer = sourceTile.layers.water
  if (!earthLayer) return null

  const sourceTileSize = earthLayer.extent / sourceLandTileSpan
  const originX = (tile.x % sourceLandTileSpan) * sourceTileSize
  const originY = (tile.y % sourceLandTileSpan) * sourceTileSize
  const earthFeatures = Array.from({ length: earthLayer.length }, (_, index) =>
    earthLayer.feature(index),
  )
  const waterFeatures = waterLayer
    ? Array.from({ length: waterLayer.length }, (_, index) => waterLayer.feature(index))
    : []
  const landSamples = Array.from({ length: landSampleSize }, (_, row) =>
    Array.from({ length: landSampleSize }, (_, column) => {
      const point = {
        x: originX + ((column + 0.5) * sourceTileSize) / landSampleSize,
        y: originY + ((row + 0.5) * sourceTileSize) / landSampleSize,
      }
      const onEarth = earthFeatures.some(feature =>
        vectorFeatureContainsPoint(feature, point),
      )
      const onWater = waterFeatures.some(feature =>
        vectorFeatureContainsPoint(feature, point),
      )
      return onEarth && !onWater
    }),
  ).flat()

  return landSamples.filter(Boolean).length / landSamples.length
}

// Choose the opening concept once at map initialization, then walk the full
// collection in order so a loading sequence never repeats early.
let loadingConceptCursor = Math.floor(Math.random() * loadingConcepts.length)
const nextLoadingConcept = () => {
  const concept = loadingConcepts[loadingConceptCursor]
  loadingConceptCursor = (loadingConceptCursor + 1) % loadingConcepts.length
  return concept
}

const createClearanceNotice = map => {
  const notice = document.createElement('div')
  notice.className = 'atlas-clearance-notice'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  notice.hidden = true

  const title = document.createElement('strong')
  title.textContent = 'The fog is moving'
  const message = document.createElement('span')
  notice.append(title, message)
  map.getContainer().append(notice)

  let hideTimer: number | undefined
  const hide = () => {
    if (hideTimer) window.clearTimeout(hideTimer)
    notice.classList.remove('is-visible')
    window.setTimeout(() => {
      if (!notice.classList.contains('is-visible')) notice.hidden = true
    }, 450)
  }

  return {
    show: text => {
      if (hideTimer) window.clearTimeout(hideTimer)
      message.textContent = text
      notice.hidden = false
      requestAnimationFrame(() => notice.classList.add('is-visible'))
      hideTimer = window.setTimeout(hide, 9000)
    },
    hide,
    destroy: () => {
      if (hideTimer) window.clearTimeout(hideTimer)
      notice.remove()
    },
  }
}

const createFogErrorAnnouncer = map => {
  const announcement = document.createElement('div')
  announcement.className = 'atlas-fog-error-announcement'
  announcement.setAttribute('role', 'alert')
  announcement.setAttribute('aria-live', 'assertive')
  map.getContainer().append(announcement)

  return {
    announce: text => {
      announcement.textContent = text
    },
    clear: () => {
      announcement.textContent = ''
    },
    destroy: () => announcement.remove(),
  }
}

const hideTextLabels = map => {
  const hiddenLayerIds = map
    .getStyle()
    .layers.filter(
      layer =>
        layer.type === 'symbol' &&
        layer.layout?.['text-field'] &&
        layer.layout.visibility !== 'none',
    )
    .map(layer => layer.id)
  hiddenLayerIds.forEach(layerId => {
    map.setLayoutProperty(layerId, 'visibility', 'none')
  })
  return hiddenLayerIds
}

export const captureTile = async (map, tile) => {
  const hiddenLayerIds = hideTextLabels(map)
  try {
    await waitForRender(map)
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const mapCanvas = map.getCanvas()
    const scale = mapCanvas.width / mapCanvas.clientWidth
    const tileCanvas = document.createElement('canvas')
    tileCanvas.width = 512
    tileCanvas.height = 512
    const context = tileCanvas.getContext('2d')
    context.drawImage(
      mapCanvas,
      northWest.x * scale,
      northWest.y * scale,
      (southEast.x - northWest.x) * scale,
      (southEast.y - northWest.y) * scale,
      0,
      0,
      512,
      512,
    )
    const generationArtifacts = createGenerationArtifacts(
      map,
      tileCanvas,
      northWest,
      southEast,
    )
    return {
      sourceImage: tileCanvas.toDataURL('image/png'),
      ...generationArtifacts,
    }
  } finally {
    hiddenLayerIds.forEach(layerId => {
      map.setLayoutProperty(layerId, 'visibility', 'visible')
    })
    map.triggerRepaint()
  }
}

export const tileHasSea = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const seaKinds = new Set(['sea', 'ocean', 'bay', 'strait', 'fjord'])
  return map
    .queryRenderedFeatures([northWest, southEast], { layers: waterLayerIds })
    .some(feature => seaKinds.has(feature.properties?.kind))
}

const tileLandFraction = (map, tile) => {
  const bounds = tileBounds(tile)
  const landSamples = Array.from({ length: landSampleSize }, (_, row) =>
    Array.from({ length: landSampleSize }, (_, column) => {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * (column + 0.5)) / landSampleSize
      const lat =
        bounds.south + ((bounds.north - bounds.south) * (row + 0.5)) / landSampleSize
      const point = map.project([lng, lat])
      return map.queryRenderedFeatures(point, { layers: waterLayerIds }).length === 0
    }),
  ).flat()

  return landSamples.filter(Boolean).length / landSamples.length
}

const pointInRing = (point, ring) => {
  let inside = false
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [x, y] = ring[index]
    const [previousX, previousY] = ring[previous]
    const crosses = y > point[1] !== previousY > point[1]
    if (
      crosses &&
      point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x
    ) {
      inside = !inside
    }
  }
  return inside
}

const geometryContainsPoint = (geometry, point) => {
  if (!geometry) return false
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates
    return (
      rings.length > 0 &&
      pointInRing(point, rings[0]) &&
      rings.slice(1).every(ring => !pointInRing(point, ring))
    )
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(
      polygon =>
        polygon.length > 0 &&
        pointInRing(point, polygon[0]) &&
        polygon.slice(1).every(ring => !pointInRing(point, ring)),
    )
  }
  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.some(child => geometryContainsPoint(child, point))
  }
  return false
}

const sourceTileLandFraction = (map, tile) => {
  const bounds = tileBounds(tile)
  const earthFeatures = map.querySourceFeatures('hongkong-latest', {
    sourceLayer: 'earth',
  })
  const waterFeatures = map.querySourceFeatures('hongkong-latest', {
    sourceLayer: 'water',
  })
  if (!earthFeatures.length && !waterFeatures.length) return null
  let coveredSampleCount = 0
  const landSamples = Array.from({ length: landSampleSize }, (_, row) =>
    Array.from({ length: landSampleSize }, (_, column) => {
      const point = [
        bounds.west + ((bounds.east - bounds.west) * (column + 0.5)) / landSampleSize,
        bounds.south + ((bounds.north - bounds.south) * (row + 0.5)) / landSampleSize,
      ]
      const onEarth = earthFeatures.some(feature =>
        geometryContainsPoint(feature.geometry, point),
      )
      const onWater = waterFeatures.some(feature =>
        geometryContainsPoint(feature.geometry, point),
      )
      if (onEarth || onWater) coveredSampleCount += 1
      return onEarth && !onWater
    }),
  ).flat()

  // querySourceFeatures() can still contain the source tiles from the previous
  // viewport while a drag exposes a new one. Treat sparse coverage as unknown
  // instead of misclassifying the newly exposed land as water.
  if (coveredSampleCount < landSamples.length * 0.75) return null
  return landSamples.filter(Boolean).length / landSamples.length
}

const atlasTileSize = 512

const firstLabelLayerId = map =>
  map.getStyle().layers.find(layer => layer.type === 'symbol')?.id

const featureName = feature =>
  `${feature.layer?.id ?? ''} ${feature.sourceLayer ?? ''}`.toLowerCase()

const isWaterFeature = feature =>
  /water|sea|ocean|bay|strait|fjord|river|stream|canal|reservoir/.test(
    featureName(feature),
  )

const isRoadLineFeature = feature =>
  feature.layer?.type === 'line' &&
  /road|street|transport|rail|path|trail/.test(featureName(feature))

const isFinePathFeature = feature =>
  /path|trail|footway|pedestrian|steps|cycleway|track/.test(
    `${featureName(feature)} ${Object.values(feature.properties ?? {}).join(' ')}`.toLowerCase(),
  )

const isLockedLineFeature = feature =>
  feature.layer?.type === 'line' &&
  !isFinePathFeature(feature) &&
  /road|street|transport|rail|boundary|water/.test(featureName(feature))

// The generated image is allowed to blend near the safe-zone boundary, so the
// protected geometry needs a generous hit area. The source pixels inside that
// area are restored after generation; the extra width therefore protects the
// street without making the street itself visually wider.
const lockedLineWidth = (feature, purpose) => {
  const name = featureName(feature)
  if (/boundary/.test(name)) return purpose === 'mask' ? 4 : 2
  if (/rail/.test(name)) return purpose === 'mask' ? 10 : 6
  if (isRoadLineFeature(feature)) return purpose === 'mask' ? 18 : 10
  return purpose === 'mask' ? 8 : 4
}

const drawGeometry = (
  context,
  geometry,
  project,
  {
    fill,
    stroke,
    lineWidth,
  }: { fill?: boolean; stroke?: boolean; lineWidth?: number } = {},
) => {
  if (!geometry) return
  const drawLine = coordinates => {
    if (!coordinates?.length) return
    context.moveTo(...project(coordinates[0]))
    coordinates.slice(1).forEach(coordinate => {
      context.lineTo(...project(coordinate))
    })
  }

  context.beginPath()
  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach(drawLine)
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.flat().forEach(drawLine)
  } else if (geometry.type === 'LineString') {
    drawLine(geometry.coordinates)
  } else if (geometry.type === 'MultiLineString') {
    geometry.coordinates.forEach(drawLine)
  } else if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach(child => {
      drawGeometry(context, child, project, { fill, stroke, lineWidth })
    })
    return
  }

  if (fill) context.fill('evenodd')
  if (stroke) {
    context.lineWidth = lineWidth ?? 4
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.stroke()
  }
}

const createGenerationArtifacts = (map, sourceCanvas, northWest, southEast) => {
  const scaleX = atlasTileSize / (southEast.x - northWest.x)
  const scaleY = atlasTileSize / (southEast.y - northWest.y)
  const project = coordinate => {
    const point = map.project(coordinate)
    return [(point.x - northWest.x) * scaleX, (point.y - northWest.y) * scaleY]
  }
  const features = map.queryRenderedFeatures([northWest, southEast])
  const safeCanvas = document.createElement('canvas')
  safeCanvas.width = atlasTileSize
  safeCanvas.height = atlasTileSize
  const safeContext = safeCanvas.getContext('2d')
  const lineCanvas = document.createElement('canvas')
  lineCanvas.width = atlasTileSize
  lineCanvas.height = atlasTileSize
  const lineContext = lineCanvas.getContext('2d')

  const landFeatures = features.filter(
    feature => feature.layer?.type === 'fill' && !isWaterFeature(feature),
  )
  const waterFeatures = features.filter(
    feature => feature.layer?.type === 'fill' && isWaterFeature(feature),
  )
  const lockedLineFeatures = features.filter(isLockedLineFeature)

  safeContext.fillStyle = '#ffffff'
  if (landFeatures.length) {
    landFeatures.forEach(feature => {
      drawGeometry(safeContext, feature.geometry, project, { fill: true })
    })
  } else {
    safeContext.fillRect(0, 0, atlasTileSize, atlasTileSize)
  }
  safeContext.globalCompositeOperation = 'destination-out'
  waterFeatures.forEach(feature => {
    drawGeometry(safeContext, feature.geometry, project, { fill: true })
  })
  lockedLineFeatures.forEach(feature => {
    drawGeometry(safeContext, feature.geometry, project, {
      stroke: true,
      lineWidth: lockedLineWidth(feature, 'mask'),
    })
  })
  safeContext.lineWidth = 24
  safeContext.strokeRect(0, 0, atlasTileSize, atlasTileSize)
  safeContext.globalCompositeOperation = 'source-over'

  lineContext.strokeStyle = '#ffffff'
  lockedLineFeatures.forEach(feature => {
    drawGeometry(lineContext, feature.geometry, project, {
      stroke: true,
      lineWidth: lockedLineWidth(feature, 'overlay'),
    })
  })

  const maskPixels = safeContext.getImageData(0, 0, atlasTileSize, atlasTileSize)
  let contentLeft = atlasTileSize
  let contentTop = atlasTileSize
  let contentRight = -1
  let contentBottom = -1
  for (let y = 0; y < atlasTileSize; y += 1) {
    for (let x = 0; x < atlasTileSize; x += 1) {
      if (maskPixels.data[(y * atlasTileSize + x) * 4 + 3] <= 32) continue
      contentLeft = Math.min(contentLeft, x)
      contentTop = Math.min(contentTop, y)
      contentRight = Math.max(contentRight, x)
      contentBottom = Math.max(contentBottom, y)
    }
  }
  const guideCanvas = document.createElement('canvas')
  guideCanvas.width = atlasTileSize
  guideCanvas.height = atlasTileSize
  const guideContext = guideCanvas.getContext('2d')
  const guidePixels = guideContext.createImageData(atlasTileSize, atlasTileSize)
  for (let index = 0; index < maskPixels.data.length; index += 4) {
    const safe = maskPixels.data[index + 3] > 32
    guidePixels.data[index] = safe ? 56 : 176
    guidePixels.data[index + 1] = safe ? 156 : 72
    guidePixels.data[index + 2] = safe ? 91 : 63
    guidePixels.data[index + 3] = safe ? 150 : 190
  }
  guideContext.putImageData(guidePixels, 0, 0)

  const sourcePixels = sourceCanvas
    .getContext('2d')
    .getImageData(0, 0, atlasTileSize, atlasTileSize)
  const linePixels = lineContext.getImageData(0, 0, atlasTileSize, atlasTileSize)
  const overlayPixels = lineContext.createImageData(atlasTileSize, atlasTileSize)
  for (let index = 0; index < sourcePixels.data.length; index += 4) {
    overlayPixels.data[index] = sourcePixels.data[index]
    overlayPixels.data[index + 1] = sourcePixels.data[index + 1]
    overlayPixels.data[index + 2] = sourcePixels.data[index + 2]
    overlayPixels.data[index + 3] = linePixels.data[index + 3]
  }
  lineContext.putImageData(overlayPixels, 0, 0)

  return {
    guideImage: guideCanvas.toDataURL('image/png'),
    safeMask: safeCanvas.toDataURL('image/png'),
    lineOverlay: lineCanvas.toDataURL('image/png'),
    contentBounds:
      contentRight >= contentLeft && contentBottom >= contentTop
        ? {
            x: contentLeft,
            y: contentTop,
            width: contentRight - contentLeft + 1,
            height: contentBottom - contentTop + 1,
          }
        : null,
  }
}

const decodedTileImages = new Map()
const fadedTileUrls = new Map()

const decodeTileImage = url => {
  if (decodedTileImages.has(url)) return decodedTileImages.get(url)
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  const promise = image.decode().then(() => image)
  decodedTileImages.set(url, promise)
  promise.catch(() => {
    if (decodedTileImages.get(url) === promise) decodedTileImages.delete(url)
  })
  return promise
}

const createFadedTileUrl = async url => {
  const image = await decodeTileImage(url)

  const size = 512
  const fade = size * 0.1
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, size, size)

  const pixels = context.getImageData(0, 0, size, size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.min(x, y, size - 1 - x, size - 1 - y)
      const amount = Math.min(1, distance / fade)
      const smoothAmount = amount * amount * (3 - 2 * amount)
      pixels.data[(y * size + x) * 4 + 3] = Math.round(
        pixels.data[(y * size + x) * 4 + 3] * smoothAmount,
      )
    }
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

const getFadedTileUrl = url => {
  if (fadedTileUrls.has(url)) return fadedTileUrls.get(url)
  const promise = createFadedTileUrl(url)
  fadedTileUrls.set(url, promise)
  promise.catch(() => {
    if (fadedTileUrls.get(url) === promise) fadedTileUrls.delete(url)
  })
  return promise
}

const addGeneratedTile = async (
  map,
  tile,
  url,
  scene,
  titleCards,
  contentBounds,
  initialOpacity = 0,
  preparedUrl = undefined,
) => {
  const id = `atlas-tile-${tile.x}-${tile.y}`
  if (map.getLayer(id)) return
  const bounds = tileBounds(tile)
  const fadedUrl = preparedUrl ?? (await getFadedTileUrl(url))
  map.addSource(id, {
    type: 'image',
    url: fadedUrl,
    coordinates: [
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.east, bounds.south],
      [bounds.west, bounds.south],
    ],
  })
  map.addLayer(
    {
      id,
      type: 'raster',
      source: id,
      paint: {
        'raster-opacity': clampUnit(initialOpacity),
        // These are already decoded, finished atlas tiles. Fading them in makes
        // a newly added tile feel like it is drifting behind the map while it
        // catches up with a pan.
        'raster-fade-duration': 0,
      },
    },
    firstLabelLayerId(map),
  )
  if (scene && titleCards) {
    const card = createAtlasTitleCard(map.getContainer(), scene)
    titleCards.set(tileId(tile), { card, tile, contentBounds })
    positionAtlasTitleCard(map, card, tile, contentBounds)
  }
}

const fogVertexShader = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  }
`

const fogFragmentShader = `
  precision highp float;
  uniform sampler2D u_mask;
  uniform float u_time;
  uniform float u_noise_detail;
  uniform vec2 u_anchor_screen;
  uniform vec2 u_mask_anchor_screen;
  uniform float u_mask_scale;
  uniform float u_map_scale;
  uniform vec2 u_viewport_size;
  uniform vec2 u_canvas_size;
  uniform vec2 u_canvas_origin;
  varying vec2 v_uv;

  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 offset = smoothstep(0.0, 1.0, fract(point));
    float bottom = mix(hash(cell), hash(cell + vec2(1.0, 0.0)), offset.x);
    float top = mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), offset.x);
    return mix(bottom, top, offset.y);
  }

  float cloudNoise(vec2 point) {
    float value = 0.0;
    value += noise(point) * 0.56;
    value += noise(point * 2.1 + 13.7) * 0.29;
    value += noise(point * 4.4 - 8.3) * 0.15;
    return value;
  }

  void main() {
    // Keep the animated texture attached to the map instead of the screen.
    // The mask moves with the map while panning, so screen-space noise would
    // expose a new part of the cloud field and make the fog appear to speed up.
    // v_uv already uses DOM screen coordinates (0 at the top and 1 at the
    // bottom). Keeping that orientation here is essential when anchoring the
    // noise field to MapLibre's projected Y axis during a vertical drag.
    // The fog canvas has a bleed margin beyond the visible map. Work in map
    // screen coordinates so the blurred mask can continue past the viewport
    // rather than being cut off at the canvas edge.
    vec2 screenPosition = v_uv * u_canvas_size + u_canvas_origin;
    vec2 fogUv =
      (screenPosition - u_anchor_screen) / (u_viewport_size * u_map_scale) + 0.5;

    // Gently deform the silhouette as well as moving the internal veils. This
    // keeps the fog from reading as a static set of tile-shaped patches.
    vec2 maskWarp = vec2(
      sin(u_time * 0.82 + fogUv.y * 16.0 + sin(fogUv.x * 8.0) * 1.2),
      cos(u_time * 0.68 + fogUv.x * 14.0 + cos(fogUv.y * 7.0) * 1.1)
    ) * 0.014;
    // The mask is painted into a screen-sized canvas. Compensate for map
    // movement since its last paint so the same fog body stays locked to the
    // same map coordinates between canvas updates.
    vec2 maskScreenPosition = u_mask_anchor_screen +
      (screenPosition - u_anchor_screen + maskWarp * u_viewport_size) / u_mask_scale;
    vec2 maskUv = (maskScreenPosition - u_canvas_origin) / u_canvas_size;
    bool maskOutside =
      maskUv.x < 0.0 || maskUv.x > 1.0 ||
      maskUv.y < 0.0 || maskUv.y > 1.0;
    if (maskOutside) discard;
    float mask = texture2D(u_mask, maskUv).a;
    if (mask < 0.01) discard;

    // Keep a generous feather around each body so the ground fog reads as a
    // soft veil rather than a set of opaque, tile-sized clouds.
    float softMask = smoothstep(0.06, 0.64, mask);
    // When detail is disabled, match this baseline to the detailed fog's
    // average density instead of falling back to a fully dense mask.
    float density = softMask * 0.94;
    vec3 pale = vec3(0.91, 0.92, 0.92);
    vec3 deep = vec3(0.67, 0.70, 0.71);
    vec3 fogColor = mix(deep, pale, 0.55);
    if (u_noise_detail > 0.5) {
      // Keep the tile coverage static, but move several veils through it
      // quickly enough to be apparent during a normal glance at the map.
      vec2 driftA = vec2(u_time * 0.18, -u_time * 0.11);
      float layerA = smoothstep(0.22, 0.76, cloudNoise(fogUv * vec2(4.2, 2.7) + driftA));
      density = softMask * (0.90 + layerA * 0.10);
      fogColor = mix(deep, pale, 0.44 + layerA * 0.26);

      if (u_noise_detail > 1.5) {
        vec2 driftB = vec2(-u_time * 0.13, u_time * 0.16);
        float layerB = smoothstep(0.26, 0.78, cloudNoise(fogUv * vec2(5.4, 3.4) + driftB));
        float movingVeil = smoothstep(
          0.28,
          0.72,
          cloudNoise(fogUv * vec2(8.0, 5.0) + driftA * 2.4)
        );
        float grain = hash(floor(fogUv * u_viewport_size / 3.0) + floor(driftA * 8.0));
        float densityB = softMask * (0.22 + layerB * 0.14);
        density = 1.0 - (1.0 - density) * (1.0 - densityB);
        density *= 0.90 + movingVeil * 0.15;
        fogColor = mix(
          deep,
          pale,
          0.28 + layerA * 0.30 + layerB * 0.22 + (grain - 0.5) * 0.08
        );
      }
    }
    gl_FragColor = vec4(fogColor, min(1.0, density * 0.96));
  }
`

const compileFogShader = (gl, type, source) => {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const createFogProgram = gl => {
  const vertexShader = compileFogShader(gl, gl.VERTEX_SHADER, fogVertexShader)
  const fragmentShader = compileFogShader(gl, gl.FRAGMENT_SHADER, fogFragmentShader)
  if (!vertexShader || !fragmentShader) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

const createFogMaskPath = (
  context,
  x,
  y,
  size,
  seed,
  radiusScale = 1,
  spillScale = 0.9,
) => {
  // Let each body reach into its neighbors. The irregular radius keeps the
  // overlap cloud-like instead of making a larger, regular tile grid.
  const scaledSize = size * radiusScale
  const offset = (size - scaledSize) / 2
  const scaledX = x + offset
  const scaledY = y + offset
  const localSpillScale = spillScale * (0.86 + seeded(seed + 91.3) * 0.28)
  const spill = scaledSize * 0.14 * localSpillScale
  const left = scaledX - spill
  const top = scaledY - spill * (0.72 + seeded(seed + 1) * 0.42)
  const width = scaledSize + spill * (1.8 + seeded(seed + 2) * 0.35)
  const height = scaledSize + spill * (1.8 + seeded(seed + 3) * 0.35)
  const points = 20
  const vertices = []

  for (let index = 0; index < points; index += 1) {
    const angle = (Math.PI * 2 * index) / points
    const radius = 0.72 + seeded(seed + index * 2.41) * 0.42
    vertices.push({
      x: left + width * (0.5 + Math.cos(angle) * 0.5 * radius),
      y: top + height * (0.5 + Math.sin(angle) * 0.5 * radius),
    })
  }

  context.beginPath()
  vertices.forEach((vertex, index) => {
    if (index === 0) context.moveTo(vertex.x, vertex.y)
    else context.lineTo(vertex.x, vertex.y)
  })
  context.closePath()
}

const createFogCanvas = (
  map,
  tileState,
  cachedTileIds,
  isFogTileRenderable,
  noNoise = false,
) => {
  const mapSourceIsReady = () =>
    map.isStyleLoaded() && map.isSourceLoaded('hongkong-latest')
  const canvas = document.createElement('canvas')
  canvas.className = 'atlas-fog'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.transformOrigin = '0 0'
  map.getContainer().append(canvas)

  const mistCanvas = document.createElement('canvas')
  mistCanvas.className = 'atlas-fog-cached-mist'
  mistCanvas.setAttribute('aria-hidden', 'true')
  mistCanvas.style.transformOrigin = '0 0'
  map.getContainer().append(mistCanvas)
  const mistContext = mistCanvas.getContext('2d')
  const cachedColourTileCanvas = document.createElement('canvas')
  const cachedColourTileContext = cachedColourTileCanvas.getContext('2d')

  const loadingCanvas = document.createElement('canvas')
  loadingCanvas.className = 'atlas-fog-loading'
  loadingCanvas.setAttribute('aria-hidden', 'true')
  loadingCanvas.style.transformOrigin = '0 0'
  map.getContainer().append(loadingCanvas)
  const loadingContext = loadingCanvas.getContext('2d')
  const maskCanvas = document.createElement('canvas')
  const maskContext = maskCanvas.getContext('2d')
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    // The share export composites this canvas separately from MapLibre's
    // canvas, so its latest cloud frame must remain drawable after presentation.
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    stencil: false,
  })
  const program = gl && createFogProgram(gl)
  const maskTexture = gl?.createTexture()
  const positionBuffer = gl?.createBuffer()
  const positionAttribute = program && gl?.getAttribLocation(program, 'a_position')
  const maskUniform = program && gl?.getUniformLocation(program, 'u_mask')
  const timeUniform = program && gl?.getUniformLocation(program, 'u_time')
  const noiseDetailUniform =
    program && gl?.getUniformLocation(program, 'u_noise_detail')
  const anchorScreenUniform =
    program && gl?.getUniformLocation(program, 'u_anchor_screen')
  const maskAnchorScreenUniform =
    program && gl?.getUniformLocation(program, 'u_mask_anchor_screen')
  const maskScaleUniform = program && gl?.getUniformLocation(program, 'u_mask_scale')
  const mapScaleUniform = program && gl?.getUniformLocation(program, 'u_map_scale')
  const viewportSizeUniform =
    program && gl?.getUniformLocation(program, 'u_viewport_size')
  const canvasSizeUniform = program && gl?.getUniformLocation(program, 'u_canvas_size')
  const canvasOriginUniform =
    program && gl?.getUniformLocation(program, 'u_canvas_origin')
  const fogAnchor = map.getCenter()
  const fogAnchorZoom = map.getZoom()
  const isMapMoving = () => isDragging || map.isMoving()
  const noiseDetail = () => {
    if (noNoise || map.getZoom() > 18) return 0
    return 2
  }
  let clientWidth = 0
  let clientHeight = 0
  let fogBleed = 0
  let fogCanvasWidth = 0
  let fogCanvasHeight = 0
  let maskScale = 0.5
  let maskDirty = true
  let maskUploaded = false
  let cachedMistDirty = true
  let colourCloudsVisible = false
  let lastCachedMistTime = -Infinity
  let animationFrame: number | undefined
  let maskFrame: number | undefined
  let lastFogFrame = -Infinity
  let lastMaskFrame = -Infinity
  let fogTime = 0
  let animationTime = 0
  let previousFrameTime: number | undefined
  let isDragging = false
  let isZooming = false
  let maskAnchorScreen: { x: number; y: number } | undefined
  let maskAnchorZoom: number | undefined
  let mistAnchorScreen: { x: number; y: number } | undefined
  let mistAnchorZoom: number | undefined
  let loadingAnchorScreen: { x: number; y: number } | undefined
  let loadingAnchorZoom: number | undefined
  const fogFrameInterval = 1000 / 60
  const maskFrameInterval = 1000 / 60
  const cachedMistFrameInterval = 1000 / 15
  const zoomFrameInterval = 1000 / 60
  let maskRetryTimer: number | undefined
  const loadingSequences = new Map()
  let fogError: { id: string; text: string; startedAt: number } | undefined
  const generatingStartedAt = new Map()
  const revealStartedAt = new Map()
  const pokedAt = new Map()

  if (gl && positionBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
  }

  const resetCanvasTransform = target => {
    target.style.transform = ''
  }

  const setFogCanvasBounds = target => {
    target.style.inset = 'auto'
    target.style.left = `${-fogBleed}px`
    target.style.top = `${-fogBleed}px`
    target.style.width = `${fogCanvasWidth}px`
    target.style.height = `${fogCanvasHeight}px`
  }

  const setOverlayContextTransform = (context, scale = 1) => {
    context.setTransform(scale, 0, 0, scale, fogBleed * scale, fogBleed * scale)
  }

  const clearOverlayContext = context => {
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, context.canvas.width, context.canvas.height)
    context.restore()
  }

  const snapshotCanvasPosition = (target, setAnchor) => {
    resetCanvasTransform(target)
    setAnchor(map.project(fogAnchor), map.getZoom())
  }

  const positionCanvasDuringMapMotion = (target, anchorScreen, anchorZoom) => {
    if ((!isZooming && !isDragging) || !anchorScreen || anchorZoom === undefined) return
    const scale = isZooming ? 2 ** (map.getZoom() - anchorZoom) : 1
    const currentAnchorScreen = map.project(fogAnchor)
    const translateX =
      currentAnchorScreen.x - anchorScreen.x * scale - (scale - 1) * fogBleed
    const translateY =
      currentAnchorScreen.y - anchorScreen.y * scale - (scale - 1) * fogBleed
    target.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${translateX}, ${translateY})`
  }

  const positionCanvasesDuringMapMotion = () => {
    // Keep the colour and loading overlays registered to the map between their
    // current-coordinate redraws, so they do not lag a moving basemap by one
    // animation frame.
    positionCanvasDuringMapMotion(mistCanvas, mistAnchorScreen, mistAnchorZoom)
    positionCanvasDuringMapMotion(loadingCanvas, loadingAnchorScreen, loadingAnchorZoom)
  }

  const resize = () => {
    const mapCanvas = map.getCanvas()
    const nextWidth = mapCanvas.clientWidth
    const nextHeight = mapCanvas.clientHeight
    if (!nextWidth || !nextHeight) return
    // Fog is intentionally rendered at CSS resolution. The shader and the soft
    // mask do not benefit from a retina-sized target, and this caps its fill cost.
    const renderScale = 1
    const changed = nextWidth !== clientWidth || nextHeight !== clientHeight
    clientWidth = nextWidth
    clientHeight = nextHeight

    // Keep the actual map viewport as the logical coordinate system, but give
    // every fog canvas an invisible border. Canvas filters otherwise clip at
    // x/y 0 and make cloud bodies read as hard-edged at the map boundary.
    fogBleed = Math.min(
      192,
      Math.max(96, Math.ceil(Math.max(clientWidth, clientHeight) * 0.18)),
    )
    fogCanvasWidth = clientWidth + fogBleed * 2
    fogCanvasHeight = clientHeight + fogBleed * 2
    const renderWidth = Math.ceil(fogCanvasWidth * renderScale)
    const renderHeight = Math.ceil(fogCanvasHeight * renderScale)
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth
      canvas.height = renderHeight
      mistCanvas.width = renderWidth
      mistCanvas.height = renderHeight
      cachedColourTileCanvas.width = renderWidth
      cachedColourTileCanvas.height = renderHeight
      loadingCanvas.width = renderWidth
      loadingCanvas.height = renderHeight
      if (gl) gl.viewport(0, 0, renderWidth, renderHeight)
    }
    setFogCanvasBounds(canvas)
    setFogCanvasBounds(mistCanvas)
    setFogCanvasBounds(loadingCanvas)

    if (changed || !maskCanvas.width || !maskCanvas.height) {
      maskScale = Math.min(0.5, 768 / Math.max(fogCanvasWidth, fogCanvasHeight))
      maskCanvas.width = Math.max(1, Math.ceil(fogCanvasWidth * maskScale))
      maskCanvas.height = Math.max(1, Math.ceil(fogCanvasHeight * maskScale))
      setOverlayContextTransform(maskContext, maskScale)
      uploadMask()
      maskDirty = true
    }
  }

  const uploadMaskTexture = (texture, source) => {
    if (!gl || !texture) return false
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return true
  }

  const uploadMask = () => {
    if (!uploadMaskTexture(maskTexture, maskCanvas)) return
    maskUploaded = true
  }

  const easeOutCubic = progress => 1 - (1 - progress) ** 3

  const drawFogMask = (context, tile, state, time) => {
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const size = southEast.x - northWest.x
    const seed = tile.x * 0.47 + tile.y * 0.91
    const x = northWest.x
    const y = northWest.y
    const id = tileId(tile)
    const pokeProgress = pokedAt.has(id)
      ? clampUnit((time - pokedAt.get(id)) / fogPokeDuration)
      : 1
    const pokeScale = 1 + Math.sin(Math.PI * pokeProgress) * fogPokeExpansion
    const generationProgress = generatingStartedAt.has(id)
      ? clampUnit((time - generatingStartedAt.get(id)) / fogRadiusDuration)
      : 0
    const baseRadiusScale =
      state === 'generating' || state === 'revealing'
        ? 1 - generationProgress * 0.34
        : 1
    const radiusScale = baseRadiusScale * pokeScale
    const revealProgress = revealStartedAt.has(id)
      ? clampUnit((time - revealStartedAt.get(id)) / generatedRevealDuration)
      : 0

    context.save()
    if (state === 'checking') {
      // Keep the body opaque while it reacts to the click. The expansion
      // should read as a physical exhale, not as the fog thinning out.
      context.globalAlpha = 1
    } else if (state === 'revealing') {
      context.globalAlpha = 1 - revealProgress
    } else {
      context.globalAlpha = state === 'generating' ? 1 : 0.96
    }
    context.filter = `blur(${Math.max(4, size * 0.055)}px)`
    context.fillStyle = '#ffffff'
    createFogMaskPath(
      context,
      x,
      y,
      size,
      seed,
      radiusScale * 1.1 * groundFogRadiusMultiplier,
    )
    context.fill()
    context.restore()
  }

  const clearGeneratedTileMask = (context, tile, state, time) => {
    const id = tileId(tile)
    const revealProgress = revealStartedAt.has(id)
      ? clampUnit((time - revealStartedAt.get(id)) / generatedRevealDuration)
      : state === 'generated'
        ? 1
        : 0
    if (revealProgress <= 0) return

    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const size = Math.min(southEast.x - northWest.x, southEast.y - northWest.y)
    const progress = easeOutCubic(revealProgress)
    const inset = size * 0.5 * (1 - progress)

    // Neighboring fog bodies intentionally spill across tile boundaries. Cut
    // the generated tile back out after drawing those bodies so the clearing
    // always identifies the exact tile that opened, even at the cloud edges.
    context.save()
    context.globalCompositeOperation = 'destination-out'
    context.globalAlpha = 1
    context.filter = `blur(${Math.max(4, size * 0.045)}px)`
    context.fillStyle = '#ffffff'
    context.fillRect(
      northWest.x + inset,
      northWest.y + inset,
      Math.max(0, southEast.x - northWest.x - inset * 2),
      Math.max(0, southEast.y - northWest.y - inset * 2),
    )
    context.restore()
  }

  const getWordDurations = (words, baselineDuration) =>
    words.map(word => {
      const characterCount = word.replace(/[^\p{L}\p{N}]/gu, '').length
      const lengthAdjustment = (characterCount - 6) * 45
      return Math.max(
        baselineDuration * 0.75,
        Math.min(baselineDuration * 1.5, baselineDuration + lengthAdjustment),
      )
    })

  const getLoadingTiming = (concept, size) => {
    const questionWords = concept.question.split(/\s+/)
    const quoteWords = concept.quote.split(/\s+/).map((word, index, words) => {
      const opening = index === 0 ? '“' : ''
      const closing = index === words.length - 1 ? '”' : ''
      return `${opening}${word}${closing}`
    })
    const baselineWordDuration = Math.max(610, Math.min(850, size * 3.57))
    const questionDurations = getWordDurations(questionWords, baselineWordDuration)
    const quoteDurations = getWordDurations(quoteWords, baselineWordDuration)
    const questionDuration = questionDurations.reduce(
      (total, duration) => total + duration,
      0,
    )
    const quoteDuration = quoteDurations.reduce(
      (total, duration) => total + duration,
      0,
    )
    const titleInDuration = 1530
    const titleHoldDuration = 1785
    const questionStart = titleInDuration + titleHoldDuration
    const questionEnd = questionStart + questionDuration
    const questionLastWordHold = 1800
    const questionQuotePause = 1800
    const quoteStart = questionEnd + questionLastWordHold + questionQuotePause
    const quoteLastWordHold = 1800
    const quoteEnd = quoteStart + quoteDuration + quoteLastWordHold
    const creditStart = quoteEnd + 1000
    const creditDuration = 2200

    return {
      questionWords,
      quoteWords,
      questionDurations,
      quoteDurations,
      titleInDuration,
      questionStart,
      questionEnd,
      questionLastWordHold,
      quoteStart,
      quoteLastWordHold,
      creditStart,
      creditDuration,
      cycleDuration: creditStart + creditDuration + 1400,
    }
  }

  const drawCachedColourField = (tile, time) => {
    if (!mistContext || !cachedColourTileContext) return false
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const size = Math.min(southEast.x - northWest.x, southEast.y - northWest.y)
    const visible =
      southEast.x >= 0 &&
      southEast.y >= 0 &&
      northWest.x <= clientWidth &&
      northWest.y <= clientHeight
    if (!visible || size <= 0) return false

    const seed = tile.x * 0.47 + tile.y * 0.91
    const baseHue = ((time / 16000) * 360 + seeded(seed + 51.7) * 360) % 360
    const swayPhase = time / 4300 + seeded(seed + 68.2) * Math.PI * 2
    const swayX = Math.cos(swayPhase) * size * 0.045
    const swayY = Math.sin(swayPhase * 0.76) * size * 0.035

    const tileWidth = southEast.x - northWest.x
    const tileHeight = southEast.y - northWest.y
    // The fog mask intentionally overlaps neighbouring tiles. Give the colour
    // field the same breathing room before compositing it onto the map canvas,
    // otherwise its soft edge is cut off by this intermediate tile buffer.
    const colourSpill = Math.max(tileWidth, tileHeight) * 0.48
    const renderWidth = Math.max(1, Math.ceil(tileWidth + colourSpill * 2))
    const renderHeight = Math.max(1, Math.ceil(tileHeight + colourSpill * 2))
    if (
      cachedColourTileCanvas.width !== renderWidth ||
      cachedColourTileCanvas.height !== renderHeight
    ) {
      cachedColourTileCanvas.width = renderWidth
      cachedColourTileCanvas.height = renderHeight
    }

    cachedColourTileContext.setTransform(1, 0, 0, 1, 0, 0)
    cachedColourTileContext.clearRect(0, 0, renderWidth, renderHeight)
    cachedColourTileContext.save()
    cachedColourTileContext.filter = `blur(${Math.max(2, size * 0.018)}px)`
    const gradient = cachedColourTileContext.createLinearGradient(
      colourSpill - tileWidth * 0.32 + swayX,
      colourSpill - tileHeight * 0.08 + swayY,
      colourSpill + tileWidth * 1.32 + swayX,
      colourSpill + tileHeight * 0.92 + swayY,
    )
    const secondHue = (baseHue + 78 + seeded(seed + 73.6) * 18) % 360
    gradient.addColorStop(0, `hsla(${baseHue}, 88%, 67%, 0.28)`)
    gradient.addColorStop(1, `hsla(${secondHue}, 88%, 67%, 0.32)`)
    cachedColourTileContext.globalAlpha = 1
    cachedColourTileContext.fillStyle = gradient
    cachedColourTileContext.fillRect(0, 0, renderWidth, renderHeight)
    cachedColourTileContext.restore()

    cachedColourTileContext.save()
    cachedColourTileContext.globalCompositeOperation = 'destination-in'
    cachedColourTileContext.globalAlpha = 1
    // Keep a little of the neutral ground fog around the colour field, then
    // feather that transition so it dissolves into the surrounding mist.
    cachedColourTileContext.filter = `blur(${Math.max(5, size * 0.085)}px)`
    cachedColourTileContext.fillStyle = '#ffffff'
    createFogMaskPath(
      cachedColourTileContext,
      colourSpill,
      colourSpill,
      size,
      seed,
      0.9 * groundFogRadiusMultiplier,
      0.9,
    )
    cachedColourTileContext.fill()
    cachedColourTileContext.restore()
    mistContext.drawImage(
      cachedColourTileCanvas,
      northWest.x - colourSpill,
      northWest.y - colourSpill,
      renderWidth,
      renderHeight,
    )
    return true
  }

  const renderCachedColourFields = (frameTime, visualTime) => {
    if (!mistContext || map.getContainer().classList.contains('atlas-admin-mode'))
      return
    // Keep the colour field in the same current map coordinates as the fog.
    // During a drag both redraw at the animation-frame cadence; at rest the
    // colour field can use its lower-cost update cadence.
    const frameInterval =
      isMapMoving() || isZooming ? zoomFrameInterval : cachedMistFrameInterval
    if (
      (!cachedMistDirty || isZooming) &&
      frameTime - lastCachedMistTime < frameInterval
    )
      return

    const ratio = canvas.width / Math.max(1, fogCanvasWidth)
    clearOverlayContext(mistContext)
    setOverlayContextTransform(mistContext, ratio)
    let hasVisibleColourCloud = false
    cachedTileIds.forEach(id => {
      const tile = tileFromId(id)
      if (tileState.has(id) || !isFogged(tile)) return
      hasVisibleColourCloud =
        drawCachedColourField(tile, visualTime) || hasVisibleColourCloud
    })
    if (hasVisibleColourCloud && !colourCloudsVisible) {
      colourCloudsVisible = true
      // Let the transparent canvas paint once before transitioning it in.
      requestAnimationFrame(() => mistCanvas.classList.add('is-visible'))
    }
    lastCachedMistTime = frameTime
    cachedMistDirty = false
    snapshotCanvasPosition(mistCanvas, (anchorScreen, zoom) => {
      mistAnchorScreen = anchorScreen
      mistAnchorZoom = zoom
    })
  }

  const drawLoadingText = time => {
    if (!loadingContext || isZooming) return
    const ratio = canvas.width / Math.max(1, fogCanvasWidth)
    clearOverlayContext(loadingContext)
    setOverlayContextTransform(loadingContext, ratio)

    tileState.forEach((state, id) => {
      // Start the loading title as soon as a tile is clicked. Cache lookup is
      // asynchronous too, so waiting for `generating` made the title appear
      // only after that lookup (and made cached tiles skip it altogether).
      const isLoading = state === 'checking' || state === 'generating'
      if (!isLoading) {
        loadingSequences.delete(id)
        if (state !== 'revealing') generatingStartedAt.delete(id)
        return
      }
      if (!loadingSequences.has(id)) {
        loadingSequences.set(id, { concept: nextLoadingConcept(), startedAt: time })
      }
      if (!generatingStartedAt.has(id)) generatingStartedAt.set(id, time)

      const tile = tileFromId(id)
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      const size = southEast.x - northWest.x
      const sequence = loadingSequences.get(id)
      let concept = sequence.concept
      let elapsed = time - sequence.startedAt
      let timing = getLoadingTiming(concept, size)
      while (elapsed >= timing.cycleDuration) {
        sequence.concept = nextLoadingConcept()
        sequence.startedAt += timing.cycleDuration
        concept = sequence.concept
        elapsed = time - sequence.startedAt
        timing = getLoadingTiming(concept, size)
      }
      const centerX = northWest.x + size / 2
      const centerY = northWest.y + size / 2
      const textWidth = size * 0.86
      const titleSize = Math.max(14, Math.min(30, size * 0.12))
      const questionSize = Math.max(12, Math.min(23, size * 0.09))
      const quoteSize = Math.max(11, Math.min(20, size * 0.075))
      const titleProgress = Math.min(1, elapsed / timing.titleInDuration)
      const titleEase = easeOutCubic(titleProgress)
      const titleLines = wrapTextForWidth(
        loadingContext,
        concept.title,
        textWidth,
        `700 ${titleSize}px 'IM Fell English SC', Georgia, serif`,
      )
      const titleLineHeight = titleSize * 0.98
      const titleTop =
        centerY - ((titleLines.length - 1) * titleLineHeight) / 2 - size * 0.2
      const titleBottom =
        titleTop + (titleLines.length - 1) * titleLineHeight + titleSize * 0.55
      const wordLimitY = titleBottom + size * 0.08
      const titleVisualCenterY = (titleTop + titleBottom) / 2
      const wordHoldCenterY = centerY + (centerY - titleVisualCenterY)
      const questionBaseline = centerY + size * 0.22
      const quoteBaseline = centerY + size * 0.22

      const drawCenteredLine = (
        text,
        y,
        font,
        color,
        alpha,
        transform = null,
        x = centerX,
      ) => {
        loadingContext.save()
        loadingContext.globalAlpha = alpha
        loadingContext.font = font
        loadingContext.textAlign = 'center'
        loadingContext.textBaseline = 'middle'
        loadingContext.fillStyle = color
        loadingContext.shadowColor = 'rgba(248, 237, 207, 0.75)'
        loadingContext.shadowBlur = Math.max(2, size * 0.025)
        if (transform) {
          loadingContext.translate(x, y)
          loadingContext.scale(transform.scale, transform.scale)
          loadingContext.translate(-x, -y)
        }
        loadingContext.fillText(text, x, y)
        loadingContext.restore()
      }

      const drawWordStream = (
        words,
        durations,
        phase,
        fontSize,
        color,
        baseline,
        lingerDuration = 0,
      ) => {
        const wordSequenceDuration = durations.reduce(
          (total, duration) => total + duration,
          0,
        )
        const isLingering = phase >= wordSequenceDuration
        if (isLingering && phase >= wordSequenceDuration + lingerDuration) return
        const lingerElapsed = isLingering ? phase - wordSequenceDuration : 0
        const lingerStartTime = time - lingerElapsed
        let currentWordIndex = 0
        let wordElapsed = phase
        if (isLingering) {
          currentWordIndex = words.length - 1
        } else {
          while (
            currentWordIndex < durations.length - 1 &&
            wordElapsed >= durations[currentWordIndex]
          ) {
            wordElapsed -= durations[currentWordIndex]
            currentWordIndex += 1
          }
        }
        const lineHeight = Math.max(fontSize * 1.12, size * 0.11)
        const firstVisibleWord = isLingering
          ? currentWordIndex
          : Math.max(0, currentWordIndex - 2)
        const streamPosition = isLingering
          ? currentWordIndex + 1
          : currentWordIndex + wordElapsed / durations[currentWordIndex]
        const streamBaseline = baseline

        for (
          let wordIndex = firstVisibleWord;
          wordIndex <= currentWordIndex;
          wordIndex += 1
        ) {
          const distance = streamPosition - wordIndex
          const isCurrentWord = wordIndex === currentWordIndex
          const isLingeringFinalWord = isLingering && isCurrentWord
          const progress = isCurrentWord && !isLingering ? distance : 1
          const word = words[wordIndex]
          loadingContext.font = `600 italic ${fontSize}px 'Cormorant Garamond', Georgia, serif`
          const fittedSize = Math.min(
            fontSize,
            (textWidth / Math.max(1, loadingContext.measureText(word).width)) *
              fontSize,
          )
          const fadeIn = isCurrentWord
            ? easeOutCubic(Math.min(1, progress / 0.55))
            : 0.84 + Math.min(0.1, (2 - distance) * 0.08)
          const scale = isCurrentWord ? 0.84 + easeOutCubic(progress) * 0.16 : 1
          const waveTime = isLingering ? lingerStartTime : time
          const waveDistance = isLingering ? 1 : distance
          const wavePhase = waveTime / 1100 + wordIndex * 1.7 + waveDistance * 2.4
          const floatX = Math.sin(wavePhase) * size * 0.035
          const floatY = isLingering ? 0 : Math.cos(wavePhase * 0.72) * size * 0.012
          const isFinalWord = wordIndex === words.length - 1
          const finalWordEase =
            isCurrentWord && isFinalWord && !isLingering ? easeOutCubic(progress) : 1
          const finalWordY =
            streamBaseline +
            (wordHoldCenterY - streamBaseline) * finalWordEase +
            (isCurrentWord && isFinalWord ? floatY * (1 - finalWordEase) : 0)
          const wordY = isLingeringFinalWord
            ? wordHoldCenterY
            : isCurrentWord && isFinalWord
              ? finalWordY
              : streamBaseline - distance * lineHeight + floatY
          if (!isLingeringFinalWord && wordY - fittedSize * 0.58 < wordLimitY) continue
          drawCenteredLine(
            word,
            wordY,
            `600 italic ${fittedSize}px 'Cormorant Garamond', Georgia, serif`,
            color,
            fadeIn,
            { scale },
            centerX + floatX,
          )
        }
      }

      loadingContext.save()
      loadingContext.textAlign = 'center'
      loadingContext.textBaseline = 'middle'
      titleLines.forEach((line, index) => {
        const y = titleTop + index * titleLineHeight
        drawCenteredLine(
          line,
          y,
          `700 ${titleSize}px 'IM Fell English SC', Georgia, serif`,
          '#3b2518',
          0.9 * titleEase,
          { scale: 0.84 + titleEase * 0.16 },
        )
      })

      if (elapsed >= timing.questionStart && elapsed < timing.quoteStart) {
        drawWordStream(
          timing.questionWords,
          timing.questionDurations,
          elapsed - timing.questionStart,
          questionSize,
          '#6e4d3b',
          questionBaseline,
          timing.questionLastWordHold,
        )
      } else if (elapsed >= timing.quoteStart && elapsed < timing.creditStart) {
        drawWordStream(
          timing.quoteWords,
          timing.quoteDurations,
          elapsed - timing.quoteStart,
          quoteSize,
          '#594435',
          quoteBaseline,
          timing.quoteLastWordHold,
        )
      } else if (
        elapsed >= timing.creditStart &&
        elapsed < timing.creditStart + timing.creditDuration
      ) {
        const creditProgress = (elapsed - timing.creditStart) / timing.creditDuration
        const creditEase = easeOutCubic(Math.min(1, creditProgress / 0.4))
        drawCenteredLine(
          `— ${concept.author}`,
          centerY + size * 0.03,
          `600 ${Math.max(10, quoteSize * 0.88)}px 'Cormorant Garamond', Georgia, serif`,
          '#a86f5b',
          creditEase,
        )
        drawCenteredLine(
          concept.work,
          centerY + size * 0.17,
          `italic ${Math.max(9, quoteSize * 0.84)}px 'Cormorant Garamond', Georgia, serif`,
          '#a86f5b',
          creditEase * 0.85,
        )
      }
      loadingContext.restore()
    })

    const snapshotLoadingCanvas = () => {
      snapshotCanvasPosition(loadingCanvas, (anchorScreen, zoom) => {
        loadingAnchorScreen = anchorScreen
        loadingAnchorZoom = zoom
      })
    }

    if (!fogError) {
      snapshotLoadingCanvas()
      return
    }
    const tile = tileFromId(fogError.id)
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const size = Math.min(southEast.x - northWest.x, southEast.y - northWest.y)
    const centerX = northWest.x + (southEast.x - northWest.x) / 2
    const centerY = northWest.y + (southEast.y - northWest.y) / 2
    const visible =
      southEast.x >= 0 &&
      southEast.y >= 0 &&
      northWest.x <= clientWidth &&
      northWest.y <= clientHeight
    if (!visible || size <= 0) {
      snapshotLoadingCanvas()
      return
    }

    const fadeIn = easeOutCubic(Math.min(1, (time - fogError.startedAt) / 420))
    const titleSize = Math.max(13, Math.min(27, size * 0.1))
    const messageSize = Math.max(11, Math.min(19, size * 0.07))
    const textWidth = size * 0.78
    const messageFont = `600 italic ${messageSize}px 'Cormorant Garamond', Georgia, serif`
    const messageLines = wrapTextForWidth(
      loadingContext,
      fogError.text,
      textWidth,
      messageFont,
      4,
    )
    const lineHeight = messageSize * 1.08
    const messageTop =
      centerY - ((messageLines.length - 1) * lineHeight) / 2 + size * 0.08

    loadingContext.save()
    loadingContext.globalAlpha = fadeIn
    loadingContext.textAlign = 'center'
    loadingContext.textBaseline = 'middle'
    loadingContext.shadowColor = 'rgba(244, 246, 243, 0.9)'
    loadingContext.shadowBlur = Math.max(2, size * 0.025)
    loadingContext.fillStyle = '#bf3131'
    loadingContext.font = `800 ${titleSize}px Inter, ui-sans-serif, system-ui, sans-serif`
    loadingContext.fillText('ERROR', centerX, centerY - size * 0.16)
    loadingContext.fillStyle = '#403c3a'
    loadingContext.font = messageFont
    messageLines.forEach((line, index) => {
      loadingContext.fillText(line, centerX, messageTop + index * lineHeight)
    })
    loadingContext.restore()
    snapshotLoadingCanvas()
  }

  const wrapTextForWidth = (context, text, maxWidth, font, maxLines = 2) => {
    context.font = font
    const words = text.split(' ')
    const lines = []
    let line = ''
    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    })
    if (line) lines.push(line)
    return lines.slice(0, maxLines)
  }

  const paintMask = context => {
    setOverlayContextTransform(context, maskScale)
    context.clearRect(-fogBleed, -fogBleed, fogCanvasWidth, fogCanvasHeight)
    visibleFogTiles(map).forEach(tile => {
      const id = tileId(tile)
      const state = tileState.get(id)
      if (state === 'generating' && !generatingStartedAt.has(id)) {
        generatingStartedAt.set(id, animationTime)
      }
      if (state !== 'checking' && state !== 'generating' && state !== 'revealing') {
        pokedAt.delete(id)
      }
      if (isFogTileRenderable(tile) && isFogged(tile) && state !== 'generated') {
        drawFogMask(context, tile, state, animationTime)
      }
      if (state === 'revealing' || state === 'generated') {
        clearGeneratedTileMask(context, tile, state, animationTime)
      }
    })
  }

  const renderMask = frameTime => {
    maskFrame = undefined
    // Repaint the primary mask from the current viewport on every animation
    // frame. A drag must never keep a transformed mask snapshot while newly
    // visible map tiles are still loading.
    const frameInterval = maskFrameInterval
    if (frameTime - lastMaskFrame < frameInterval) {
      if (maskDirty) maskFrame = requestAnimationFrame(renderMask)
      return
    }
    lastMaskFrame = frameTime
    if (!clientWidth || !clientHeight) return
    if (!mapSourceIsReady() && !isMapMoving()) {
      // The first render can happen before the vector source has finished its
      // initial request. Keep the mask dirty and retry after the source settles
      // instead of permanently accepting an empty mask.
      if (maskRetryTimer === undefined) {
        maskRetryTimer = window.setTimeout(() => {
          maskRetryTimer = undefined
          invalidate()
        }, 250)
      }
      return
    }
    paintMask(maskContext)
    uploadMask()
    maskAnchorScreen = map.project(fogAnchor)
    maskAnchorZoom = map.getZoom()
    maskDirty = false
  }

  const invalidate = () => {
    maskDirty = true
    cachedMistDirty = true
    if (!maskFrame) maskFrame = requestAnimationFrame(renderMask)
  }

  const render = time => {
    resize()
    const frameDelta = previousFrameTime === undefined ? 0 : time - previousFrameTime
    previousFrameTime = time
    const elapsed = Math.min(100, frameDelta)
    if (!isMapMoving()) fogTime += (elapsed / 1000) * groundFogMotionSpeed
    animationTime += elapsed
    renderCachedColourFields(time, animationTime)
    // Keep the card geometry in lockstep with the map while it is being
    // dragged. Keeping the fog and labels on the same frame cadence prevents
    // either overlay from visibly trailing the raster map or generated artwork.
    drawLoadingText(animationTime)
    if (time - lastFogFrame < fogFrameInterval) {
      animationFrame = requestAnimationFrame(render)
      return
    }
    lastFogFrame = time
    const fogIsActive = [...tileState.values()].some(
      state => state === 'checking' || state === 'generating' || state === 'revealing',
    )
    if ((maskDirty || fogIsActive) && !maskFrame) renderMask(time)
    if (maskUploaded && gl && program && positionBuffer && maskTexture) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.enableVertexAttribArray(positionAttribute)
      gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, maskTexture)
      gl.uniform1i(maskUniform, 0)
      gl.uniform1f(timeUniform, fogTime)
      if (noiseDetailUniform) gl.uniform1f(noiseDetailUniform, noiseDetail())
      if (anchorScreenUniform && viewportSizeUniform) {
        // Keep the cloud field registered to its geographic anchor as the map
        // moves while its animation clock is frozen.
        const anchorScreen = map.project(fogAnchor)
        gl.uniform2f(anchorScreenUniform, anchorScreen.x, anchorScreen.y)
        if (maskAnchorScreenUniform) {
          gl.uniform2f(
            maskAnchorScreenUniform,
            maskAnchorScreen?.x ?? anchorScreen.x,
            maskAnchorScreen?.y ?? anchorScreen.y,
          )
        }
        gl.uniform1f(
          maskScaleUniform,
          2 ** (map.getZoom() - (maskAnchorZoom ?? map.getZoom())),
        )
        gl.uniform1f(mapScaleUniform, 2 ** (map.getZoom() - fogAnchorZoom))
        gl.uniform2f(viewportSizeUniform, clientWidth, clientHeight)
        if (canvasSizeUniform) {
          gl.uniform2f(canvasSizeUniform, fogCanvasWidth, fogCanvasHeight)
        }
        if (canvasOriginUniform) {
          gl.uniform2f(canvasOriginUniform, -fogBleed, -fogBleed)
        }
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    animationFrame = requestAnimationFrame(render)
  }

  const mapEvents = ['move', 'resize', 'zoom', 'rotate', 'pitch']
  mapEvents.forEach(eventName => {
    map.on(eventName, invalidate)
  })
  const pauseAnimationForDrag = () => {
    isDragging = true
    invalidate()
  }
  const resumeAnimationAfterDrag = () => {
    isDragging = false
    invalidate()
  }
  map.on('dragstart', pauseAnimationForDrag)
  map.on('dragend', resumeAnimationAfterDrag)
  const startZoom = () => {
    isZooming = true
    positionCanvasesDuringMapMotion()
  }
  const updateCanvasPosition = () => positionCanvasesDuringMapMotion()
  const finishZoom = () => {
    isZooming = false
    invalidate()
  }
  map.on('zoomstart', startZoom)
  map.on('zoom', updateCanvasPosition)
  map.on('move', updateCanvasPosition)
  map.on('zoomend', finishZoom)
  map.on('data', invalidate)
  map.on('idle', invalidate)
  resize()
  invalidate()
  animationFrame = requestAnimationFrame(render)
  return {
    invalidate,
    poke: id => {
      pokedAt.set(id, animationTime)
    },
    showError: (id, text) => {
      fogError = { id, text, startedAt: animationTime }
    },
    clearError: () => {
      fogError = undefined
    },
    beginReveal: id => {
      revealStartedAt.set(id, animationTime)
    },
    finishReveal: id => {
      revealStartedAt.delete(id)
      pokedAt.delete(id)
    },
    cancelReveal: id => {
      revealStartedAt.delete(id)
      pokedAt.delete(id)
    },
    destroy: () => {
      mapEvents.forEach(eventName => {
        map.off(eventName, invalidate)
      })
      map.off('dragstart', pauseAnimationForDrag)
      map.off('dragend', resumeAnimationAfterDrag)
      map.off('zoomstart', startZoom)
      map.off('zoom', updateCanvasPosition)
      map.off('move', updateCanvasPosition)
      map.off('zoomend', finishZoom)
      map.off('data', invalidate)
      map.off('idle', invalidate)
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (maskFrame) cancelAnimationFrame(maskFrame)
      if (maskRetryTimer !== undefined) window.clearTimeout(maskRetryTimer)
      fogError = undefined
      generatingStartedAt.clear()
      revealStartedAt.clear()
      pokedAt.clear()
      canvas.remove()
      mistCanvas.remove()
      loadingCanvas.remove()
    },
  }
}

export const installAtlasTileInteractions = (
  map,
  audio?: {
    playFogLift: (scene?: AtlasScene) => void
    preloadScene: (scene: AtlasScene) => void
  },
  {
    noNoise = false,
    onRevealCountChange = (_count: number) => {},
  }: { noNoise?: boolean; onRevealCountChange?: (count: number) => void } = {},
) => {
  const tileState = new Map()
  const landTargetState = new Map()
  const revealedTileIds = new Set()
  const generatedTileIds = new Set()
  const titleCards = new Map()
  const clearanceNotice = createClearanceNotice(map)
  const fogErrorAnnouncer = createFogErrorAnnouncer(map)
  let clearanceStartedAt: number | undefined
  const isAdminMode = () => map.getContainer().classList.contains('atlas-admin-mode')
  const mapDataIsReady = () =>
    map.isStyleLoaded() && map.isSourceLoaded('hongkong-latest') && map.areTilesLoaded()
  const activeGenerationCount = () =>
    [...tileState.values()].filter(state => state === 'generating').length

  const isLandTargetable = tile => {
    const id = tileId(tile)
    if (landTargetState.has(id)) return landTargetState.get(id)

    // queryRenderedFeatures() is render-state dependent. Never turn missing
    // source data into land while the initial map or a new viewport is still
    // settling. Cached classifications above must remain usable during that
    // settling period or the whole fog mask can briefly clear during a pan.
    if (!mapDataIsReady() || !isFullyVisible(map, tile)) return false
    landTargetState.set(id, tileLandFraction(map, tile) >= landTargetThreshold)
    return landTargetState.get(id)
  }

  const fogLandState = new Map()
  const fogLandRequests = new Map()
  let invalidateFog = () => {}
  const requestFogLandClassification = tile => {
    const id = tileId(tile)
    if (fogLandState.has(id) || fogLandRequests.has(id)) return

    const request = loadSourceLandTile(tile)
      .then(sourceTile => {
        const fraction = vectorTileLandFraction(sourceTile, tile)
        if (fraction !== null) {
          fogLandState.set(id, fraction >= landTargetThreshold)
        }
      })
      .catch(() => {})
      .finally(() => {
        fogLandRequests.delete(id)
        invalidateFog()
      })
    fogLandRequests.set(id, request)
  }
  const isFogTileLand = tile => {
    const id = tileId(tile)
    if (fogLandState.has(id)) return fogLandState.get(id)
    if (isFullyVisible(map, tile) && mapDataIsReady()) {
      const isLand = isLandTargetable(tile)
      fogLandState.set(id, isLand)
      return isLand
    }

    const fraction = sourceTileLandFraction(map, tile)
    if (fraction !== null) {
      const isLand = fraction >= landTargetThreshold
      fogLandState.set(id, isLand)
      return isLand
    }

    requestFogLandClassification(tile)
    return false
  }

  const cachedTileIds = new Set()
  const fog = createFogCanvas(map, tileState, cachedTileIds, isFogTileLand, noNoise)
  invalidateFog = fog.invalidate
  const revealGeneratedTile = (
    id,
    scene: AtlasScene | undefined,
    countsAgainstQuota = true,
  ) => {
    audio?.playFogLift(scene)
    tileState.set(id, 'revealing')
    revealedTileIds.add(id)
    if (countsAgainstQuota) generatedTileIds.add(id)
    fog.beginReveal(id)

    const titleCard = titleCards.get(id)?.card
    if (titleCard) {
      titleCard.style.opacity = '0'
      titleCard.style.transform = 'rotate(-1.2deg) translateY(0.4rem) scale(0.96)'
    }

    const startedAt = performance.now()
    const reveal = time => {
      if (tileState.get(id) !== 'revealing') return
      // RAF timestamps can be a few milliseconds older than the performance
      // timestamp captured immediately before scheduling the first frame.
      // Clamp the progress so MapLibre never receives a negative opacity.
      const progress = clampUnit((time - startedAt) / generatedRevealDuration)
      const tile = tileFromId(id)
      const layerId = `atlas-tile-${tile.x}-${tile.y}`
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, 'raster-opacity', generatedTileOpacity * progress)
      }
      if (titleCard) {
        titleCard.style.opacity = `${progress}`
        titleCard.style.transform =
          `rotate(-1.2deg) translateY(${(1 - progress) * 0.4}rem) ` +
          `scale(${0.96 + progress * 0.04})`
      }
      fog.invalidate()

      if (progress < 1) {
        requestAnimationFrame(reveal)
        return
      }

      tileState.set(id, 'generated')
      // Count tiles that visibly clear from the fog. This deliberately includes
      // cache hits clicked by the visitor, but not background cache preloads.
      onRevealCountChange(revealedTileIds.size)
      if (
        countsAgainstQuota &&
        generatedTileIds.size === personalClearanceLimit &&
        clearanceStartedAt === undefined
      ) {
        clearanceStartedAt = Date.now()
      }
      if (titleCard) {
        titleCard.style.opacity = ''
        titleCard.style.transform = ''
      }
      fog.finishReveal(id)
      fog.invalidate()
    }
    requestAnimationFrame(reveal)
  }
  const positionTitleCards = () => {
    titleCards.forEach(({ card, tile, contentBounds }) => {
      positionAtlasTitleCard(map, card, tile, contentBounds)
    })
  }

  ;['move', 'resize', 'zoom', 'rotate', 'pitch'].forEach(eventName => {
    map.on(eventName, positionTitleCards)
  })

  const cachedTileRequests = new Map()
  const preloadedTileRequests = new Map()
  const queuedCacheStatusRequests = new Map()
  let cacheStatusBatchTimer: number | undefined
  let cacheStatusBatchActive = false

  const cacheStatusFromResponse = body => {
    const scenes = Array.isArray(body?.scenes)
      ? body.scenes.filter(
          (scene): scene is AtlasScene =>
            typeof scene === 'string' && atlasSceneNames.includes(scene as AtlasScene),
        )
      : []
    if (body?.cached !== true) {
      return { cached: false, scenes, preparedUrl: undefined }
    }
    if (
      typeof body.url !== 'string' ||
      !body.url ||
      typeof body.scene !== 'string' ||
      !atlasSceneNames.includes(body.scene as AtlasScene)
    ) {
      throw new Error(
        'The atlas-tile cache lookup returned an invalid cached image URL.',
      )
    }
    return {
      cached: true,
      url: body.url,
      scene: body.scene as AtlasScene,
      scenes,
      contentBounds: body.contentBounds,
      preparedUrl: undefined,
    }
  }

  const flushCacheStatusRequests = async () => {
    cacheStatusBatchTimer = undefined
    if (cacheStatusBatchActive || !queuedCacheStatusRequests.size) return
    cacheStatusBatchActive = true
    const queued = [...queuedCacheStatusRequests.values()].slice(0, 64)
    queued.forEach(({ id }) => {
      queuedCacheStatusRequests.delete(id)
    })
    try {
      const response = await fetch('/api/atlas-tiles/cache-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tiles: queued.map(({ tile }) => ({ ...tile, zoom: atlasZoom })),
        }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          body?.error ??
            `The atlas-tile cache lookup failed with HTTP ${response.status}.`,
        )
      }
      const statuses = Array.isArray(body?.statuses) ? body.statuses : []
      if (statuses.length !== queued.length)
        throw new Error('The atlas-tile cache lookup returned an incomplete result.')
      queued.forEach(({ id, resolve, request }, index) => {
        try {
          resolve(cacheStatusFromResponse(statuses[index]))
        } catch (error) {
          if (cachedTileRequests.get(id) === request) cachedTileRequests.delete(id)
          throw error
        }
      })
    } catch (error) {
      queued.forEach(({ id, reject, request }) => {
        if (cachedTileRequests.get(id) === request) cachedTileRequests.delete(id)
        reject(error)
      })
    } finally {
      cacheStatusBatchActive = false
      if (queuedCacheStatusRequests.size) scheduleCacheStatusFlush()
    }
  }

  const scheduleCacheStatusFlush = () => {
    if (cacheStatusBatchTimer || cacheStatusBatchActive) return
    cacheStatusBatchTimer = window.setTimeout(() => {
      flushCacheStatusRequests()
    }, 20)
  }

  const checkCachedTile = tile => {
    const id = tileId(tile)
    if (preloadedTileRequests.has(id)) return preloadedTileRequests.get(id)
    if (cachedTileRequests.has(id)) return cachedTileRequests.get(id)

    let resolveRequest: (value: ReturnType<typeof cacheStatusFromResponse>) => void
    let rejectRequest: (reason?: unknown) => void
    const request = new Promise<ReturnType<typeof cacheStatusFromResponse>>(
      (resolve, reject) => {
        resolveRequest = resolve
        rejectRequest = reject
      },
    )
    cachedTileRequests.set(id, request)
    queuedCacheStatusRequests.set(id, {
      id,
      tile,
      request,
      resolve: resolveRequest,
      reject: rejectRequest,
    })
    scheduleCacheStatusFlush()
    return request
  }

  const preloadCachedTile = tile => {
    const id = tileId(tile)
    if (preloadedTileRequests.has(id)) return preloadedTileRequests.get(id)

    const request = checkCachedTile(tile)
      .then(async status => {
        if (!status.cached) {
          cachedTileIds.delete(id)
          fog.invalidate()
          return status
        }
        cachedTileIds.add(id)
        fog.invalidate()
        audio?.preloadScene(status.scene)
        return {
          ...status,
          // Do the decode and edge fade while the tile is merely visible. The
          // click path can then add the ready-to-render image immediately.
          preparedUrl: await getFadedTileUrl(status.url),
        }
      })
      .catch(error => {
        cachedTileIds.delete(id)
        fog.invalidate()
        if (preloadedTileRequests.get(id) === request) preloadedTileRequests.delete(id)
        throw error
      })
    preloadedTileRequests.set(id, request)
    return request
  }

  const preloadVisibleCachedTiles = () => {
    if (map.getZoom() < minimumFogZoom) return
    visibleFogTiles(map).forEach(tile => {
      const id = tileId(tile)
      // Check every currently visible fog tile as the viewport moves.
      if (tileState.has(id) || !isFogged(tile) || !isFogTileLand(tile)) return
      // A miss is cached too, so moving the map does not repeatedly ask the
      // server about the same visible tile during one visit.
      preloadCachedTile(tile).catch(() => {})
    })
  }

  ;['move', 'moveend', 'resize', 'zoom', 'zoomend', 'data', 'idle'].forEach(
    eventName => {
      map.on(eventName, preloadVisibleCachedTiles)
    },
  )
  preloadVisibleCachedTiles()

  map.on('mousemove', event => {
    if (isAdminMode()) {
      map.getCanvas().style.cursor = ''
      return
    }
    const tile = tileForPosition(event.lngLat)
    map.getCanvas().style.cursor =
      map.getZoom() >= minimumFogZoom &&
      isLandTargetable(tile) &&
      isFogged(tile) &&
      isFullyVisible(map, tile) &&
      tileState.get(tileId(tile)) !== 'generated' &&
      tileState.get(tileId(tile)) !== 'revealing'
        ? 'pointer'
        : ''
  })

  map.on('click', async event => {
    if (isAdminMode()) return
    if (map.getZoom() < minimumFogZoom) return
    const tile = tileForPosition(event.lngLat)
    const id = tileId(tile)
    if (
      !isLandTargetable(tile) ||
      !isFogged(tile) ||
      !isFullyVisible(map, tile) ||
      tileState.get(id) === 'checking' ||
      tileState.get(id) === 'generating' ||
      tileState.get(id) === 'revealing' ||
      tileState.get(id) === 'generated'
    )
      return

    fog.clearError()
    fogErrorAnnouncer.clear()
    tileState.set(id, 'checking')
    fog.poke(id)
    fog.invalidate()
    const startedAt = performance.now()
    let rateLimited = false
    try {
      const cacheStatus = await checkCachedTile(tile)
      if (cacheStatus.cached) {
        // The visible-tile preloader normally has started this already, but a
        // direct click can beat it. Start decoding before image setup so the
        // reveal uses the site's own cue rather than the generic fallback.
        audio?.preloadScene(cacheStatus.scene)
        await addGeneratedTile(
          map,
          tile,
          cacheStatus.url,
          cacheStatus.scene,
          titleCards,
          cacheStatus.contentBounds,
          0,
          cacheStatus.preparedUrl,
        )
        revealGeneratedTile(id, cacheStatus.scene, false)
        console.info(
          `[atlas] ${id} loaded from cache in ${Math.round(performance.now() - startedAt)}ms`,
        )
        return
      }

      if (generatedTileIds.size >= personalClearanceLimit) {
        const remaining =
          clearanceStartedAt === undefined
            ? cityClearanceDuration
            : Math.max(0, cityClearanceDuration - (Date.now() - clearanceStartedAt))
        if (remaining > 0) {
          tileState.delete(id)
          fog.cancelReveal(id)
          fog.invalidate()
          clearanceNotice.show(
            'Your three clearings are complete. The fog is being cleared elsewhere in the city; it takes around three minutes.',
          )
          return
        }
        clearanceStartedAt = undefined
      }

      // Cache checks may run together, but only three cache misses may reach
      // the paid image request at once. This is deliberately checked directly
      // before marking the tile as generating so rapid clicks cannot start a
      // fourth request while the first three are still in flight.
      if (activeGenerationCount() >= personalClearanceLimit) {
        tileState.delete(id)
        fog.cancelReveal(id)
        fog.invalidate()
        clearanceNotice.show(
          'Three tile clearings are already in progress.\nWait for one to finish before clearing more fog.',
        )
        return
      }

      tileState.set(id, 'generating')
      fog.invalidate()
      const capturedTile = await captureTile(map, tile)
      const capturedAt = performance.now()
      const hasSea = tileHasSea(map, tile)
      const scene = pickAtlasScene(hasSea, cacheStatus.scenes)
      audio?.preloadScene(scene)
      const response = await fetch(
        `/api/atlas-tiles/${atlasZoom}/${tile.x}/${tile.y}/${scene}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...capturedTile, hasSea }),
        },
      )
      const responseText = await response.text()
      let body: {
        error?: string
        message?: string
        url?: string
        scene?: string
        variant?: string
        contentBounds?: { x: number; y: number; width: number; height: number } | null
      } | null
      try {
        const parsedBody = responseText ? JSON.parse(responseText) : null
        body = parsedBody && typeof parsedBody === 'object' ? parsedBody : null
      } catch {
        throw new Error(
          `The atlas-tile server returned a non-JSON response (HTTP ${response.status}). Restart with bun run dev.`,
        )
      }
      if (!response.ok) {
        if (response.status === 429) {
          rateLimited = true
          clearanceStartedAt = Date.now()
          clearanceNotice.show(
            body?.error ??
              'The fog is being cleared elsewhere in the city; it takes around three minutes.',
          )
        }
      }
      if (!response.ok)
        throw new Error(
          body?.error ??
            body?.message ??
            `The atlas-tile server returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ''}.`,
        )
      if (!body?.url)
        throw new Error(
          `The atlas-tile server returned HTTP ${response.status} without a generated tile URL.`,
        )
      const generatedAt = performance.now()
      const generatedScene = atlasSceneNames.includes(body.scene as AtlasScene)
        ? (body.scene as AtlasScene)
        : scene
      await addGeneratedTile(
        map,
        tile,
        body.url,
        generatedScene,
        titleCards,
        body.contentBounds,
      )
      revealGeneratedTile(id, generatedScene)
      console.info(
        `[atlas] ${id} ready in ${Math.round(performance.now() - startedAt)}ms ` +
          `(capture ${Math.round(capturedAt - startedAt)}ms, full-tile safe-zone mask, ` +
          `generation ${Math.round(generatedAt - capturedAt)}ms, ` +
          `display ${Math.round(performance.now() - generatedAt)}ms)`,
      )
    } catch (error) {
      tileState.delete(id)
      fog.invalidate()
      if (!rateLimited) {
        const message =
          error instanceof Error ? error.message : 'Could not generate this atlas tile.'
        fog.showError(id, message)
        fogErrorAnnouncer.announce(message)
      }
    }
  })

  const resetReveals = () => {
    const revealedLayerIds = [...revealedTileIds]
      .map(id => `atlas-tile-${tileFromId(id).x}-${tileFromId(id).y}`)
      .filter(layerId => map.getLayer(layerId))

    // Put the fog back over the artwork before the artwork fades away. This
    // makes the reset read as the city disappearing into mist, not as a hard cut.
    revealedTileIds.forEach(id => {
      cachedTileRequests.delete(id)
      preloadedTileRequests.delete(id)
      fog.cancelReveal(id)
      tileState.set(id, 'resetting')
    })
    fog.invalidate()

    return new Promise<void>(resolve => {
      const startedAt = performance.now()
      const duration = 1200
      const fade = now => {
        const progress = clampUnit((now - startedAt) / duration)
        const eased = 1 - (1 - progress) ** 3
        revealedLayerIds.forEach(layerId => {
          if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'raster-opacity', 0.94 * (1 - eased))
          }
        })

        if (progress < 1) {
          requestAnimationFrame(fade)
          return
        }

        revealedLayerIds.forEach(layerId => {
          const sourceId = layerId
          if (map.getLayer(layerId)) map.removeLayer(layerId)
          if (map.getSource(sourceId)) map.removeSource(sourceId)
        })
        titleCards.forEach(({ card, tile }) => {
          if (revealedTileIds.has(tileId(tile))) {
            card.remove()
            titleCards.delete(tileId(tile))
          }
        })
        generatedTileIds.clear()
        revealedTileIds.clear()
        onRevealCountChange(0)
        tileState.clear()
        clearanceStartedAt = undefined
        clearanceNotice.hide()
        fog.clearError()
        fogErrorAnnouncer.clear()
        fog.invalidate()
        resolve()
      }
      requestAnimationFrame(fade)
    })
  }

  return { resetReveals, getRevealCount: () => revealedTileIds.size }
}
