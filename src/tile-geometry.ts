import { atlasZoom } from './atlas-protocol.ts'

export { atlasZoom }

const tileCountAtZoom = zoom => 2 ** zoom

const tileLongitude = (x, zoom = atlasZoom) =>
  (x / tileCountAtZoom(zoom)) * 360 - 180

const tileLatitude = (y, zoom = atlasZoom) => {
  const radians = Math.PI - (2 * Math.PI * y) / tileCountAtZoom(zoom)
  return (180 / Math.PI) * Math.atan(Math.sinh(radians))
}

export const tileBounds = tile => {
  const zoom = tile.zoom ?? atlasZoom
  return {
    west: tileLongitude(tile.x, zoom),
    north: tileLatitude(tile.y, zoom),
    east: tileLongitude(tile.x + 1, zoom),
    south: tileLatitude(tile.y + 1, zoom),
  }
}

export const tileForPosition = ({ lng, lat }, zoom = atlasZoom) => {
  const count = tileCountAtZoom(zoom)
  const latitudeRadians = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * count),
    y: Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count),
  }
}

export const tilePolygon = tile => {
  const bounds = tileBounds(tile)
  return [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
  ]
}

// Artwork images are anchored at their southwest tile and extend north and east.
export const drawingFootprint = (tile: {
  x: number; y: number; scene?: string; tileSpan?: { columns: number; rows: number }
}) => {
  const { columns, rows } = tile.tileSpan ?? { columns: 1, rows: tile.scene === 'skyscraper' ? 2 : 1 }
  const cells = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) cells.push({ x: tile.x + col, y: tile.y - row })
  }
  const { west, south } = tileBounds(tile)
  const { east, north } = tileBounds(cells.at(-1))
  return { cells, bounds: { west, south, east, north } }
}
