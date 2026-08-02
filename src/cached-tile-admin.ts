import { createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards.ts'

const atlasZoom = 18
const adminControlId = 'atlas-admin-delete-control'
const adminStatusId = 'atlas-admin-status'

const tileKey = tile => `${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}`
const tilePositionKey = tile => `${tile.zoom}/${tile.x}/${tile.y}`

const tileBounds = tile => {
  const tileCount = 2 ** tile.zoom
  const longitude = x => (x / tileCount) * 360 - 180
  const latitude = y => {
    const radians = Math.PI - (2 * Math.PI * y) / tileCount
    return (180 / Math.PI) * Math.atan(Math.sinh(radians))
  }

  return {
    west: longitude(tile.x),
    north: latitude(tile.y),
    east: longitude(tile.x + 1),
    south: latitude(tile.y + 1),
  }
}

const tileForPosition = ({ lng, lat }) => {
  const count = 2 ** atlasZoom
  const latitudeRadians = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * count),
    y: Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count),
  }
}

const imageLayerId = tile => `atlas-admin-tile-${tileKey(tile).replaceAll('/', '-')}`
const imageSourceId = tile => `${imageLayerId(tile)}-source`
const firstLabelLayerId = map =>
  map.getStyle().layers.find(layer => layer.type === 'symbol')?.id

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
    const response = await fetch('/api/atlas-tiles/cached')
    if (!response.ok)
      throw new Error(`Cache manifest request failed with ${response.status}`)
    const body = await response.json()
    if (body.adminMode !== true) return

    const tiles = Array.isArray(body.tiles)
      ? body.tiles.filter(tile => tile?.url && tile.scene)
      : []
    let preRenderedCount = Number.isFinite(Number(body.preRenderedCount))
      ? Number(body.preRenderedCount)
      : tiles.length
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

    const status = document.createElement('div')
    status.id = adminStatusId
    status.className = 'atlas-admin-status'
    const updateStatus = () => {
      status.textContent = `ADMIN MODE · PRE-RENDERS: ${preRenderedCount} · click an image to manage it`
    }
    updateStatus()
    container.append(status)

    const deleteControl = document.createElement('button')
    deleteControl.id = adminControlId
    deleteControl.className = 'atlas-admin-delete'
    deleteControl.type = 'button'
    deleteControl.hidden = true
    deleteControl.textContent = 'Delete cached image'
    container.append(deleteControl)

    const cycleControl = document.createElement('button')
    cycleControl.id = 'atlas-admin-cycle-control'
    cycleControl.className = 'atlas-admin-cycle'
    cycleControl.type = 'button'
    cycleControl.hidden = true
    cycleControl.textContent = 'Cycle image'
    container.append(cycleControl)

    const countBadges = new Map()
    tilesByPosition.forEach((positionTiles, positionKey) => {
      const [zoom, x, y] = positionKey.split('/').map(Number)
      const badge = document.createElement('div')
      badge.className = 'atlas-admin-count'
      badge.setAttribute('aria-label', `${positionTiles.length} pre-rendered images`)
      badge.textContent = `${positionTiles.length} PRE-RENDER${positionTiles.length === 1 ? '' : 'S'}`
      container.append(badge)
      countBadges.set(positionKey, { badge, tile: { zoom, x, y } })
    })

    let selectedTile = null
    let deleting = false

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
      if (!selectedTile) {
        deleteControl.hidden = true
        cycleControl.hidden = true
        return
      }
      positionOverlay(deleteControl, selectedTile, true)
      const candidates = tilesByPosition.get(tilePositionKey(selectedTile)) ?? []
      cycleControl.hidden = candidates.length < 2
      if (!cycleControl.hidden) {
        positionOverlay(cycleControl, selectedTile, true)
        cycleControl.style.top = `${Number.parseFloat(deleteControl.style.top) + deleteControl.offsetHeight + 6}px`
      }
    }

    const selectTileAt = point => {
      const position = tileForPosition(point)
      const positionKey = `${atlasZoom}/${position.x}/${position.y}`
      const candidates = tilesByPosition.get(positionKey)
      selectedTile = activeTilesByPosition.get(positionKey) ?? candidates?.at(-1) ?? null
      deleteControl.hidden = !selectedTile
      if (selectedTile) {
        deleteControl.textContent = `Delete ${selectedTile.scene}`
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
      deleteControl.textContent = `Delete ${nextTile.scene}`
      positionControl()
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
        const response = await fetch(
          `/api/atlas-tiles/${tile.zoom}/${tile.x}/${tile.y}/${tile.scene}`,
          {
            method: 'DELETE',
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
        }
        const countBadge = countBadges.get(positionKey)?.badge
        if (countBadge) {
          countBadge.textContent = `${remaining.length} PRE-RENDER${remaining.length === 1 ? '' : 'S'}`
          countBadge.setAttribute('aria-label', `${remaining.length} pre-rendered images`)
        }
        const index = tiles.findIndex(candidate => tileKey(candidate) === tileKey(tile))
        if (index >= 0) tiles.splice(index, 1)
        preRenderedCount = Math.max(0, preRenderedCount - 1)
        selectedTile = remaining.at(-1) ?? null
        updateStatus()
        deleteControl.hidden = !selectedTile
        if (selectedTile) deleteControl.textContent = `Delete ${selectedTile.scene}`
        positionControl()
      } catch (error) {
        deleteControl.textContent =
          error instanceof Error ? error.message : 'Delete failed'
      } finally {
        deleting = false
        deleteControl.disabled = false
      }
    })

    console.info(
      `Cached tile admin: ${tiles.length} image${tiles.length === 1 ? '' : 's'}`,
    )
  } catch (error) {
    console.warn('Cached tile admin could not load.', error)
  }
}
