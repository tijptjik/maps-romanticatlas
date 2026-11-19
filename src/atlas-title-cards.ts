import { atlasScenes } from './atlas-scenes.ts'
import { tileBounds } from './tile-geometry.ts'

const titleCase = value =>
  value
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

export const createAtlasTitleCard = (container, scene, displayTitle?: string) => {
  const card = document.createElement('aside')
  card.className = 'atlas-title-card is-awaiting-focus'
  card.setAttribute('aria-label', displayTitle ?? `${titleCase(scene)}: ${atlasScenes[scene]}`)

  const title = document.createElement('strong')
  title.className = 'atlas-title-card__title'
  title.textContent = displayTitle ?? titleCase(scene)

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
  // Keep the title wrapped at its full size while the whole plaque shrinks.
  const cardWidth = card.offsetWidth
  const scale = Math.min(1, tileWidth * 0.8 / cardWidth, Math.max(1, canvas.clientWidth - 16) / cardWidth)
  card.style.scale = String(scale)
  const renderedCardWidth = cardWidth * scale
  const layoutHeight = card.offsetHeight
  const cardHeight = layoutHeight * scale
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
  // Scaling about the center keeps the existing rotation and reveal animation aligned.
  card.style.left = `${left - (cardWidth - renderedCardWidth) / 2}px`
  card.style.top = `${top - (layoutHeight - cardHeight) / 2}px`
}
