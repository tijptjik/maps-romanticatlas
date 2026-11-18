import type { ImageSource, Map as AtlasMap } from 'maplibre-gl'

type ArtworkImage = NonNullable<ImageSource['image']>
const originals = new WeakMap<ArtworkImage, ArtworkImage>()

export const originalArtwork = (image: ArtworkImage) => originals.get(image) ?? image

// MapLibre image sources use a single texture level. Supply a prefiltered
// level when several artwork pixels fit inside one physical screen pixel.
export const installArtworkSampling = (map: AtlasMap) => {
  // MapLibre 6 switches rasters to a pixel-snapped projection at rest.
  // Atlas images share surveyed corners with unsnapped vector buildings.
  map.once('load', () => {
    const transform = map._camera.transform
    const projectTile = transform.getProjectionData.bind(transform)
    transform.getProjectionData = params =>
      projectTile(params.aligned ? { ...params, aligned: false } : params)
  })

  const pyramids = new WeakMap<ArtworkImage, ImageData[]>()
  let frame = 0

  const sync = () => {
    frame = 0
    const canvas = map.getCanvas()
    if (!canvas.clientWidth) return
    const density = canvas.width / canvas.clientWidth
    for (const id of map.getLayersOrder()) {
      const layer = map.getLayer(id)
      if (layer.type !== 'raster' || layer.visibility === 'none') continue
      const source = map.getSource<ImageSource>(layer.source)
      if (source?.type !== 'image' || !source.loaded() || !source.image?.width) continue
      const [nw, ne, , sw] = source.coordinates.map(point => map.project(point))
      const original = originalArtwork(source.image)
      const width = Math.hypot(ne.x - nw.x, ne.y - nw.y) * density
      const height = Math.hypot(sw.x - nw.x, sw.y - nw.y) * density
      if (!width || !height) continue

      let image = original
      let levels = pyramids.get(original)
      for (let index = 0; image.width >= 2 * width && image.height >= 2 * height &&
        (image.width > 1 || image.height > 1); index++) {
        if (!levels) pyramids.set(original, levels = [])
        if (!levels[index]) {
          const next = document.createElement('canvas')
          next.width = Math.max(1, Math.ceil(image.width / 2))
          next.height = Math.max(1, Math.ceil(image.height / 2))
          const context = next.getContext('2d', { willReadFrequently: true })
          if (!context) break
          let input: CanvasImageSource
          if (image instanceof ImageData) {
            const full = document.createElement('canvas')
            full.width = image.width
            full.height = image.height
            const fullContext = full.getContext('2d', { willReadFrequently: true })
            if (!fullContext) break
            fullContext.putImageData(image, 0, 0)
            input = full
          } else {
            input = image
          }
          context.drawImage(input, 0, 0, next.width, next.height)
          // Send explicit sRGB RGBA bytes through MapLibre's raw texture path.
          // Accelerated canvas textures can swap red and blue on upload.
          const pixels = context.getImageData(0, 0, next.width, next.height)
          levels[index] = pixels
          originals.set(pixels, original)
        }
        image = levels[index]
      }
      if (image !== source.image) source.updateImage({ image })
    }
  }

  const schedule = () => { frame ||= requestAnimationFrame(sync) }
  map.on('zoom', schedule)
  map.on('resize', schedule)
  map.on('styledata', schedule)
  map.on('sourcedata', event => {
    if (event.source.type === 'image') schedule()
  })
  map.once('remove', () => cancelAnimationFrame(frame))
  schedule()
}
