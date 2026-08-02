import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { installAtlasTileInteractions } from './atlas-tiles.js'
import { hongKongStyle } from './map-style.js'
import './style.css'

const map = new maplibregl.Map({
  container: 'map',
  style: hongKongStyle,
  center: [114.1694, 22.3193],
  zoom: 16,
  maxZoom: 19,
  maxBounds: [113.8, 22.1, 114.5, 22.6],
  attributionControl: false,
})

map.addControl(new maplibregl.AttributionControl({ compact: true }))
map.on('load', () => {
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    installAtlasTileInteractions(map, maplibregl)
  }
})
