import { viewportFogTiles } from './atlas-tiles.ts'
import { fogEligibilityChildSpan as span, type FogEligibility } from './fog-eligibility.ts'
import type { Map as AtlasMap } from 'maplibre-gl'

// Versioned regional blocks are precomputed and cached by the server.
// Keep a compact byte per child and share one request per parent.
export const installStudyEligibility = (map: AtlasMap, changed: () => void) => {
  const blocks = new Map<string, Uint8Array>()
  const pending = new Set<string>()
  const failed = new Map<string, number>()
  const abort = new AbortController()
  const key = (x: number, y: number) => Math.floor(x / span) + '/' + Math.floor(y / span)
  let version: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let previousCenter = map.getCenter()
  let direction = { x: 0, y: 0 }
  const update = () => {
    timer = undefined
    if (abort.signal.aborted) return
    const center = map.getCenter()
    const previous = map.project(previousCenter), current = map.project(center)
    const dx = current.x - previous.x, dy = current.y - previous.y
    if (Math.hypot(dx, dy) > 1) direction = { x: Math.sign(dx), y: Math.sign(dy) }
    previousCenter = center
    // Match the drawing buffer, including the wider view exposed by zoom-out.
    const tilePixels = 512 * 2 ** (map.getZoom() - 18)
    const bufferCells = Math.ceil(Math.min(1024, Math.max(256,
      Math.max(map.getCanvas().clientWidth, map.getCanvas().clientHeight) * 0.55)) / tilePixels) + 1
    const visible = viewportFogTiles(map, bufferCells)
    // Keep visible cells first, then prefetch two cells in the travel direction.
    const ahead = visible.map(tile => ({ x: tile.x + direction.x * 2, y: tile.y + direction.y * 2 }))
    for (const tile of [...visible, ...ahead]) {
      const id = key(tile.x, tile.y)
      if (blocks.has(id) || pending.has(id) || (failed.get(id) ?? 0) > Date.now()) continue
      if (pending.size >= 4) break
      pending.add(id)
      fetch('/api/fog-index/15/' + id, { signal: abort.signal })
        .then(async response => {
          if (!response.ok) throw Error('Eligibility HTTP ' + response.status)
          const body = await response.json() as { version: string; eligibility: FogEligibility[] }
          if (!body.version || body.eligibility.length !== span * span) throw Error('Incomplete eligibility block')
          if (version && version !== body.version) blocks.clear()
          version = body.version
          const bytes = new Uint8Array(span * span)
          for (const entry of body.eligibility)
            bytes[(entry.y % span) * span + entry.x % span] = Number(entry.regionalLandAvailable && entry.isTargetable)
          blocks.set(id, bytes)
          failed.delete(id)
          changed()
        })
        .catch(() => { if (!abort.signal.aborted) failed.set(id, Date.now() + 5000) })
        .finally(() => {
          pending.delete(id)
          if (!abort.signal.aborted && timer === undefined) timer = setTimeout(update, 50)
        })
    }
    if (failed.size && timer === undefined) timer = setTimeout(update, 5000)
  }
  const moving = () => {
    if (timer === undefined) timer = setTimeout(update, 100)
  }
  map.on('move', moving)
  map.on('moveend', moving)
  map.once('remove', () => {
    abort.abort()
    clearTimeout(timer)
    map.off('move', moving)
    map.off('moveend', moving)
  })
  update()
  return ({ x, y }: { x: number; y: number }) => blocks.get(key(x, y))?.[(y % span) * span + x % span] === 1
}
