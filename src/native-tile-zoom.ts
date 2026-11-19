import { originalArtwork } from './artwork-sampling.ts'
import type { ImageSource, Map as AtlasMap } from 'maplibre-gl'
import { atlasTileSize, atlasZoom } from './atlas-protocol.ts'

// At the grid zoom a tile spans 512 CSS pixels. At the ceiling each artwork pixel spans one CSS pixel.
export const nativeTileZoom = (imageWidth: number) =>
  atlasZoom + Math.log2(imageWidth / 512)

export const installNativeTileZoom = (map: AtlasMap, minimumZoom: number) => {
  let frame = 0
  const sync = () => {
    frame = 0
    const canvas = map.getCanvas()
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return

    let nearest = Infinity
    let artworkZoom = nativeTileZoom(atlasTileSize)
    for (const id of map.getLayersOrder()) {
      const layer = map.getLayer(id)
      if (layer.type !== 'raster' || layer.visibility === 'none') continue
      const source = map.getSource<ImageSource>(layer.source)
      if (source?.type !== 'image' || !source.image?.width) continue
      const nw = map.project(source.coordinates[0])
      const se = map.project(source.coordinates[2])
      if (se.x <= 0 || se.y <= 0 || nw.x >= width || nw.y >= height) continue
      if (se.x <= nw.x || se.y <= nw.y) continue
      const distance = (nw.x + se.x - width) ** 2 + (nw.y + se.y - height) ** 2
      // Later layers are drawn on top when experiments share a grid cell.
      if (distance <= nearest) {
        nearest = distance
        const image = originalArtwork(source.image)
        const scale = Math.min(image.width / (se.x - nw.x), image.height / (se.y - nw.y))
        artworkZoom = map.getZoom() + Math.log2(scale)
      }
    }

    const limit = Math.max(minimumZoom, artworkZoom)
    if (Math.abs(limit - map.getMaxZoom()) > 1e-6) map.setMaxZoom(limit)
  }
  const schedule = () => { frame ||= requestAnimationFrame(sync) }
  map.getContainer().addEventListener('load', schedule, true)
  map.on('moveend', schedule)
  map.on('resize', schedule)
  map.on('styledata', schedule)
  map.on('sourcedata', event => {
    if (event.source.type === 'image') schedule()
  })

  // A monitor change can alter pixel density without changing the CSS viewport.
  let density = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
  const refreshDensity = () => {
    density = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    density.addEventListener('change', refreshDensity, { once: true })
    map.resize()
    schedule()
  }
  density.addEventListener('change', refreshDensity, { once: true })
  map.once('remove', () => {
    density.removeEventListener('change', refreshDensity)
    map.getContainer().removeEventListener('load', schedule, true)
    cancelAnimationFrame(frame)
  })
  schedule()
}
