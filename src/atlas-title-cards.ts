import recoveredTitles from '../releases/discovery-titles.json'
import { atlasScenes } from './atlas-scenes.ts'
import { tileBounds } from './tile-geometry.ts'

export const atlasSceneTitle = (value: string) =>
  value
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const historicalTitles: Record<string, string> = recoveredTitles

export const discoveryTitle = (url: string, scene: string, title?: string) =>
  title && title !== atlasSceneTitle(scene) ? title : historicalTitles[url] ?? title

export const createAtlasTitleCard = (container, scene, displayTitle?: string, onCopy?: () => void) => {
  const card = document.createElement(onCopy ? 'button' : 'aside')
  if (card instanceof HTMLButtonElement && onCopy) {
    card.type = 'button'
    card.setAttribute('aria-description', 'Copy tile link')
    card.onclick = event => {
      event.stopPropagation()
      onCopy()
    }
  }
  card.className = 'atlas-title-card is-awaiting-focus'
  card.setAttribute('aria-label', displayTitle ?? `${atlasSceneTitle(scene)}: ${atlasScenes[scene]}`)

  const title = document.createElement('strong')
  title.className = 'atlas-title-card__title'
  title.textContent = displayTitle ?? atlasSceneTitle(scene)

  card.append(title)
  container.append(card)
  return card
}

// Prefix counts let each plaque query the painted width of a row as the map zooms.
export function sampleArtworkAlpha(image: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = Math.max(1, Math.round(canvas.width * image.naturalHeight / image.naturalWidth))
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  const stride = canvas.width + 1
  const counts = new Uint8Array(stride * canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const painted = data[(y * canvas.width + x) * 4 + 3] >= 96
      counts[y * stride + x + 1] = counts[y * stride + x] + Number(painted)
    }
  }
  return { counts, width: canvas.width, height: canvas.height }
}

export const positionAtlasTitleCard = (map, card, tile, contentBounds,
  bounds = tileBounds(tile), alpha?: ReturnType<typeof sampleArtworkAlpha>) => {
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
  const left = Math.max(
    8,
    Math.min(canvas.clientWidth - renderedCardWidth - 8, preferredLeft),
  )
  let preferredTop = contentBottom
  if (alpha) {
    const first = Math.max(0, Math.floor((left - northWest.x) / tileWidth * alpha.width))
    const last = Math.min(alpha.width, Math.ceil((left + renderedCardWidth - northWest.x) / tileWidth * alpha.width))
    if (first < last) {
      // Skip faint shadows and narrow details such as a staircase below a building.
      const required = Math.ceil((last - first) / 3)
      let widest = 0
      let anchorRow = -1
      for (let y = alpha.height - 1; y >= 0; y--) {
        const row = y * (alpha.width + 1)
        const painted = alpha.counts[row + last] - alpha.counts[row + first]
        if (painted > widest) {
          widest = painted
          anchorRow = y
        }
        if (painted >= required) break
      }
      if (anchorRow >= 0) {
        const bottom = northWest.y + (anchorRow + 1) / alpha.height * tileHeight
        preferredTop = Math.min(contentBottom, bottom) - Math.min(12, cardHeight / 3)
      }
    }
  }
  const top = Math.max(8, Math.min(canvas.clientHeight - cardHeight - 8, preferredTop))
  // Scaling about the center keeps the existing rotation and reveal animation aligned.
  card.style.left = `${left - (cardWidth - renderedCardWidth) / 2}px`
  card.style.top = `${top - (layoutHeight - cardHeight) / 2}px`
}
