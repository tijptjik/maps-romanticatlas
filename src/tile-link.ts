import { atlasZoom, tileBounds } from './tile-geometry'

export function linkedTile() {
  const params = new URLSearchParams(location.search)
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(params.get('tile') ?? '')
  if (!match || Number(match[1]) !== atlasZoom) return
  const tile = { x: Number(match[2]), y: Number(match[3]) }
  const { west, east, south, north } = tileBounds(tile)
  if (west > 114.5 || east < 113.8 || south > 22.6 || north < 22.1) return
  return { ...tile, center: [(west + east) / 2, (south + north) / 2] as [number, number], art: params.get('art') }
}

export function createTileLink(id: string, art: string) {
  const link = document.createElement('a')
  link.className = 'atlas-tile-link'
  link.href = '/?tile=' + id + '&art=' + encodeURIComponent(art)
  link.textContent = 'Copy tile link'
  link.onclick = async event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(link.href)
      link.textContent = 'Link copied'
      window.setTimeout(() => { link.textContent = 'Copy tile link' }, 2000)
    } catch {
      window.prompt('Copy tile link', link.href)
    }
  }
  return link
}
