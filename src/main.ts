import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { installAtlasTileInteractions } from './atlas-tiles.ts'
import { installCachedTileDiagnostic } from './cached-tile-diagnostic.ts'
import { hongKongStyle } from './map-style.ts'
import './style.css'

const map = new maplibregl.Map({
  container: 'map',
  style: hongKongStyle,
  center: [114.1694, 22.3193],
  zoom: 16.5,
  // Atlas interactions use the z18 tile grid. The fog remains visible above it,
  // while generation still requires a complete z18 tile in the viewport.
  minZoom: 16.5,
  maxZoom: 18,
  maxBounds: [113.8, 22.1, 114.5, 22.6],
  attributionControl: false,
})

map.addControl(new maplibregl.AttributionControl({ compact: true }))
map.on('load', () => {
  if (import.meta.env.VITE_DIAGNOSTIC_CACHED_TILES === 'true') {
    installCachedTileDiagnostic(map)
  }

  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    installAtlasTileInteractions(map, maplibregl)
  }
})
