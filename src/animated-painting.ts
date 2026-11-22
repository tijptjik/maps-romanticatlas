import type { ImageSource, Map as AtlasMap } from 'maplibre-gl'
import { originalArtwork } from './artwork-sampling'
import type { Painting } from './artwork-review'
import { drawingFootprint } from './tile-geometry'

// Feed the frames into the painting's existing raster layer so fog, labels,
// opacity, tile registration and click handling all keep working.
export function installAnimatedPainting(
  map: AtlasMap,
  art: Painting,
  url: string,
  getSource: () => ImageSource | undefined,
) {
  if (!('ImageDecoder' in window)) return () => {}
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const { west, south, east, north } = drawingFootprint({
    ...art,
    tileSpan: { columns: art.columns ?? 1, rows: art.rows },
  }).bounds
  const still = new URL(
    art.animation?.plate ?? art.imageUrl ?? art.url,
    document.baseURI,
  ).href
  const matchesPoster = (source?: ImageSource) =>
    source?.url && new URL(source.url, document.baseURI).href === still
  let selected = false
  let failed = false
  let active: AbortController | undefined
  let playing: ImageSource | undefined

  async function play(source: ImageSource, signal: AbortSignal) {
    const poster = originalArtwork(source.image)
    let decoder: ImageDecoder | undefined
    let frame: ImageBitmap | undefined
    let timer: number
    const stop = () => {
      clearTimeout(timer)
      decoder?.close()
      if (frame && getSource() === source && matchesPoster(source))
        source.updateImage({ image: poster })
      frame?.close()
    }
    signal.addEventListener('abort', stop, { once: true })
    const fail = (error: unknown) => {
      if (signal.aborted) return
      failed = true
      active?.abort()
      console.warn('Could not play artwork animation', art.title, error)
    }
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw Error(`HTTP ${response.status}`)
      const data = await response.arrayBuffer()
      signal.throwIfAborted()
      decoder = new ImageDecoder({ data, type: 'image/webp', preferAnimation: true })
      await decoder.tracks.ready
      const count = decoder.tracks.selectedTrack?.frameCount
      if (!count || count < 2) throw Error('Missing animation frames')
      let index = 0
      async function next() {
        const start = performance.now()
        try {
          const { image } = await decoder.decode({ frameIndex: index })
          const duration = (image.duration ?? 83333) / 1000
          let bitmap: ImageBitmap
          try {
            bitmap = await createImageBitmap(image)
          } finally {
            image.close()
          }
          if (signal.aborted) {
            bitmap.close()
            return
          }
          source.updateImage({ image: bitmap })
          frame?.close()
          frame = bitmap
          index = (index + 1) % count
          timer = window.setTimeout(
            next,
            Math.max(0, duration - (performance.now() - start)),
          )
        } catch (error) {
          fail(error)
        }
      }
      if (!signal.aborted) void next()
    } catch (error) {
      fail(error)
    }
  }

  function refresh() {
    const source =
      selected &&
      !failed &&
      !reduced.matches &&
      !document.hidden &&
      map.getBounds().intersects([
        [west, south],
        [east, north],
      ])
        ? getSource()
        : undefined
    const ready =
      matchesPoster(source) && source.loaded() && source.image ? source : undefined
    if (ready === playing) return
    active?.abort()
    playing = ready
    if (ready) {
      active = new AbortController()
      void play(ready, active.signal)
    }
  }
  reduced.addEventListener('change', refresh)
  document.addEventListener('visibilitychange', refresh)
  map.on('moveend', refresh)
  map.on('idle', refresh)
  map.once('remove', () => {
    reduced.removeEventListener('change', refresh)
    document.removeEventListener('visibilitychange', refresh)
    map.off('moveend', refresh)
    map.off('idle', refresh)
    active?.abort()
  })
  return (visible: boolean) => {
    selected = visible
    refresh()
  }
}
