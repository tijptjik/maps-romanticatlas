import { mapModePath } from './runtime-modes'
import { neighborhoodLabelLayerId } from './map-style'
import type { Map as AtlasMap, ImageSource } from 'maplibre-gl'
import { drawingFootprint, tileForPosition } from './tile-geometry'

import type { Painting } from './artwork-review'
import { installArtworkAnimations } from './fountain-glitter'

type Sheet = { id: string; title: string; isolated?: boolean; art: Painting[] }
const footprint = (art: Painting) =>
  drawingFootprint({ ...art, tileSpan: { columns: art.columns ?? 1, rows: art.rows } })
const site = (art: Painting) => `v2-${art.x}-${art.y}`

export function installV2ReviewMap(map: AtlasMap, onCount = (_count: number) => {}) {
  const panel = document.createElement('section')
  panel.className = 'v2-review'
  panel.setAttribute('aria-label', 'Atlas V2 contact cards')
  panel.innerHTML =
    '<label>Atlas V2 <select aria-label="Contact card"></select></label><div><button aria-label="Previous painting">‹</button><output aria-live="polite"></output><button aria-label="Next painting">›</button></div>'
  map.getContainer().append(panel)
  const select = panel.querySelector('select')!
  const output = panel.querySelector('output')!
  const [prev, next] = panel.querySelectorAll('button')
  let sheets: Sheet[] = []
  let sheet: Sheet
  let index = 0
  let stopped = false
  let fingerprint = ''
  const seen = new Set<string>()
  const loaded = new Map<string, string>()
  let sites = new Map<string, Painting>()

  const showAnimations = installArtworkAnimations(map, site)
  function render() {
    const displayed: Painting[] = []
    const view = map.getBounds()
    for (const [id, art] of sites) {
      const { west, east, north, south } = footprint(art).bounds
      if (
        !view.intersects([
          [west, south],
          [east, north],
        ])
      )
        continue
      displayed.push(art)
      const url = art.animation?.plate ?? art.imageUrl ?? art.url
      const coordinates: ImageSource['coordinates'] = [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ]
      if (!loaded.has(id)) {
        map.addSource(id, { type: 'image', url, coordinates })
        map.addLayer(
          { id, type: 'raster', source: id, paint: { 'raster-fade-duration': 0 } },
          neighborhoodLabelLayerId,
        )
      } else if (loaded.get(id) !== url) {
        map.getSource<ImageSource>(id)?.updateImage({ url, coordinates })
      }
      loaded.set(id, url)
    }
    for (const id of loaded.keys()) {
      const art = sites.get(id)
      if (art) {
        const { west, east, north, south } = footprint(art).bounds
        if (
          view.intersects([
            [west, south],
            [east, north],
          ])
        )
          continue
      }
      map.removeLayer(id)
      map.removeSource(id)
      loaded.delete(id)
    }
    showAnimations(displayed)
  }

  function show(focus: boolean) {
    if (!sheet) return
    const art = sheet.art[index]
    select.value = sheet.id
    output.textContent = `${index + 1}/${sheet.art.length} · ${art.title}`
    prev.disabled = next.disabled = sheet.art.length === 1
    sites = new Map()
    for (const item of sheet.isolated
      ? []
      : sheets.filter(s => !s.isolated).flatMap(s => s.art)) {
      if (!sites.has(site(item))) sites.set(site(item), item)
    }
    for (const item of sheet.art) sites.set(site(item), item)
    sites.set(site(art), art)
    if (focus) {
      const { west, east, north, south } = footprint(art).bounds
      if (sheet.isolated) {
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          {
            padding: { top: panel.offsetHeight + 24, bottom: 40, left: 20, right: 20 },
            duration: 0,
          },
        )
      } else {
        map.jumpTo({ center: [(east + west) / 2, (north + south) / 2], zoom: 17.6 })
      }
    }
    render()
    seen.add(art.url)
    onCount(seen.size)
    const url = new URL(location.href)
    url.searchParams.set('card', sheet.id)
    url.searchParams.set('painting', String(index + 1))
    history.replaceState(history.state, '', mapModePath(url))
  }

  select.onchange = () => {
    sheet = sheets.find(s => s.id === select.value)!
    index = 0
    show(true)
  }
  function step(by: number) {
    if (!sheet) return
    index = (index + by + sheet.art.length) % sheet.art.length
    show(true)
  }
  prev.onclick = () => step(-1)
  next.onclick = () => step(1)
  map.on('moveend', render)
  map.on('click', event => {
    const tile = tileForPosition(event.lngLat)
    const current = [...sites.values()].find(a =>
      footprint(a).cells.some(c => c.x === tile.x && c.y === tile.y),
    )
    if (!current) return
    sheet = sheets.find(s => s.art.includes(current))!
    index = sheet.art.indexOf(current)
    show(false)
  })

  async function refresh() {
    try {
      const response = await fetch('/atlas-v2/catalog.json', { cache: 'no-store' })
      if (!response.ok) throw Error()
      const text = await response.text()
      if (stopped || text === fingerprint) return
      const data = JSON.parse(text)
      if (data.release !== 'v2' || !data.sheets?.length) throw Error()
      sheets = data.sheets
      select.replaceChildren(
        ...sheets.map(s => {
          const number = s.id.match(/-v2-(\d+)$/)?.[1]
          return new Option(s.title + (number ? ` · ${Number(number)}` : ''), s.id)
        }),
      )
      const params = new URLSearchParams(location.search)
      const first = !sheet
      sheet = sheets.find(s => s.id === params.get('card')) ?? sheets[0]
      index = Math.max(
        0,
        Math.min(
          sheet.art.length - 1,
          Number.parseInt(params.get('painting') || '1', 10) - 1 || 0,
        ),
      )
      show(first && !history.state?.atlasModeCamera)
      fingerprint = text
    } catch {
      if (!sheet) output.textContent = 'V2 review images unavailable. Retrying…'
    }
  }
  void refresh()
  const timer = window.setInterval(refresh, 30000)
  map.once('remove', () => {
    stopped = true
    clearInterval(timer)
  })
  return () => {
    seen.clear()
    index = 0
    sheet = sheets[0]
    show(true)
  }
}
