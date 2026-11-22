import { Map as AtlasMap } from 'maplibre-gl'
import { hongKongStyle } from './map-style'
import { drawingFootprint } from './tile-geometry'
import type { Painting } from './artwork-review'

// Both references have the same north-up extent. Pad rectangular footprints
// to a square for the renderer, then remove only that padding on publication.
export function revisionReferences(art: Painting) {
  return artworkReferences(art, art.animation?.plate ?? art.imageUrl ?? art.url)
}

export async function artworkReferences(
  art: Pick<Painting, 'x' | 'y' | 'rows' | 'columns'>,
  previousUrl?: string,
) {
  const columns = art.columns ?? 1
  const side = Math.max(columns, art.rows)
  const width = Math.round((1024 * columns) / side)
  const height = Math.round((1024 * art.rows) / side)
  const { bounds } = drawingFootprint({ ...art, tileSpan: { columns, rows: art.rows } })
  const container = document.createElement('div')
  Object.assign(container.style, {
    position: 'fixed',
    left: '-4000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
  })
  document.body.append(container)
  const map = new AtlasMap({
    container,
    style: {
      ...hongKongStyle,
      layers: hongKongStyle.layers.filter(layer => layer.type !== 'symbol'),
    },
    bounds: [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  })
  function png(image: CanvasImageSource) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1024
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff00ff'
    ctx.fillRect(0, 0, 1024, 1024)
    ctx.drawImage(
      image,
      Math.floor((1024 - width) / 2),
      Math.floor((1024 - height) / 2),
      width,
      height,
    )
    return canvas.toDataURL('image/png')
  }
  let timer: number
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      timer = window.setTimeout(
        () => reject(Error('Basemap capture timed out.')),
        60000,
      )
      map.on('error', e => reject(e.error))
      map.once('idle', () =>
        map.areTilesLoaded()
          ? resolve()
          : reject(Error('Basemap tiles are incomplete.')),
      )
    })
    const previous = new Image()
    if (previousUrl) previous.src = previousUrl
    await Promise.all([previousUrl && previous.decode(), loaded])
    return {
      mapImage: png(map.getCanvas()),
      ...(previousUrl && { previousImage: png(previous) }),
    }
  } finally {
    clearTimeout(timer)
    map.remove()
    container.remove()
  }
}
