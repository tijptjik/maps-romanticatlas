const diagnosticSourceId = 'cached-tile-diagnostic'
const diagnosticLayerId = 'cached-tile-diagnostic-boundary'

const tileBounds = (zoom, x, y) => {
  const tileCount = 2 ** zoom
  const longitude = tileX => (tileX / tileCount) * 360 - 180
  const latitude = tileY => {
    const radians = Math.PI - (2 * Math.PI * tileY) / tileCount
    return (180 / Math.PI) * Math.atan(Math.sinh(radians))
  }

  return [
    [longitude(x), latitude(y)],
    [longitude(x + 1), latitude(y)],
    [longitude(x + 1), latitude(y + 1)],
    [longitude(x), latitude(y + 1)],
    [longitude(x), latitude(y)],
  ]
}

export const installCachedTileDiagnostic = async map => {
  try {
    const response = await fetch('/api/atlas-tiles/cached')
    if (!response.ok)
      throw new Error(`Cache manifest request failed with ${response.status}`)
    const { tiles } = await response.json()
    const uniqueTiles = new Map(
      (Array.isArray(tiles) ? tiles : []).map(tile => [
        `${tile.zoom}/${tile.x}/${tile.y}`,
        tile,
      ]),
    )
    const features = [...uniqueTiles.values()].map(tile => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [tileBounds(tile.zoom, tile.x, tile.y)],
      },
    }))

    map.addSource(diagnosticSourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    })
    map.addLayer({
      id: diagnosticLayerId,
      type: 'line',
      source: diagnosticSourceId,
      paint: {
        'line-color': '#e11d2e',
        'line-width': 2.5,
        'line-opacity': 0.95,
      },
    })
    console.info(
      `Cached tile diagnostic: ${features.length} tile${features.length === 1 ? '' : 's'}`,
    )
  } catch (error) {
    console.warn('Cached tile diagnostic could not load.', error)
  }
}
