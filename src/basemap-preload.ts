import type { Map as AtlasMap, VectorTileSource } from 'maplibre-gl'

// The basemap stops at z15: one neighboring tile covers several screens at
// atlas zoom. Warm that ring before a drag exposes it, using the same versioned
// URLs and HTTP cache as MapLibre (no second map or duplicate GPU tile cache).
export const neighboringTiles = (visible: { x: number; y: number; z: number }[]) => {
  const key = ({ z, x, y }) => `${z}/${x}/${y}`
  const occupied = new Set(visible.map(key))
  const neighbors = new Map<string, { x: number; y: number; z: number }>()
  for (const tile of visible) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const candidate = { z: tile.z, x: tile.x + dx, y: tile.y + dy }
        if (
          candidate.x < 0 ||
          candidate.y < 0 ||
          candidate.x >= 2 ** tile.z ||
          candidate.y >= 2 ** tile.z
        )
          continue
        if (!occupied.has(key(candidate))) neighbors.set(key(candidate), candidate)
      }
    }
  }
  return [...neighbors.values()]
}

export const installBasemapPreload = (map: AtlasMap) => {
  const sourceId = 'hongkong-latest'
  const completed = new Set<string>()
  const pending = new Set<string>()
  const controller = new AbortController()
  let queue: string[] = []
  let removed = false

  const pump = () => {
    // Give visible tiles priority whenever the camera enters a cold area.
    if (removed || !map.isSourceLoaded(sourceId)) return
    while (pending.size < 4 && queue.length) {
      const url = queue.shift()!
      if (completed.has(url) || pending.has(url)) continue
      pending.add(url)
      void fetch(url, { signal: controller.signal, priority: 'low' })
        .then(async response => {
          if (!response.ok) return
          await response.arrayBuffer()
          completed.add(url)
          if (completed.size > 128) completed.delete(completed.values().next().value!)
        })
        .catch(() => {
          /* A failed warm-up must not affect map loading. */
        })
        .finally(() => {
          pending.delete(url)
          pump()
        })
    }
  }

  const update = () => {
    const source = map.getSource(sourceId) as VectorTileSource | undefined
    if (!source?.tiles?.length || !map.isSourceLoaded(sourceId)) return
    const visible = map
      .coveringTiles({
        tileSize: source.tileSize,
        minzoom: source.minzoom,
        maxzoom: source.maxzoom,
      })
      .map(tile => tile.canonical)
    queue = neighboringTiles(visible)
      .map(({ x, y, z }) => {
        const template = source.tiles[(x + y) % source.tiles.length]
        return template
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(source.scheme === 'tms' ? 2 ** z - y - 1 : y))
      })
      .filter(url => !completed.has(url) && !pending.has(url))
    pump()
  }
  const onSourceData = event => {
    if (event.sourceId === sourceId && event.isSourceLoaded) update()
  }
  map.on('sourcedata', onSourceData)
  map.on('idle', update)
  map.on('moveend', update)
  map.on('remove', () => {
    removed = true
    controller.abort()
    map.off('sourcedata', onSourceData)
    map.off('idle', update)
    map.off('moveend', update)
  })
}
