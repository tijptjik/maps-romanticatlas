import { artworkRequest, installArtworkEdgeFade } from './artwork-edge-fade.ts'
import { installArtworkSampling } from './artwork-sampling.ts'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { installDiscoveryMap } from './v2-discovery-map'
import { installCachedTileAdmin } from './cached-tile-admin'
import { installAtlasTileInteractions, minimumFogZoom } from './atlas-tiles'
import { installV2ReviewMap } from './v2-review-map'
import type { Pavilion } from './landing'
import { installAtlasSharing } from './atlas-sharing.ts'
import { createMapFlight } from './map-flight.ts'
import { hongKongStyle } from './map-style.ts'
import { atlasTileSize, modeEnabled } from './atlas-protocol.ts'
import { installNativeTileZoom, nativeTileZoom } from './native-tile-zoom.ts'
import { installBasemapPreload } from './basemap-preload.ts'
import {
  mapModePath,
  adminModeEnabled,
  reviewModeEnabled,
  reviewQueueEnabled,
  revealedModeEnabled,
  diagnosticsModeEnabled,
  cloudDiagnosticsModeEnabled,
  noNoiseEnabled,
  kioskModeEnabled,
} from './runtime-modes.ts'

// Vite emits MapLibre's module worker as a self-contained same-origin asset.
maplibregl.setWorkerUrl(workerUrl)

const initialView = {
  center: [114.13765, 22.28364] as [number, number],
  zoom: 17,
  bearing: 0,
  pitch: 0,
}

const kioskFlightCenter = [114.1455, 22.2759] as [number, number]
const reviewMode = reviewModeEnabled()
const kioskMode = kioskModeEnabled()
// The review overview can span several districts, including on narrow screens.
const adminMap = !reviewMode && adminModeEnabled()
const minimumZoom = reviewMode ? 10 : diagnosticsModeEnabled() ? minimumFogZoom : 16
const nativeMaxZoom = nativeTileZoom(atlasTileSize)
const initialMaxZoom = adminMap ? nativeMaxZoom : Math.max(minimumZoom, nativeMaxZoom)

installArtworkEdgeFade()
const map = new maplibregl.Map({
  transformRequest: artworkRequest,
  container: 'map',
  style: hongKongStyle,
  ...initialView,
  ...(history.state?.atlasModeCamera ?? {}),
  maxPitch: 0,
  dragRotate: false,
  keyboard: false,
  touchZoomRotate: true,
  touchPitch: false,
  pitchWithRotate: false,
  // Atlas interactions use the z18 tile grid. The fog remains visible above it,
  // while generation still requires a complete z18 tile in the viewport.
  ...(adminMap ? {} : { minZoom: minimumZoom, maxBounds: [113.8, 22.1, 114.5, 22.6] as [number, number, number, number] }),
  maxZoom: reviewQueueEnabled() ? 22 : initialMaxZoom,
  attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true },
})

map.getContainer().addEventListener('contextmenu', event => {
  if (event.pointerType === 'touch' || event.pointerType === 'pen') event.preventDefault()
}, { capture: true })

map.touchZoomRotate.disableRotation()
installArtworkSampling(map)
if (!reviewQueueEnabled()) installNativeTileZoom(map, map.getMinZoom())
installBasemapPreload(map)

function installModeShortcuts(mapVisible: () => boolean) {
  const modes = { r: null, d: 'diagnostics', a: 'admin', v: 'review', w: 'revealed' } as const
  window.addEventListener('keydown', event => {
    if (kioskMode || !mapVisible() || event.repeat || event.isComposing ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="dialog"]'))) return
    const key = event.key.toLowerCase()
    if (reviewQueueEnabled() && key === 'a') return
    if (key !== 'r' && key !== 'd' && key !== 'a' && key !== 'v' && key !== 'w') return
    event.preventDefault()
    const url = new URL(location.href)
    const selected = modes[key]
    const flags = ['admin', 'diagnostics', 'review', 'revealed']
    if (!reviewQueueEnabled() && flags.every(flag => modeEnabled(url.searchParams, flag) === (flag === selected))) return
    if (reviewQueueEnabled()) url.pathname = '/'
    for (const flag of flags) url.searchParams.delete(flag)
    if (selected) url.searchParams.set(selected, '')
    history.replaceState({ ...history.state, atlasModeCamera: {
      center: map.getCenter().toArray(), zoom: map.getZoom(),
    } }, '', mapModePath(url))
    location.reload()
  })
}

map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: reviewMode ? undefined :
    '<a href="https://github.com/tijptjik/maps-romanticatlas/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">Sounds</a>',
}))
// Initialize the compact state before asynchronous source credits arrive.
const credits = map.getContainer().querySelector<HTMLDetailsElement>('.maplibregl-ctrl-attrib')!
credits.classList.add('maplibregl-compact')
credits.classList.remove('maplibregl-compact-show')
credits.open = false

if (reviewMode) {
  installModeShortcuts(() => true)
  map.once('load', () => {
    if (reviewQueueEnabled()) void installDiscoveryMap(map, 'queue', true, () => {}, undefined)
    else installV2ReviewMap(map)
  })
}

export function startAtlas(pavilion: Pavilion) {
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

  const { audio, intro, returnToPavilion } = pavilion
  const sharing = installAtlasSharing(map, audio)
  pavilion.onReturn = () => {
    window.clearTimeout(idleTimer)
    sharing.reset()
  }
  const idleDelay = 120_000
  const kioskIdleDelay = 30_000
  let idleTimer: number | undefined
  let kioskTimer: number | undefined
  let resetAtlas: (() => Promise<void>) | undefined
  let isResetting = false
  let kioskFlight: ReturnType<typeof createMapFlight> | undefined

  function scheduleIdleReset() {
    if (kioskMode || revealedModeEnabled() || !intro.element.hidden) return
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
  pavilion.onMapVisible = scheduleIdleReset

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

  map.getContainer().addEventListener('atlas-generation-progress', noteActivity)

  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'touchstart', 'touchmove', 'keydown']) {
    window.addEventListener(type, noteActivity, { passive: true, capture: true })
  }
  if (pavilion.directEntry) map.once('click', () => audio.start())
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
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || kioskMode ||
        intro.element.classList.contains('is-visible')) return
    event.preventDefault()
    returnToPavilion()
  })
  scheduleIdleReset()

  map.on('load', async () => {
    const params = new URLSearchParams(location.search)
    if (adminMap && (params.get('view') === 'cache' || params.has('version'))) {
      await installCachedTileAdmin(map)
      const atlas = installAtlasTileInteractions(map, audio, {
        cloudDiagnostics: cloudDiagnosticsModeEnabled(),
        noNoise: noNoiseEnabled(),
        onRevealCountChange: sharing.setRevealCount,
      })
      resetAtlas = async () => { await atlas.resetReveals() }
    } else {
      const reset = await installDiscoveryMap(map, adminMap ? 'admin' : diagnosticsModeEnabled(), noNoiseEnabled(),
        sharing.setRevealCount, audio, revealedModeEnabled() && !diagnosticsModeEnabled())
      resetAtlas = async () => { await reset() }
    }

    if (kioskMode) {
      kioskFlight = createMapFlight(map, kioskFlightCenter)
      kioskFlight.start()
    }
  })
}
