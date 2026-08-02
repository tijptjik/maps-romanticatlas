import { atlasScenes } from './atlas-scenes.ts'

const atlasZoom = 18

const tileBounds = tile => {
  const zoom = tile.zoom ?? atlasZoom
  const tileCount = 2 ** zoom
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

const titleCase = value =>
  value
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

export const createAtlasTitleCard = (container, scene) => {
  const card = document.createElement('aside')
  card.className = 'atlas-title-card'
  card.setAttribute('aria-label', `${titleCase(scene)}: ${atlasScenes[scene]}`)

  const title = document.createElement('strong')
  title.className = 'atlas-title-card__title'
  title.textContent = titleCase(scene)

  card.append(title)
  container.append(card)
  return card
}

export const positionAtlasTitleCard = (map, card, tile, contentBounds) => {
  const bounds = tileBounds(tile)
  const northWest = map.project([bounds.west, bounds.north])
  const southEast = map.project([bounds.east, bounds.south])
  const canvas = map.getCanvas()
  const visible =
    southEast.x >= 0 &&
    southEast.y >= 0 &&
    northWest.x <= canvas.clientWidth &&
    northWest.y <= canvas.clientHeight

  card.hidden = !visible
  if (!visible) return

  const tileWidth = Math.max(1, southEast.x - northWest.x)
  const tileHeight = Math.max(1, southEast.y - northWest.y)
  const cardWidth = Math.min(224, tileWidth * 0.8)
  const renderedCardWidth = Math.min(cardWidth, Math.max(1, canvas.clientWidth - 16))
  card.style.width = `${renderedCardWidth}px`

  const cardHeight = card.offsetHeight || 86
  const contentLeft = contentBounds
    ? northWest.x + (contentBounds.x / 512) * tileWidth
    : northWest.x
  const contentWidth = contentBounds
    ? (contentBounds.width / 512) * tileWidth
    : tileWidth
  const preferredLeft = contentLeft + (contentWidth - renderedCardWidth) / 2
  const contentBottom = contentBounds
    ? northWest.y + ((contentBounds.y + contentBounds.height) / 512) * tileHeight
    : northWest.y + tileHeight * 0.9
  const preferredTop = contentBottom
  const left = Math.max(
    8,
    Math.min(canvas.clientWidth - renderedCardWidth - 8, preferredLeft),
  )
  const top = Math.max(8, Math.min(canvas.clientHeight - cardHeight - 8, preferredTop))
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}
