import poetNotebookUrl from './assets/loading/01-poet-notebook.png'
import poetLetterUrl from './assets/loading/02-poet-letter.png'
import astrolabeUrl from './assets/loading/03-astrolabe.png'
import ravenCageUrl from './assets/loading/04-raven-cage.png'
import teacupRoseUrl from './assets/loading/05-teacup-rose.png'
import violinUrl from './assets/loading/06-violin.png'
import poetLanternUrl from './assets/loading/07-poet-lantern.png'
import mirrorUrl from './assets/loading/08-mirror.png'
import mapCompassUrl from './assets/loading/09-map-compass.png'
import poetBustUrl from './assets/loading/10-poet-bust.png'

const atlasZoom = 18

const loadingImageUrls = [
  poetNotebookUrl,
  poetLetterUrl,
  astrolabeUrl,
  ravenCageUrl,
  teacupRoseUrl,
  violinUrl,
  poetLanternUrl,
  mirrorUrl,
  mapCompassUrl,
  poetBustUrl,
]

const loadingImages = loadingImageUrls.map(url => {
  const image = new Image()
  image.src = url
  return image
})

const tileId = ({ x, y }) => `${atlasZoom}/${x}/${y}`

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
  const y = Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count)
  return { x, y }
}

const isFullyVisible = (map, tile) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const canvas = map.getCanvas()
  return northWest.x >= 0 && northWest.y >= 0 && southEast.x <= canvas.clientWidth && southEast.y <= canvas.clientHeight
}

const visibleTiles = map => {
  if (map.getZoom() < 17.95) return []
  const bounds = map.getBounds()
  const northWest = tileForPosition({ lng: bounds.getWest(), lat: bounds.getNorth() })
  const southEast = tileForPosition({ lng: bounds.getEast(), lat: bounds.getSouth() })
  const tiles = []
  for (let y = northWest.y; y <= southEast.y; y += 1) {
    for (let x = northWest.x; x <= southEast.x; x += 1) {
      const tile = { x, y }
      if (isFullyVisible(map, tile)) tiles.push(tile)
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

const captureTile = async (map, tile) => {
  await waitForRender(map)
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const mapCanvas = map.getCanvas()
  const scale = mapCanvas.width / mapCanvas.clientWidth
  const tileCanvas = document.createElement('canvas')
  tileCanvas.width = 512
  tileCanvas.height = 512
  tileCanvas.getContext('2d').drawImage(mapCanvas, northWest.x * scale, northWest.y * scale, (southEast.x - northWest.x) * scale, (southEast.y - northWest.y) * scale, 0, 0, 512, 512)
  return tileCanvas.toDataURL('image/jpeg', 0.92)
}

const addGeneratedTile = (map, tile, url) => {
  const id = `atlas-tile-${tile.x}-${tile.y}`
  if (map.getLayer(id)) return
  const bounds = tileBounds(tile)
  map.addSource(id, { type: 'image', url, coordinates: [[bounds.west, bounds.north], [bounds.east, bounds.north], [bounds.east, bounds.south], [bounds.west, bounds.south]] })
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.94 } })
}

const createFogCanvas = (map, tileState) => {
  const canvas = document.createElement('canvas')
  canvas.className = 'atlas-fog'
  canvas.setAttribute('aria-hidden', 'true')
  map.getContainer().append(canvas)
  const context = canvas.getContext('2d')
  let animationFrame

  const resize = () => {
    const { clientWidth, clientHeight } = map.getCanvas()
    const ratio = window.devicePixelRatio || 1
    if (canvas.width === clientWidth * ratio && canvas.height === clientHeight * ratio) return
    canvas.width = clientWidth * ratio
    canvas.height = clientHeight * ratio
    canvas.style.width = `${clientWidth}px`
    canvas.style.height = `${clientHeight}px`
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  const drawFog = (x, y, size, time, generating, seed) => {
    context.save()
    context.beginPath()
    const edge = size * 0.24
    const top = y - edge + seeded(seed) * edge
    const right = x + size + edge - seeded(seed + 1) * edge
    const bottom = y + size + edge - seeded(seed + 2) * edge
    const left = x - edge + seeded(seed + 3) * edge
    // A wandering contour avoids treating a tile as a visible square card.
    context.moveTo(x + size * 0.04, top)
    context.bezierCurveTo(x + size * 0.28, top - edge * 0.45, x + size * 0.6, y - edge * 0.12, x + size * 0.91, y - edge * 0.04)
    context.bezierCurveTo(right + edge * 0.25, y + size * 0.2, right - edge * 0.4, y + size * 0.55, right, y + size * 0.84)
    context.bezierCurveTo(x + size * 0.77, bottom + edge * 0.3, x + size * 0.37, bottom - edge * 0.18, x + size * 0.08, bottom)
    context.bezierCurveTo(left - edge * 0.22, y + size * 0.71, left + edge * 0.38, y + size * 0.34, left, y + size * 0.08)
    context.bezierCurveTo(x + size * 0.03, y - edge * 0.15, x + size * 0.01, top + edge * 0.15, x + size * 0.04, top)
    context.closePath()
    const drift = (time / 1500) % size
    const gradient = context.createLinearGradient(x, y - size + drift, x, y + size + drift)
    gradient.addColorStop(0, 'rgba(207, 211, 216, 0.93)')
    gradient.addColorStop(0.48, generating ? 'rgba(135, 143, 150, 0.96)' : 'rgba(150, 157, 164, 0.95)')
    gradient.addColorStop(1, 'rgba(77, 84, 92, 0.87)')
    // Paint the body through a blur first; this feathers the boundary into the
    // surrounding map rather than leaving an exact clipped contour.
    context.save()
    context.filter = `blur(${Math.max(6, size * 0.065)}px)`
    context.fillStyle = gradient
    context.fill()
    context.restore()
    context.clip()
    // A field of small, irregular ink wisps rather than one translucent overlay.
    // Their shared downward drift makes the tile feel like an illustrated mist curtain.
    for (let index = 0; index < 250; index += 1) {
      const random = seeded(seed + index * 3.71)
      const width = size * (0.025 + seeded(seed + index * 7.17) * 0.075)
      const lineY = y + ((seeded(seed + index * 5.23) * size + time / (42 + random * 32)) % (size + width)) - width * 0.5
      const lineX = x + seeded(seed + index * 11.31) * size
      const bend = (seeded(seed + index * 17.89) - 0.5) * width * 2.5
      context.strokeStyle = index % 4 === 0 ? 'rgba(47, 52, 58, 0.36)' : 'rgba(239, 243, 245, 0.46)'
      context.lineWidth = 0.55 + seeded(seed + index * 19.41) * 1.2
      context.beginPath()
      context.moveTo(lineX - width, lineY)
      context.bezierCurveTo(lineX - width * 0.36, lineY - bend, lineX + width * 0.32, lineY + bend, lineX + width, lineY + bend * 0.12)
      context.stroke()
    }
    if (generating) drawLoadingImage(x, y, size, time, seed)
    context.restore()
  }

  const drawLoadingImage = (x, y, size, time, seed) => {
    const image = loadingImages[Math.floor(seeded(seed) * loadingImages.length)]
    if (!image?.complete || !image.naturalWidth) return
    const bob = Math.sin(time / 1300 + seed) * size * 0.018
    const imageHeight = size * 0.82
    const imageWidth = imageHeight * (image.naturalWidth / image.naturalHeight)
    context.save()
    context.globalAlpha = 0.84
    context.shadowColor = 'rgba(239, 222, 181, 0.52)'
    context.shadowBlur = Math.max(5, size * 0.06)
    context.drawImage(image, x + (size - imageWidth) / 2, y + (size - imageHeight) / 2 + bob, imageWidth, imageHeight)
    context.restore()
  }

  const render = time => {
    resize()
    const { clientWidth, clientHeight } = map.getCanvas()
    context.clearRect(0, 0, clientWidth, clientHeight)
    visibleTiles(map).forEach(tile => {
      const state = tileState.get(tileId(tile))
      if (!isFogged(tile) || state === 'generated') return
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      drawFog(northWest.x, northWest.y, southEast.x - northWest.x, time, state === 'generating', tile.x * 0.47 + tile.y * 0.91)
    })
    animationFrame = requestAnimationFrame(render)
  }
  animationFrame = requestAnimationFrame(render)
  return () => cancelAnimationFrame(animationFrame)
}

export const installAtlasTileInteractions = (map, maplibregl) => {
  const tileState = new Map()
  createFogCanvas(map, tileState)

  map.on('mousemove', event => {
    const tile = tileForPosition(event.lngLat)
    map.getCanvas().style.cursor = map.getZoom() >= 17.95 && isFogged(tile) && tileState.get(tileId(tile)) !== 'generated' ? 'pointer' : ''
  })

  map.on('click', async event => {
    if (map.getZoom() < 17.95) return
    const tile = tileForPosition(event.lngLat)
    const id = tileId(tile)
    if (!isFogged(tile) || !isFullyVisible(map, tile) || tileState.get(id) === 'generating' || tileState.get(id) === 'generated') return
    tileState.set(id, 'generating')
    try {
      const sourceImage = await captureTile(map, tile)
      const response = await fetch(`/api/atlas-tiles/${atlasZoom}/${tile.x}/${tile.y}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceImage }) })
      const responseText = await response.text()
      let body
      try { body = responseText ? JSON.parse(responseText) : null } catch { throw new Error('The map is not connected to the local atlas-tile server. Restart with bun run dev.') }
      if (!response.ok) throw new Error(body?.error ?? 'The local atlas-tile server did not return a valid response.')
      if (!body?.url) throw new Error('The local atlas-tile server returned no generated tile URL.')
      addGeneratedTile(map, tile, body.url)
      tileState.set(id, 'generated')
    } catch (error) {
      tileState.delete(id)
      new maplibregl.Popup({ closeButton: false }).setLngLat(event.lngLat).setText(error instanceof Error ? error.message : 'Could not generate this atlas tile.').addTo(map)
    }
  })
}
