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

export async function copyTileLink(id: string, art: string) {
  const url = new URL('/?tile=' + id + '&art=' + encodeURIComponent(art), location.origin)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url.href)
      return
    } catch {
      // Some embedded browsers only support the selection-based clipboard API.
    }
  }
  const field = document.createElement('textarea')
  field.value = url.href
  field.style.cssText = 'position:fixed;left:-9999px;top:0'
  const focused = document.activeElement
  document.body.append(field)
  try {
    field.select()
    document.execCommand('copy')
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
}
