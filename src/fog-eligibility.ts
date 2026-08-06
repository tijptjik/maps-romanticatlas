import { atlasTileSize, atlasZoom } from './atlas-protocol.ts'

// The version names the sampling rules. The Worker appends the upstream map
// release identifier, so either deliberate definition changes or a basemap
// release creates a fresh persistent-cache namespace.
export const fogEligibilityVersion = '2026-08-06.1'
export const fogEligibilitySourceZoom = 15
const landSampleSize = 10
const streetSampleSize = 128
const landTargetThreshold = 0.75
const streetTargetThreshold = 0.2
export const fogEligibilityChildSpan = 2 ** (atlasZoom - fogEligibilitySourceZoom)

export type FogEligibilityPosition = { zoom: number; x: number; y: number }

export type FogEligibility = FogEligibilityPosition & {
  isTargetable: boolean
  regionalLandAvailable: boolean
  landFraction: number | null
  streetFraction: number | null
}

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

const vectorFeatureContainsPoint = (feature, point) => {
  if (feature.type !== 3) return false
  return feature
    .loadGeometry()
    .reduce(
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
  if (!earthLayer) return null

  const { sourceTileSize, originX, originY } = sourceTileWindow(tile, earthLayer)
  const earthFeatures = Array.from({ length: earthLayer.length }, (_, index) =>
    earthLayer.feature(index),
  ).filter(isRegionalBaseFeature)
  const waterFeatures = waterLayer
    ? Array.from({ length: waterLayer.length }, (_, index) => waterLayer.feature(index))
    : []
  if (!earthFeatures.length) return null

  let landSamples = 0
  for (let row = 0; row < landSampleSize; row += 1) {
    for (let column = 0; column < landSampleSize; column += 1) {
      const point = {
        x: originX + ((column + 0.5) * sourceTileSize) / landSampleSize,
        y: originY + ((row + 0.5) * sourceTileSize) / landSampleSize,
      }
      const onEarth = earthFeatures.some(feature => vectorFeatureContainsPoint(feature, point))
      const onWater = waterFeatures.some(feature => vectorFeatureContainsPoint(feature, point))
      if (onEarth && !onWater) landSamples += 1
    }
  }
  return landSamples / (landSampleSize * landSampleSize)
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
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared),
  )
  const x = point.x - (start.x + fraction * deltaX)
  const y = point.y - (start.y + fraction * deltaY)
  return x * x + y * y
}

const vectorTileStreetFraction = (sourceTile, tile) => {
  const roadsLayer = sourceTile.layers.roads
  if (!roadsLayer) return 0

  const { sourceTileSize, originX, originY } = sourceTileWindow(tile, roadsLayer)
  const halfStroke = (18 / 2) * (sourceTileSize / atlasTileSize)
  const paddedSegments = Array.from({ length: roadsLayer.length }, (_, index) =>
    roadsLayer.feature(index),
  )
    .filter(feature => feature.type === 2 && !isVectorFinePath(feature))
    .flatMap(feature =>
      feature.loadGeometry().flatMap(line =>
        line.slice(1).map((end, index) => {
          const start = line[index]
          return {
            start,
            end,
            left: Math.min(start.x, end.x) - halfStroke,
            right: Math.max(start.x, end.x) + halfStroke,
            top: Math.min(start.y, end.y) - halfStroke,
            bottom: Math.max(start.y, end.y) + halfStroke,
          }
        }),
      ),
    )
  if (!paddedSegments.length) return 0

  let coveredSamples = 0
  const halfStrokeSquared = halfStroke * halfStroke
  for (let row = 0; row < streetSampleSize; row += 1) {
    for (let column = 0; column < streetSampleSize; column += 1) {
      const point = {
        x: originX + ((column + 0.5) * sourceTileSize) / streetSampleSize,
        y: originY + ((row + 0.5) * sourceTileSize) / streetSampleSize,
      }
      if (
        paddedSegments.some(
          segment =>
            point.x >= segment.left &&
            point.x <= segment.right &&
            point.y >= segment.top &&
            point.y <= segment.bottom &&
            squaredDistanceToSegment(point, segment.start, segment.end) <= halfStrokeSquared,
        )
      ) {
        coveredSamples += 1
      }
    }
  }
  return coveredSamples / (streetSampleSize * streetSampleSize)
}

export const classifyFogEligibility = (
  sourceTile,
  tile: FogEligibilityPosition,
): FogEligibility => {
  const landFraction = vectorTileLandFraction(sourceTile, tile)
  if (landFraction === null) {
    return {
      ...tile,
      isTargetable: false,
      regionalLandAvailable: false,
      landFraction: null,
      streetFraction: null,
    }
  }
  const streetFraction = vectorTileStreetFraction(sourceTile, tile)
  return {
    ...tile,
    isTargetable:
      landFraction >= landTargetThreshold && streetFraction <= streetTargetThreshold,
    regionalLandAvailable: true,
    landFraction,
    streetFraction,
  }
}
