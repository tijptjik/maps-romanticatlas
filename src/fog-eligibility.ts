import { planAtlasRoads } from './atlas-road-plan.ts'
import { atlasTileSize, atlasZoom } from './atlas-protocol.ts'

// The version names the sampling rules. The Worker appends the upstream map
// release identifier, so either deliberate definition changes or a basemap
// release creates a fresh persistent-cache namespace.
export const fogEligibilityVersion = '2026-11-18.4'
export const fogEligibilitySourceZoom = 15
const landSampleSize = 10
const streetSampleSize = 128
const landTargetThreshold = 0.75
export const minimumUsableFraction = 0.25
export const coastalSceneCoverage = 0.5
export const requiredUsableFraction = (coastal = false) => coastal ? coastalSceneCoverage : minimumUsableFraction
export const coastalLandThreshold = 0.1
export const fogEligibilityChildSpan = 2 ** (atlasZoom - fogEligibilitySourceZoom)

export type FogEligibilityPosition = { zoom: number; x: number; y: number }

export type FogEligibility = FogEligibilityPosition & {
  isTargetable: boolean
  regionalLandAvailable: boolean
  landFraction: number | null
  streetFraction: number | null
  coastal?: boolean
  usableFraction?: number | null
}

export { isFogPatternSelected } from './fog-pattern.js'

export const fogEligibilitySourceTile = ({ x, y }: FogEligibilityPosition) => ({
  x: Math.floor(x / fogEligibilityChildSpan),
  y: Math.floor(y / fogEligibilityChildSpan),
})

export const fogEligibilitySourceTileId = (tile: FogEligibilityPosition) => {
  const source = fogEligibilitySourceTile(tile)
  return `${fogEligibilitySourceZoom}/${source.x}/${source.y}`
}

const vectorRingContainsPoint = (point, ring) => {
  let inside = false
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const current = ring[index]
    const prior = ring[previous]
    const crosses = current.y > point.y !== prior.y > point.y
    if (
      crosses &&
      point.x <
        ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) +
          current.x
    ) {
      inside = !inside
    }
  }
  return inside
}

const vectorFeatureContainsPoint = (rings, point) => {
  return rings.reduce(
    (inside, ring) => (vectorRingContainsPoint(point, ring) ? !inside : inside),
    false,
  )
}

const isRegionalBaseFeature = feature => feature.properties['saanseoi:base'] === true

const isVectorFinePath = feature =>
  /path|trail|footway|pedestrian|steps|cycleway|track/.test(
    Object.values(feature.properties).join(' ').toLowerCase(),
  )

const sourceTileWindow = (tile, layer) => {
  const sourceTileSize = layer.extent / fogEligibilityChildSpan
  return {
    sourceTileSize,
    originX: (tile.x % fogEligibilityChildSpan) * sourceTileSize,
    originY: (tile.y % fogEligibilityChildSpan) * sourceTileSize,
  }
}

const vectorTileLandFraction = (sourceTile, tile) => {
  const earthLayer = sourceTile.layers.earth
  const waterLayer = sourceTile.layers.water
  if (!earthLayer) return { landFraction: null, coastal: false }

  const { sourceTileSize, originX, originY } = sourceTileWindow(tile, earthLayer)
  const earthFeatures = Array.from({ length: earthLayer.length }, (_, index) =>
    earthLayer.feature(index),
  )
    .filter(isRegionalBaseFeature)
    .map(feature => (feature.type === 3 ? feature.loadGeometry() : []))
  const waterFeatures = waterLayer
    ? Array.from({ length: waterLayer.length }, (_, index) =>
        waterLayer.feature(index),
      ).map(feature => (feature.type === 3 ? feature.loadGeometry() : []))
    : []
  if (!earthFeatures.length) return { landFraction: null, coastal: false }

  const seaFeatures = waterLayer ? Array.from({ length: waterLayer.length }, (_, i) => waterLayer.feature(i))
    .filter(f => f.type === 3 && ['sea', 'ocean', 'bay', 'strait', 'fjord'].includes(f.properties.kind))
    .map(f => f.loadGeometry()) : []
  let seaSamples = 0
  let landSamples = 0
  for (let row = 0; row < landSampleSize; row += 1) {
    for (let column = 0; column < landSampleSize; column += 1) {
      const point = {
        x: originX + ((column + 0.5) * sourceTileSize) / landSampleSize,
        y: originY + ((row + 0.5) * sourceTileSize) / landSampleSize,
      }
      const onEarth = earthFeatures.some(feature =>
        vectorFeatureContainsPoint(feature, point),
      )
      const onWater = waterFeatures.some(feature =>
        vectorFeatureContainsPoint(feature, point),
      )
      if (seaFeatures.some(feature => vectorFeatureContainsPoint(feature, point))) seaSamples++
      if (onEarth && !onWater) landSamples += 1
    }
  }
  return { landFraction: landSamples / (landSampleSize * landSampleSize), coastal: seaSamples > 0 }
}

const squaredDistanceToSegment = (point, start, end) => {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (!lengthSquared) {
    const x = point.x - start.x
    const y = point.y - start.y
    return x * x + y * y
  }
  const fraction = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    ),
  )
  const x = point.x - (start.x + fraction * deltaX)
  const y = point.y - (start.y + fraction * deltaY)
  return x * x + y * y
}

// All 64 children share the same vector layer. Decode each line once and
// keep its full geometry so junctions and continuations retain their meaning.
const prepareRoadLines = layer => {
  const lines = []
  for (let index = 0; index < layer.length; index++) {
    const feature = layer.feature(index)
    if (feature.type !== 2) continue
    for (const line of feature.loadGeometry()) {
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
      const coordinates = line.map(({ x, y }) => {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        return [x / layer.extent, 1 - y / layer.extent]
      })
      lines.push({ left, right, top, bottom, properties: feature.properties,
        geometry: { type: 'LineString', coordinates } })
    }
  }
  return lines
}

const roadsByLayer = new WeakMap<object, ReturnType<typeof prepareRoadLines>>()

const vectorTileStreetSpace = (sourceTile, tile) => {
  const roadsLayer = sourceTile.layers.roads
  if (!roadsLayer) return { streetFraction: 0, usableFraction: 1 }

  const { sourceTileSize, originX, originY } = sourceTileWindow(tile, roadsLayer)
  const halfStroke = (18 / 2) * (sourceTileSize / atlasTileSize)
  let lines = roadsByLayer.get(roadsLayer)
  if (!lines) {
    lines = prepareRoadLines(roadsLayer)
    roadsByLayer.set(roadsLayer, lines)
  }
  // The planner only follows junctions inside this child. Include the
  // stroke margin for roads outside it that can still cover a sample.
  const features = lines.filter(line => line.right >= originX - halfStroke &&
    line.left <= originX + sourceTileSize + halfStroke && line.bottom >= originY - halfStroke &&
    line.top <= originY + sourceTileSize + halfStroke)
  const plan = planAtlasRoads(features, {
    west: originX / roadsLayer.extent, east: (originX + sourceTileSize) / roadsLayer.extent,
    north: 1 - originY / roadsLayer.extent, south: 1 - (originY + sourceTileSize) / roadsLayer.extent,
  })
  const paddedSegments = plan.retained.filter(feature => !isVectorFinePath(feature))
    .flatMap(feature => feature.geometry.coordinates.slice(1).map((point, index) => {
      const prior = feature.geometry.coordinates[index]
      const start = { x: prior[0] * roadsLayer.extent, y: (1 - prior[1]) * roadsLayer.extent }
      const end = { x: point[0] * roadsLayer.extent, y: (1 - point[1]) * roadsLayer.extent }
      return { start, end,
        left: Math.min(start.x, end.x) - halfStroke, right: Math.max(start.x, end.x) + halfStroke,
        top: Math.min(start.y, end.y) - halfStroke, bottom: Math.max(start.y, end.y) + halfStroke }
    }))
  // Only segments whose padded bounds intersect this child can cover a sample.
  const tileSegments = paddedSegments.filter(
    segment =>
      segment.right >= originX &&
      segment.left <= originX + sourceTileSize &&
      segment.bottom >= originY &&
      segment.top <= originY + sourceTileSize,
  )
  if (!tileSegments.length) return { streetFraction: 0, usableFraction: 1 }

  const blocked = new Uint8Array(streetSampleSize * streetSampleSize)
  let coveredSamples = 0
  const halfStrokeSquared = halfStroke * halfStroke
  for (let row = 0; row < streetSampleSize; row += 1) {
    const sampleY = originY + ((row + 0.5) * sourceTileSize) / streetSampleSize
    const rowSegments = tileSegments.filter(
      segment => sampleY >= segment.top && sampleY <= segment.bottom,
    )
    if (!rowSegments.length) continue
    for (let column = 0; column < streetSampleSize; column += 1) {
      const point = {
        x: originX + ((column + 0.5) * sourceTileSize) / streetSampleSize,
        y: originY + ((row + 0.5) * sourceTileSize) / streetSampleSize,
      }
      if (
        rowSegments.some(
          segment =>
            point.x >= segment.left &&
            point.x <= segment.right &&
            point.y >= segment.top &&
            point.y <= segment.bottom &&
            squaredDistanceToSegment(point, segment.start, segment.end) <=
              halfStrokeSquared,
        )
      ) {
        coveredSamples += 1
        blocked[row * streetSampleSize + column] = 1
      }
    }
  }
  return {
    streetFraction: coveredSamples / blocked.length,
    usableFraction: usableRoadSpace(blocked, streetSampleSize),
  }
}

// Remove two sample widths around roads so narrow cracks cannot join
// otherwise unusable fragments. Measure the largest remaining connected plot.
export const usableRoadSpace = (blocked: Uint8Array, size: number) => {
  const free = new Uint8Array(size * size).fill(1)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!blocked[y * size + x]) continue
    for (let row = Math.max(0, y - 2); row <= Math.min(size - 1, y + 2); row++)
      for (let col = Math.max(0, x - 2); col <= Math.min(size - 1, x + 2); col++)
        free[row * size + col] = 0
  }
  const queue = new Int32Array(free.length)
  let largest = 0
  for (let start = 0; start < free.length; start++) {
    if (!free[start]) continue
    let head = 0, tail = 1
    queue[0] = start
    free[start] = 0
    while (head < tail) {
      const cell = queue[head++], x = cell % size
      const neighbours = [cell - size, cell + size]
      if (x > 0) neighbours.push(cell - 1)
      if (x < size - 1) neighbours.push(cell + 1)
      for (const next of neighbours) {
        if (next < 0 || next >= free.length || !free[next]) continue
        free[next] = 0
        queue[tail++] = next
      }
    }
    largest = Math.max(largest, tail)
  }
  return largest / free.length
}

export const classifyFogEligibility = (
  sourceTile,
  tile: FogEligibilityPosition,
): FogEligibility => {
  const { landFraction, coastal } = vectorTileLandFraction(sourceTile, tile)
  if (landFraction === null) {
    return {
      ...tile,
      isTargetable: false,
      regionalLandAvailable: false,
      landFraction: null,
      streetFraction: null,
    }
  }
  const { streetFraction, usableFraction } = vectorTileStreetSpace(sourceTile, tile)
  return {
    ...tile,
    isTargetable:
      (landFraction >= (coastal ? coastalLandThreshold : landTargetThreshold)) && usableFraction >= requiredUsableFraction(coastal),
    regionalLandAvailable: true,
    landFraction,
    streetFraction,
    coastal,
    usableFraction,
  }
}
