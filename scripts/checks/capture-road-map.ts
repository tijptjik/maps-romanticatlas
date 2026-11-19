import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { hongKongStyle } from '../../src/map-style.ts'
import { captureTile, tileHasSea } from '../../src/atlas-tiles.ts'
import { tileBounds } from '../../src/tile-geometry.ts'

export const captureRoadMap = async tile => {
  const container = document.createElement('div')
  Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '99999' })
  document.body.append(container)
  maplibregl.setWorkerUrl(workerUrl)
  const bounds = tileBounds(tile)
  const map = new maplibregl.Map({
    container,
    style: hongKongStyle,
    zoom: 18,
    pixelRatio: 2,
    center: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Map capture load timed out')),
        90000,
      )
      map.once('idle', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    if (!map.areTilesLoaded()) throw new Error('Source map tiles are incomplete')
    const baseline = await captureTile(map, tile, 512)
    const highResolution = await captureTile(map, tile, 1024, true)
    return { tile, hasSea: tileHasSea(map, tile), baseline, highResolution }
  } finally {
    map.remove()
    container.remove()
  }
}
