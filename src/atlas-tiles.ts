import { originalArtwork } from './artwork-sampling'
import { installArtworkAnimations } from './fountain-glitter'
import type { Painting } from './artwork-review'
import { createFogSilhouette } from './fog-silhouette'
import hkuSite from '../experiments/dream-atlas/hku-site.json'
import hkuTowers from '../experiments/dream-atlas/hku-selection.json'
import { fogShapeSeed } from './fog-pattern.js'
import { clickRevealBudgetMs } from './atlas-protocol.ts'
import { planAtlasRoads } from './atlas-road-plan.ts'
import { FogQuality } from './fog-quality.ts'
import { atlasSceneNames, pickAtlasScene, type AtlasScene } from './atlas-scenes.ts'
import { sampleArtworkAlpha, createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards.ts'
import { loadingConcepts } from './loading-concepts.ts'
import { atlasZoom, drawingFootprint, tileBounds, tileForPosition } from './tile-geometry.ts'
import {
  requiredUsableFraction,
  fogEligibilityChildSpan,
  fogEligibilitySourceZoom,
  isFogPatternSelected,
  type FogEligibility,
} from './fog-eligibility.ts'

export const minimumFogZoom = 15
const loadingLayoutZoom = 17.5
const waterLayerIds = ['water', 'water_stream', 'water_river']
const groundFogMotionSpeed = 1.1
const groundFogRadiusMultiplier = 1.045
const fogRadiusDuration = 180_000
export const generatedRevealDuration = 1400
const generatedTileOpacity = 0.94
const revealedTileFocusDuration = 1500
const titleCardFocusLeadTime = 500
const fogPokeDuration = 900
const fogPokeExpansion = 0.16
const concurrentGenerationLimit = 3
// A Worker may finish writing an image after the browser connection has been
// interrupted by an edge or mobile-network timeout. Give that completed work a
// short window to appear in the cache before treating the clearing as failed.
const generatedTileRecoveryAttempts = 8
const generatedTileRecoveryInterval = 2500
// z15 fog indexes begin loading before they cross into view, then remain in
// memory one additional parent tile beyond that request area.
const fogIndexLoadMarginZ15 = 1
const fogIndexRetainMarginZ15 = 2
// Leave headroom for visible vector tiles on cold loads, and keep slots
// available for newly visible fog parents when the camera changes direction.
const concurrentFogIndexRequestLimit = 4
const speculativeFogIndexRequestLimit = 2
// Draw fog one z18 child outside the screen so its soft edge never clips.
const fogRenderMarginZ18 = 1
// Decode cached images only near the screen; these margins grow as a zoomed-out
// view can cross more z18 children in one pan.
const imagePreloadMarginZ18 = zoom => (zoom >= 18 ? 1 : zoom >= 17 ? 2 : 4)
// Image variants are mutable, unlike eligibility. Refresh the compact z15
// index so generation and deletion become visible without a full page reload.
const fogImageIndexRefreshMs = 60_000

const cloudExclusion = {
  fogPattern: { icon: 'pattern', label: 'Not selected by the fog pattern' },
  lowLand: { icon: 'land', label: 'Land coverage is below 75%' },
  highStreets: { icon: 'streets', label: 'Roads leave no sufficiently large usable plot' },
  noRegionalLand: { icon: 'map', label: 'No regional land data is available' },
  unavailableMapData: { icon: 'unavailable', label: 'Map data is unavailable' },
}

const createCloudDiagnosticIcon = iconName => {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.classList.add('atlas-cloud-diagnostic__icon')
  icon.setAttribute('viewBox', '0 0 100 100')
  icon.setAttribute('aria-hidden', 'true')
  const shape = (name, attributes) => {
    const element = document.createElementNS(namespace, name)
    Object.entries(attributes).forEach(([attribute, value]) => {
      element.setAttribute(attribute, value)
    })
    icon.append(element)
  }

  if (iconName === 'pattern') {
    ;[
      [12, 12],
      [56, 12],
      [12, 56],
      [56, 56],
    ].forEach(([x, y]) => {
      shape('rect', { x, y, width: 32, height: 32, rx: 4 })
    })
  } else if (iconName === 'land') {
    shape('path', { d: 'M8 80 38 29l18 26 12-17 24 42H8Z' })
    shape('path', { d: 'm38 29 10 17 8-12 12 18-12 3-18-26Z', fill: 'none' })
  } else if (iconName === 'streets') {
    shape('path', {
      d: 'M16 83 44 16h12l28 67H70L51 38 32 83H16Zm32 3V14',
    })
  } else if (iconName === 'map') {
    shape('path', { d: 'm10 24 25-10 30 11 25-10v61L65 86 35 75 10 85V24Z' })
    shape('path', { d: 'M35 14v61m30-50v61', fill: 'none' })
  } else {
    shape('circle', { cx: 50, cy: 50, r: 40, fill: 'none' })
    shape('path', { d: 'M50 28v31m0 17v1', fill: 'none' })
  }
  return icon
}

export const tileId = ({ x, y }) => `${atlasZoom}/${x}/${y}`
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

const screenBounds = (map, bounds) => {
  const nw = map.project([bounds.west, bounds.north])
  const se = map.project([bounds.east, bounds.south])
  if (!map.getPitch() && !map.getBearing()) return [nw, se]
  const ne = map.project([bounds.east, bounds.north])
  const sw = map.project([bounds.west, bounds.south])
  return [
    { x: Math.min(nw.x, ne.x, se.x, sw.x), y: Math.min(nw.y, ne.y, se.y, sw.y) },
    { x: Math.max(nw.x, ne.x, se.x, sw.x), y: Math.max(nw.y, ne.y, se.y, sw.y) },
  ]
}

const intersectsViewport = (map, tile, spill = 0) => {
  const bounds = tileBounds(tile)
  const [northWest, southEast] = screenBounds(map, bounds)
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

export const viewportFogTiles = (map, spill = 0, margin = Math.ceil(spill)) => {
  const bounds = map.getBounds()
  const northWest = tileForPosition({ lng: bounds.getWest(), lat: bounds.getNorth() })
  const southEast = tileForPosition({ lng: bounds.getEast(), lat: bounds.getSouth() })
  const tiles = []
  for (let y = northWest.y - margin; y <= southEast.y + margin; y += 1) {
    for (let x = northWest.x - margin; x <= southEast.x + margin; x += 1) {
      const tile = { x, y }
      if (intersectsViewport(map, tile, spill)) tiles.push(tile)
    }
  }
  return tiles
}

const visibleFogTiles = (map, spill = 0) =>
  map.getZoom() < minimumFogZoom ? [] : viewportFogTiles(map, spill)

const hkuBase = hkuSite.tiles[0]
const hkuDrawing = drawingFootprint(hkuBase)
const hkuCells = hkuDrawing.cells.map(tileId)
const isHkuSite = tile => hkuCells.includes(tileId(tile))
const isFogged = tile => isHkuSite(tile) || isFogPatternSelected(tile)
// Shared image/cache work can still serve another click after this one expires.
const withinClickBudget = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
const waitForRender = map => new Promise(resolve => map.once('render', resolve))
const seeded = value => {
  const noise = Math.sin(value * 12.9898) * 43758.5453
  return noise - Math.floor(noise)
}
const clampUnit = value => Math.max(0, Math.min(1, value))

const cloudEligibilityFromResult = (result: FogEligibility) => {
  if (!result.regionalLandAvailable) {
    return {
      isTargetable: false,
      landFraction: null,
      reasons: [cloudExclusion.noRegionalLand],
      streetFraction: null,
    }
  }
  const reasons = []
  if (result.landFraction !== null && result.landFraction < (result.coastal ? 0.1 : 0.75)) {
    reasons.push({
      ...cloudExclusion.lowLand,
      label: `Land coverage is ${Math.round(result.landFraction * 100)}% (minimum ${result.coastal ? 10 : 75}%)`,
    })
  }
  if (result.usableFraction !== undefined && result.usableFraction !== null && result.usableFraction < requiredUsableFraction(result.coastal)) {
    reasons.push({
      ...cloudExclusion.highStreets,
      label: `Largest usable plot is ${Math.round(result.usableFraction * 100)}% (minimum ${requiredUsableFraction(result.coastal) * 100}%)`,
    })
  }
  return {
    isTargetable: result.isTargetable,
    landFraction: result.landFraction,
    reasons,
    streetFraction: result.streetFraction,
    coastal: result.coastal,
    usableFraction: result.usableFraction,
  }
}

const unavailableCloudEligibility = detail => ({
  cacheVersion: 'NOT RECEIVED',
  error: detail,
  isTargetable: false,
  landFraction: null,
  reasons: [{ ...cloudExclusion.unavailableMapData, label: detail }],
  streetFraction: null,
})

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

export const captureTile = async (map, tile, pixelSize = atlasTileSize, study = false) => {
  if (![512, 1024, 2048].includes(pixelSize))
    throw new Error('Unsupported capture size')
  const hiddenLayerIds = hideTextLabels(map)
  const restoreRoads: (() => void)[] = []
  try {
    await waitForRender(map)
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const mapCanvas = map.getCanvas()
    const scale = mapCanvas.width / mapCanvas.clientWidth
    const tileCanvas = document.createElement('canvas')
    tileCanvas.width = pixelSize
    tileCanvas.height = pixelSize
    const context = tileCanvas.getContext('2d')
    const readTile = () => context.drawImage(
      mapCanvas,
      northWest.x * scale,
      northWest.y * scale,
      (southEast.x - northWest.x) * scale,
      (southEast.y - northWest.y) * scale,
      0,
      0,
      pixelSize,
      pixelSize,
    )
    readTile()
    const styles = map.getStyle().layers.filter(l => l['source-layer'] === 'roads' && l.type === 'line')
    const roads = map.queryRenderedFeatures([northWest, southEast], { layers: styles.map(l => l.id) })
    const unique = new Map()
    for (const f of roads) unique.set(JSON.stringify([f.geometry, f.properties]), f)
    const plan = planAtlasRoads([...unique.values()], bounds)
    let roadCleanup: string | undefined
    if (plan.removedPaths.length) {
      const original = context.getImageData(0, 0, pixelSize, pixelSize)
      const source = 'atlas-capture-roads'
      map.addSource(source, { type: 'geojson', tolerance: 0, maxzoom: 22,
        data: { type: 'FeatureCollection', features: plan.retained } })
      restoreRoads.push(() => map.removeSource(source))
      for (const style of styles.filter(l => /^roads_minor(?:_service)?(?:_casing)?$/.test(l.id))) {
        const id = source + '-' + style.id
        const { 'source-layer': _, ...layer } = style
        map.addLayer({ ...layer, id, source }, style.id)
        restoreRoads.push(() => map.removeLayer(id))
        map.setLayoutProperty(style.id, 'visibility', 'none')
        restoreRoads.push(() => map.setLayoutProperty(style.id, 'visibility', style.layout?.visibility ?? null))
      }
      // Wait for the replacement vector geometry to reach the renderer.
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          if (!map.isSourceLoaded(source)) return
          finish()
          resolve()
        }
        const finish = () => { clearTimeout(timer); map.off('render', ready) }
        const timer = setTimeout(() => { finish(); reject(new Error('Road layout timed out')) }, 3000)
        map.on('render', ready)
        map.triggerRepaint()
      })
      readTile()
      const revised = context.getImageData(0, 0, pixelSize, pixelSize)
      const delta = document.createElement('canvas')
      delta.width = delta.height = pixelSize
      const diff = delta.getContext('2d')
      const project = coord => {
        const point = map.project(coord)
        return [(point.x - northWest.x) * pixelSize / (southEast.x - northWest.x),
          (point.y - northWest.y) * pixelSize / (southEast.y - northWest.y)]
      }
      // Only copy the rerendered road corridor. Outside it retain exact source pixels.
      for (const coordinates of plan.removedPaths) drawGeometry(diff,
        { type: 'LineString', coordinates }, project,
        { stroke: true, lineWidth: 20 * pixelSize / (southEast.x - northWest.x) })
      const patch = diff.getImageData(0, 0, pixelSize, pixelSize)
      for (let i = 0; i < patch.data.length; i += 4) {
        if (patch.data[i + 3] && (original.data[i] !== revised.data[i] ||
            original.data[i+1] !== revised.data[i+1] || original.data[i+2] !== revised.data[i+2])) {
          original.data.set(revised.data.subarray(i,i+4),i)
          patch.data.set(revised.data.subarray(i,i+4),i)
        } else patch.data[i+3] = 0
      }
      context.putImageData(original,0,0)
      if (study) {
        diff.putImageData(patch,0,0)
        roadCleanup = delta.toDataURL('image/png')
      }
    }
    const generationArtifacts = createGenerationArtifacts(
      map,
      tileCanvas,
      northWest,
      southEast,
      study,
    )
    return {
      sourceImage: tileCanvas.toDataURL('image/png'),
      ...generationArtifacts,
      ...(study ? { roadCleanup, reclaimedConnectors: plan.removedPaths.length } : {}),
    }
  } finally {
    for (const restore of restoreRoads.reverse()) restore()
    hiddenLayerIds.forEach(layerId => {
      map.setLayoutProperty(layerId, 'visibility', 'visible')
    })
    map.triggerRepaint()
  }
}

const seaKinds = new Set(['sea', 'ocean', 'bay', 'strait', 'fjord'])

export const tileHasSea = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  return map
    .queryRenderedFeatures([northWest, southEast], { layers: waterLayerIds })
    .some(feature => seaKinds.has(feature.properties?.kind))
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
  /road|street|transport|rail|path|trail|boundary|water/.test(featureName(feature))

// The generated image is allowed to blend near the safe-zone boundary, so the
// protected geometry needs a generous hit area. The source pixels inside that
// area are restored after generation; the extra width therefore protects the
// street without making the street itself visually wider.
const lockedLineWidth = (feature, purpose) => {
  const name = featureName(feature)
  if (/boundary/.test(name)) return purpose === 'mask' ? 4 : 2
  if (/rail/.test(name)) return purpose === 'mask' ? 10 : 6
  if (isFinePathFeature(feature)) return purpose === 'mask' ? 6 : 4
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

const createGenerationArtifacts = (map, sourceCanvas, northWest, southEast, study) => {
  const pixelSize = sourceCanvas.width
  const pixelRatio = pixelSize / atlasTileSize
  const scaleX = pixelSize / (southEast.x - northWest.x)
  const scaleY = pixelSize / (southEast.y - northWest.y)
  const project = coordinate => {
    const point = map.project(coordinate)
    return [(point.x - northWest.x) * scaleX, (point.y - northWest.y) * scaleY]
  }
  const features = map.queryRenderedFeatures([northWest, southEast])
  const safeCanvas = document.createElement('canvas')
  safeCanvas.width = pixelSize
  safeCanvas.height = pixelSize
  const safeContext = safeCanvas.getContext('2d')
  const lineCanvas = document.createElement('canvas')
  lineCanvas.width = pixelSize
  lineCanvas.height = pixelSize
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
    safeContext.fillRect(0, 0, pixelSize, pixelSize)
  }
  safeContext.globalCompositeOperation = 'destination-out'
  waterFeatures.forEach(feature => {
    drawGeometry(safeContext, feature.geometry, project, { fill: true })
  })
  lockedLineFeatures.forEach(feature => {
    drawGeometry(safeContext, feature.geometry, project, {
      stroke: true,
      lineWidth: lockedLineWidth(feature, 'mask') * pixelRatio,
    })
  })
  safeContext.lineWidth = 24 * pixelRatio
  safeContext.strokeRect(0, 0, pixelSize, pixelSize)
  safeContext.globalCompositeOperation = 'source-over'

  lineContext.strokeStyle = '#ffffff'
  lockedLineFeatures.forEach(feature => {
    drawGeometry(lineContext, feature.geometry, project, {
      stroke: true,
      lineWidth: lockedLineWidth(feature, 'overlay') * pixelRatio,
    })
  })

  const buildings = document.createElement('canvas')
  buildings.width = buildings.height = pixelSize
  const buildingContext = buildings.getContext('2d')
  for (const feature of features.filter(f => f.layer.id === 'buildings'))
    drawGeometry(buildingContext, feature.geometry, project, { fill: true })
  const footprints = buildingContext.getImageData(0, 0, pixelSize, pixelSize)
  const maskPixels = safeContext.getImageData(0, 0, pixelSize, pixelSize)
  // Keep the placement mask at ground level. The image compositor also needs
  // two separate permissions for raised architecture and nearshore vessels.
  const geometryMask = (features, width = 0) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = pixelSize
    const ctx = canvas.getContext('2d')
    for (const f of features) drawGeometry(ctx, f.geometry, project, width
      ? { stroke: true, lineWidth: width } : { fill: true })
    return ctx.getImageData(0, 0, pixelSize, pixelSize).data
  }
  const surfaceStreet = f => isRoadLineFeature(f) && !/rail/.test(featureName(f))
    && !f.properties?.is_bridge && !f.properties?.is_tunnel
  const barriers = geometryMask(lockedLineFeatures.filter(f => !surfaceStreet(f)), 10 * pixelRatio)
  const water = geometryMask(waterFeatures)
  const sea = waterFeatures.filter(f => seaKinds.has(f.properties?.kind))
  const sourcePixels = sourceCanvas
    .getContext('2d')
    .getImageData(0, 0, pixelSize, pixelSize)
  const seaFill = geometryMask(sea)
  // A shore-connected complex can extend across half a tile of nearshore water.
  // The stroke straddles the shoreline, so its full width is twice that reach.
  const shore = geometryMask(sea, pixelSize)
  const street = geometryMask(lockedLineFeatures.filter(surfaceStreet), 18 * pixelRatio)
  const projection = safeContext.createImageData(pixelSize, pixelSize)
  const mooring = safeContext.createImageData(pixelSize, pixelSize)
  const deck = safeContext.createImageData(pixelSize, pixelSize)
  const southBase = new Int32Array(pixelSize).fill(pixelSize * 2)
  const margin = Math.ceil(12 * pixelRatio)
  for (let y = pixelSize - margin - 1; y >= margin; y--) {
    for (let x = margin; x < pixelSize - margin; x++) {
      const i = (y * pixelSize + x) * 4 + 3
      if (barriers[i] || water[i]) southBase[x] = pixelSize * 2
      else if (footprints.data[i] && maskPixels.data[i] === 255) southBase[x] = y
      if (street[i] && !barriers[i] && !water[i] && southBase[x] - y <= pixelSize * .24)
        projection.data[i] = 255
      if (seaFill[i] === 255 && shore[i] && !barriers[i] && !street[i]) {
        // In the harbour a mapped structure can sit above a sea polygon.
        // Only the exposed water takes a hull; cargo goes on the deck.
        if (footprints.data[i] === 255) deck.data[i] = 255
        else if (sourcePixels.data[i-3] === 125 && sourcePixels.data[i-2] === 159 &&
            sourcePixels.data[i-1] === 160) mooring.data[i] = 255
      }
    }
  }
  const maskUrl = pixels => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = pixelSize
    canvas.getContext('2d').putImageData(pixels, 0, 0)
    return canvas.toDataURL('image/png')
  }
  for (let i = 3; i < deck.data.length; i += 4) {
    if (deck.data[i]) maskPixels.data.set([255, 255, 255, 255], i-3)
  }
  safeContext.putImageData(maskPixels, 0, 0)
  const groundMask = study ? safeCanvas.toDataURL('image/png') : undefined
  let contentLeft = pixelSize
  let contentTop = pixelSize
  let contentRight = -1
  let contentBottom = -1
  for (let y = 0; y < pixelSize; y += 1) {
    for (let x = 0; x < pixelSize; x += 1) {
      const alpha = (y * pixelSize + x) * 4 + 3
      if (maskPixels.data[alpha] <= 32 && !projection.data[alpha] && !mooring.data[alpha]) continue
      contentLeft = Math.min(contentLeft, x)
      contentTop = Math.min(contentTop, y)
      contentRight = Math.max(contentRight, x)
      contentBottom = Math.max(contentBottom, y)
    }
  }
  const guideCanvas = document.createElement('canvas')
  guideCanvas.width = pixelSize
  guideCanvas.height = pixelSize
  const guideContext = guideCanvas.getContext('2d')
  const guidePixels = guideContext.createImageData(pixelSize, pixelSize)
  for (let index = 0; index < maskPixels.data.length; index += 4) {
    const safe = maskPixels.data[index + 3] > 32
    guidePixels.data[index] = safe ? 56 : 176
    guidePixels.data[index + 1] = safe ? (footprints.data[index + 3] ? 224 : 156) : 72
    guidePixels.data[index + 2] = safe ? 91 : 63
    guidePixels.data[index + 3] = safe ? 150 : 190
    if (projection.data[index + 3] || mooring.data[index + 3]) {
      guidePixels.data.set(projection.data[index + 3] ? [232, 169, 60, 175] : [57, 152, 208, 165], index)
      maskPixels.data.set([255, 255, 255, 255], index)
    }
  }
  guideContext.putImageData(guidePixels, 0, 0)
  safeContext.putImageData(maskPixels, 0, 0)

  const linePixels = lineContext.getImageData(0, 0, pixelSize, pixelSize)
  const overlayPixels = lineContext.createImageData(pixelSize, pixelSize)
  for (let index = 0; index < sourcePixels.data.length; index += 4) {
    overlayPixels.data[index] = sourcePixels.data[index]
    overlayPixels.data[index + 1] = sourcePixels.data[index + 1]
    overlayPixels.data[index + 2] = sourcePixels.data[index + 2]
    overlayPixels.data[index + 3] = !study && projection.data[index + 3] ? 0 : linePixels.data[index + 3]
  }
  lineContext.putImageData(overlayPixels, 0, 0)

  return {
    ...(study ? { buildingMask: buildings.toDataURL('image/png'),
      projectionMask: maskUrl(projection), mooringMask: maskUrl(mooring), deckMask: maskUrl(deck) } : {}),
    guideImage: guideCanvas.toDataURL('image/png'),
    safeMask: groundMask ?? safeCanvas.toDataURL('image/png'),
    lineOverlay: lineCanvas.toDataURL('image/png'),
    contentBounds:
      contentRight >= contentLeft && contentBottom >= contentTop
        ? {
            x: contentLeft / pixelRatio,
            y: contentTop / pixelRatio,
            width: (contentRight - contentLeft + 1) / pixelRatio,
            height: (contentBottom - contentTop + 1) / pixelRatio,
          }
        : null,
  }
}

const decodedTileImages = new Map()

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

export const addGeneratedTile = async (
  map,
  tile,
  url,
  scene,
  titleCards,
  contentBounds,
  initialOpacity = 0,
  signal?: AbortSignal,
  placement?: { bounds: ReturnType<typeof tileBounds>; title: string; image: HTMLImageElement },
) => {
  const id = `atlas-tile-${tile.x}-${tile.y}`
  if (map.getLayer(id)) return
  const bounds = placement?.bounds ?? tileBounds(tile)
  const alpha = scene && titleCards
    ? sampleArtworkAlpha(placement?.image ?? await withinClickBudget(decodeTileImage(url), signal))
    : undefined
  signal?.throwIfAborted()
  map.addSource(id, {
    type: 'image',
    url,
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
    const card = createAtlasTitleCard(map.getContainer(), scene, placement?.title)
    titleCards.set(tileId(tile), { card, tile, contentBounds, bounds, alpha })
    positionAtlasTitleCard(map, card, tile, contentBounds, bounds, alpha)
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
      sin(u_time * 0.19 + fogUv.y * 7.0 + sin(fogUv.x * 8.0) * 1.2),
      cos(u_time * 0.16 + fogUv.x * 6.0 + cos(fogUv.y * 7.0) * 1.1)
    ) * 0.075;
    // The mask is painted into a screen-sized canvas. Compensate for map
    // movement since its last paint so the same fog body stays locked to the
    // same map coordinates between canvas updates.
    vec2 maskScreenPosition = u_mask_anchor_screen +
      (screenPosition - u_anchor_screen + maskWarp * min(u_viewport_size, vec2(260.0))) / u_mask_scale;
    vec2 maskUv = (maskScreenPosition - u_canvas_origin) / u_canvas_size;
    bool maskOutside =
      maskUv.x < 0.0 || maskUv.x > 1.0 ||
      maskUv.y < 0.0 || maskUv.y > 1.0;
    if (maskOutside) discard;
    vec2 registeredUv = (u_mask_anchor_screen +
      (screenPosition - u_anchor_screen) / u_mask_scale - u_canvas_origin) / u_canvas_size;
    float mask = mix(texture2D(u_mask, registeredUv).a, texture2D(u_mask, maskUv).a, 0.85);
    if (mask < 0.01) discard;

    // Keep a generous feather around each body so the ground fog reads as a
    // soft veil rather than a set of opaque, tile-sized clouds.
    float softMask = smoothstep(0.0, 1.0, mask);
    // Soft pearl shadows and a warm white crown. Vary light across the
    // whole cloud bank so the interior reads as one volume over dark water.
    float light = 0.5;
    if (u_noise_detail > 0.5) {
      vec2 drift = vec2(u_time * 0.035, -u_time * 0.024);
      light = smoothstep(0.20, 0.80, noise(fogUv * vec2(2.2, 4.0) + drift));
      if (u_noise_detail > 1.5) {
        light = mix(light, noise(fogUv * vec2(5.1, 3.6) - drift), 0.18);
      }
    }
    vec3 pearl = vec3(0.91, 0.93, 0.93);
    vec3 ivory = vec3(1.0, 0.993, 0.974);
    vec3 fogColor = mix(pearl, ivory, 0.60 + 0.20 * light);
    gl_FragColor = vec4(fogColor, softMask * (0.72 + 0.23 * light));
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

type ArtworkFrame = { bounds: ReturnType<typeof tileBounds>; width: number; height: number }

export const focusAtlasTile = (map, tile, onApproach?: () => void, frame?: ArtworkFrame) => {
  const source = map.getSource(`atlas-tile-${tile.x}-${tile.y}`)
  const image = source?.image && originalArtwork(source.image)
  const { west, north, east, south } = frame?.bounds ?? tileBounds(tile)
  const nw = map.project([west, north])
  const se = map.project([east, south])
  const canvas = map.getCanvas()
  const width = se.x - nw.x
  const height = se.y - nw.y
  const scale = Math.min(
    canvas.clientWidth / width,
    canvas.clientHeight / height,
    (frame?.width ?? image?.width ?? atlasTileSize) / width,
    (frame?.height ?? image?.height ?? atlasTileSize) / height,
  )
  const zoom = map.getZoom() + Math.log2(scale)
  // The previous artwork may have set a smaller native-resolution ceiling.
  if (zoom > map.getMaxZoom()) map.setMaxZoom(zoom)
  map.easeTo({
    center: map.unproject([(nw.x + se.x) / 2, (nw.y + se.y) / 2]),
    zoom,
    duration: revealedTileFocusDuration,
    essential: true,
  })
  if (onApproach) window.setTimeout(onApproach, revealedTileFocusDuration - titleCardFocusLeadTime)
}

export const createFogCanvas = (
  map,
  tileState,
  cachedTileIds,
  isFogTileRenderable,
  noNoise = false,
  isSelected = isFogged,
  maskTiles = visibleFogTiles,
  shouldAnimate = () => true,
  cloudBounds = tileBounds,
  cloudShapeSeed = fogShapeSeed,
) => {
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
  const quality = new FogQuality()
  let appliedQuality = -1
  const silhouettes = new Map<string, HTMLCanvasElement>()
  let silhouetteBytes = 0
  const silhouette = (seed, radius, padding) => {
    // Bake the feathered body at a fixed resolution. Camera scale only affects
    // the size of the blit, so wheel zoom never creates new sprite variants.
    const unit = 80
    const variant = Math.floor(seeded(seed + 7) * 24)
    const key = `${variant}:${radius}:${padding.toFixed(3)}`
    const existing = silhouettes.get(key)
    if (existing) return existing
    const sprite = createFogSilhouette(variant, radius, padding, unit)
    const bytes = sprite.width * sprite.height * 4
    while (silhouettes.size && silhouetteBytes + bytes > 16 * 1024 * 1024) {
      const entry = silhouettes.entries().next().value
      if (!entry) break
      const [oldest, previous] = entry
      silhouetteBytes -= previous.width * previous.height * 4
      silhouettes.delete(oldest)
    }
    silhouettes.set(key, sprite)
    silhouetteBytes += bytes
    return sprite
  }
  const fogAnchor = map.getCenter()
  const fogAnchorZoom = map.getZoom()
  const isMapMoving = () => isDragging || map.isMoving()
  // The noise controls opacity, so camera motion must not replace it with
  // a different field. Resolution and cached masks handle rendering pressure.
  const noiseDetail = () => noNoise ? 0 : 2
  let clientWidth = 0
  let clientHeight = 0
  let fogBleed = 0
  let fogCanvasWidth = 0
  let fogCanvasHeight = 0
  let maskScale = 0.5
  let maskDirty = true
  let maskUploaded = false
  let cachedMistDirty = true
  let maskContentDirty = false
  let mistContentDirty = false
  let colourCloudsVisible = false
  let loadingCanvasHasContent = false
  let textureWidth = 0
  let textureHeight = 0
  let loadingPixelRatio = 0
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
  const fogFrameInterval = 1000 / 60
  // The shader compensates for camera motion between mask uploads.
  const maskFrameInterval = 1000 / 30
  const zoomMaskFrameInterval = 1000 / 20
  const cachedMistFrameInterval = 1000 / 15
  const loadingSequences = new Map()
  let fogError: { id: string; text: string; startedAt: number } | undefined
  const generatingStartedAt = new Map()
  const revealStartedAt = new Map()
  const pokedAt = new Map()
  const revealFootprints = new Map<string, {
    key: string
    bounds: ReturnType<typeof tileBounds>
    cells: ReturnType<typeof tileBounds>[]
    rectangular: boolean
  }>()
  const revealFrames = new Map<string, number>()

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
    if (!anchorScreen || anchorZoom === undefined) return
    const scale = 2 ** (map.getZoom() - anchorZoom)
    const currentAnchorScreen = map.project(fogAnchor)
    const translateX =
      currentAnchorScreen.x - anchorScreen.x * scale - (scale - 1) * fogBleed
    const translateY =
      currentAnchorScreen.y - anchorScreen.y * scale - (scale - 1) * fogBleed
    target.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${translateX}, ${translateY})`
  }

  const canReuseDuringMotion = (screen, zoom, reserveFraction = 0.4) => {
    if (!screen || zoom === undefined || !isMapMoving() ||
        map.getPitch() || map.getBearing() || tileState.size) return false
    const scale = 2 ** (map.getZoom() - zoom)
    const anchor = map.project(fogAnchor)
    const left = anchor.x - (screen.x + fogBleed) * scale
    const top = anchor.y - (screen.y + fogBleed) * scale
    const reserve = fogBleed * reserveFraction
    return left <= -reserve && top <= -reserve && left + fogCanvasWidth * scale >= clientWidth + reserve &&
      top + fogCanvasHeight * scale >= clientHeight + reserve
  }

  const positionCanvasesDuringMapMotion = () => {
    // The colour field can use a transformed snapshot between its lower-rate
    // redraws. Loading copy redraws every frame so it can keep its fixed
    // physical layout rather than scaling with the map during a zoom.
    positionCanvasDuringMapMotion(mistCanvas, mistAnchorScreen, mistAnchorZoom)
  }

  const resize = () => {
    const mapCanvas = map.getCanvas()
    const nextWidth = mapCanvas.clientWidth
    const nextHeight = mapCanvas.clientHeight
    if (!nextWidth || !nextHeight) return
    const nextPixelRatio = Math.max(1, mapCanvas.width / nextWidth)
    if (
      nextWidth === clientWidth &&
      nextHeight === clientHeight &&
      nextPixelRatio === loadingPixelRatio &&
      appliedQuality === quality.level
    )
      return
    loadingPixelRatio = nextPixelRatio
    appliedQuality = quality.level
    canvas.dataset.quality = String(quality.level)
    cachedMistDirty = true
    // This is a deliberately soft overlay, so rendering above 960px on either
    // axis only spends GPU time on imperceptible detail. Keeping the target
    // bounded leaves MapLibre enough frame time to animate zooms smoothly.
    const changed = nextWidth !== clientWidth || nextHeight !== clientHeight
    clientWidth = nextWidth
    clientHeight = nextHeight

    // Keep the actual map viewport as the logical coordinate system, but give
    // every fog canvas an invisible border. Canvas filters otherwise clip at
    // x/y 0 and make cloud bodies read as hard-edged at the map boundary.
    fogBleed = Math.min(
      1024,
      Math.max(256, Math.ceil(Math.max(clientWidth, clientHeight) * 0.55)),
    )
    fogCanvasWidth = clientWidth + fogBleed * 2
    fogCanvasHeight = clientHeight + fogBleed * 2
    const renderScale =
      Math.min(0.75, 960 / Math.max(fogCanvasWidth, fogCanvasHeight)) * quality.scale
    const renderWidth = Math.ceil(fogCanvasWidth * renderScale)
    const renderHeight = Math.ceil(fogCanvasHeight * renderScale)
    // Loading copy has sharp edges, unlike the intentionally soft fog. Keep
    // its backing store at the map canvas's pixel density so CSS never has to
    // enlarge the letters after they have been rasterised.
    const loadingRenderScale = Math.max(1, mapCanvas.width / nextWidth)
    const loadingRenderWidth = Math.ceil(fogCanvasWidth * loadingRenderScale)
    const loadingRenderHeight = Math.ceil(fogCanvasHeight * loadingRenderScale)
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth
      canvas.height = renderHeight
      mistCanvas.width = renderWidth
      mistCanvas.height = renderHeight
      cachedColourTileCanvas.width = renderWidth
      cachedColourTileCanvas.height = renderHeight
      if (gl) gl.viewport(0, 0, renderWidth, renderHeight)
    }
    if (
      loadingCanvas.width !== loadingRenderWidth ||
      loadingCanvas.height !== loadingRenderHeight
    ) {
      loadingCanvas.width = loadingRenderWidth
      loadingCanvas.height = loadingRenderHeight
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
    if (textureWidth === source.width && textureHeight === source.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
      return true
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    textureWidth = source.width
    textureHeight = source.height
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
  const easeInOutSine = progress => -(Math.cos(Math.PI * clampUnit(progress)) - 1) / 2

  const drawFogMask = (context, tile, state, time) => {
    const bounds = cloudBounds(tile)
    const [northWest, southEast] = screenBounds(map, bounds)
    const size = southEast.x - northWest.x
    const seed = cloudShapeSeed(tile)
    const x = northWest.x
    const y = northWest.y
    const id = tileId(tile)
    const pokeProgress = pokedAt.has(id)
      ? clampUnit((time - pokedAt.get(id)) / fogPokeDuration)
      : 1
    const footprint = revealFootprints.get(id)
    const pokeScale = 1 + Math.sin(Math.PI * pokeProgress) * fogPokeExpansion
    const generationProgress = generatingStartedAt.has(id)
      ? clampUnit((time - generatingStartedAt.get(id)) / fogRadiusDuration)
      : 0
    const baseRadiusScale =
      state === 'generating' || state === 'revealing'
        ? 1 - generationProgress * 0.34
        : 1
    const radiusScale = baseRadiusScale * (footprint ? 1 : pokeScale)
    const revealProgress = revealStartedAt.has(id)
      ? clampUnit((time - revealStartedAt.get(id)) / generatedRevealDuration)
      : 0

    context.save()
    if (footprint && pokeScale !== 1) {
      const [nw, se] = screenBounds(map, footprint.bounds)
      const cx = (nw.x + se.x) / 2, cy = (nw.y + se.y) / 2
      context.translate(cx, cy)
      context.scale(pokeScale, pokeScale)
      context.translate(-cx, -cy)
    }
    if (state === 'checking') {
      // Keep the body opaque while it reacts to the click. The expansion
      // should read as a physical exhale, not as the fog thinning out.
      context.globalAlpha = 1
    } else if (state === 'revealing') {
      context.globalAlpha = 1 - revealProgress
    } else {
      context.globalAlpha = 1
    }
    const padding = 0.5
    const sprite = silhouette(seed, 1.1 * groundFogRadiusMultiplier, padding)
    const extent = size * radiusScale * (1 + 2 * padding)
    // Offset each bank deterministically so its lobes do not repeat on grid centres.
    const offsetX = (seeded(seed + 43) - 0.5) * size * 0.28
    const offsetY = (seeded(seed + 47) - 0.5) * size * 0.28
    context.drawImage(sprite, x + (size - extent) / 2 + offsetX, y + (size - extent) / 2 + offsetY, extent, extent)
    context.restore()
  }

  const clearGeneratedTileMask = (context, tile, state, time) => {
    const footprint = revealFootprints.get(tileId(tile))
    const id = footprint?.key ?? tileId(tile)
    const revealProgress = revealStartedAt.has(id)
      ? clampUnit((time - revealStartedAt.get(id)) / generatedRevealDuration)
      : state === 'generated'
        ? 1
        : 0
    if (revealProgress <= 0) return

    const [nw, se] = screenBounds(map, footprint?.bounds ?? tileBounds(tile))
    const width = se.x - nw.x, height = se.y - nw.y
    const progress = easeOutCubic(revealProgress)
    const left = nw.x + width * (1 - progress) / 2
    const top = nw.y + height * (1 - progress) / 2

    context.save()
    context.globalCompositeOperation = 'destination-out'
    context.globalAlpha = 1
    context.filter = `blur(${Math.max(4, Math.min(width, height) * 0.045)}px)`
    context.fillStyle = '#ffffff'
    if (!footprint || footprint.rectangular) {
      context.fillRect(left, top, width * progress, height * progress)
    } else {
      // Overlapping drawings can leave a partial footprint. Feather its union once.
      context.beginPath()
      for (const cell of footprint.cells) {
        const [start, end] = screenBounds(map, cell)
        const x = Math.max(start.x, left), y = Math.max(start.y, top)
        const w = Math.min(end.x, left + width * progress) - x
        const h = Math.min(end.y, top + height * progress) - y
        if (w > 0 && h > 0) context.rect(x, y, w, h)
      }
      context.fill()
    }
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
    const titleInDuration = 1200
    const titleHoldDuration = 600
    const titleLiftDuration = 1800
    const questionStart = titleInDuration + titleHoldDuration + titleLiftDuration
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
      titleHoldDuration,
      titleLiftDuration,
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
    const bounds = cloudBounds(tile)
    const [northWest, southEast] = screenBounds(map, bounds)
    const size = Math.min(southEast.x - northWest.x, southEast.y - northWest.y)
    const visible =
      southEast.x >= -fogBleed &&
      southEast.y >= -fogBleed &&
      northWest.x <= clientWidth + fogBleed &&
      northWest.y <= clientHeight + fogBleed
    if (!visible || size <= 0) return false

    const seed = cloudShapeSeed(tile)
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
    const logicalWidth = tileWidth + colourSpill * 2
    const logicalHeight = tileHeight + colourSpill * 2
    const colourScale = canvas.width / Math.max(1, fogCanvasWidth)
    const renderWidth = Math.max(1, Math.ceil(logicalWidth * colourScale))
    const renderHeight = Math.max(1, Math.ceil(logicalHeight * colourScale))
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
    cachedColourTileContext.scale(colourScale, colourScale)
    cachedColourTileContext.filter = `blur(${Math.max(2, size * 0.018) * colourScale}px)`
    const gradient = cachedColourTileContext.createLinearGradient(
      colourSpill - tileWidth * 0.32 + swayX,
      colourSpill - tileHeight * 0.08 + swayY,
      colourSpill + tileWidth * 1.32 + swayX,
      colourSpill + tileHeight * 0.92 + swayY,
    )
    const secondHue = (baseHue + 78 + seeded(seed + 73.6) * 18) % 360
    gradient.addColorStop(0, `hsla(${baseHue}, 100%, 67%, 0.28)`)
    gradient.addColorStop(1, `hsla(${secondHue}, 100%, 67%, 0.32)`)
    cachedColourTileContext.globalAlpha = 1
    cachedColourTileContext.fillStyle = gradient
    cachedColourTileContext.restore()

    cachedColourTileContext.save()
    cachedColourTileContext.scale(colourScale, colourScale)
    cachedColourTileContext.globalCompositeOperation = 'source-over'
    cachedColourTileContext.globalAlpha = 1
    // Keep a little of the neutral ground fog around the colour field, then
    // feather that transition so it dissolves into the surrounding mist.
    const sprite = silhouette(
      seed,
      0.9 * groundFogRadiusMultiplier,
      colourSpill / size,
    )
    // Deform the cached circular mask gently rather than regenerating pixels.
    const breath = time / 11000 + seeded(seed + 19) * Math.PI * 2
    const stretchX = 0.94 + Math.sin(breath) * 0.045
    const stretchY = 0.94 + Math.cos(breath * 0.83) * 0.045
    cachedColourTileContext.translate(logicalWidth / 2 + swayX, logicalHeight / 2 + swayY)
    cachedColourTileContext.rotate(Math.sin(breath * 0.61) * 0.12)
    cachedColourTileContext.scale(stretchX, stretchY)
    cachedColourTileContext.drawImage(sprite, -logicalWidth / 2, -logicalHeight / 2, logicalWidth, logicalHeight)
    cachedColourTileContext.restore()
    // Tint the finished mask across the entire buffer. Clipping an already
    // filled rectangle with a rotated image leaves untouched strips outside
    // that image's bounds, producing coloured square frames.
    cachedColourTileContext.save()
    cachedColourTileContext.scale(colourScale, colourScale)
    cachedColourTileContext.globalCompositeOperation = 'source-in'
    cachedColourTileContext.fillStyle = gradient
    cachedColourTileContext.fillRect(0, 0, logicalWidth, logicalHeight)
    cachedColourTileContext.restore()
    mistContext.drawImage(
      cachedColourTileCanvas,
      northWest.x - colourSpill,
      northWest.y - colourSpill,
      logicalWidth,
      logicalHeight,
    )
    return true
  }

  const renderCachedColourFields = (frameTime, visualTime) => {
    if (!mistContext || map.getContainer().classList.contains('atlas-admin-mode'))
      return
    if (isMapMoving() && colourCloudsVisible) {
      // Batch incoming index responses without invalidating the geographic
      // anchor of the image still on screen.
      if (frameTime - lastCachedMistTime < 250 && canReuseDuringMotion(mistAnchorScreen, mistAnchorZoom, 0.05)) return
      if (!mistContentDirty && canReuseDuringMotion(mistAnchorScreen, mistAnchorZoom)) return
    }
    if (
      frameTime - lastCachedMistTime < cachedMistFrameInterval &&
      (!cachedMistDirty || isMapMoving())
    )
      return

    const ratio = canvas.width / Math.max(1, fogCanvasWidth)
    if (cachedTileIds.size === 0 && !colourCloudsVisible) return
    clearOverlayContext(mistContext)
    setOverlayContextTransform(mistContext, ratio)
    let hasVisibleColourCloud = false
    cachedTileIds.forEach(id => {
      const tile = tileFromId(id)
      if (tileState.has(id) || !isSelected(tile) || !isFogTileRenderable(tile)) return
      hasVisibleColourCloud =
        drawCachedColourField(tile, visualTime) || hasVisibleColourCloud
    })
    if (hasVisibleColourCloud && !colourCloudsVisible) {
      colourCloudsVisible = true
      // Let the transparent canvas paint once before transitioning it in.
      requestAnimationFrame(() => mistCanvas.classList.add('is-visible'))
    }
    if (!hasVisibleColourCloud && colourCloudsVisible) {
      colourCloudsVisible = false
      mistCanvas.classList.remove('is-visible')
    }
    lastCachedMistTime = frameTime
    cachedMistDirty = false
    mistContentDirty = false
    snapshotCanvasPosition(mistCanvas, (anchorScreen, zoom) => {
      mistAnchorScreen = anchorScreen
      mistAnchorZoom = zoom
    })
  }

  const drawLoadingText = time => {
    if (!loadingContext) return
    const hasContent =
      Boolean(fogError) ||
      [...tileState.values()].some(
        state => state === 'checking' || state === 'generating',
      )
    if (!hasContent && !loadingCanvasHasContent) return
    loadingCanvasHasContent = hasContent
    const ratio = loadingCanvas.width / Math.max(1, fogCanvasWidth)
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
      const tileSize = southEast.x - northWest.x
      // Let the composition remain registered to the ground fog. The type
      // reaches its intended design size at z17.5, then grows with the map
      // rather than being held at a viewport-sized font cap.
      const textScale = 2 ** Math.max(0, map.getZoom() - loadingLayoutZoom)
      const textLayoutSize = tileSize / textScale
      const size = tileSize
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
      const centerX = northWest.x + tileSize / 2
      const centerY = northWest.y + tileSize / 2
      const textWidth = size * 0.86
      const titleSize = Math.max(14, Math.min(30, textLayoutSize * 0.12)) * textScale
      const questionSize = Math.max(12, Math.min(23, textLayoutSize * 0.09)) * textScale
      const quoteSize = Math.max(11, Math.min(20, textLayoutSize * 0.075)) * textScale
      const titleProgress = Math.min(1, elapsed / timing.titleInDuration)
      const titleEase = easeInOutSine(titleProgress)
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
      const titleLiftStart = timing.titleInDuration + timing.titleHoldDuration
      const titleLiftProgress = clampUnit(
        (elapsed - titleLiftStart) / timing.titleLiftDuration,
      )
      const titleLiftEase = easeInOutSine(titleLiftProgress)
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
          // Let the final word finish the stream's usual one-line ascent, then
          // carry it a small distance farther as it settles into its linger.
          // Its horizontal drift remains exactly as drawn above.
          const finalWordSettleDuration = Math.min(900, lingerDuration * 0.5)
          const finalWordSettleProgress = isLingeringFinalWord
            ? easeOutCubic(
                Math.min(1, lingerElapsed / Math.max(1, finalWordSettleDuration)),
              )
            : 0
          const finalWordExtraRise = isFinalWord
            ? lineHeight * 0.15 * finalWordSettleProgress
            : 0
          const finalWordFloatY =
            isFinalWord && !isLingering ? floatY * (1 - easeOutCubic(progress)) : floatY
          const wordY =
            streamBaseline -
            distance * lineHeight +
            finalWordFloatY -
            finalWordExtraRise
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
        const restingY = titleTop + index * titleLineHeight
        const centeredY = centerY + restingY - titleVisualCenterY
        const y = centeredY + (restingY - centeredY) * titleLiftEase
        drawCenteredLine(
          line,
          y,
          `700 ${titleSize}px 'IM Fell English SC', Georgia, serif`,
          '#3b2518',
          0.9 * titleEase,
          { scale: 0.9 + titleEase * 0.1 },
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

    const resetLoadingCanvasTransform = () => resetCanvasTransform(loadingCanvas)

    if (!fogError) {
      resetLoadingCanvasTransform()
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
      southEast.x >= -fogBleed &&
      southEast.y >= -fogBleed &&
      northWest.x <= clientWidth + fogBleed &&
      northWest.y <= clientHeight + fogBleed
    if (!visible || size <= 0) {
      resetLoadingCanvasTransform()
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
    resetLoadingCanvasTransform()
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
    const tilePixels = 512 * 2 ** (map.getZoom() - atlasZoom)
    const tiles = maskTiles(map, Math.max(fogRenderMarginZ18, Math.ceil(fogBleed / tilePixels) + 1))
    const covered = tile => isFogTileRenderable(tile) && isSelected(tile) &&
      !['generated', 'revealing'].includes(tileState.get(tileId(tile)))
    // Join selected neighbours with broad, bent banks. These cached sprites
    // are painted only when the mask changes, not on every animation frame.
    // Diagonal links break up the repeated rows without seeding excluded cells.
    for (const tile of tiles) {
      if (!covered(tile)) continue
      const seed = cloudShapeSeed(tile)
      const b = tileBounds(tile)
      const start = map.project([(b.west + b.east) / 2, (b.north + b.south) / 2])
      const size = Math.abs(map.project([b.east, b.north]).x - map.project([b.west, b.north]).x)
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const neighbour = { x: tile.x + dx, y: tile.y + dy }
        if (!covered(neighbour)) continue
        const n = tileBounds(neighbour)
        const end = map.project([(n.west + n.east) / 2, (n.north + n.south) / 2])
        const variant = seed + dx * 13 + dy * 29
        const bend = (seeded(variant + 59) - 0.5) * size * 0.4
        const sprite = silhouette(variant, 1.1, 0.5)
        context.save()
        context.translate((start.x + end.x) / 2, (start.y + end.y) / 2)
        context.rotate(Math.atan2(end.y - start.y, end.x - start.x))
        const length = Math.hypot(end.x - start.x, end.y - start.y) + size * 0.9
        const width = size * (1.25 + seeded(variant + 61) * 0.35)
        context.drawImage(sprite, -length / 2, -width / 2 + bend, length, width)
        context.restore()
      }
    }
    // Union the interior junctions before drawing the feathered banks.
    // A shared corner surrounded on all four sides is interior fog.
    for (const tile of tiles) {
      const east = { x: tile.x + 1, y: tile.y }
      const south = { x: tile.x, y: tile.y + 1 }
      const diagonal = { x: tile.x + 1, y: tile.y + 1 }
      if (![tile, east, south, diagonal].every(covered)) continue
      const centres = [tile, east, diagonal, south].map(cell => {
        const b = tileBounds(cell)
        return map.project([(b.west + b.east) / 2, (b.north + b.south) / 2])
      })
      context.beginPath()
      centres.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
      context.closePath()
      context.fillStyle = '#fff'
      context.fill()
    }
    tiles.forEach(tile => {
      const id = tileId(tile)
      const state = tileState.get(id)
      if (state === 'generating' && !generatingStartedAt.has(id)) {
        generatingStartedAt.set(id, animationTime)
      }
      if (state !== 'checking' && state !== 'generating' && state !== 'revealing') {
        pokedAt.delete(id)
      }
      if (isFogTileRenderable(tile) && isSelected(tile) && state !== 'generated') {
        drawFogMask(context, tile, state, animationTime)
      }
    })
    if (tileState.size) {
      const painted = new Set<string>()
      for (const tile of tiles) {
        const state = tileState.get(tileId(tile))
        if (state === 'revealing' || state === 'generated') {
          const group = revealFootprints.get(tileId(tile))
          if (group && painted.has(group.key)) continue
          if (group) painted.add(group.key)
          clearGeneratedTileMask(context, tile, state, animationTime)
        }
      }
    }
    // Eligibility controls cloud origins, not clipping. Let neighbouring banks
    // spill naturally into excluded cells just as they do into unselected cells.
  }

  const renderMask = frameTime => {
    maskFrame = undefined
    if (!shouldAnimate()) return
    if (isMapMoving() && maskUploaded) {
      if (frameTime - lastMaskFrame < 250 && canReuseDuringMotion(maskAnchorScreen, maskAnchorZoom, 0.05)) return
      if (!maskContentDirty && canReuseDuringMotion(maskAnchorScreen, maskAnchorZoom)) return
    }
    // Refresh from the current viewport while it moves. During zoom, cap mask
    // repaints to leave enough frame time for MapLibre's camera animation.
    const frameInterval = isZooming ? zoomMaskFrameInterval : maskFrameInterval
    if (frameTime - lastMaskFrame < frameInterval) {
      if (maskDirty) maskFrame = requestAnimationFrame(renderMask)
      return
    }
    lastMaskFrame = frameTime
    if (!clientWidth || !clientHeight) return
    // Each eligibility response invalidates the mask independently, including
    // while MapLibre is still fetching other visible vector tiles.
    paintMask(maskContext)
    uploadMask()
    maskAnchorScreen = map.project(fogAnchor)
    maskAnchorZoom = map.getZoom()
    maskDirty = false
    maskContentDirty = false
  }

  const syncAnimationVisibility = () => {
    const active = shouldAnimate()
    for (const overlay of [canvas, mistCanvas, loadingCanvas]) overlay.style.display = active ? '' : 'none'
    if (!active) {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      if (maskFrame !== undefined) cancelAnimationFrame(maskFrame)
      animationFrame = maskFrame = undefined
      previousFrameTime = undefined
    }
    return active
  }

  const invalidate = () => {
    maskDirty = true
    cachedMistDirty = true
    if (!syncAnimationVisibility()) return
    if (animationFrame === undefined) animationFrame = requestAnimationFrame(render)
    if (!maskFrame) maskFrame = requestAnimationFrame(renderMask)
  }

  const render = time => {
    animationFrame = undefined
    if (!syncAnimationVisibility()) return
    const frameDelta = previousFrameTime === undefined ? 0 : time - previousFrameTime
    previousFrameTime = time
    quality.sample(frameDelta, !document.hidden)
    resize()
    const elapsed = Math.min(100, frameDelta)
    if (!isMapMoving()) fogTime += (elapsed / 1000) * groundFogMotionSpeed
    animationTime += elapsed
    renderCachedColourFields(time, fogTime * 1000 / groundFogMotionSpeed)
    // Keep the card geometry in lockstep with the map while it is being
    // dragged. Keeping the fog and labels on the same frame cadence prevents
    // either overlay from visibly trailing the raster map or generated artwork.
    drawLoadingText(animationTime)
    if (!isMapMoving() && time - lastFogFrame < fogFrameInterval) {
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
  map.on('moveend', invalidate)
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
  return {
    invalidate: () => {
      // New eligibility or artwork must enter the buffer even mid-pan.
      maskContentDirty = true
      mistContentDirty = true
      invalidate()
    },
    poke: id => {
      pokedAt.set(id, animationTime)
    },
    showError: (id, text) => {
      fogError = { id, text, startedAt: animationTime }
    },
    clearError: () => {
      fogError = undefined
    },
    animateReveal: (ids: string[], layers: string[], opacity: number, onComplete?: () => void) => {
      const startedAt = performance.now()
      const key = ids[0]
      if (ids.length > 1) {
        const tiles = ids.map(tileFromId)
        const xs = tiles.map(tile => tile.x), ys = tiles.map(tile => tile.y)
        const minX = Math.min(...xs), maxX = Math.max(...xs)
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        const { west, north } = tileBounds({ x: minX, y: minY })
        const { east, south } = tileBounds({ x: maxX, y: maxY })
        const group = { key, bounds: { west, north, east, south }, cells: tiles.map(tileBounds),
          rectangular: ids.length === (maxX - minX + 1) * (maxY - minY + 1) }
        for (const id of ids) revealFootprints.set(id, group)
      }
      for (const id of ids) {
        tileState.set(id, 'revealing')
        revealStartedAt.set(id, animationTime)
      }
      const frame = (time: number) => {
        revealFrames.delete(key)
        if (tileState.get(key) !== 'revealing') return
        const progress = clampUnit((time - startedAt) / generatedRevealDuration)
        for (const layer of layers) {
          if (map.getLayer(layer)) map.setPaintProperty(layer, 'raster-opacity', opacity * progress)
        }
        maskContentDirty = true
        mistContentDirty = true
        invalidate()
        if (progress < 1) {
          revealFrames.set(key, requestAnimationFrame(frame))
          return
        }
        for (const id of ids) {
          tileState.set(id, 'generated')
          revealStartedAt.delete(id)
          pokedAt.delete(id)
        }
        onComplete?.()
      }
      frame(startedAt)
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
      map.off('moveend', invalidate)
      map.off('zoomstart', startZoom)
      map.off('zoom', updateCanvasPosition)
      map.off('move', updateCanvasPosition)
      map.off('zoomend', finishZoom)
      map.off('data', invalidate)
      map.off('idle', invalidate)
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (maskFrame) cancelAnimationFrame(maskFrame)
      fogError = undefined
      generatingStartedAt.clear()
      for (const frame of revealFrames.values()) cancelAnimationFrame(frame)
      revealFrames.clear()
      revealFootprints.clear()
      revealStartedAt.clear()
      pokedAt.clear()
      silhouettes.clear()
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
    artwork,
    revealed = false,
    rejectedUrls = new Set<string>(),
    cloudDiagnostics = false,
    noNoise = false,
    onRevealCountChange = (_count: number) => {},
  }: {
    artwork?: Map<string, Painting[]>
    revealed?: boolean
    rejectedUrls?: Set<string>
    cloudDiagnostics?: boolean
    noNoise?: boolean
    onRevealCountChange?: (count: number) => void
  } = {},
) => {
  const tileState = new Map()
  const revealedTileIds = new Set()
  const artworkFrames = new Map<string, ArtworkFrame>()
  const animatedPaintings = new Set<Painting>()
  const showAnimations = installArtworkAnimations(map)
  const titleCards = new Map()
  const clearanceNotice = createClearanceNotice(map)
  const fogErrorAnnouncer = createFogErrorAnnouncer(map)
  const isAdminMode = () => map.getContainer().classList.contains('atlas-admin-mode')
  const activeGenerationCount = () =>
    [...tileState.values()].filter(state => state === 'generating').length

  const fogLandState = new Map()
  const visitKey = import.meta.env.DEV ? 'atlas-codex-discovery-visit' : 'atlas-discovery-visit'
  const discoveryVisit = artwork ? (sessionStorage.getItem(visitKey) ?? crypto.randomUUID()) : undefined
  if (discoveryVisit) sessionStorage.setItem(visitKey, discoveryVisit)
  const discoveryQuery = discoveryVisit ? '?discovery=' + discoveryVisit : ''
  const belongsToVisit = (url: string) => !discoveryVisit || (
    new URL(url, location.href).searchParams.get('variant')?.startsWith('discovery-' + discoveryVisit + '-')
  )
  const spansMultipleTiles = (art: Painting) => art.rows > 1 || (art.columns ?? 1) > 1
  const multiTileCells = new Set<string>()
  for (const [id, paintings] of artwork ?? []) {
    if (paintings.some(spansMultipleTiles)) multiTileCells.add(id)
  }
  const hasFootprintOverride = artwork ? tile => multiTileCells.has(tileId(tile)) : isHkuSite
  const selected = tile => hasFootprintOverride(tile) || isFogPatternSelected(tile)
  const cachedTileIds = new Set<string>(revealed ? [] : artwork?.keys())
  const indexedCachedTiles = new Map()
  const fogIndexTiles = new Map()
  const fogIndexRequests = new Map()
  const cachedTileRequests = new Map()
  const preloadedTileRequests = new Map()
  const queuedCacheStatusRequests = new Map()
  let fogIndexUpdateTimer: number | undefined
  let fogIndexActiveRequests = 0
  let cacheStatusBatchTimer: number | undefined
  let cacheStatusBatchActive = false
  let invalidateFog = () => {}
  let updateCloudDiagnostics = () => {}
  let updateCloudDiagnosticTooltip = () => {}
  const fogIndexId = tile => `${fogEligibilitySourceZoom}/${tile.x}/${tile.y}`
  const fogIndexTilesForViewport = margin => {
    const bounds = map.getBounds()
    const northWest = tileForPosition(
      { lng: bounds.getWest(), lat: bounds.getNorth() },
      fogEligibilitySourceZoom,
    )
    const southEast = tileForPosition(
      { lng: bounds.getEast(), lat: bounds.getSouth() },
      fogEligibilitySourceZoom,
    )
    const tileCount = 2 ** fogEligibilitySourceZoom
    const tiles = []
    for (
      let y = Math.max(0, northWest.y - margin);
      y <= Math.min(tileCount - 1, southEast.y + margin);
      y += 1
    ) {
      for (
        let x = Math.max(0, northWest.x - margin);
        x <= Math.min(tileCount - 1, southEast.x + margin);
        x += 1
      ) {
        tiles.push({ x, y })
      }
    }
    return tiles
  }
  const removeFogIndexTileContents = parent => {
    Array.from(
      { length: fogEligibilityChildSpan * fogEligibilityChildSpan },
      (_, offset) => ({
        x: parent.x * fogEligibilityChildSpan + (offset % fogEligibilityChildSpan),
        y:
          parent.y * fogEligibilityChildSpan +
          Math.floor(offset / fogEligibilityChildSpan),
      }),
    ).forEach(tile => {
      const id = tileId(tile)
      const indexed = indexedCachedTiles.get(id)
      fogLandState.delete(id)
      if (!artwork?.has(id) && !(artwork && tileState.has(id))) cachedTileIds.delete(id)
      indexedCachedTiles.delete(id)
      if (!tileState.has(id)) {
        cachedTileRequests.delete(id)
        preloadedTileRequests.delete(id)
        if (indexed?.url) decodedTileImages.delete(indexed.url)
      }
    })
  }
  const removeFogIndexTile = parent => {
    const id = fogIndexId(parent)
    if (!fogIndexTiles.delete(id)) return
    removeFogIndexTileContents(parent)
  }
  const loadFogIndexTile = async parent => {
    const id = fogIndexId(parent)
    const loaded = fogIndexTiles.get(id)
    if (
      fogIndexRequests.has(id) ||
      (loaded && Date.now() - loaded.loadedAt < fogImageIndexRefreshMs)
    )
      return
    const request = fetch(`/api/fog-index/15/${parent.x}/${parent.y}${artwork ? '?eligibilityOnly=true' : ''}`)
      .then(async response => {
        if (!response.ok) throw new Error(`Fog index returned HTTP ${response.status}.`)
        const body = (await response.json()) as {
          version?: string
          eligibility?: FogEligibility[]
          cached?: Array<{
            variant?: string
            x: number
            y: number
            scene: AtlasScene
            url: string
            contentBounds?: unknown
          }>
        }
        if (loaded) removeFogIndexTileContents(parent)
        const version = body.version ?? 'UNKNOWN'
        ;(Array.isArray(body.eligibility) ? body.eligibility : []).forEach(result => {
          fogLandState.set(tileId(result), {
            ...cloudEligibilityFromResult(result),
            cacheVersion: version,
          })
        })
        const variantsByTile = new Map<
          string,
          Array<{ scene: AtlasScene; url: string; contentBounds?: unknown }>
        >()
        ;(!revealed && Array.isArray(body.cached) ? body.cached : []).forEach(entry => {
          if (artwork && (!belongsToVisit(entry.url) || rejectedUrls.has(entry.url))) return
          const id = tileId(entry)
          const variants = variantsByTile.get(id) ?? []
          variants.push(entry)
          variantsByTile.set(id, variants)
        })
        variantsByTile.forEach((variants, tileIdValue) => {
          const selected = variants[Math.floor(Math.random() * variants.length)]
          cachedTileIds.add(tileIdValue)
          indexedCachedTiles.set(tileIdValue, selected)
        })
        fogIndexTiles.set(id, { ...parent, loadedAt: Date.now() })
      })
      .catch(error => {
        fogIndexTiles.set(id, { ...parent, loadedAt: Date.now() })
        const detail =
          error instanceof Error ? error.message : 'Fog index request failed.'
        Array.from(
          { length: fogEligibilityChildSpan * fogEligibilityChildSpan },
          (_, offset) => ({
            x: parent.x * fogEligibilityChildSpan + (offset % fogEligibilityChildSpan),
            y:
              parent.y * fogEligibilityChildSpan +
              Math.floor(offset / fogEligibilityChildSpan),
          }),
        ).forEach(tile => {
          fogLandState.set(tileId(tile), unavailableCloudEligibility(detail))
        })
      })
      .finally(() => {
        fogIndexRequests.delete(id)
        fogIndexActiveRequests -= 1
        invalidateFog()
        updateCloudDiagnostics()
        updateCloudDiagnosticTooltip()
        preloadVisibleCachedTiles()
        scheduleFogIndexUpdate()
      })
    fogIndexRequests.set(id, request)
    fogIndexActiveRequests += 1
  }
  const updateFogIndexes = () => {
    fogIndexUpdateTimer = undefined
    if (map.getZoom() < minimumFogZoom) {
      ;[...fogIndexTiles.values()].forEach(parent => {
        removeFogIndexTile(parent)
      })
      return
    }
    const center = tileForPosition(map.getCenter(), fogEligibilitySourceZoom)
    const visible = fogIndexTilesForViewport(0).sort(
      (left, right) =>
        Math.abs(left.x - center.x) +
        Math.abs(left.y - center.y) -
        (Math.abs(right.x - center.x) + Math.abs(right.y - center.y)),
    )
    const visibleIds = new Set(visible.map(fogIndexId))
    // Ask for the z15 parent below the visitor before the wider prefetch
    // ring. This makes cached clouds at the opening position available from a
    // single fog-index response instead of spending the initial request budget
    // on off-screen parents.
    const required = [
      ...visible,
      ...fogIndexTilesForViewport(fogIndexLoadMarginZ15).filter(
        parent => !visibleIds.has(fogIndexId(parent)),
      ),
    ]
    const retained = new Set(
      fogIndexTilesForViewport(fogIndexRetainMarginZ15).map(fogIndexId),
    )
    fogIndexTiles.forEach(parent => {
      if (!retained.has(fogIndexId(parent))) removeFogIndexTile(parent)
    })
    required.forEach(parent => {
      const limit = visibleIds.has(fogIndexId(parent))
        ? concurrentFogIndexRequestLimit : speculativeFogIndexRequestLimit
      if (fogIndexActiveRequests < limit) void loadFogIndexTile(parent)
    })
  }
  const scheduleFogIndexUpdate = () => {
    if (fogIndexUpdateTimer !== undefined) return
    fogIndexUpdateTimer = window.setTimeout(updateFogIndexes, 24)
  }
  const isTargetableLand = tile => {
    const id = tileId(tile)
    if (fogLandState.has(id)) return fogLandState.get(id).isTargetable
    scheduleFogIndexUpdate()
    return false
  }

  const isFogTileLand = tile => hasFootprintOverride(tile) || isTargetableLand(tile)
  const fog = createFogCanvas(
    map,
    tileState,
    cachedTileIds,
    isFogTileLand,
    noNoise,
    selected,
  )
  invalidateFog = fog.invalidate

  if (cloudDiagnostics) {
    const diagnosticRoot = document.createElement('div')
    diagnosticRoot.className = 'atlas-cloud-diagnostics'
    diagnosticRoot.setAttribute('aria-hidden', 'true')
    map.getContainer().append(diagnosticRoot)
    const diagnosticLabels = new Map()
    const diagnosticTooltip = document.createElement('aside')
    diagnosticTooltip.className = 'atlas-cloud-diagnostic-tooltip'
    diagnosticTooltip.hidden = true
    map.getContainer().append(diagnosticTooltip)
    let hoveredTile: { x: number; y: number } | undefined

    const percentage = value => `${Math.round(value * 100)}%`
    const addTooltipRow = (label, value, state = undefined) => {
      const row = document.createElement('div')
      row.className = 'atlas-cloud-diagnostic-tooltip__row'
      const name = document.createElement('span')
      name.textContent = label
      const detail = document.createElement('strong')
      detail.textContent = value
      if (state) detail.dataset.state = state
      row.append(name, detail)
      diagnosticTooltip.append(row)
    }
    updateCloudDiagnosticTooltip = () => {
      if (!hoveredTile) return
      const id = tileId(hoveredTile)
      const eligibility = fogLandState.get(id)
      diagnosticTooltip.replaceChildren()
      diagnosticTooltip.hidden = false
      addTooltipRow('Tile', `z${atlasZoom} / ${hoveredTile.x} / ${hoveredTile.y}`)
      if (!eligibility) {
        scheduleFogIndexUpdate()
        addTooltipRow('Conditions', 'MEASURING')
        return
      }

      const patternIncluded = isFogged(hoveredTile)
      const cloudIncluded =
        patternIncluded && eligibility.isTargetable
      addTooltipRow(
        'Cache',
        eligibility.cacheVersion ?? 'NOT RECEIVED',
        eligibility.cacheVersion ? undefined : 'fail',
      )
      if (eligibility.error) addTooltipRow('Endpoint', eligibility.error, 'fail')
      addTooltipRow(
        'Fog pattern',
        patternIncluded ? 'INCLUDED' : 'EXCLUDED',
        patternIncluded ? 'pass' : 'fail',
      )
      if (Number.isFinite(eligibility.landFraction)) {
        addTooltipRow(
          'Land',
          `${percentage(eligibility.landFraction)} · needs ${eligibility.coastal ? 10 : 75}%`,
          eligibility.landFraction >= (eligibility.coastal ? 0.1 : 0.75) ? 'pass' : 'fail',
        )
      } else {
        addTooltipRow('Land', eligibility.reasons[0]?.label ?? 'UNAVAILABLE', 'fail')
      }
      if (Number.isFinite(eligibility.streetFraction)) {
        addTooltipRow(
          'Streets',
          `${percentage(eligibility.streetFraction)} · after cleanup`,
          eligibility.isTargetable ? 'pass' : 'fail',
        )
      }
      addTooltipRow(
        'Cloud',
        cloudIncluded ? 'WILL RENDER' : 'EXCLUDED',
        cloudIncluded ? 'pass' : 'fail',
      )
    }

    updateCloudDiagnostics = () => {
      const visibleIds = new Set()
      if (map.getZoom() < minimumFogZoom) {
        diagnosticLabels.forEach(label => {
          label.remove()
        })
        diagnosticLabels.clear()
        return
      }

      visibleFogTiles(map).forEach(tile => {
        const id = tileId(tile)
        visibleIds.add(id)
        let reasons: { icon: string; label: string }[] | undefined
        if (!isFogged(tile)) {
          reasons = [cloudExclusion.fogPattern]
        } else {
          const eligibility = fogLandState.get(id)
          if (eligibility) reasons = eligibility.reasons
          else scheduleFogIndexUpdate()
        }

        // A label exists only when this tile is excluded. In particular, do
        // not annotate tiles which are eligible through either the land test
        // or a cached image: those are exactly the tiles that render a cloud.
        if (!reasons?.length) {
          diagnosticLabels.get(id)?.remove()
          diagnosticLabels.delete(id)
          return
        }

        let label = diagnosticLabels.get(id)
        if (!label) {
          label = document.createElement('output')
          label.className = 'atlas-cloud-diagnostic'
          diagnosticRoot.append(label)
          diagnosticLabels.set(id, label)
        }
        const bounds = tileBounds(tile)
        const northWest = map.project([bounds.west, bounds.north])
        const southEast = map.project([bounds.east, bounds.south])
        label.style.left = `${northWest.x}px`
        label.style.top = `${northWest.y}px`
        label.style.width = `${Math.max(0, southEast.x - northWest.x)}px`
        label.style.height = `${Math.max(0, southEast.y - northWest.y)}px`
        // Do not tint a tile red when the fog pattern would normally cover
        // it. For example, a temporary eligibility-data failure should not
        // visually replace the cloud with a red panel.
        label.classList.toggle(
          'atlas-cloud-diagnostic--fog-pattern-included',
          isFogged(tile),
        )
        label.replaceChildren(
          ...reasons.map(reason => createCloudDiagnosticIcon(reason.icon)),
        )
      })

      diagnosticLabels.forEach((label, id) => {
        if (visibleIds.has(id)) return
        label.remove()
        diagnosticLabels.delete(id)
      })
      updateCloudDiagnosticTooltip()
    }
    ;['move', 'moveend', 'resize', 'zoom', 'zoomend', 'data', 'idle'].forEach(
      eventName => {
        map.on(eventName, updateCloudDiagnostics)
      },
    )
    map.on('mousemove', event => {
      if (map.getZoom() < minimumFogZoom) return
      hoveredTile = tileForPosition(event.lngLat)
      updateCloudDiagnosticTooltip()
    })
    map.getCanvas().addEventListener('mouseleave', () => {
      hoveredTile = undefined
      diagnosticTooltip.hidden = true
    })
    updateCloudDiagnostics()
  }
  const focusRevealedTile = (tile, onApproach?: () => void) => focusAtlasTile(map, tile, onApproach)
  const focusTileForCapture = tile =>
    new Promise<void>(resolve => {
      const bounds = tileBounds(tile)
      const canvas = map.getCanvas()
      // A z18 tile is 512 CSS pixels wide at zoom 18. Leave a small frame so
      // the canvas crop remains complete even on a narrow display.
      const availableSize = Math.max(
        1,
        Math.min(canvas.clientWidth, canvas.clientHeight) - 32,
      )
      const captureSafeZoom = atlasZoom + Math.log2(availableSize / 512)
      // Preserve the visitor's zoom whenever it can contain the tile. This
      // is a local pan, not a dramatic reveal flight; only zoom out when a
      // full canvas capture would otherwise be impossible.
      const zoom = Math.max(minimumFogZoom, Math.min(map.getZoom(), captureSafeZoom))
      map.once('moveend', resolve)
      map.easeTo({
        center: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
        zoom,
        duration: 500,
        essential: true,
      })
    })
  const revealGeneratedTile = (id, scene: AtlasScene | undefined) => {
    audio?.playFogLift(scene)
    revealedTileIds.add(id)
    const tile = tileFromId(id)
    const titleCard = titleCards.get(id)?.card
    fog.animateReveal([id], [`atlas-tile-${tile.x}-${tile.y}`], generatedTileOpacity, () => {
      onRevealCountChange(revealedTileIds.size)
      focusRevealedTile(tile, () => titleCard?.classList.remove('is-awaiting-focus'))
    })
  }
  const positionTitleCards = () => {
    titleCards.forEach(({ card, tile, contentBounds, bounds, alpha }) => {
      positionAtlasTitleCard(map, card, tile, contentBounds, bounds, alpha)
    })
  }

  ;['move', 'resize', 'zoom', 'rotate', 'pitch'].forEach(eventName => {
    map.on(eventName, positionTitleCards)
  })

  const cacheStatusFromResponse = body => {
    const scenes = Array.isArray(body?.scenes)
      ? body.scenes.filter(
          (scene): scene is AtlasScene =>
            typeof scene === 'string' && atlasSceneNames.includes(scene as AtlasScene),
        )
      : []
    if (body?.cached !== true || rejectedUrls.has(body.url) || !belongsToVisit(body.url)) {
      return { cached: false, scenes }
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
      const response = await fetch('/api/atlas-tiles/cache-status' + discoveryQuery, {
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

  const checkCachedTile = (tile): Promise<ReturnType<typeof cacheStatusFromResponse>> => {
    const id = tileId(tile)
    if (preloadedTileRequests.has(id)) return preloadedTileRequests.get(id)
    if (cachedTileRequests.has(id)) return cachedTileRequests.get(id)
    const indexed = indexedCachedTiles.get(id)
    if (indexed) {
      return Promise.resolve({
        cached: true,
        url: indexed.url,
        scene: indexed.scene,
        scenes: [],
        contentBounds: indexed.contentBounds,
      })
    }

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

  const recoverGeneratedTile = async (tile, signal: AbortSignal) => {
    const id = tileId(tile)
    for (let attempt = 0; attempt < generatedTileRecoveryAttempts; attempt += 1) {
      await new Promise(resolve =>
        window.setTimeout(resolve, generatedTileRecoveryInterval),
      )
      signal.throwIfAborted()
      // A cache miss is intentionally memoized during ordinary panning. It
      // must be discarded here because this specific tile may have completed
      // while its long-running render response was in transit.
      cachedTileRequests.delete(id)
      preloadedTileRequests.delete(id)
      try {
        const status = await checkCachedTile(tile)
        if (status.cached) return status
      } catch {
        // Keep polling: a transient cache-status failure should not discard a
        // render that has already reached R2 and the manifest.
      }
    }
    return null
  }

  const preloadCachedTile = tile => {
    const id = tileId(tile)
    if (preloadedTileRequests.has(id)) return preloadedTileRequests.get(id)

    const request = checkCachedTile(tile)
      .then(async status => {
        if (preloadedTileRequests.get(id) !== request) return status
        if (!status.cached) {
          if (!artwork?.has(id)) cachedTileIds.delete(id)
          fog.invalidate()
          updateCloudDiagnostics()
          return status
        }
        cachedTileIds.add(id)
        fog.invalidate()
        updateCloudDiagnostics()
        audio?.preloadScene(status.scene)
        await decodeTileImage(status.url)
        return status
      })
      .catch(error => {
        if (preloadedTileRequests.get(id) !== request) throw error
        if (!artwork?.has(id)) cachedTileIds.delete(id)
        fog.invalidate()
        updateCloudDiagnostics()
        preloadedTileRequests.delete(id)
        throw error
      })
    preloadedTileRequests.set(id, request)
    return request
  }

  const preloadVisibleCachedTiles = () => {
    if (map.getZoom() < minimumFogZoom) return
    indexedCachedTiles.forEach((_cached, id) => {
      const tile = tileFromId(id)
      if (!intersectsViewport(map, tile, imagePreloadMarginZ18(map.getZoom()))) return
      if (tileState.has(id) || !selected(tile)) return
      preloadCachedTile(tile).catch(() => {})
    })
  }

  ;['move', 'moveend', 'resize', 'zoom', 'zoomend', 'data', 'idle'].forEach(
    eventName => {
      map.on(eventName, scheduleFogIndexUpdate)
      map.on(eventName, preloadVisibleCachedTiles)
    },
  )
  scheduleFogIndexUpdate()
  preloadVisibleCachedTiles()

  if (revealed && artwork) {
    for (const id of artwork.keys()) tileState.set(id, 'generated')
    fog.invalidate()
    // Keep the chosen paintings for the visit, but only mount nearby images and plaques.
    const mounted = new Map<Painting, AbortController>()
    const frames = new Map<Painting, ArtworkFrame>()
    async function mount(art: Painting, signal: AbortSignal) {
      const { bounds } = drawingFootprint({ ...art, tileSpan: { columns: art.columns ?? 1, rows: art.rows } })
      const image = new Image()
      image.src = art.animation?.plate ?? art.imageUrl ?? art.url
      try {
        await image.decode()
        await addGeneratedTile(map, art, image.src, art.title, titleCards, undefined,
          1, signal, { bounds, title: art.title, image })
        if (signal.aborted) return
        titleCards.get(tileId(art)).card.classList.remove('is-awaiting-focus')
        frames.set(art, { bounds, width: image.naturalWidth, height: image.naturalHeight })
        if (art.animation) {
          animatedPaintings.add(art)
          showAnimations(animatedPaintings)
        }
      } catch (error) {
        if (!signal.aborted) console.warn('Could not load revealed painting', art.title, error)
      }
    }
    function updatePaintings() {
      const visible = new Set<Painting>()
      for (const cell of viewportFogTiles(map, 1)) {
        const art = artwork.get(tileId(cell))?.[0]
        if (art) visible.add(art)
      }
      for (const [art, controller] of mounted) {
        if (visible.has(art)) continue
        controller.abort()
        mounted.delete(art)
        frames.delete(art)
        const id = `atlas-tile-${art.x}-${art.y}`
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
        const anchor = tileId(art)
        titleCards.get(anchor)?.card.remove()
        titleCards.delete(anchor)
        if (animatedPaintings.delete(art)) showAnimations(animatedPaintings)
      }
      for (const art of visible) {
        if (mounted.has(art)) continue
        const controller = new AbortController()
        mounted.set(art, controller)
        void mount(art, controller.signal)
      }
    }
    map.on('move', updatePaintings)
    map.on('resize', updatePaintings)
    map.once('remove', () => {
      for (const controller of mounted.values()) controller.abort()
    })
    map.on('click', event => {
      const art = artwork.get(tileId(tileForPosition(event.lngLat)))?.[0]
      const frame = art && frames.get(art)
      if (frame) focusAtlasTile(map, art, undefined, frame)
    })
    updatePaintings()
    const count = new Set([...artwork.values()].map(([art]) => art)).size
    onRevealCountChange(count)
    return { resetReveals: async () => {}, getRevealCount: () => count }
  }

  map.on('mousemove', event => {
    if (isAdminMode()) {
      map.getCanvas().style.cursor = 'pointer'
      return
    }
    const tile = tileForPosition(event.lngLat)
    const id = tileId(tile)
    const state = tileState.get(id)
    map.getCanvas().style.cursor =
      map.getZoom() >= minimumFogZoom &&
      (state === 'generated' ||
        (selected(tile) &&
          state !== 'revealing' &&
          isFogTileLand(tile)))
        ? 'pointer'
        : ''
  })

  map.on('click', async event => {
    if (isAdminMode()) return
    if (map.getZoom() < minimumFogZoom) return
    const tile = tileForPosition(event.lngLat)
    const id = tileId(tile)
    if (artwork && !tileState.has(id) && (!selected(tile) || !isFogTileLand(tile))) return
    const frame = artworkFrames.get(id)
    if (frame && tileState.get(id) === 'generated') {
      focusAtlasTile(map, tile, undefined, frame)
      return
    }
    const choices = artwork?.get(id)
    const paintings = choices && multiTileCells.has(id) &&
      !(isFogPatternSelected(tile) && isTargetableLand(tile))
      ? choices.filter(spansMultipleTiles)
      : choices
    if (paintings?.length) {
      if (tileState.has(id)) return
      const art = paintings[Math.floor(Math.random() * paintings.length)]
      const footprint = drawingFootprint({ ...art, tileSpan: { columns: art.columns ?? 1, rows: art.rows } })
      const cells = footprint.cells.map(tileId)
      if (cells.some(cell => tileState.has(cell))) return
      for (const cell of cells) tileState.set(cell, 'checking')
      fog.invalidate()
      try {
        const image = new Image()
        const plate = art.animation?.plate ?? art.url
        image.src = plate
        await image.decode()
        if (tileState.get(id) !== 'checking') return
        await addGeneratedTile(map, art, plate, art.title, titleCards, undefined,
          0, undefined, { bounds: footprint.bounds, title: art.title, image })
        const frame = { bounds: footprint.bounds, width: image.naturalWidth, height: image.naturalHeight }
        for (const cell of cells) artworkFrames.set(cell, frame)
        const anchor = tileId(art)
        revealedTileIds.add(anchor)
        audio?.playFogLift()
        fog.animateReveal(cells, [`atlas-tile-${art.x}-${art.y}`], 1, () => {
          if (art.animation) {
            animatedPaintings.add(art)
            showAnimations(animatedPaintings)
          }
          focusAtlasTile(map, art, () => titleCards.get(anchor)?.card.classList.remove('is-awaiting-focus'), frame)
          onRevealCountChange(revealedTileIds.size)
        })
      } catch {
        for (const cell of cells) tileState.delete(cell)
        fog.showError(id, 'The artwork could not load. Click the cloud to try again.')
        fog.invalidate()
      }
      return
    }
    if (!artwork && isHkuSite(tile)) {
      const baseId = tileId(hkuBase)
      if (tileState.has(baseId)) return
      for (const cell of hkuCells) tileState.set(cell, 'checking')
      const tower = hkuTowers[Math.floor(Math.random() * hkuTowers.length)]
      const image = new Image()
      image.src = '/hku-skyscrapers-in-place/' + tower.slug + '.webp'
      const layerId = `atlas-tile-${hkuBase.x}-${hkuBase.y}`
      try {
        await image.decode()
        if (tileState.get(baseId) !== 'checking') return
        await addGeneratedTile(map, hkuBase, image.src, tower.slug, titleCards, undefined,
          0, undefined, { bounds: hkuDrawing.bounds, title: tower.title, image })
        revealedTileIds.add(baseId)
        const frame = { bounds: hkuDrawing.bounds, width: image.naturalWidth, height: image.naturalHeight }
        for (const cell of hkuCells) artworkFrames.set(cell, frame)
        focusAtlasTile(map, hkuBase, undefined, frame)
        fog.animateReveal(hkuCells, [layerId], generatedTileOpacity, () => {
          titleCards.get(baseId)?.card.classList.remove('is-awaiting-focus')
          onRevealCountChange(revealedTileIds.size)
        })
      } catch {
        for (const cell of hkuCells) tileState.delete(cell)
        const message = 'The HKU tower could not load. Click either tile to try again.'
        fog.showError(id, message)
        fogErrorAnnouncer.announce(message)
      }
      return
    }
    if (tileState.get(id) === 'generated') {
      focusRevealedTile(tile)
      return
    }
    const revealBudget = import.meta.env.DEV && artwork ? 16 * 60_000 : clickRevealBudgetMs
    const budget = AbortSignal.timeout(revealBudget - generatedRevealDuration - revealedTileFocusDuration - 500)
    if (!isFullyVisible(map, tile)) {
      if (tileState.has(id)) return
      tileState.set(id, 'focusing')
      try {
        await withinClickBudget(focusTileForCapture(tile), budget)
      } catch {
        return
      } finally {
        tileState.delete(id)
      }
    }
    if (
      !isFogTileLand(tile) ||
      !selected(tile) ||
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
      const cacheStatus = await withinClickBudget(checkCachedTile(tile), budget)
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
          budget,
        )
        revealGeneratedTile(id, cacheStatus.scene)
        console.info(
          `[atlas] ${id} loaded from cache in ${Math.round(performance.now() - startedAt)}ms`,
        )
        return
      }

      // Cache checks may run together, but only three cache misses may reach
      // the paid image request at once. This is deliberately checked directly
      // before marking the tile as generating so rapid clicks cannot start a
      // fourth request while the first three are still in flight.
      if (activeGenerationCount() >= concurrentGenerationLimit) {
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
      const capturedTile = await withinClickBudget(captureTile(map, tile, import.meta.env.DEV && artwork ? 1024 : atlasTileSize), budget)
      const capturedAt = performance.now()
      const hasSea = tileHasSea(map, tile)
      const scene = pickAtlasScene(hasSea, cacheStatus.scenes)
      audio?.preloadScene(scene)
      let response: Response
      let responseText: string
      try {
        response = await fetch(
          `/api/atlas-tiles/${atlasZoom}/${tile.x}/${tile.y}/${scene}${discoveryQuery}`,
          {
            method: 'POST',
            signal: budget,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...capturedTile, hasSea }),
          },
        )
        if (response.status === 202) {
          const { statusUrl } = await response.json()
          if (typeof statusUrl !== 'string' || !/^\/api\/discovery-jobs\/[a-f0-9-]{36}$/.test(statusUrl))
            throw new Error('The generator returned an invalid job location.')
          do {
            await new Promise(resolve => window.setTimeout(resolve, 1500))
            response = await fetch(statusUrl, { signal: budget, cache: 'no-store' })
            map.getContainer().dispatchEvent(new Event('atlas-generation-progress'))
          } while (response.status === 202)
        }
        responseText = await response.text()
      } catch (error) {
        budget.throwIfAborted()
        const recovered = await withinClickBudget(recoverGeneratedTile(tile, budget), budget)
        if (recovered?.cached) {
          audio?.preloadScene(recovered.scene)
          await addGeneratedTile(
            map,
            tile,
            recovered.url,
            recovered.scene,
            titleCards,
            recovered.contentBounds,
            0,
            budget,
          )
          revealGeneratedTile(id, recovered.scene)
          console.info(
            `[atlas] ${id} recovered from cache after an interrupted render response in ` +
              `${Math.round(performance.now() - startedAt)}ms`,
          )
          return
        }
        if (error instanceof TypeError) {
          throw new Error(
            'The connection to the rendering service closed before this tile was ready. Please try this patch of fog again.',
          )
        }
        throw error
      }
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
          clearanceNotice.show(
            response.headers.get('x-atlas-limit-reason') === 'concurrent-generations'
              ? (body?.error ??
                  'Three tile clearings are already in progress.\nWait for one to finish before clearing more fog.')
              : 'This clearing is temporarily unavailable.\nPlease wait a moment, then try another patch of fog.',
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
      if (!belongsToVisit(body.url) || rejectedUrls.has(body.url))
        throw new Error('The rendering service returned artwork outside this discovery visit.')
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
        0,
        budget,
      )
      cachedTileIds.add(id)
      indexedCachedTiles.set(id, { scene: generatedScene, url: body.url, contentBounds: body.contentBounds })
      cachedTileRequests.delete(id)
      preloadedTileRequests.delete(id)
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
          budget.aborted ? 'This clearing took too long. Click the fog to try again.' :
          error instanceof Error ? error.message : 'Could not generate this atlas tile.'
        fog.showError(id, message)
        fogErrorAnnouncer.announce(message)
      }
    }
  })

  const resetReveals = () => {
    animatedPaintings.clear()
    showAnimations(animatedPaintings)
    if (tileState.has(tileId(hkuBase))) {
      for (const cell of hkuCells) { fog.cancelReveal(cell); tileState.set(cell, 'resetting') }
    }
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
        artworkFrames.clear()
        revealedTileIds.clear()
        onRevealCountChange(0)
        tileState.clear()
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
