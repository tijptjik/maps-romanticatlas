import * as maplibregl from 'maplibre-gl'
import { createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards.ts'
import { captureTile, tileHasSea } from './atlas-tiles.ts'
import { atlasSceneNames, pickAtlasScene, type AtlasScene } from './atlas-scenes.ts'
import { atlasZoom, tileBounds, tileForPosition, tilePolygon } from './tile-geometry.ts'
import { runtimeModeUrl } from './runtime-modes.ts'
import { installAdminTileGrid } from './admin-tile-grid.ts'

const adminControlId = 'atlas-admin-delete-control'
const adminStatusId = 'atlas-admin-status'
const adminTokenStorageKey = 'atlas-admin-token'
const csrfCookieName = 'atlas_csrf'
const selectionSourceId = 'atlas-admin-tile-selection'
const selectionLayerId = 'atlas-admin-tile-selection-outline'
const rasterSourceId = 'atlas-admin-cached-tiles'
const rasterLayerId = 'atlas-admin-cached-tiles'
const rasterProtocol = 'atlas-admin-cache'
const transparentRasterTile = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  ),
  character => character.charCodeAt(0),
).buffer

const tileKey = tile =>
  `${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}/v${tile.version}/${tile.variant ?? 'default'}`
const tilePositionKey = tile => `${tile.zoom}/${tile.x}/${tile.y}`
const sceneLabel = scene =>
  scene
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const controlIcons = {
  delete:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 .8 13h8.4L16 7M10 11v5m4-5v5"/><path d="M3 7h18"/></svg>',
  cycle:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3.2c4.7 0 5 10 9.7 10H20"/><path d="m16 14 4 3-4 3M4 17h3.2c1.8 0 3.1-1.5 4.1-3.3"/><path d="M16 4l4 3-4 3"/></svg>',
  rerender:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 11.8-11.8 2 2L7 21H5v-2Z"/><path d="m14.8 6.2 1.1-1.1M18.6 7.4h1.6M17.8 4.2v1.6"/><path d="m4 6 1 2.1L7 9l-2 1-1 2.1L3 10 1 9l2-0.9L4 6Z"/></svg>',
}

const setControlIcon = (control, icon, label) => {
  control.innerHTML = controlIcons[icon]
  control.setAttribute('aria-label', label)
  control.title = label
}

const firstLabelLayerId = map =>
  map.getStyle().layers.find(layer => layer.type === 'symbol')?.id

const storedAdminToken = () => {
  try {
    return sessionStorage.getItem(adminTokenStorageKey)
  } catch {
    return null
  }
}

const csrfToken = () =>
  document.cookie
    .split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${csrfCookieName}=`))
    ?.slice(csrfCookieName.length + 1) ?? null

export const fetchAdmin = async (url, options: RequestInit = {}) => {
  const makeRequest = token => {
    const headers = new Headers(options.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(runtimeModeUrl(url), { ...options, headers })
  }

  let token = storedAdminToken()
  let response = await makeRequest(token)
  if (response.status !== 401) return response

  const enteredToken = window.prompt('Enter the Atlas admin token')?.trim()
  if (!enteredToken) return response
  token = enteredToken
  try {
    sessionStorage.setItem(adminTokenStorageKey, token)
  } catch {
    // The token can still be used for this request when session storage is unavailable.
  }
  response = await makeRequest(token)
  if (response.status === 401) {
    try {
      sessionStorage.removeItem(adminTokenStorageKey)
    } catch {
      // Ignore storage errors; the failed credential is not reused in this tab.
    }
  }
  return response
}

const rasterTileCoordinates = url => {
  const match = new URL(url).pathname.match(/^\/(\d+)\/(\d+)\/(\d+)$/)
  return match
    ? { zoom: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
    : null
}

const installCachedTileRasterSource = (map, activeTilesByPosition) => {
  maplibregl.addProtocol(rasterProtocol, async ({ url }, abortController) => {
    const rasterTile = rasterTileCoordinates(url)
    if (!rasterTile || rasterTile.zoom > atlasZoom)
      return { data: transparentRasterTile.slice(0) }

    const tileSpan = 2 ** (atlasZoom - rasterTile.zoom)
    const minX = rasterTile.x * tileSpan
    const minY = rasterTile.y * tileSpan
    const tiles = [...activeTilesByPosition.values()].filter(
      tile =>
        tile.x >= minX &&
        tile.x < minX + tileSpan &&
        tile.y >= minY &&
        tile.y < minY + tileSpan,
    )
    if (!tiles.length) return { data: transparentRasterTile.slice(0) }

    if (rasterTile.zoom === atlasZoom) {
      const response = await fetch(tiles[0].url, { signal: abortController.signal })
      if (!response.ok) return { data: transparentRasterTile.slice(0) }
      return {
        data: await response.arrayBuffer(),
        cacheControl: response.headers.get('cache-control') ?? undefined,
        expires: response.headers.get('expires') ?? undefined,
      }
    }

    const plates = await Promise.all(
      tiles.map(async tile => {
        const response = await fetch(tile.url, { signal: abortController.signal })
        if (!response.ok) return null
        return { tile, image: await createImageBitmap(await response.blob()) }
      }),
    )
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) return { data: transparentRasterTile.slice(0) }
    const plateSize = 512 / tileSpan
    plates.forEach(plate => {
      if (!plate) return
      context.drawImage(
        plate.image,
        (plate.tile.x - minX) * plateSize,
        (plate.tile.y - minY) * plateSize,
        plateSize,
        plateSize,
      )
      plate.image.close()
    })
    return { data: await createImageBitmap(canvas) }
  })

  map.addSource(rasterSourceId, {
    type: 'raster',
    tiles: [`${rasterProtocol}://tiles/{z}/{x}/{y}`],
    minzoom: 12,
    maxzoom: atlasZoom,
    tileSize: 512,
  })
  map.addLayer(
    {
      id: rasterLayerId,
      type: 'raster',
      source: rasterSourceId,
      paint: {
        'raster-opacity': 0.94,
        'raster-fade-duration': 0,
      },
    },
    firstLabelLayerId(map),
  )

  let revision = 0
  return () => {
    revision += 1
    map
      .getSource(rasterSourceId)
      ?.setTiles([`${rasterProtocol}://tiles/{z}/{x}/{y}?revision=${revision}`])
  }
}

export const installCachedTileAdmin = async map => {
  try {
    const replayVersion = new URLSearchParams(window.location.search).get('version')
    const manifestUrl = replayVersion
      ? `/api/atlas-tiles/cached?version=${encodeURIComponent(replayVersion)}`
      : '/api/atlas-tiles/cached'
    const response = await fetchAdmin(manifestUrl)
    if (!response.ok)
      throw new Error(`Cache manifest request failed with ${response.status}`)
    const body = await response.json()
    if (body.adminMode !== true) return
    map.setMinZoom(12)

    const tiles = Array.isArray(body.tiles)
      ? body.tiles.filter(tile => tile?.url && tile.scene)
      : []
    let preRenderedCount = Number.isFinite(Number(body.preRenderedCount))
      ? Number(body.preRenderedCount)
      : tiles.length
    const version =
      typeof body.version === 'number' && Number.isInteger(body.version)
        ? body.version
        : null
    const tilesByPosition = new Map()
    const activeTilesByPosition = new Map()
    tiles.forEach(tile => {
      const positionKey = tilePositionKey(tile)
      const positionTiles = tilesByPosition.get(positionKey) ?? []
      positionTiles.push(tile)
      tilesByPosition.set(positionKey, positionTiles)
      activeTilesByPosition.set(positionKey, positionTiles.at(-1))
    })
    const refreshCachedTileRaster = installCachedTileRasterSource(
      map,
      activeTilesByPosition,
    )

    const titleCards = new Map()
    tiles.forEach(tile => {
      const card = createAtlasTitleCard(map.getContainer(), tile.scene)
      const positionKey = tilePositionKey(tile)
      card.hidden = activeTilesByPosition.get(positionKey) !== tile
      titleCards.set(tileKey(tile), { card, tile })
    })

    const container = map.getContainer()
    container.classList.add('atlas-admin-mode')

    map.addSource(selectionSourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: selectionLayerId,
      type: 'line',
      source: selectionSourceId,
      paint: {
        'line-color': '#e11d2e',
        'line-width': 3,
        'line-opacity': 0.95,
      },
    })
    installAdminTileGrid(map)

    const actionBar = document.createElement('div')
    actionBar.className = 'atlas-admin-actions'
    actionBar.setAttribute('aria-label', 'Tile actions')
    actionBar.hidden = true
    container.append(actionBar)

    const status = document.createElement('div')
    status.id = adminStatusId
    status.className = 'atlas-admin-status'
    const updateStatus = () => {
      const versionLabel = version ? ` · VERSION: v${version}` : ''
      status.textContent = `ADMIN MODE · PRE-RENDERS: ${preRenderedCount}${versionLabel} · select a tile to manage or render it`
    }
    updateStatus()
    container.append(status)

    const deleteControl = document.createElement('button')
    deleteControl.id = adminControlId
    deleteControl.className = 'atlas-admin-delete'
    deleteControl.type = 'button'
    deleteControl.hidden = true
    setControlIcon(deleteControl, 'delete', 'Delete cached image')
    actionBar.append(deleteControl)

    const cycleControl = document.createElement('button')
    cycleControl.id = 'atlas-admin-cycle-control'
    cycleControl.className = 'atlas-admin-cycle'
    cycleControl.type = 'button'
    cycleControl.hidden = true
    setControlIcon(cycleControl, 'cycle', 'Shuffle cached images')
    actionBar.append(cycleControl)

    const rerenderControl = document.createElement('button')
    rerenderControl.id = 'atlas-admin-rerender-control'
    rerenderControl.className = 'atlas-admin-rerender'
    rerenderControl.type = 'button'
    rerenderControl.hidden = true
    setControlIcon(rerenderControl, 'rerender', 'Render a new scene')
    actionBar.append(rerenderControl)

    const renderingOverlay = document.createElement('section')
    renderingOverlay.className = 'atlas-admin-rendering'
    renderingOverlay.hidden = true
    renderingOverlay.setAttribute('aria-live', 'polite')
    renderingOverlay.setAttribute('aria-atomic', 'true')

    const renderingPanel = document.createElement('div')
    renderingPanel.className = 'atlas-admin-rendering__panel'
    const renderingKicker = document.createElement('span')
    renderingKicker.className = 'atlas-admin-rendering__kicker'
    renderingKicker.textContent = 'Atlas press at work'
    const renderingTitle = document.createElement('strong')
    renderingTitle.className = 'atlas-admin-rendering__title'
    const renderingMessage = document.createElement('p')
    renderingMessage.className = 'atlas-admin-rendering__message'
    const renderingProgress = document.createElement('span')
    renderingProgress.className = 'atlas-admin-rendering__progress'

    renderingPanel.append(
      renderingKicker,
      renderingTitle,
      renderingMessage,
      renderingProgress,
    )
    renderingOverlay.append(renderingPanel)
    container.append(renderingOverlay)

    const countBadges = new Map()
    const versionLabels = new Map()
    tilesByPosition.forEach((positionTiles, positionKey) => {
      const [zoom, x, y] = positionKey.split('/').map(Number)
      const badge = document.createElement('div')
      badge.className = 'atlas-admin-count'
      badge.setAttribute('aria-label', `${positionTiles.length} pre-rendered images`)
      badge.textContent = String(positionTiles.length)
      container.append(badge)
      countBadges.set(positionKey, { badge, tile: { zoom, x, y } })

      const versionLabel = document.createElement('div')
      versionLabel.className = 'atlas-admin-version'
      const activeTile = activeTilesByPosition.get(positionKey)
      versionLabel.textContent = `v${activeTile.version}`
      versionLabel.setAttribute('aria-label', `Image version ${activeTile.version}`)
      container.append(versionLabel)
      versionLabels.set(positionKey, versionLabel)
    })

    let selectedTile = null
    let selectedPosition = null
    let deleting = false
    const renderingByPosition = new Map()
    let captureQueue = Promise.resolve()

    const updateRenderingOverlay = (tile, message) => {
      const rendering = renderingByPosition.get(tilePositionKey(tile))
      if (rendering) rendering.message = message
      if (
        !selectedPosition ||
        tilePositionKey(selectedPosition) !== tilePositionKey(tile)
      )
        return
      renderingTitle.textContent = `Rendering ${sceneLabel(tile.scene)}`
      renderingMessage.textContent = message
    }

    const positionRenderingOverlay = tile => {
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      const canvas = map.getCanvas()
      const left = Math.max(0, northWest.x)
      const top = Math.max(0, northWest.y)
      const right = Math.min(canvas.clientWidth, southEast.x)
      const bottom = Math.min(canvas.clientHeight, southEast.y)
      const visible = right > left && bottom > top

      renderingOverlay.hidden = !visible
      if (!visible) return
      renderingOverlay.classList.toggle(
        'atlas-admin-rendering--compact',
        right - left < 180 || bottom - top < 180,
      )
      renderingOverlay.style.left = `${left}px`
      renderingOverlay.style.top = `${top}px`
      renderingOverlay.style.width = `${right - left}px`
      renderingOverlay.style.height = `${bottom - top}px`
    }

    const positionOverlay = (element, tile, alignRight = false) => {
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      const canvas = map.getCanvas()
      const visible =
        southEast.x >= 0 &&
        southEast.y >= 0 &&
        northWest.x <= canvas.clientWidth &&
        northWest.y <= canvas.clientHeight
      element.hidden = !visible
      if (!visible) return
      const elementWidth = element.offsetWidth || (alignRight ? 170 : 110)
      const left = alignRight ? southEast.x - elementWidth - 8 : northWest.x + 8
      element.style.left = `${Math.max(8, Math.min(canvas.clientWidth - elementWidth - 8, left))}px`
      element.style.top = `${Math.max(8, Math.min(canvas.clientHeight - 40, northWest.y + 8))}px`
    }

    const positionActionBar = tile => {
      const bounds = tileBounds(tile)
      const northWest = map.project([bounds.west, bounds.north])
      const southEast = map.project([bounds.east, bounds.south])
      const canvas = map.getCanvas()
      const tileLeft = Math.max(8, northWest.x)
      const tileRight = Math.min(canvas.clientWidth - 8, southEast.x)
      const tileTop = Math.max(8, northWest.y)
      const tileBottom = Math.min(canvas.clientHeight - 8, southEast.y)
      const tileWidth = Math.abs(southEast.x - northWest.x)
      const maxActionBarWidth = Math.max(1, tileWidth * 0.82)
      actionBar.style.maxWidth = `${maxActionBarWidth}px`
      const barWidth = actionBar.offsetWidth
      const barHeight = actionBar.offsetHeight
      const tileCenter = (tileLeft + tileRight) / 2
      const left = Math.max(
        8,
        Math.min(canvas.clientWidth - barWidth - 8, tileCenter - barWidth / 2),
      )
      const top = Math.max(
        tileTop + 8,
        Math.min(canvas.clientHeight - barHeight - 8, tileBottom - barHeight - 12),
      )

      actionBar.style.left = `${left}px`
      actionBar.style.top = `${top}px`
      actionBar.style.bottom = 'auto'
      actionBar.style.transform = 'none'
    }

    const showRenderingFeedback = tile => {
      const rendering = renderingByPosition.get(tilePositionKey(tile))
      if (!rendering) return false
      actionBar.hidden = true
      deleteControl.hidden = true
      cycleControl.hidden = true
      rerenderControl.hidden = true
      updateRenderingOverlay(rendering.tile, rendering.message)
      // Do not depend on a later map movement to repaint the status. A new
      // tile has no cached image layer to trigger one, so its rendering state
      // must make the overlay visible immediately.
      renderingOverlay.hidden = false
      positionRenderingOverlay(rendering.tile)
      return true
    }

    const positionControl = () => {
      titleCards.forEach(({ card, tile }) => {
        const positionKey = tilePositionKey(tile)
        card.hidden = activeTilesByPosition.get(positionKey) !== tile
        if (!card.hidden) positionAtlasTitleCard(map, card, tile, tile.contentBounds)
      })
      countBadges.forEach(({ badge, tile }) => {
        positionOverlay(badge, tile)
      })
      versionLabels.forEach((label, positionKey) => {
        const activeTile = activeTilesByPosition.get(positionKey)
        label.hidden = !activeTile
        if (!activeTile) return
        label.textContent = `v${activeTile.version}`
        label.setAttribute('aria-label', `Image version ${activeTile.version}`)
        positionOverlay(label, activeTile, true)
      })
      const rendering = selectedPosition
        ? renderingByPosition.get(tilePositionKey(selectedPosition))
        : null
      if (rendering) {
        showRenderingFeedback(rendering.tile)
        return
      }
      renderingOverlay.hidden = true
      if (!selectedPosition) {
        actionBar.hidden = true
        deleteControl.hidden = true
        cycleControl.hidden = true
        rerenderControl.hidden = true
        return
      }
      actionBar.hidden = false
      rerenderControl.hidden = false
      if (!selectedTile) {
        deleteControl.hidden = true
        cycleControl.hidden = true
        setControlIcon(
          rerenderControl,
          'rerender',
          `Render a new scene at ${selectedPosition.x}/${selectedPosition.y}`,
        )
        positionActionBar(selectedPosition)
        return
      }
      deleteControl.hidden = false
      setControlIcon(
        deleteControl,
        'delete',
        `Delete ${sceneLabel(selectedTile.scene)}`,
      )
      const candidates = tilesByPosition.get(tilePositionKey(selectedTile)) ?? []
      cycleControl.hidden = false
      cycleControl.disabled = candidates.length < 2
      cycleControl.title =
        candidates.length < 2 ? 'No alternate image' : 'Show next image'
      setControlIcon(rerenderControl, 'rerender', 'Render a different scene')
      positionActionBar(selectedTile)
    }

    const updateSelectionOutline = () => {
      const source = map.getSource(selectionSourceId)
      if (!source) return
      source.setData({
        type: 'FeatureCollection',
        features:
          selectedPosition && !selectedTile
            ? [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'Polygon',
                    coordinates: [tilePolygon(selectedPosition)],
                  },
                },
              ]
            : [],
      })
    }

    const selectTileAt = point => {
      const position = tileForPosition(point)
      const positionKey = `${atlasZoom}/${position.x}/${position.y}`
      const candidates = tilesByPosition.get(positionKey)
      selectedPosition = { ...position, zoom: atlasZoom }
      selectedTile =
        activeTilesByPosition.get(positionKey) ?? candidates?.at(-1) ?? null
      deleteControl.hidden = !selectedTile
      cycleControl.hidden = !selectedTile
      rerenderControl.hidden = !selectedTile
      if (selectedTile) {
        setControlIcon(
          deleteControl,
          'delete',
          `Delete ${sceneLabel(selectedTile.scene)}`,
        )
      }
      updateSelectionOutline()
      positionControl()
    }

    map.on('click', event => {
      // MapLibre observes the button click through its own handler even after
      // the control stops DOM propagation. Without this guard, pressing the
      // render button selects the tile beneath the button (often a neighbour)
      // and positionControl immediately hides the active render overlay.
      const target = event.originalEvent.target
      if (target instanceof Element && target.closest('.atlas-admin-actions')) return
      selectTileAt(event.lngLat)
    })
    const mapEvents = ['move', 'resize', 'zoom', 'rotate', 'pitch']
    mapEvents.forEach(eventName => {
      map.on(eventName, positionControl)
    })
    positionControl()

    cycleControl.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      if (!selectedTile) return
      const positionKey = tilePositionKey(selectedTile)
      const candidates = tilesByPosition.get(positionKey) ?? []
      if (candidates.length < 2) return
      const currentIndex = candidates.findIndex(
        candidate => tileKey(candidate) === tileKey(selectedTile),
      )
      const nextTile = candidates[(currentIndex + 1) % candidates.length]
      activeTilesByPosition.set(positionKey, nextTile)
      selectedTile = nextTile
      candidates.forEach(candidate => {
        const titleCard = titleCards.get(tileKey(candidate))?.card
        if (titleCard) titleCard.hidden = candidate !== nextTile
      })
      refreshCachedTileRaster()
      setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(nextTile.scene)}`)
      positionControl()
    })

    const updateCountBadge = (positionKey, count) => {
      const countBadge = countBadges.get(positionKey)?.badge
      if (!countBadge) return
      countBadge.textContent = String(count)
      countBadge.setAttribute('aria-label', `${count} pre-rendered images`)
    }

    const focusTileForCapture = tile =>
      new Promise<void>(resolve => {
        const bounds = tileBounds(tile)
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north],
          ],
          { padding: 24, duration: 0, maxZoom: atlasZoom },
        )
        // A newly selected admin tile has no raster image layer yet, so waiting
        // for MapLibre's global idle state can defer both capture and visible
        // feedback behind unrelated source work. The zero-duration camera update
        // is synchronous; capture on the next frame instead.
        requestAnimationFrame(() => resolve())
      })

    const captureForRerender = (tile, renderingTile) => {
      const capture = captureQueue.then(async () => {
        updateRenderingOverlay(renderingTile, 'Preparing the map reference…')
        showRenderingFeedback(renderingTile)
        // An additional scene must start from the underlying map geometry, not
        // from the active cached plate at this position. Otherwise the image
        // model receives its own previous output as the source reference and
        // extends that scene instead of fitting the map beneath it.
        const cachedRasterVisibility = map.getLayoutProperty(
          rasterLayerId,
          'visibility',
        )
        map.setLayoutProperty(rasterLayerId, 'visibility', 'none')
        try {
          await focusTileForCapture(tile)
          showRenderingFeedback(renderingTile)
          return await captureTile(map, tile)
        } finally {
          map.setLayoutProperty(
            rasterLayerId,
            'visibility',
            cachedRasterVisibility ?? 'visible',
          )
          map.triggerRepaint()
        }
      })
      // Keep later captures moving if this one fails. The render that owns the
      // failed capture still receives its rejection and reports the error.
      captureQueue = capture.catch(() => undefined)
      return capture
    }

    const installRerenderedTile = tile => {
      const positionKey = tilePositionKey(tile)
      const replacesSelectedTile =
        selectedPosition && tilePositionKey(selectedPosition) === positionKey
      const candidates = tilesByPosition.get(positionKey) ?? []
      const matchingIndex = candidates.findIndex(
        candidate => tileKey(candidate) === tileKey(tile),
      )
      const replaced = matchingIndex >= 0 ? candidates[matchingIndex] : null

      if (replaced) {
        titleCards.get(tileKey(replaced))?.card.remove()
        titleCards.delete(tileKey(replaced))
        candidates.splice(matchingIndex, 1, tile)
        const index = tiles.findIndex(
          candidate => tileKey(candidate) === tileKey(replaced),
        )
        if (index >= 0) tiles.splice(index, 1, tile)
      } else {
        candidates.push(tile)
        tiles.push(tile)
        preRenderedCount += 1
      }

      tilesByPosition.set(positionKey, candidates)
      const card = createAtlasTitleCard(container, tile.scene)
      titleCards.set(tileKey(tile), { card, tile })
      activeTilesByPosition.set(positionKey, tile)
      // A render recenters the map for capture, but the operator may then pan
      // to and select another cached tile while the request is in flight. Do
      // not make the completed request steal that newer selection.
      if (replacesSelectedTile) {
        selectedTile = tile
        selectedPosition = { zoom: tile.zoom, x: tile.x, y: tile.y }
      }
      refreshCachedTileRaster()
      updateCountBadge(positionKey, candidates.length)
      updateStatus()
      updateSelectionOutline()
      positionControl()
    }

    rerenderControl.addEventListener('click', async event => {
      event.preventDefault()
      event.stopPropagation()
      if (!selectedPosition) return

      const tile = selectedTile ?? selectedPosition
      const selectedTileAtRenderStart = selectedTile
      const positionKey = tilePositionKey(tile)
      const renderingNewTile = !selectedTileAtRenderStart
      if (renderingByPosition.has(positionKey)) return

      renderingByPosition.set(positionKey, {
        tile: selectedTileAtRenderStart ?? { ...tile, scene: 'new-scene' },
        message: 'Finding an unused scene…',
      })
      showRenderingFeedback(tile)
      try {
        // Cache status is the same 9×9 scene lookup used by ordinary tile
        // generation. It deliberately includes scenes already cached at this
        // exact coordinate, so rerenders do not duplicate a local event.
        const statusResponse = await fetch(
          `/api/atlas-tiles/cache-status/${tile.zoom}/${tile.x}/${tile.y}`,
          { cache: 'no-store' },
        )
        const status = await statusResponse.json().catch(() => null)
        if (!statusResponse.ok) {
          throw new Error(
            status?.error ?? `Cache lookup failed with HTTP ${statusResponse.status}`,
          )
        }
        const scenes = Array.isArray(status?.scenes)
          ? status.scenes.filter(
              (scene): scene is AtlasScene =>
                typeof scene === 'string' &&
                atlasSceneNames.includes(scene as AtlasScene),
            )
          : []

        // Always exclude the selected scene too. The status response should
        // contain it, but this makes a different scene an invariant even if a
        // stale manifest response omits the current image. Include selected
        // scenes from active overlapping renders as well: they are not in the
        // manifest yet, but must still reserve their place in the 9×9 grid.
        const reservedScenes = [...renderingByPosition.values()]
          .filter(
            ({ tile: renderingTile }) =>
              Math.abs(renderingTile.x - tile.x) <= 4 &&
              Math.abs(renderingTile.y - tile.y) <= 4,
          )
          .map(({ tile: renderingTile }) => renderingTile.scene)
        const scene = pickAtlasScene(tileHasSea(map, tile), [
          ...scenes,
          ...(selectedTileAtRenderStart ? [selectedTileAtRenderStart.scene] : []),
          ...reservedScenes,
        ])
        const renderingScene = { ...tile, scene }
        renderingByPosition.set(positionKey, {
          tile: renderingScene,
          message: 'Waiting to prepare the map reference…',
        })
        showRenderingFeedback(renderingScene)
        const capturedTile = await captureForRerender(tile, renderingScene)
        updateRenderingOverlay(
          renderingScene,
          'Setting the new scene in ink and watercolour…',
        )
        showRenderingFeedback(renderingScene)
        const generationPath = `/api/atlas-tiles/${tile.zoom}/${tile.x}/${tile.y}/${scene}`
        const response = renderingNewTile
          ? await fetch(generationPath, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...capturedTile, hasSea: tileHasSea(map, tile) }),
            })
          : await fetchAdmin(`${generationPath}?rerender=true`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-atlas-csrf-token': csrfToken() ?? '',
              },
              body: JSON.stringify({ ...capturedTile, hasSea: tileHasSea(map, tile) }),
            })
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(body?.error ?? `Rerender failed with HTTP ${response.status}`)
        }
        if (
          typeof body?.url !== 'string' ||
          !atlasSceneNames.includes(body.scene as AtlasScene)
        ) {
          throw new Error('The rerender response did not include a valid tile image.')
        }

        updateRenderingOverlay(renderingScene, 'Placing the finished atlas plate…')
        showRenderingFeedback(renderingScene)
        installRerenderedTile({
          zoom: tile.zoom,
          x: tile.x,
          y: tile.y,
          scene: body.scene as AtlasScene,
          version: Number.isInteger(body.version) ? body.version : tile.version,
          variant: typeof body.variant === 'string' ? body.variant : 'default',
          url: body.url,
          contentBounds: body.contentBounds ?? null,
        })
      } catch (error) {
        rerenderControl.title =
          error instanceof Error ? error.message : 'Rerender failed'
      } finally {
        renderingByPosition.delete(positionKey)
        updateSelectionOutline()
        positionControl()
      }
    })

    deleteControl.addEventListener('click', async event => {
      event.preventDefault()
      event.stopPropagation()
      if (!selectedTile || deleting) return
      const tile = selectedTile
      if (
        !window.confirm(
          `Delete the cached ${tile.scene} image for ${tile.x}/${tile.y}?`,
        )
      )
        return

      deleting = true
      deleteControl.disabled = true
      deleteControl.textContent = 'Deleting…'
      try {
        const response = await fetchAdmin(
          `/api/atlas-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}?version=${tile.version}&variant=${encodeURIComponent(tile.variant ?? 'default')}`,
          {
            method: 'DELETE',
            headers: {
              'x-atlas-csrf-token': csrfToken() ?? '',
            },
          },
        )
        const body = await response.json().catch(() => null)
        if (!response.ok)
          throw new Error(body?.error ?? `Delete failed with HTTP ${response.status}`)

        titleCards.get(tileKey(tile))?.card.remove()
        titleCards.delete(tileKey(tile))
        const positionKey = tilePositionKey(tile)
        const remaining = (tilesByPosition.get(positionKey) ?? []).filter(
          candidate => tileKey(candidate) !== tileKey(tile),
        )
        if (remaining.length) {
          tilesByPosition.set(positionKey, remaining)
          activeTilesByPosition.set(positionKey, remaining.at(-1))
        } else {
          tilesByPosition.delete(positionKey)
          activeTilesByPosition.delete(positionKey)
          countBadges.get(positionKey)?.badge.remove()
          countBadges.delete(positionKey)
          versionLabels.get(positionKey)?.remove()
          versionLabels.delete(positionKey)
        }
        refreshCachedTileRaster()
        const countBadge = countBadges.get(positionKey)?.badge
        if (countBadge) {
          countBadge.textContent = String(remaining.length)
          countBadge.setAttribute(
            'aria-label',
            `${remaining.length} pre-rendered images`,
          )
        }
        const index = tiles.findIndex(candidate => tileKey(candidate) === tileKey(tile))
        if (index >= 0) tiles.splice(index, 1)
        preRenderedCount = Math.max(0, preRenderedCount - 1)
        selectedTile = remaining.at(-1) ?? null
        selectedPosition = { zoom: tile.zoom, x: tile.x, y: tile.y }
        updateStatus()
        deleteControl.hidden = !selectedTile
        cycleControl.hidden = !selectedTile
        if (selectedTile) {
          setControlIcon(
            deleteControl,
            'delete',
            `Delete ${sceneLabel(selectedTile.scene)}`,
          )
        }
        updateSelectionOutline()
        positionControl()
      } catch (error) {
        deleteControl.textContent =
          error instanceof Error ? error.message : 'Delete failed'
      } finally {
        deleting = false
        deleteControl.disabled = false
        if (selectedTile) {
          setControlIcon(
            deleteControl,
            'delete',
            `Delete ${sceneLabel(selectedTile.scene)}`,
          )
        }
      }
    })

    console.info(
      `Cached tile admin: ${tiles.length} image${tiles.length === 1 ? '' : 's'}`,
    )
  } catch (error) {
    console.warn('Cached tile admin could not load.', error)
  }
}
