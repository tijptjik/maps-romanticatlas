import { revisionEndpoint, revisionImagePattern, type Revision } from './artwork-revision'
import { neighborhoodLabelLayerId } from './map-style'
import { installArtworkAnimations } from './fountain-glitter'
import type { GeoJSONSource, ImageSource, Map as AtlasMap } from 'maplibre-gl'
import { atlasSceneTitle } from './atlas-title-cards'
import { originalArtwork } from './artwork-sampling'
import { csrfToken, fetchAdmin } from './cached-tile-admin'
import { reviewEndpoint, type ArtworkReview, type Painting } from './artwork-review'
import { focusAtlasTile, installAtlasTileInteractions, tileId } from './atlas-tiles'
import { drawingFootprint, tileBounds, tileForPosition, tilePolygon } from './tile-geometry'

type Footprint = ReturnType<typeof drawingFootprint>
type Unit = { art: Painting; footprint: Footprint; layer: string }
type Label = { element: HTMLElement; title: HTMLElement; bounds: Footprint['bounds'] }

type Catalog = { release: string; sheets: { accepted?: boolean; art: Painting[] }[] }

export async function installDiscoveryMap(map: AtlasMap, diagnostics: boolean | 'admin', noNoise: boolean,
  onCount: (count: number) => void, audio: Parameters<typeof installAtlasTileInteractions>[1], revealed = false) {
  const admin = diagnostics === 'admin'
  const units = new Map<string, Unit>()
  const byCell = new Map<string, Unit[]>()
  const visibleLayers = new Set<string>()
  const labels = new Map<string, Label>()
  const superseded = new Set<string>()
  let disposed = false

  function add(art: Painting) {
    if (superseded.has(art.url) || units.has(art.url)) return
    const footprint = drawingFootprint({ ...art, tileSpan: { columns: art.columns ?? 1, rows: art.rows } })
    const unit = { art, footprint, layer: 'discovery-' + units.size }
    units.set(art.url, unit)
    for (const cell of footprint.cells) {
      const id = tileId(cell)
      const alternatives = byCell.get(id) ?? []
      alternatives.push(unit)
      byCell.set(id, alternatives)
    }
  }
  const status = new Map<string, ArtworkReview['status']>()
  let revisions: Revision[] = []
  async function readRevisions(): Promise<Revision[]> {
    const response = await fetch(revisionEndpoint, { cache: 'no-store' })
    if (!response.ok) throw Error('Artwork revision queue unavailable')
    return response.json()
  }
  try {
    const [catalogResponse, reviewResponse, discoveryResponse] = await Promise.all([
      fetch('/atlas-v2/catalog.json', { cache: 'no-cache' }),
      fetch(reviewEndpoint, { cache: 'no-store' }),
      admin ? fetchAdmin('/api/atlas-tiles/cached?admin=true&diagnostics=true&collection=discovery', { cache: 'no-store' }) :
      diagnostics || revealed ? fetch('/api/atlas-tiles/cached?diagnostics=true&collection=discovery', { cache: 'no-store' }) : null,
    ])
    if ((!catalogResponse.ok && catalogResponse.status !== 404) || !reviewResponse.ok) throw Error('Artwork catalog or reviews unavailable')
    // Static hosts can return their HTML entry point when no catalog is installed.
    const missing = catalogResponse.status === 404 || catalogResponse.headers.get('content-type')?.includes('text/html')
    const catalog: Catalog = missing ? { release: 'v2', sheets: [] } : await catalogResponse.json()
    const reviews: ArtworkReview[] = await reviewResponse.json()
    if (catalog.release !== 'v2' || !Array.isArray(catalog.sheets) || !Array.isArray(reviews)) {
      throw Error('Invalid V2 artwork catalog or reviews')
    }
    for (const sheet of catalog.sheets) {
      if (sheet.accepted) for (const art of sheet.art) status.set(art.url, 'accepted')
    }
    for (const review of reviews) status.set(review.url, review.status)
    if (diagnostics || revealed) {
      revisions = admin ? await readRevisions() : await readRevisions().catch(() => [])
    }
    if (admin) {
      for (const job of revisions) {
        if (job.state === 'ready' && job.candidate) superseded.add(job.source.url)
      }
    }
    for (const sheet of catalog.sheets) {
      for (const art of sheet.art) {
        const decision = status.get(art.url)
        if (diagnostics || revealed ? decision !== 'rejected' : decision === 'accepted') add(art)
      }
    }
    for (const revision of revisions) {
      if (revision.candidate && status.get(revision.candidate.url) !== 'rejected') add(revision.candidate)
    }
    for (const art of reviews) {
      if (revisionImagePattern.test(art.url) && status.get(art.url) === 'accepted') add(art)
    }
    if (discoveryResponse) {
      if (!discoveryResponse.ok) throw Error('Generated artwork unavailable')
      const { tiles, adminMode } = await discoveryResponse.json()
      if (admin && adminMode !== true) throw Error('Admin access required')
      for (const tile of tiles) {
        if (tile.variant.startsWith('discovery-') && status.get(tile.url) !== 'rejected') {
          add({ x: tile.x, y: tile.y, rows: 1, title: tile.title || atlasSceneTitle(tile.scene), url: tile.url })
        }
      }
    } else {
      for (const art of reviews) {
        if (art.url.startsWith('/generated-tiles/') && status.get(art.url) === 'accepted') add(art)
      }
    }
  } catch (error) {
    console.warn('Atlas artwork reviews unavailable', error)
    const retry = document.createElement('button')
    retry.className = 'atlas-review-retry'
    retry.textContent = admin ? 'Admin artwork unavailable · Retry' : 'Artwork reviews unavailable · Retry'
    retry.onclick = () => location.reload()
    map.getContainer().append(retry)
    return () => {}
  }
  if (!diagnostics) {
    const artwork = new Map<string, Painting[]>()
    if (revealed) {
      // Give cells with few alternatives first choice. Reserve the whole drawing
      // so a neighbouring tile cannot select an overlapping painting.
      for (const [id, choices] of [...byCell].sort((a, b) => a[1].length - b[1].length)) {
        if (artwork.has(id)) continue
        const available = choices.filter(unit => unit.footprint.cells.every(cell => !artwork.has(tileId(cell))))
        if (!available.length) continue
        const unit = available[Math.floor(Math.random() * available.length)]
        for (const cell of unit.footprint.cells) artwork.set(tileId(cell), [unit.art])
      }
    } else {
      for (const [id, choices] of byCell) artwork.set(id, choices.map(unit => unit.art))
    }
    const atlas = installAtlasTileInteractions(map, audio, {
      artwork, revealed, noNoise, onRevealCountChange: onCount,
      rejectedUrls: new Set([...status].filter(([, decision]) => decision === 'rejected').map(([url]) => url)),
    })
    return atlas.resetReveals
  }

  let inventoryCount: HTMLOutputElement | undefined
  if (admin) {
    const container = map.getContainer()
    container.classList.add('atlas-admin-mode')
    const toolbar = document.createElement('nav')
    toolbar.className = 'atlas-admin-status atlas-v2-admin'
    toolbar.setAttribute('aria-label', 'Atlas V2 admin')
    const heading = document.createElement('strong')
    heading.textContent = 'Atlas V2 admin'
    inventoryCount = document.createElement('output')
    const queueLink = document.createElement('a')
    queueLink.href = '/?review'
    queueLink.textContent = 'Artwork review'
    const cacheLink = document.createElement('a')
    const cacheUrl = new URL(location.href)
    cacheUrl.searchParams.set('view', 'cache')
    cacheLink.href = cacheUrl.href
    cacheLink.textContent = 'Tile cache'
    toolbar.append(heading, inventoryCount, queueLink, cacheLink)
    container.append(toolbar)
  }

  const copyStatus = document.createElement('div')
  copyStatus.className = 'atlas-copy-status'
  copyStatus.setAttribute('role', 'status')
  map.getContainer().append(copyStatus)
  let clearCopyStatus: number

  async function copyReference({ art, footprint }: Unit) {
    const reference = JSON.stringify({
      title: art.title,
      image: new URL(art.url, location.href).href,
      southwestTile: tileId(art),
      tiles: footprint.cells.map(tileId),
    })
    try {
      await navigator.clipboard.writeText(reference)
      copyStatus.textContent = 'Copied reference for ' + art.title
      window.clearTimeout(clearCopyStatus)
      clearCopyStatus = window.setTimeout(() => { copyStatus.textContent = '' }, 2200)
    } catch {
      window.prompt('Copy the regeneration reference for ' + art.title, reference)
    }
  }

  function positionLabels() {
    const view = map.getBounds()
    for (const { element, title, bounds } of labels.values()) {
      const { west, east, north, south } = bounds
      element.hidden = !view.intersects([[west, south], [east, north]])
      title.hidden = element.hidden
      if (element.hidden) continue
      const point = map.project([(east + west) / 2, south])
      element.style.left = point.x + 'px'
      element.style.top = point.y + 'px'
      const corner = map.project([east, north])
      title.style.left = element.style.left
      title.style.top = corner.y + 'px'
      title.style.maxWidth = Math.max(0, 2 * (corner.x - point.x) - 8) + 'px'
    }
  }

  const showAnimations = installArtworkAnimations(map)

  function draw(unit: Unit, opacity: number) {
    const {layer, art, footprint: {bounds: {west, east, north, south}}} = unit
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[west,north],[east,north],[east,south],[west,south]]
    map.addSource(layer, { type: 'image', url: art.animation?.plate ?? art.imageUrl ?? art.url, coordinates })
    map.addLayer({id: layer, type: 'raster', source: layer, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 }}, edges)
  }

  const edges = 'discovery-tile-edges'
  const priority = new Map<Unit, number>()
  let sequence = 0
  let gridSize = -1
  const saving = new Set<string>()

  function select(unit: Unit) {
    priority.set(unit, ++sequence)
    renderDiagnostics()
  }

  async function review(choices: Unit[], unit: Unit, decision: ArtworkReview['status']) {
    if (saving.has(unit.art.url)) return
    const selectionAtClick = sequence
    saving.add(unit.art.url)
    renderDiagnostics()
    try {
      const write = (token: string) => fetchAdmin(reviewEndpoint + '?admin=true', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-atlas-csrf-token': token },
        body: JSON.stringify({ ...unit.art, status: decision }),
      })
      const existingToken = csrfToken()
      let response = existingToken ? await write(existingToken) : null
      if (!response || response.status === 403) {
        const session = await fetchAdmin('/api/atlas-tiles/cached?admin=true')
        if (!session.ok) throw Error('Admin access required (' + session.status + ')')
        const token = csrfToken()
        if (!token) throw Error('The browser did not receive the review session cookie.')
        response = await write(token)
      }
      if (!response.ok) {
        const details = await response.json().catch(() => null)
        throw Error(details?.error || 'Review returned ' + response.status)
      }
      const saved: ArtworkReview = await response.json()
      status.set(saved.url, saved.status)
      if (!disposed && sequence === selectionAtClick) {
        const index = choices.indexOf(unit)
        for (let offset = 1; offset < choices.length; offset++) {
          const next = choices[(index + offset) % choices.length]
          if (status.has(next.art.url) || saving.has(next.art.url)) continue
          priority.set(next, ++sequence)
          break
        }
      }
      if (saved.status === 'rejected') {
        units.delete(saved.url)
        priority.delete(unit)
        for (const cell of unit.footprint.cells) {
          const id = tileId(cell)
          const remaining = byCell.get(id)!.filter(choice => choice !== unit)
          if (remaining.length) {
            byCell.set(id, remaining)
          } else {
            byCell.delete(id)
            labels.get(id)?.element.remove()
            labels.get(id)?.title.remove()
            labels.delete(id)
          }
        }
      }
    } catch (error) {
      window.alert('Could not save the artwork review. ' + error.message)
    } finally {
      saving.delete(unit.art.url)
      if (!disposed) renderDiagnostics()
    }
  }

  function renderDiagnostics() {
    if (inventoryCount) inventoryCount.value = units.size + (units.size === 1 ? ' painting' : ' paintings')
    const view = map.getBounds()
    const groups = new Map<string, Unit>()
    for (const unit of units.values()) {
      const {west,east,north,south} = unit.footprint.bounds
      if (!view.intersects([[west,south],[east,north]])) continue
      const key = unit.footprint.cells.map(tileId).join(',')
      const previous = groups.get(key)
      if (!previous || (priority.get(unit) ?? 0) > (priority.get(previous) ?? 0)) groups.set(key, unit)
    }
    const displayed = [...groups.values()].sort((a,b) => (priority.get(a) ?? 0) - (priority.get(b) ?? 0))
    const layers = new Set(displayed.map(unit => unit.layer))
    for (const layer of visibleLayers) {
      if (layers.has(layer)) continue
      map.removeLayer(layer)
      map.removeSource(layer)
      visibleLayers.delete(layer)
    }
    const top = new Map<string, Unit>()
    for (const unit of displayed) {
      if (!visibleLayers.has(unit.layer)) {
        draw(unit, 1)
        visibleLayers.add(unit.layer)
      }
      map.moveLayer(unit.layer, edges)
      for (const cell of unit.footprint.cells) top.set(tileId(cell), unit)
    }
    showAnimations(new Set([...top.values()].map(unit => unit.art)))
    if (gridSize !== byCell.size) {
      gridSize = byCell.size
      const coordinates = [...byCell.keys()].map(id => {
        const [zoom, x, y] = id.split('/').map(Number)
        return tilePolygon({zoom, x, y})
      })
      map.getSource<GeoJSONSource>(edges)!.setData({ type: 'MultiLineString', coordinates })
    }
    for (const [id, current] of top) {
      const choices = byCell.get(id)!
      let label = labels.get(id)
      if (!label) {
        const element = document.createElement('div')
        element.className = 'atlas-image-count'
        element.setAttribute('role', 'group')
        element.innerHTML = '<span class="atlas-image-pips"></span><output></output><button type="button" data-action="accepted">✓</button><button type="button" data-action="rejected">×</button>'
        const title = document.createElement('button')
        title.type = 'button'
        title.className = 'atlas-discovery-title'
        title.dataset.tile = id
        map.getContainer().append(title, element)
        const cell = current.footprint.cells.find(cell => tileId(cell) === id)!
        label = {element, title, bounds: tileBounds(cell)}
        labels.set(id, label)
      }
      const {element, title} = label
      title.textContent = current.art.title
      title.title = 'Copy regeneration reference for ' + current.art.title
      title.setAttribute('aria-label', title.title)
      title.onclick = event => {
        event.stopPropagation()
        void copyReference(current)
      }
      element.setAttribute('aria-label', choices.length + ' images on tile ' + id)
      element.querySelector('output')!.value = String(choices.length)
      const pips = element.querySelector('.atlas-image-pips')!
      choices.forEach((unit, index) => {
        let pip = pips.children[index] as HTMLButtonElement
        if (!pip) {
          pip = document.createElement('button')
          pip.type = 'button'
          pips.append(pip)
        }
        pip.onclick = () => select(unit)
        const state = status.get(unit.art.url) ?? 'considered'
        pip.dataset.status = state
        pip.title = (index + 1) + '. ' + unit.art.title + ' · ' + state
        pip.setAttribute('aria-label', pip.title)
        pip.setAttribute('aria-pressed', String(unit === current))
      })
      while (pips.children.length > choices.length) pips.lastElementChild!.remove()
      for (const button of element.querySelectorAll<HTMLButtonElement>('[data-action]')) {
        const decision = button.dataset.action as ArtworkReview['status']
        button.title = (decision === 'accepted' ? 'Accept ' : 'Reject ') + current.art.title + ' for production'
        button.setAttribute('aria-label', button.title)
        button.disabled = saving.has(current.art.url) || status.get(current.art.url) === decision
        button.onclick = () => void review(choices, current, decision)
      }
    }
    positionLabels()
  }

  if (diagnostics) {
    map.addSource(edges, {type: 'geojson', data: {type: 'MultiLineString', coordinates: []}})
    map.addLayer({id: edges, source: edges, type: 'line', paint: {
      'line-color': '#382e20', 'line-width': 1.5, 'line-dasharray': [4, 2], 'line-opacity': 0.9,
    }}, neighborhoodLabelLayerId)
    renderDiagnostics()
    map.on('moveend', renderDiagnostics)

  }

  map.on('click', async event => {
    const choices = byCell.get(tileId(tileForPosition(event.lngLat)))
    if (!choices) return
    const layers = map.getLayersOrder()
    const current = choices.reduce((top, unit) => layers.indexOf(unit.layer) > layers.indexOf(top.layer) ? unit : top)
    const next = choices[(choices.indexOf(current) + 1) % choices.length]
    select(next)
    let image = map.getSource<ImageSource>(next.layer)?.image
    if (!image) {
      const selectionAtClick = sequence
      const plate = new Image()
      plate.src = next.art.animation?.plate ?? next.art.imageUrl ?? next.art.url
      try {
        await plate.decode()
      } catch {
        return
      }
      if (disposed || sequence !== selectionAtClick) return
      image = plate
    }
    const { width, height } = originalArtwork(image)
    focusAtlasTile(map, next.art, undefined, {
      bounds: next.footprint.bounds, width, height,
    })
  })
  map.on('move', positionLabels)
  map.once('remove', () => { disposed = true })
  return () => {}
}
