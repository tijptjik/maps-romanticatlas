import { tileForPosition, tilePolygon } from './tile-geometry.ts'

const adminGridZoom = 15
const sourceId = 'atlas-admin-z15-grid'
const layerId = 'atlas-admin-z15-grid-outline'

const visibleTiles = map => {
  const bounds = map.getBounds()
  const northWest = tileForPosition(
    { lng: bounds.getWest(), lat: bounds.getNorth() },
    adminGridZoom,
  )
  const southEast = tileForPosition(
    { lng: bounds.getEast(), lat: bounds.getSouth() },
    adminGridZoom,
  )
  const tiles = []

  for (let y = northWest.y; y <= southEast.y; y += 1) {
    for (let x = northWest.x; x <= southEast.x; x += 1) {
      tiles.push({ zoom: adminGridZoom, x, y })
    }
  }

  return tiles
}

export const installAdminTileGrid = map => {
  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })
  map.addLayer({
    id: layerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': '#facc15',
      'line-width': 4.5,
      'line-opacity': 0.9,
    },
  })

  const updateGrid = () => {
    const features = visibleTiles(map).map(tile => ({
      type: 'Feature',
      properties: { zoom: tile.zoom, x: tile.x, y: tile.y },
      geometry: { type: 'Polygon', coordinates: [tilePolygon(tile)] },
    }))
    map.getSource(sourceId)?.setData({ type: 'FeatureCollection', features })
  }

  updateGrid()
  map.on('moveend', updateGrid)
  map.on('resize', updateGrid)
}
