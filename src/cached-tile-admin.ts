import { createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards.ts'
import { captureTile, tileHasSea } from './atlas-tiles.ts'
import { atlasSceneNames, pickAtlasScene, type AtlasScene } from './atlas-scenes.ts'
import { atlasZoom, tileBounds, tileForPosition } from './tile-geometry.ts'
import { runtimeModeUrl } from './runtime-modes.ts'

const adminControlId = 'atlas-admin-delete-control'
const adminStatusId = 'atlas-admin-status'
const adminTokenStorageKey = 'atlas-admin-token'
const csrfCookieName = 'atlas_csrf'

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
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9.2A7 7 0 0 1 18.8 7M17.9 14.8A7 7 0 0 1 5.2 17"/></svg>',
  rerender:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L4 9"/><path d="M4 4v5h5M4 13a8 8 0 0 0 14.9 4L20 15"/><path d="M20 20v-5h-5"/></svg>',
}

const setControlIcon = (control, icon, label) => {
  control.innerHTML = controlIcons[icon]
  control.setAttribute('aria-label', label)
  control.title = label
}

const imageLayerId = tile => `atlas-admin-tile-${tileKey(tile).replaceAll('/', '-')}`
const imageSourceId = tile => `${imageLayerId(tile)}-source`
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

const installCachedImage = (map, tile) => {
  const sourceId = imageSourceId(tile)
  const layerId = imageLayerId(tile)
  if (map.getSource(sourceId)) return
  const bounds = tileBounds(tile)
  map.addSource(sourceId, {
    type: 'image',
    url: tile.url,
    coordinates: [
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.east, bounds.south],
      [bounds.west, bounds.south],
    ],
  })
  map.addLayer(
    {
      id: layerId,
      type: 'raster',
      source: sourceId,
      paint: {
        'raster-opacity': 0.94,
        'raster-fade-duration': 0,
      },
    },
    firstLabelLayerId(map),
  )
}

const removeCachedImage = (map, tile) => {
  const layerId = imageLayerId(tile)
  const sourceId = imageSourceId(tile)
  if (map.getLayer(layerId)) map.removeLayer(layerId)
  if (map.getSource(sourceId)) map.removeSource(sourceId)
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
    const version = typeof body.version === 'number' && Number.isInteger(body.version)
      ? body.version
      : null
    const tilesByPosition = new Map()
    const activeTilesByPosition = new Map()
    tiles.forEach(tile => {
      installCachedImage(map, tile)
      const positionKey = tilePositionKey(tile)
      const positionTiles = tilesByPosition.get(positionKey) ?? []
      positionTiles.push(tile)
      tilesByPosition.set(positionKey, positionTiles)
      activeTilesByPosition.set(positionKey, positionTiles.at(-1))
    })

    const titleCards = new Map()
    tiles.forEach(tile => {
      const card = createAtlasTitleCard(map.getContainer(), tile.scene)
      const positionKey = tilePositionKey(tile)
      card.hidden = activeTilesByPosition.get(positionKey) !== tile
      titleCards.set(tileKey(tile), { card, tile })
    })

    const container = map.getContainer()
    container.classList.add('atlas-admin-mode')

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
      status.textContent = `ADMIN MODE · PRE-RENDERS: ${preRenderedCount}${versionLabel} · click an image to manage it`
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
    setControlIcon(cycleControl, 'cycle', 'Show next image')
    actionBar.append(cycleControl)

    const rerenderControl = document.createElement('button')
    rerenderControl.id = 'atlas-admin-rerender-control'
    rerenderControl.className = 'atlas-admin-rerender'
    rerenderControl.type = 'button'
    rerenderControl.hidden = true
    setControlIcon(rerenderControl, 'rerender', 'Rerender this tile')
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
    const renderingSpinner = document.createElement('span')
    renderingSpinner.className = 'atlas-admin-rendering__spinner'
    renderingSpinner.setAttribute('aria-hidden', 'true')
    const renderingTitle = document.createElement('strong')
    renderingTitle.className = 'atlas-admin-rendering__title'
    const renderingMessage = document.createElement('p')
    renderingMessage.className = 'atlas-admin-rendering__message'
    const renderingProgress = document.createElement('span')
    renderingProgress.className = 'atlas-admin-rendering__progress'

    renderingPanel.append(
      renderingKicker,
      renderingSpinner,
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
    let deleting = false
    let rerendering = false
    let renderingTile = null

    const updateRenderingOverlay = (tile, message) => {
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
      if (rerendering && renderingTile) {
        actionBar.hidden = true
        deleteControl.hidden = true
        cycleControl.hidden = true
        rerenderControl.hidden = true
        positionRenderingOverlay(renderingTile)
        return
      }
      renderingOverlay.hidden = true
      if (!selectedTile) {
        actionBar.hidden = true
        deleteControl.hidden = true
        cycleControl.hidden = true
        rerenderControl.hidden = true
        return
      }
      actionBar.hidden = false
      deleteControl.hidden = false
      const candidates = tilesByPosition.get(tilePositionKey(selectedTile)) ?? []
      cycleControl.hidden = false
      cycleControl.disabled = candidates.length < 2
      cycleControl.title = candidates.length < 2 ? 'No alternate image' : 'Show next image'
      rerenderControl.hidden = false
    }

    const selectTileAt = point => {
      if (rerendering) return
      const position = tileForPosition(point)
      const positionKey = `${atlasZoom}/${position.x}/${position.y}`
      const candidates = tilesByPosition.get(positionKey)
      selectedTile = activeTilesByPosition.get(positionKey) ?? candidates?.at(-1) ?? null
      deleteControl.hidden = !selectedTile
      cycleControl.hidden = !selectedTile
      rerenderControl.hidden = !selectedTile
      if (selectedTile) {
        setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(selectedTile.scene)}`)
      }
      positionControl()
    }

    map.on('click', event => selectTileAt(event.lngLat))
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
      map.moveLayer(imageLayerId(nextTile))
      setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(nextTile.scene)}`)
      positionControl()
    })

    const updateCountBadge = (positionKey, count) => {
      const countBadge = countBadges.get(positionKey)?.badge
      if (!countBadge) return
      countBadge.textContent = String(count)
      countBadge.setAttribute('aria-label', `${count} pre-rendered images`)
    }

    const focusTileForCapture = tile => new Promise<void>(resolve => {
      const bounds = tileBounds(tile)
      map.once('idle', resolve)
      map.fitBounds(
        [[bounds.west, bounds.south], [bounds.east, bounds.north]],
        { padding: 24, duration: 0, maxZoom: atlasZoom },
      )
    })

    const installRerenderedTile = tile => {
      const positionKey = tilePositionKey(tile)
      const candidates = tilesByPosition.get(positionKey) ?? []
      const matchingIndex = candidates.findIndex(
        candidate => tileKey(candidate) === tileKey(tile),
      )
      const replaced = matchingIndex >= 0 ? candidates[matchingIndex] : null

      if (replaced) {
        removeCachedImage(map, replaced)
        titleCards.get(tileKey(replaced))?.card.remove()
        titleCards.delete(tileKey(replaced))
        candidates.splice(matchingIndex, 1, tile)
        const index = tiles.findIndex(candidate => tileKey(candidate) === tileKey(replaced))
        if (index >= 0) tiles.splice(index, 1, tile)
      } else {
        candidates.push(tile)
        tiles.push(tile)
        preRenderedCount += 1
      }

      tilesByPosition.set(positionKey, candidates)
      installCachedImage(map, tile)
      const card = createAtlasTitleCard(container, tile.scene)
      titleCards.set(tileKey(tile), { card, tile })
      activeTilesByPosition.set(positionKey, tile)
      selectedTile = tile
      map.moveLayer(imageLayerId(tile))
      updateCountBadge(positionKey, candidates.length)
      updateStatus()
      setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(tile.scene)}`)
      positionControl()
    }

    rerenderControl.addEventListener('click', async event => {
      event.preventDefault()
      event.stopPropagation()
      if (!selectedTile || rerendering) return

      const tile = selectedTile
      if (
        !window.confirm(
          `Rerender the cached ${sceneLabel(tile.scene)} image for ${tile.x}/${tile.y}?`,
        )
      )
        return

      rerendering = true
      renderingTile = tile
      updateRenderingOverlay(tile, 'Preparing the map reference…')
      deleteControl.disabled = true
      cycleControl.disabled = true
      rerenderControl.disabled = true
      positionControl()
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
          throw new Error(status?.error ?? `Cache lookup failed with HTTP ${statusResponse.status}`)
        }
        const scenes = Array.isArray(status?.scenes)
          ? status.scenes.filter((scene): scene is AtlasScene =>
              typeof scene === 'string' && atlasSceneNames.includes(scene as AtlasScene),
            )
          : []

        updateRenderingOverlay(tile, 'Framing the tile for its new illustration…')
        await focusTileForCapture(tile)
        const capturedTile = await captureTile(map, tile)
        const scene = pickAtlasScene(tileHasSea(map, tile), scenes)
        updateRenderingOverlay(tile, 'Setting the new scene in ink and watercolour…')
        const response = await fetchAdmin(
          `/api/atlas-tiles/${tile.zoom}/${tile.x}/${tile.y}/${scene}?rerender=true`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-atlas-csrf-token': csrfToken() ?? '',
            },
            body: JSON.stringify({ ...capturedTile, hasSea: tileHasSea(map, tile) }),
          },
        )
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(body?.error ?? `Rerender failed with HTTP ${response.status}`)
        }
        if (typeof body?.url !== 'string' || !atlasSceneNames.includes(body.scene as AtlasScene)) {
          throw new Error('The rerender response did not include a valid tile image.')
        }

        updateRenderingOverlay(tile, 'Placing the finished atlas plate…')
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
        rerenderControl.title = error instanceof Error ? error.message : 'Rerender failed'
      } finally {
        rerendering = false
        renderingTile = null
        deleteControl.disabled = false
        cycleControl.disabled = false
        rerenderControl.disabled = false
        setControlIcon(rerenderControl, 'rerender', 'Rerender this tile')
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

        removeCachedImage(map, tile)
        titleCards.get(tileKey(tile))?.card.remove()
        titleCards.delete(tileKey(tile))
        const positionKey = tilePositionKey(tile)
        const remaining = (tilesByPosition.get(positionKey) ?? []).filter(
          candidate => tileKey(candidate) !== tileKey(tile),
        )
        if (remaining.length) {
          tilesByPosition.set(positionKey, remaining)
          activeTilesByPosition.set(positionKey, remaining.at(-1))
        }
        else {
          tilesByPosition.delete(positionKey)
          activeTilesByPosition.delete(positionKey)
          countBadges.get(positionKey)?.badge.remove()
          countBadges.delete(positionKey)
          versionLabels.get(positionKey)?.remove()
          versionLabels.delete(positionKey)
        }
        const countBadge = countBadges.get(positionKey)?.badge
        if (countBadge) {
          countBadge.textContent = String(remaining.length)
          countBadge.setAttribute('aria-label', `${remaining.length} pre-rendered images`)
        }
        const index = tiles.findIndex(candidate => tileKey(candidate) === tileKey(tile))
        if (index >= 0) tiles.splice(index, 1)
        preRenderedCount = Math.max(0, preRenderedCount - 1)
        selectedTile = remaining.at(-1) ?? null
        updateStatus()
        deleteControl.hidden = !selectedTile
        cycleControl.hidden = !selectedTile
        if (selectedTile) {
          setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(selectedTile.scene)}`)
        }
        positionControl()
      } catch (error) {
        deleteControl.textContent =
          error instanceof Error ? error.message : 'Delete failed'
      } finally {
        deleting = false
        deleteControl.disabled = false
        if (selectedTile) {
          setControlIcon(deleteControl, 'delete', `Delete ${sceneLabel(selectedTile.scene)}`)
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
