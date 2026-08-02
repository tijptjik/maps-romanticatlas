import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { installAtlasTileInteractions } from './atlas-tiles.ts'
import { installCachedTileAdmin } from './cached-tile-admin.ts'
import { installCachedTileDiagnostic } from './cached-tile-diagnostic.ts'
import { createIntroSplash } from './intro-splash.ts'
import { installArtistStatement } from './artist-statement.ts'
import { hongKongStyle } from './map-style.ts'
import './style.css'

const initialView = {
  center: [114.1346, 22.28364] as [number, number],
  zoom: 16.5,
  bearing: 0,
  pitch: 0,
}

const map = new maplibregl.Map({
  container: 'map',
  style: hongKongStyle,
  ...initialView,
  maxPitch: 0,
  dragRotate: false,
  keyboard: false,
  touchZoomRotate: false,
  touchPitch: false,
  pitchWithRotate: false,
  // Atlas interactions use the z18 tile grid. The fog remains visible above it,
  // while generation still requires a complete z18 tile in the viewport.
  minZoom: 16.5,
  maxZoom: 18.5,
  maxBounds: [113.8, 22.1, 114.5, 22.6],
  attributionControl: false,
})

const intro = createIntroSplash(map.getContainer())
installArtistStatement(map.getContainer())
const idleDelay = 180_000
let idleTimer: number | undefined
let resetAtlas: (() => Promise<void>) | undefined
let isResetting = false

const scheduleIdleReset = () => {
  if (idleTimer) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(async () => {
    if (isResetting || !resetAtlas) return
    isResetting = true
    intro.show()
    map.stop()
    map.easeTo({ ...initialView, duration: 900, essential: true })
    try {
      await resetAtlas()
    } finally {
      isResetting = false
      scheduleIdleReset()
    }
  }, idleDelay)
}

const noteActivity = (dismissIntro = false) => {
  if (isResetting) return
  if (dismissIntro) intro.dismiss()
  scheduleIdleReset()
}

window.addEventListener('pointerdown', () => noteActivity(true), { passive: true })
window.addEventListener('pointermove', () => noteActivity(), { passive: true })
window.addEventListener('wheel', () => noteActivity(), { passive: true })
window.addEventListener('touchstart', () => noteActivity(true), { passive: true })
window.addEventListener(
  'keydown',
  event => {
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault()
      event.stopPropagation()
      intro.show()
      noteActivity()
    }
  },
  { capture: true },
)
window.addEventListener('keydown', () => noteActivity())

const collapseAttribution = () => {
  const attribution = map
    .getContainer()
    .querySelector<HTMLElement>('.maplibregl-ctrl-attrib')
  attribution?.classList.remove('maplibregl-compact-show')
  attribution?.removeAttribute('open')
}

map.addControl(new maplibregl.AttributionControl({ compact: true }))
collapseAttribution()
map.once('idle', collapseAttribution)
map.on('mousemove', () => noteActivity())
map.on('load', async () => {
  await installCachedTileAdmin(map)

  if (import.meta.env.VITE_DIAGNOSTIC_CACHED_TILES === 'true') {
    await installCachedTileDiagnostic(map)
  }

  const atlas = installAtlasTileInteractions(map, maplibregl)
  resetAtlas = async () => {
    await atlas.resetReveals()
  }

  scheduleIdleReset()
})
