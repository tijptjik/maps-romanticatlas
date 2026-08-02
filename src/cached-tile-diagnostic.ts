import { tilePolygon } from './tile-geometry.ts'
import { fetchAdmin } from './cached-tile-admin.ts'

const diagnosticSourceId = 'cached-tile-diagnostic'
const diagnosticLayerId = 'cached-tile-diagnostic-boundary'

export const installCachedTileDiagnostic = async map => {
  try {
    const response = await fetchAdmin('/api/atlas-tiles/cached')
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
        coordinates: [tilePolygon(tile)],
      },
    }))

    // The fog is a DOM canvas above MapLibre's canvas. Hide it in diagnostic
    // mode so the tile boundaries remain visible even when admin mode is off.
    map.getContainer().classList.add('atlas-diagnostic-mode')
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
