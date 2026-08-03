import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { installAtlasTileInteractions } from './atlas-tiles.ts'
import { installCachedTileAdmin } from './cached-tile-admin.ts'
import { installCachedTileDiagnostic } from './cached-tile-diagnostic.ts'
import { createIntroSplash } from './intro-splash.ts'
import { installArtistStatement } from './artist-statement.ts'
import { installAtlasAudio } from './atlas-audio.ts'
import { hongKongStyle } from './map-style.ts'
import {
  diagnosticsModeEnabled,
  noMusicEnabled,
  noNoiseEnabled,
  noSplashEnabled,
} from './runtime-modes.ts'
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

const introFontFaces = [
  '400 1em "Ewert"',
  '400 1em "IM Fell English SC"',
  '700 1em "Cormorant Garamond"',
]

const waitForIntroFonts = async () => {
  if (!('fonts' in document)) return

  // Explicitly request the fonts because the splash is not in the document yet,
  // so relying on document.fonts.ready alone would not necessarily load them.
  await Promise.allSettled(introFontFaces.map(font => document.fonts.load(font)))
  await document.fonts.ready
}

const skipSplash = noSplashEnabled()
const audio = installAtlasAudio(map.getContainer(), { initiallyMuted: noMusicEnabled() })
if (!skipSplash) await waitForIntroFonts()
const intro = createIntroSplash(map.getContainer(), audio.start, !skipSplash)
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
window.addEventListener('click', () => audio.start(), { once: true, passive: true })
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

  if (diagnosticsModeEnabled()) {
    await installCachedTileDiagnostic(map)
  }

  const atlas = installAtlasTileInteractions(map, audio, {
    noNoise: noNoiseEnabled(),
  })
  resetAtlas = async () => {
    await atlas.resetReveals()
  }

  scheduleIdleReset()
})
