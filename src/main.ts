import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { installAtlasTileInteractions } from './atlas-tiles.ts'
import { installCachedTileAdmin } from './cached-tile-admin.ts'
import { installCachedTileDiagnostic } from './cached-tile-diagnostic.ts'
import { createIntroSplash } from './intro-splash.ts'
import { installArtistStatement } from './artist-statement.ts'
import { installAtlasAudio } from './atlas-audio.ts'
import { installAtlasSharing } from './atlas-sharing.ts'
import { hongKongStyle } from './map-style.ts'
import {
  adminModeEnabled,
  diagnosticsModeEnabled,
  noMusicEnabled,
  noNoiseEnabled,
  noSplashEnabled,
} from './runtime-modes.ts'
import './style.css'

const initialView = {
  center: [114.1346, 22.28364] as [number, number],
  zoom: 17,
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
  // Keep the share capture sharp on high-density displays without exceeding a
  // 2× backing canvas.
  pixelRatio: Math.min(window.devicePixelRatio, 2),
  canvasContextAttributes: { preserveDrawingBuffer: true },
})

const installDeployCommit = (mapContainer: HTMLElement) => {
  if (!adminModeEnabled()) return

  const commit = import.meta.env.VITE_DEPLOY_COMMIT?.trim()
  const label = document.createElement('output')
  label.className = 'atlas-deploy-commit'
  label.textContent = `DEPLOY ${commit ? commit.slice(0, 7) : 'UNKNOWN'}`
  label.title = commit ? `Deployed commit: ${commit}` : 'Deployed commit unavailable'
  label.setAttribute('aria-label', label.title)
  mapContainer.append(label)
}

installDeployCommit(map.getContainer())

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
const sharing = installAtlasSharing(map, audio)
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
    sharing.reset()
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
      audio.stop()
      sharing.reset()
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

map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '<a href="https://github.com/tijptjik/maps-romanticatlas/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">Sounds</a>',
  }),
)
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
    onRevealCountChange: sharing.setRevealCount,
  })
  sharing.setRevealCount(atlas.getRevealCount())
  resetAtlas = async () => {
    await atlas.resetReveals()
  }

  scheduleIdleReset()
})
