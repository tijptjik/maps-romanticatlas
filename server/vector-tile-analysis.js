import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'

const sourceMaxZoom = 15
const sourceTileUrl = 'https://tiles.hype.hk/basemap/hongkong-latest/{z}/{x}/{y}.mvt'
const analyses = new Map()

const intersects = (feature, bounds) => {
  const points = feature.loadGeometry().flat()
  if (points.length === 0) return false

  const xValues = points.map(point => point.x)
  const yValues = points.map(point => point.y)
  return !(
    Math.max(...xValues) < bounds.minX ||
    Math.min(...xValues) > bounds.maxX ||
    Math.max(...yValues) < bounds.minY ||
    Math.min(...yValues) > bounds.maxY
  )
}

const addCount = (counts, kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1)

const topCounts = counts =>
  [...counts.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, 3)
    .map(([kind, count]) => `${count} ${kind.replaceAll('_', ' ')}`)
    .join(', ')

const analyseVectorTile = async tile => {
  const parentScale = 2 ** (tile.zoom - sourceMaxZoom)
  const parentTile = {
    x: Math.floor(tile.x / parentScale),
    y: Math.floor(tile.y / parentScale),
  }
  const cacheKey = `${tile.zoom}/${tile.x}/${tile.y}`
  if (analyses.has(cacheKey)) return analyses.get(cacheKey)

  const response = await fetch(
    sourceTileUrl
      .replace('{z}', String(sourceMaxZoom))
      .replace('{x}', String(parentTile.x))
      .replace('{y}', String(parentTile.y)),
  )
  if (!response.ok) throw new Error('Could not retrieve the matching Hype vector tile.')

  const vectorTile = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())))
  const extent = 4096
  const subTileSize = extent / parentScale
  const bounds = {
    minX: (tile.x % parentScale) * subTileSize,
    minY: (tile.y % parentScale) * subTileSize,
    maxX: ((tile.x % parentScale) + 1) * subTileSize,
    maxY: ((tile.y % parentScale) + 1) * subTileSize,
  }
  const roads = new Map()
  const landuse = new Map()
  const names = []
  let buildings = 0
  let water = 0

  for (const [layerName, layer] of Object.entries(vectorTile.layers)) {
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index)
      if (!intersects(feature, bounds)) continue

      if (layerName === 'roads') addCount(roads, feature.properties.kind ?? 'road')
      if (layerName === 'landuse') addCount(landuse, feature.properties.kind ?? 'landuse')
      if (layerName === 'buildings') buildings += 1
      if (layerName === 'water') water += 1
      if (layerName === 'places' && feature.properties.name && names.length < 3) {
        names.push(feature.properties.name)
      }
    }
  }

  const brief = [
    `Level-18 target ${cacheKey} is clipped from level-${sourceMaxZoom} parent ${parentTile.x}/${parentTile.y}.`,
    `${buildings} building footprint${buildings === 1 ? '' : 's'}.`,
    `${water} water feature${water === 1 ? '' : 's'}.`,
    roads.size ? `Road classes: ${topCounts(roads)}.` : 'No mapped roads in this sub-tile.',
    landuse.size ? `Land use: ${topCounts(landuse)}.` : '',
    names.length ? `Nearby place names: ${names.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  analyses.set(cacheKey, brief)
  return brief
}

export const describeTileGeometry = async tile => {
  try {
    return await analyseVectorTile(tile)
  } catch (error) {
    console.warn('Vector tile analysis failed:', error)
    return 'Vector analysis was unavailable. Trace the supplied level-18 source image exactly.'
  }
}
