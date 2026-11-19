import { installArtworkSampling } from './artwork-sampling.ts'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { installDiscoveryMap } from './v2-discovery-map'
import { installCachedTileAdmin } from './cached-tile-admin'
import { installAtlasTileInteractions, minimumFogZoom } from './atlas-tiles'
import { createIntroSplash } from './intro-splash.ts'
import { installArtistStatement } from './artist-statement.ts'
import { installAtlasAudio } from './atlas-audio.ts'
import { installAtlasSharing } from './atlas-sharing.ts'
import { createMapFlight } from './map-flight.ts'
import { hongKongStyle } from './map-style.ts'
import { atlasTileSize } from './atlas-protocol.ts'
import { installNativeTileZoom, nativeTileZoom } from './native-tile-zoom.ts'
import { installBasemapPreload } from './basemap-preload.ts'
import {
  adminModeEnabled,
  diagnosticsModeEnabled,
  cloudDiagnosticsModeEnabled,
  noNoiseEnabled,
  kioskModeEnabled,
  noMusicEnabled,
  noSplashEnabled,
} from './runtime-modes.ts'
import './style.css'

// Vite emits MapLibre's module worker as a self-contained same-origin asset.
maplibregl.setWorkerUrl(workerUrl)

const initialView = {
  center: [114.13765, 22.28364] as [number, number],
  zoom: 17,
  bearing: 0,
  pitch: 0,
}

const kioskFlightCenter = [114.1455, 22.2759] as [number, number]
const kioskMode = kioskModeEnabled()
const restoringMap = history.state?.atlasView === 'map' ||
  (!history.state?.atlasView && Boolean(history.state?.atlasModeCamera))
if (kioskMode || noSplashEnabled() || restoringMap) {
  document.documentElement.classList.remove('atlas-boot')
}

const adminMap = adminModeEnabled()
const minimumZoom = diagnosticsModeEnabled() ? minimumFogZoom : 16
const nativeMaxZoom = nativeTileZoom(atlasTileSize)
const initialMaxZoom = adminMap ? nativeMaxZoom : Math.max(minimumZoom, nativeMaxZoom)

const map = new maplibregl.Map({
  container: 'map',
  style: hongKongStyle,
  ...initialView,
  ...(history.state?.atlasModeCamera ?? {}),
  maxPitch: 0,
  dragRotate: false,
  keyboard: false,
  touchZoomRotate: false,
  touchPitch: false,
  pitchWithRotate: false,
  // Atlas interactions use the z18 tile grid. The fog remains visible above it,
  // while generation still requires a complete z18 tile in the viewport.
  ...(adminMap ? {} : { minZoom: minimumZoom, maxBounds: [113.8, 22.1, 114.5, 22.6] as [number, number, number, number] }),
  maxZoom: initialMaxZoom,
  attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true },
})

map.getContainer().addEventListener('contextmenu', event => {
  if (event.pointerType === 'touch' || event.pointerType === 'pen') event.preventDefault()
}, { capture: true })

installArtworkSampling(map)
installNativeTileZoom(map, map.getMinZoom())
installBasemapPreload(map)

function installModeShortcuts(mapVisible: () => boolean) {
  const modes = { r: null, d: 'diagnostics', a: 'admin' } as const
  window.addEventListener('keydown', event => {
    if (kioskMode || !mapVisible() || event.repeat || event.isComposing ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="dialog"]'))) return
    const key = event.key.toLowerCase()
    if (key !== 'r' && key !== 'd' && key !== 'a') return
    event.preventDefault()
    const url = new URL(location.href)
    const selected = modes[key]
    const flags = ['admin', 'diagnostics']
    if (flags.every(flag => (url.searchParams.get(flag) === 'true') === (flag === selected))) return
    for (const flag of flags) url.searchParams.delete(flag)
    if (selected) url.searchParams.set(selected, 'true')
    history.replaceState({ ...history.state, atlasModeCamera: {
      center: map.getCenter().toArray(), zoom: map.getZoom(),
    } }, '', url)
    location.reload()
  })
}

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

const skipSplash = noSplashEnabled() || kioskMode
const audio = installAtlasAudio(map.getContainer(), {
  initiallyMuted: noMusicEnabled() || kioskMode,
})
const enterMap = () => {
  if (history.state?.atlasView !== 'map') {
    history.replaceState({ ...history.state, atlasView: 'pavilion' }, '')
    history.pushState({ ...history.state, atlasView: 'map' }, '')
  }
  audio.unlock()
}
const intro = createIntroSplash(map.getContainer(), enterMap, !skipSplash && !restoringMap, () => {
  audio.start()
  scheduleIdleReset()
}, audio.playPavilionCue)
const statement = installArtistStatement(map.getContainer(), {
  showMapTrigger: !adminModeEnabled(),
  onBookmarkPull: () => audio.playPavilionCue('book', 'pull'),
  onPavilionClose: () => audio.playPavilionCue('book', 'fall'),
})
const sharing = installAtlasSharing(map, audio)
const showPavilion = () => {
  window.clearTimeout(idleTimer)
  void statement.close()
  void intro.show()
  audio.stop()
  sharing.reset()
}
const returnToPavilion = () => {
  if (history.state?.atlasView === 'map') history.back()
  else showPavilion()
}
window.addEventListener('popstate', event => {
  if (event.state?.atlasView === 'pavilion') {
    showPavilion()
  } else if (event.state?.atlasView === 'map') {
    void statement.close()
    intro.dismiss()
  }
})
const idleDelay = 120_000
const kioskIdleDelay = 30_000
let idleTimer: number | undefined
let kioskTimer: number | undefined
let resetAtlas: (() => Promise<void>) | undefined
let isResetting = false
let kioskFlight: ReturnType<typeof createMapFlight> | undefined

const scheduleIdleReset = () => {
  if (kioskMode || !intro.element.hidden) return
  if (idleTimer) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(async () => {
    if (isResetting || !intro.element.hidden) return
    isResetting = true
    returnToPavilion()
    map.stop()
    map.easeTo({ ...initialView, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900 })
    try {
      await resetAtlas?.()
    } finally {
      isResetting = false
    }
  }, idleDelay)
}

const scheduleKioskFlight = () => {
  if (!kioskMode) return
  if (kioskTimer) window.clearTimeout(kioskTimer)
  kioskTimer = window.setTimeout(() => kioskFlight?.start(), kioskIdleDelay)
}

const noteActivity = () => {
  if (isResetting) return
  if (kioskMode) {
    kioskFlight?.pause()
    scheduleKioskFlight()
    return
  }
  scheduleIdleReset()
}

for (const type of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'touchstart', 'touchmove', 'keydown']) {
  window.addEventListener(type, noteActivity, { passive: true, capture: true })
}
if (skipSplash || restoringMap) map.once('click', () => audio.start())
window.addEventListener(
  'keydown',
  event => {
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault()
      event.stopPropagation()
      if (kioskMode) {
        kioskFlight?.pause()
        scheduleKioskFlight()
        return
      }
      returnToPavilion()
      noteActivity()
    }
  },
  { capture: true },
)
installModeShortcuts(() => Boolean(intro.element.hidden))
scheduleIdleReset()

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
map.on('load', async () => {
  if (adminModeEnabled()) {
    await installCachedTileAdmin(map)
    const atlas = installAtlasTileInteractions(map, audio, {
      cloudDiagnostics: cloudDiagnosticsModeEnabled(),
      noNoise: noNoiseEnabled(),
      onRevealCountChange: sharing.setRevealCount,
    })
    resetAtlas = async () => { await atlas.resetReveals() }
  } else {
    const reset = await installDiscoveryMap(map, diagnosticsModeEnabled(), noNoiseEnabled(),
      sharing.setRevealCount, audio)
    resetAtlas = async () => { await reset() }
  }

  if (kioskMode) {
    kioskFlight = createMapFlight(map, kioskFlightCenter)
    kioskFlight.start()
  }
})
