import { atlasSeaScenes, atlasSceneNames } from './atlas-scenes.ts'
import { loadingConcepts } from './loading-concepts.ts'

const atlasZoom = 18
const minimumFogZoom = 15
const landTargetThreshold = 0.75
const landSampleSize = 10

const tileId = ({ x, y }) => `${atlasZoom}/${x}/${y}`
const tileFromId = id => {
  const [, x, y] = id.split('/').map(Number)
  return { x, y }
}

const tileLongitude = x => (x / 2 ** atlasZoom) * 360 - 180

const tileLatitude = y => {
  const radians = Math.PI - (2 * Math.PI * y) / 2 ** atlasZoom
  return (180 / Math.PI) * Math.atan(Math.sinh(radians))
}

const tileBounds = tile => ({
  west: tileLongitude(tile.x),
  north: tileLatitude(tile.y),
  east: tileLongitude(tile.x + 1),
  south: tileLatitude(tile.y + 1),
})

const tileForPosition = ({ lng, lat }) => {
  const count = 2 ** atlasZoom
  const x = Math.floor(((lng + 180) / 360) * count)
  const latitudeRadians = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count,
  )
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

const intersectsViewport = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const canvas = map.getCanvas()
  return (
    southEast.x >= 0 &&
    southEast.y >= 0 &&
    northWest.x <= canvas.clientWidth &&
    northWest.y <= canvas.clientHeight
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

const captureTile = async (map, tile) => {
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
    return tileCanvas.toDataURL('image/png')
  } finally {
    hiddenLayerIds.forEach(layerId => {
      map.setLayoutProperty(layerId, 'visibility', 'visible')
    })
    map.triggerRepaint()
  }
}

const tileHasSea = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const seaKinds = new Set(['sea', 'ocean', 'bay', 'strait', 'fjord'])
  return map
    .queryRenderedFeatures([northWest, southEast], { layers: ['water'] })
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
      return map.queryRenderedFeatures(point, { layers: ['water'] }).length === 0
    }),
  ).flat()

  return landSamples.filter(Boolean).length / landSamples.length
}

const atlasTileSize = 512
const generationCropMinimum = 192
const generationCropMaximum = 448
const generationCropPadding = 32

const projectedGeometryBounds = (map, geometry) => {
  const points = []
  const visit = coordinates => {
    if (!Array.isArray(coordinates)) return
    if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
      const point = map.project(coordinates)
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) points.push(point)
      return
    }
    coordinates.forEach(visit)
  }
  visit(geometry?.coordinates)
  if (!points.length) return null
  return {
    left: Math.min(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)),
    bottom: Math.max(...points.map(point => point.y)),
  }
}

const generationBoundsForTile = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const screenWidth = southEast.x - northWest.x
  const screenHeight = southEast.y - northWest.y
  const screenToTile = point => ({
    x: ((point.x - northWest.x) / screenWidth) * atlasTileSize,
    y: ((point.y - northWest.y) / screenHeight) * atlasTileSize,
  })

  const candidates = map
    .queryRenderedFeatures([northWest, southEast])
    .filter(feature => {
      if (feature.layer?.type !== 'fill') return false
      const layerName = `${feature.layer?.id ?? ''} ${feature.sourceLayer ?? ''}`.toLowerCase()
      return !/water|road|street|transport|boundary|label|place/.test(layerName)
    })
    .map(feature => projectedGeometryBounds(map, feature.geometry))
    .filter(featureBounds => {
      if (!featureBounds) return false
      const width = featureBounds.right - featureBounds.left
      const height = featureBounds.bottom - featureBounds.top
      return width >= 48 && height >= 48 && width < screenWidth * 0.82 && height < screenHeight * 0.82
    })
    .sort((first, second) =>
      (second.right - second.left) * (second.bottom - second.top) -
      (first.right - first.left) * (first.bottom - first.top),
    )

  const candidate = candidates[0]
  if (!candidate) {
    return {
      x: (atlasTileSize - generationCropMaximum) / 2,
      y: (atlasTileSize - generationCropMaximum) / 2,
      width: generationCropMaximum,
      height: generationCropMaximum,
    }
  }

  const tileBoundsForCandidate = {
    left: screenToTile({ x: candidate.left, y: candidate.top }).x,
    top: screenToTile({ x: candidate.left, y: candidate.top }).y,
    right: screenToTile({ x: candidate.right, y: candidate.bottom }).x,
    bottom: screenToTile({ x: candidate.right, y: candidate.bottom }).y,
  }
  const candidateWidth = tileBoundsForCandidate.right - tileBoundsForCandidate.left
  const candidateHeight = tileBoundsForCandidate.bottom - tileBoundsForCandidate.top
  const side = Math.min(
    generationCropMaximum,
    Math.max(generationCropMinimum, Math.max(candidateWidth, candidateHeight) + generationCropPadding * 2),
  )
  const centerX = (tileBoundsForCandidate.left + tileBoundsForCandidate.right) / 2
  const centerY = (tileBoundsForCandidate.top + tileBoundsForCandidate.bottom) / 2

  return {
    x: Math.max(0, Math.min(atlasTileSize - side, Math.round(centerX - side / 2))),
    y: Math.max(0, Math.min(atlasTileSize - side, Math.round(centerY - side / 2))),
    width: Math.round(side),
    height: Math.round(side),
  }
}

const fadeTileEdges = async url => {
  const image = new Image()
  image.src = url
  await image.decode()

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

const addGeneratedTile = async (map, tile, url) => {
  const id = `atlas-tile-${tile.x}-${tile.y}`
  if (map.getLayer(id)) return
  const bounds = tileBounds(tile)
  const fadedUrl = await fadeTileEdges(url)
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
  map.addLayer({
    id,
    type: 'raster',
    source: id,
    paint: {
      'raster-opacity': 0.94,
      // These are already decoded, finished atlas tiles. Fading them in makes
      // a newly added tile feel like it is drifting behind the map while it
      // catches up with a pan.
      'raster-fade-duration': 0,
    },
  })
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
    float mask = texture2D(u_mask, v_uv).a;
    if (mask < 0.01) discard;

    // Keep the tile coverage static, but move several veils through it quickly
    // enough to be apparent during a normal glance at the map.
    vec2 driftA = vec2(u_time * 0.060, -u_time * 0.036);
    vec2 driftB = vec2(-u_time * 0.042, u_time * 0.054);
    float layerA = smoothstep(0.22, 0.76, cloudNoise(v_uv * vec2(4.2, 2.7) + driftA));
    float layerB = smoothstep(0.26, 0.78, cloudNoise(v_uv * vec2(5.4, 3.4) + driftB));
    float movingVeil = smoothstep(
      0.28,
      0.72,
      cloudNoise(v_uv * vec2(8.0, 5.0) + driftA * 1.8)
    );
    float edgeFade = smoothstep(0.02, 0.78, mask);
    float softMask = mask * edgeFade;
    float grain = hash(floor(gl_FragCoord.xy / 3.0) + floor(driftA * 8.0));
    float densityA = softMask * (0.72 + layerA * 0.24);
    float densityB = softMask * (0.10 + layerB * 0.16);
    float density = 1.0 - (1.0 - densityA) * (1.0 - densityB);
    density *= 0.88 + movingVeil * 0.16;
    vec3 pale = vec3(0.91, 0.92, 0.92);
    vec3 deep = vec3(0.67, 0.70, 0.71);
    vec3 fogColor = mix(deep, pale, 0.28 + layerA * 0.30 + layerB * 0.22 + (grain - 0.5) * 0.08);
    gl_FragColor = vec4(fogColor, density * 0.98);
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

const createFogMaskPath = (context, x, y, size, seed) => {
  // Keep the body close to its target tile. A narrow spill and the blur provide
  // a soft edge without washing out most of the neighboring tiles.
  const spill = size * 0.06
  const left = x - spill
  const top = y - spill * (0.72 + seeded(seed + 1) * 0.42)
  const width = size + spill * (1.8 + seeded(seed + 2) * 0.35)
  const height = size + spill * (1.8 + seeded(seed + 3) * 0.35)
  const points = 12

  context.beginPath()
  for (let index = 0; index < points; index += 1) {
    const angle = (Math.PI * 2 * index) / points
    const radius = 0.92 + seeded(seed + index * 2.41) * 0.16
    const pointX = left + width * (0.5 + Math.cos(angle) * 0.5 * radius)
    const pointY = top + height * (0.5 + Math.sin(angle) * 0.5 * radius)
    if (index === 0) context.moveTo(pointX, pointY)
    else context.lineTo(pointX, pointY)
  }
  context.closePath()
}

const createFogCanvas = (map, tileState, isLandTargetable) => {
  const canvas = document.createElement('canvas')
  canvas.className = 'atlas-fog'
  canvas.setAttribute('aria-hidden', 'true')
  map.getContainer().append(canvas)

  const loadingCanvas = document.createElement('canvas')
  loadingCanvas.className = 'atlas-fog-loading'
  loadingCanvas.setAttribute('aria-hidden', 'true')
  map.getContainer().append(loadingCanvas)
  const loadingContext = loadingCanvas.getContext('2d')
  const maskCanvas = document.createElement('canvas')
  const maskContext = maskCanvas.getContext('2d')
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    stencil: false,
  })
  const program = gl && createFogProgram(gl)
  const maskTexture = gl?.createTexture()
  const positionBuffer = gl?.createBuffer()
  const positionAttribute = program && gl?.getAttribLocation(program, 'a_position')
  const maskUniform = program && gl?.getUniformLocation(program, 'u_mask')
  const timeUniform = program && gl?.getUniformLocation(program, 'u_time')
  let clientWidth = 0
  let clientHeight = 0
  let maskScale = 0.5
  let maskDirty = true
  let animationFrame: number | undefined
  let maskFrame: number | undefined
  let lastFogFrame = -Infinity
  let lastMaskFrame = -Infinity
  const fogFrameInterval = 1000 / 60
  const maskFrameInterval = 1000 / 60

  if (gl && positionBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
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

    const renderWidth = Math.ceil(clientWidth * renderScale)
    const renderHeight = Math.ceil(clientHeight * renderScale)
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth
      canvas.height = renderHeight
      loadingCanvas.width = renderWidth
      loadingCanvas.height = renderHeight
      if (gl) gl.viewport(0, 0, renderWidth, renderHeight)
    }
    canvas.style.width = `${clientWidth}px`
    canvas.style.height = `${clientHeight}px`
    loadingCanvas.style.width = `${clientWidth}px`
    loadingCanvas.style.height = `${clientHeight}px`

    if (changed || !maskCanvas.width || !maskCanvas.height) {
      maskScale = Math.min(0.5, 768 / Math.max(clientWidth, clientHeight))
      maskCanvas.width = Math.max(1, Math.ceil(clientWidth * maskScale))
      maskCanvas.height = Math.max(1, Math.ceil(clientHeight * maskScale))
      maskContext.setTransform(maskScale, 0, 0, maskScale, 0, 0)
      maskDirty = true
    }
  }

  const uploadMask = () => {
    if (!gl || !maskTexture) return
    gl.bindTexture(gl.TEXTURE_2D, maskTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  const drawFogMask = (tile, state, time) => {
    const bounds = tileBounds(tile)
    const northWest = map.project([bounds.west, bounds.north])
    const southEast = map.project([bounds.east, bounds.south])
    const size = southEast.x - northWest.x
    const seed = tile.x * 0.47 + tile.y * 0.91
    const x = northWest.x
    const y = northWest.y

    maskContext.save()
    if (state === 'checking') {
      const pulse = (Math.sin(time / 180 + seed) + 1) / 2
      maskContext.globalAlpha = 0.42 + pulse * 0.48
    } else {
      maskContext.globalAlpha = state === 'generating' ? 1 : 0.96
    }
    maskContext.filter = `blur(${Math.max(5, size * 0.07)}px)`
    maskContext.fillStyle = '#ffffff'
    createFogMaskPath(maskContext, x, y, size, seed)
    maskContext.fill()
    maskContext.restore()

    // A restrained second cloud breaks up the repeated tile cadence without
    // becoming a second, oversized fog tile between the target tiles.
    maskContext.save()
    maskContext.globalAlpha = 0.08
    maskContext.filter = `blur(${Math.max(7, size * 0.12)}px)`
    maskContext.fillStyle = '#ffffff'
    createFogMaskPath(
      maskContext,
      x + (seeded(seed + 7) - 0.5) * size * 0.35,
      y + (seeded(seed + 8) - 0.5) * size * 0.35,
      size * (0.94 + seeded(seed + 9) * 0.08),
      seed + 19,
    )
    maskContext.fill()
    maskContext.restore()
  }

  const wrapText = (context, text, maxWidth) => {
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
    return lines
  }

  const drawLoadingText = time => {
    if (!loadingContext) return
    const ratio = canvas.width / Math.max(1, clientWidth)
    loadingContext.setTransform(ratio, 0, 0, ratio, 0, 0)
    loadingContext.clearRect(0, 0, clientWidth, clientHeight)
    tileState.forEach((state, id) => {
      if (state !== 'generating') return
      const tile = tileFromId(id)
      const concept =
        loadingConcepts[
          Math.floor(seeded(tile.x * 0.47 + tile.y * 0.91) * loadingConcepts.length)
        ]
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      const size = southEast.x - northWest.x
      const cardWidth = size * 0.84
      const cardHeight = size * 0.84
      const left = northWest.x + (size - cardWidth) / 2
      const top = northWest.y + (size - cardHeight) / 2
      const padding = Math.max(8, size * 0.075)
      const pulse = 0.9 + Math.sin(time / 1100 + tile.x * 0.3) * 0.06
      const titleSize = Math.max(9, Math.min(17, size * 0.075))
      const questionSize = Math.max(8, Math.min(14, size * 0.057))
      const quoteSize = Math.max(7, Math.min(12, size * 0.047))
      const innerWidth = cardWidth - padding * 2

      loadingContext.save()
      loadingContext.globalAlpha = pulse
      loadingContext.strokeStyle = `rgba(168, 111, 91, ${0.62 + pulse * 0.18})`
      loadingContext.lineWidth = Math.max(2, size * 0.018)
      loadingContext.setLineDash([Math.max(5, size * 0.035), Math.max(3, size * 0.018)])
      loadingContext.strokeRect(
        left - padding * 0.42,
        top - padding * 0.42,
        cardWidth + padding * 0.84,
        cardHeight + padding * 0.84,
      )
      loadingContext.setLineDash([])
      loadingContext.shadowColor = 'rgba(52, 34, 22, 0.35)'
      loadingContext.shadowBlur = Math.max(5, size * 0.05)
      loadingContext.fillStyle = 'rgba(248, 237, 207, 0.94)'
      loadingContext.fillRect(left, top, cardWidth, cardHeight)
      loadingContext.shadowBlur = 0
      loadingContext.strokeStyle = 'rgba(125, 92, 67, 0.78)'
      loadingContext.lineWidth = Math.max(1, size * 0.008)
      loadingContext.strokeRect(left, top, cardWidth, cardHeight)

      loadingContext.fillStyle = '#a86f5b'
      loadingContext.font = `700 ${Math.max(7, size * 0.035)}px Arial, sans-serif`
      loadingContext.fillText(
        `${size < 150 ? 'LOOKUP ACTIVE' : 'LOOKING UP THIS TILE'} · ${String(loadingConcepts.indexOf(concept) + 1).padStart(2, '0')}/24`,
        left + padding,
        top + padding + Math.max(7, size * 0.035),
      )

      let cursorY = top + padding + Math.max(7, size * 0.035) + titleSize * 1.5
      loadingContext.fillStyle = '#3b2518'
      loadingContext.font = `700 ${titleSize}px Georgia, serif`
      wrapText(loadingContext, concept.title, innerWidth)
        .slice(0, 2)
        .forEach(line => {
          loadingContext.fillText(line, left + padding, cursorY)
          cursorY += titleSize * 1.05
        })

      cursorY += questionSize * 0.3
      loadingContext.fillStyle = '#6e4d3b'
      loadingContext.font = `italic ${questionSize}px Georgia, serif`
      wrapText(loadingContext, concept.question, innerWidth)
        .slice(0, 3)
        .forEach(line => {
          loadingContext.fillText(line, left + padding, cursorY)
          cursorY += questionSize * 1.12
        })

      cursorY += quoteSize * 0.45
      loadingContext.fillStyle = '#594435'
      loadingContext.font = `italic ${quoteSize}px Georgia, serif`
      wrapText(loadingContext, `“${concept.quote}”`, innerWidth)
        .slice(0, 3)
        .forEach(line => {
          loadingContext.fillText(line, left + padding, cursorY)
          cursorY += quoteSize * 1.08
        })

      loadingContext.fillStyle = '#a86f5b'
      loadingContext.font = `600 ${Math.max(7, quoteSize * 0.82)}px Arial, sans-serif`
      wrapText(loadingContext, `— ${concept.author}, ${concept.work}`, innerWidth)
        .slice(0, 2)
        .forEach(line => {
          loadingContext.fillText(line, left + padding, cursorY + quoteSize * 0.25)
          cursorY += quoteSize * 0.9
        })
      loadingContext.restore()
    })
  }

  const renderMask = time => {
    maskFrame = undefined
    if (time - lastMaskFrame < maskFrameInterval) {
      if (maskDirty) maskFrame = requestAnimationFrame(renderMask)
      return
    }
    lastMaskFrame = time
    if (!clientWidth || !clientHeight) return
    maskContext.setTransform(maskScale, 0, 0, maskScale, 0, 0)
    maskContext.clearRect(0, 0, clientWidth, clientHeight)
    visibleFogTiles(map).forEach(tile => {
      const state = tileState.get(tileId(tile))
      if (!isLandTargetable(tile) || !isFogged(tile) || state === 'generated') return
      drawFogMask(tile, state, time)
    })
    uploadMask()
    maskDirty = false
  }

  const invalidate = () => {
    maskDirty = true
    if (!maskFrame) maskFrame = requestAnimationFrame(renderMask)
  }

  const render = time => {
    resize()
    // Keep the card geometry in lockstep with the map while it is being
    // dragged. Keeping the fog and labels on the same frame cadence prevents
    // either overlay from visibly trailing the raster map or generated artwork.
    drawLoadingText(time)
    if (time - lastFogFrame < fogFrameInterval) {
      animationFrame = requestAnimationFrame(render)
      return
    }
    lastFogFrame = time
    const fogIsChecking = [...tileState.values()].some(state => state === 'checking')
    if ((maskDirty || fogIsChecking) && !maskFrame) renderMask(time)
    if (gl && program && positionBuffer && maskTexture) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.enableVertexAttribArray(positionAttribute)
      gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, maskTexture)
      gl.uniform1i(maskUniform, 0)
      gl.uniform1f(timeUniform, time / 1000)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    animationFrame = requestAnimationFrame(render)
  }

  const mapEvents = ['move', 'resize', 'zoom', 'rotate', 'pitch']
  mapEvents.forEach(eventName => {
    map.on(eventName, invalidate)
  })
  resize()
  invalidate()
  animationFrame = requestAnimationFrame(render)
  return {
    invalidate,
    destroy: () => {
      mapEvents.forEach(eventName => {
        map.off(eventName, invalidate)
      })
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (maskFrame) cancelAnimationFrame(maskFrame)
      canvas.remove()
      loadingCanvas.remove()
    },
  }
}

export const installAtlasTileInteractions = (map, maplibregl) => {
  const tileState = new Map()
  const landTargetState = new Map()
  const isAdminMode = () => map.getContainer().classList.contains('atlas-admin-mode')

  const isLandTargetable = tile => {
    const id = tileId(tile)
    if (!landTargetState.has(id)) {
      landTargetState.set(id, tileLandFraction(map, tile) >= landTargetThreshold)
    }
    return landTargetState.get(id)
  }

  const fog = createFogCanvas(map, tileState, isLandTargetable)

  const checkCachedTile = async tile => {
    const response = await fetch(
      `/api/atlas-tiles/cache-status/${atlasZoom}/${tile.x}/${tile.y}`,
      { cache: 'no-store' },
    )
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        body?.error ?? `The atlas-tile cache lookup failed with HTTP ${response.status}.`,
      )
    }
    if (body?.cached !== true) return null
    if (typeof body.url !== 'string' || !body.url) {
      throw new Error('The atlas-tile cache lookup returned an invalid cached image URL.')
    }
    return body.url
  }

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
      tileState.get(tileId(tile)) !== 'generated'
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
      tileState.get(id) === 'generated'
    )
      return
    tileState.set(id, 'checking')
    fog.invalidate()
    const startedAt = performance.now()
    try {
      const cachedUrl = await checkCachedTile(tile)
      if (cachedUrl) {
        await addGeneratedTile(map, tile, cachedUrl)
        tileState.set(id, 'generated')
        fog.invalidate()
        console.info(`[atlas] ${id} loaded from cache in ${Math.round(performance.now() - startedAt)}ms`)
        return
      }

      tileState.set(id, 'generating')
      fog.invalidate()
      const sourceImage = await captureTile(map, tile)
      const capturedAt = performance.now()
      const generationBounds = generationBoundsForTile(map, tile)
      const hasSea = tileHasSea(map, tile)
      const availableScenes = hasSea
        ? atlasSceneNames
        : atlasSceneNames.filter(scene => !atlasSeaScenes.has(scene))
      const scene = availableScenes[Math.floor(Math.random() * availableScenes.length)]
      const response = await fetch(
        `/api/atlas-tiles/${atlasZoom}/${tile.x}/${tile.y}/${scene}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceImage, hasSea, generationBounds }),
        },
      )
      const responseText = await response.text()
      let body: { error?: string; message?: string; url?: string } | null
      try {
        const parsedBody = responseText ? JSON.parse(responseText) : null
        body = parsedBody && typeof parsedBody === 'object' ? parsedBody : null
      } catch {
        throw new Error(
          `The atlas-tile server returned a non-JSON response (HTTP ${response.status}). Restart with bun run dev.`,
        )
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
      await addGeneratedTile(map, tile, body.url)
      tileState.set(id, 'generated')
      fog.invalidate()
      console.info(
        `[atlas] ${id} ready in ${Math.round(performance.now() - startedAt)}ms ` +
          `(capture ${Math.round(capturedAt - startedAt)}ms, ` +
          `crop ${generationBounds.width}x${generationBounds.height}@${generationBounds.x},${generationBounds.y}, ` +
          `generation ${Math.round(generatedAt - capturedAt)}ms, ` +
          `display ${Math.round(performance.now() - generatedAt)}ms)`,
      )
    } catch (error) {
      tileState.delete(id)
      fog.invalidate()
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(event.lngLat)
        .setText(
          error instanceof Error
            ? error.message
            : 'Could not generate this atlas tile.',
        )
        .addTo(map)
    }
  })
}
