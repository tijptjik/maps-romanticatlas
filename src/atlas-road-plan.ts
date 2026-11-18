// Use shared vector vertices as junctions. A visual crossing alone does not
// establish a connection (for example, a flyover above a surface street).
type Position = number[]
type Edge = { a: string; b: string; minor: boolean; twoWay: boolean }
const vertex = (p: Position) => p.join(',')
const edgeKey = (a: string, b: string) => (a < b ? a + '/' + b : b + '/' + a)

export const planAtlasRoads = (features, bounds) => {
  const nodes = new Map<string, Set<string>>()
  const edges = new Map<string, Edge>()
  const inside = ([x, y]: Position) => {
    const dx = (bounds.east - bounds.west) * 0.035
    const dy = (bounds.north - bounds.south) * 0.035
    return (
      x > bounds.west + dx &&
      x < bounds.east - dx &&
      y > bounds.south + dy &&
      y < bounds.north - dy
    )
  }
  const lines = features.flatMap(f => {
    const geometry = f.geometry
    const paths =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : []
    return paths.map(coords => ({ coords, properties: f.properties }))
  })
  const surface = p =>
    !p.is_bridge &&
    !p.is_tunnel &&
    !Number(p.layer ?? 0) &&
    ['minor_road', 'major_road', 'highway'].includes(p.kind)
  const local = p =>
    surface(p) &&
    p.kind === 'minor_road' &&
    ['service', 'residential', 'unclassified', 'living_street'].includes(
      p.kind_detail,
    ) &&
    !p.is_link &&
    !p.ref &&
    !p.roundabout &&
    !p.junction
  const accesses = new Set<string>()
  for (const { coords, properties: p } of lines) {
    if (!surface(p)) {
      if (!p.is_bridge && !p.is_tunnel && !Number(p.layer ?? 0))
        for (const coord of coords) accesses.add(vertex(coord))
      continue
    }
    for (let i = 1; i < coords.length; i++) {
      const a = vertex(coords[i - 1]),
        b = vertex(coords[i])
      if (a === b) continue
      const key = edgeKey(a, b)
      const previous = edges.get(key)
      const twoWay =
        [undefined, false, 'no', 0].includes(p.oneway) && !p.junction && !p.roundabout
      edges.set(key, {
        a,
        b,
        minor: local(p) && twoWay && (previous?.minor ?? true),
        twoWay: twoWay && (previous?.twoWay ?? true),
      })
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        if (!nodes.has(from)) nodes.set(from, new Set())
        nodes.get(from)!.add(to)
      }
    }
  }
  const visited = new Set<string>(),
    removed = new Set<string>()
  const position = (k: string) => k.split(',').map(Number)
  const through = (node: string, branch: string) => {
    const [x, y] = position(node)
    const rays = [...nodes.get(node)!]
      .filter(k => k !== branch)
      .map(k => {
        const p = position(k)
        const dx = (p[0] - x) * Math.cos((y * Math.PI) / 180),
          dy = p[1] - y
        const length = Math.hypot(dx, dy)
        return [dx / length, dy / length]
      })
    return rays.some((r, i) =>
      rays.slice(i + 1).some(s => r[0] * s[0] + r[1] * s[1] < -0.7),
    )
  }
  const candidates: string[][] = []
  for (const [start, neighbours] of nodes) {
    if (neighbours.size < 3 || !inside(position(start))) continue
    for (const next of neighbours) {
      const chain = [start, next]
      let a = start,
        b = next
      while (true) {
        const key = edgeKey(a, b)
        if (visited.has(key) || !edges.get(key)!.minor || !inside(position(b))) break
        visited.add(key)
        const onward = nodes.get(b)!
        if (onward.size !== 2) {
          if (b !== start && onward.size >= 3 && through(start, next) && through(b, a))
            candidates.push(chain)
          break
        }
        if (accesses.has(b)) break
        const c = [...onward].find(k => k !== a)!
        chain.push(c)
        a = b
        b = c
      }
    }
  }
  // Reclaim a local terminal branch up to its first actual junction.
  // A tile-edge endpoint may continue in another tile and is not a dead end.
  const deadEnds: string[][] = []
  for (const [tip, neighbours] of nodes) {
    if (neighbours.size !== 1 || !inside(position(tip)) || accesses.has(tip)) continue
    const chain = [tip]
    let previous: string | undefined
    let current = tip
    while (true) {
      const next = [...nodes.get(current)!].find(node => node !== previous)
      if (!next || !edges.get(edgeKey(current, next))!.minor || !inside(position(next))) break
      chain.push(next)
      if (accesses.has(next)) break
      const degree = nodes.get(next)!.size
      if (degree >= 3) { deadEnds.push(chain); break }
      if (degree !== 2) break
      previous = current
      current = next
    }
  }
  const length = chain =>
    chain.slice(1).reduce((sum, k, i) => {
      const a = position(chain[i]),
        b = position(k)
      return (
        sum + Math.hypot((a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180), a[1] - b[1])
      )
    }, 0)
  candidates.sort(
    (a, b) => length(a) - length(b) || a.join('/').localeCompare(b.join('/')),
  )
  const removedPaths: Position[][] = []
  const usedJunctions = new Set<string>()
  for (const chain of candidates) {
    const start = chain[0],
      end = chain.at(-1)!
    if (usedJunctions.has(start) || usedJunctions.has(end)) continue
    const keys = chain.slice(1).map((k, i) => edgeKey(chain[i], k))
    const blocked = new Set([...removed, ...keys])
    const queue = [start],
      reached = new Set(queue)
    for (let i = 0; i < queue.length && !reached.has(end); i++) {
      const current = queue[i]
      for (const k of nodes.get(current)!) {
        const key = edgeKey(current, k)
        if (
          reached.has(k) ||
          blocked.has(key) ||
          !edges.get(key)!.twoWay ||
          !inside(position(k))
        )
          continue
        queue.push(k)
        reached.add(k)
      }
    }
    if (!reached.has(end)) continue
    keys.forEach(k => removed.add(k))
    usedJunctions.add(start)
    usedJunctions.add(end)
    removedPaths.push(chain.map(position))
  }
  for (const chain of deadEnds) {
    chain.slice(1).forEach((node, index) => removed.add(edgeKey(chain[index], node)))
    removedPaths.push(chain.map(position))
  }
  const retained = lines.flatMap(({ coords, properties }) => {
    const chunks: Position[][] = []
    let chunk = [coords[0]]
    for (let i = 1; i < coords.length; i++) {
      if (
        local(properties) &&
        removed.has(edgeKey(vertex(coords[i - 1]), vertex(coords[i])))
      ) {
        if (chunk.length > 1) chunks.push(chunk)
        chunk = []
      }
      chunk.push(coords[i])
    }
    if (chunk.length > 1) chunks.push(chunk)
    return chunks.map(coordinates => ({
      type: 'Feature',
      properties,
      geometry: { type: 'LineString', coordinates },
    }))
  })
  return { removedPaths, retained }
}
