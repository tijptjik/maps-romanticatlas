import { addProtocol, type RequestTransformFunction } from 'maplibre-gl'
import { artworkPresentation } from './artwork-presentation'

const protocol = 'atlas-edge-fade://'

export const artworkRequest: RequestTransformFunction = (url, type) => {
  if (type !== 'Image') return { url }
  const asset = new URL(url, document.baseURI)
  if (asset.origin !== location.origin) return { url }
  return {
    url: artworkPresentation(asset)?.edgeFade
      ? protocol + asset.pathname + asset.search + asset.hash
      : url,
  }
}

export function installArtworkEdgeFade() {
  addProtocol('atlas-edge-fade', async ({ url }, { signal }) => {
    const response = await fetch(url.slice(protocol.length), { signal })
    if (!response.ok) throw Error(`Artwork returned HTTP ${response.status}`)
    const image = await createImageBitmap(await response.blob())
    try {
      signal.throwIfAborted()
      const { width, height } = image
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const settings = artworkPresentation(
        new URL(url.slice(protocol.length), location.origin),
      )
      if (settings?.backgroundMask) {
        context.save()
        context.globalCompositeOperation = 'destination-out'
        context.beginPath()
        for (const [index, [x, y]] of settings.backgroundMask.entries()) {
          if (index === 0) context.moveTo(x * width, y * height)
          else context.lineTo(x * width, y * height)
        }
        context.closePath()
        context.fill()
        context.restore()
      }
      const pixels = context.getImageData(0, 0, width, height)
      const margin = Math.min(width, height) * 0.1
      for (let y = 0; y < height; y++) {
        const vertical = Math.min(y, height - 1 - y)
        for (let x = 0; x < width; x++) {
          const distance = Math.min(x, width - 1 - x, vertical)
          const t = Math.min(1, distance / margin)
          const alpha = (y * width + x) * 4 + 3
          pixels.data[alpha] *= t * t * (3 - 2 * t)
          if (settings?.waterFadeStart !== undefined) {
            const water = Math.max(
              0,
              Math.min(1, (1 - y / (height - 1)) / (1 - settings.waterFadeStart)),
            )
            pixels.data[alpha] *= water * water * (3 - 2 * water)
          }
        }
      }
      context.putImageData(pixels, 0, 0)
      return { data: canvas.transferToImageBitmap() }
    } finally {
      image.close()
    }
  })
}
