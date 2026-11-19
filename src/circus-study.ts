import { defaultCloudCoverage } from './fog-pattern.js'
import { LngLatBounds, type ImageSource, type Map as AtlasMap } from 'maplibre-gl'
import { installStudyEligibility } from './study-eligibility.ts'
import { cloudDraw, studyCloudSeed } from './study-cloud-seed.ts'
import { createFogCanvas, tileId, viewportFogTiles } from './atlas-tiles.ts'
import { drawingFootprint, tileBounds, tileForPosition } from './tile-geometry.ts'
import { results as circuses } from '../experiments/circus-study.json'
import botanical from '../experiments/botanical-study.json'
import central from '../experiments/central-grid-v18.json'
import printworks from '../experiments/central-grid-v18-variety.json'
import weather from '../experiments/weather-study-v18.json'
import weatherV19 from '../experiments/weather-study-v19.json'
import kiteMakers from '../experiments/kite-makers-yards.json'
import clockwork from '../experiments/clockwork-quarter.json'
import textiles from '../experiments/northern-textile-works.json'
import raveArena from '../experiments/kowloon-rave-arena.json'
import festival from '../experiments/kowloon-rave-festival.json'
import rainExchange from '../experiments/rain-exchange.json'
import westernTowers from '../experiments/western-district-towers.json'
import skyPorts from '../experiments/kowloon-sky-ports.json'
import civicModern from '../experiments/kowloon-sky-ports-modern.json'
import waterfront from '../experiments/victorian-waterfront.json'
import grandSkyworks from '../experiments/kowloon-grand-skyworks.json'
import harbourAtlas from '../experiments/harbour-atlas.json'
import airworks from '../experiments/harbour-airworks.json'
import { installAirworksFigure, installFountainGlitter, installTheatreSpotlights } from './fountain-glitter.ts'
import harbourCuriosities from '../experiments/harbour-curiosities.json'
import southernShore from '../experiments/south-island-shore.json'
import './circus-study.css'

// Append new studies in release order so the picker opens on the latest one.
const experiments = [
  { title: 'Six Circuses in Central', folder: 'circus-study', grid: { x: 214197, y: 114419, size: 5 }, tiles: circuses },
  { title: botanical.title, folder: 'botanical-study', grid: botanical.grid, tiles: botanical.tiles },
  { title: central.title + ' (v18)', folder: 'central-grid-v18', grid: central.grid, tiles: central.tiles },
  { title: printworks.title, folder: 'central-grid-v18-variety', grid: printworks.grid, tiles: printworks.tiles },
  { title: weather.title, folder: 'weather-study-v18', grid: weather.grid, tiles: weather.tiles },
  { title: weatherV19.title, folder: 'weather-study-v19', grid: weatherV19.grid, tiles: weatherV19.tiles },
  { title: kiteMakers.title, folder: kiteMakers.slug, grid: kiteMakers.grid, tiles: kiteMakers.tiles },
  { title: clockwork.title, folder: clockwork.slug, grid: clockwork.grid, tiles: clockwork.tiles },
  { title: textiles.title, folder: textiles.slug, grid: textiles.grid, tiles: textiles.tiles },
  { title: raveArena.title, folder: raveArena.slug, grid: raveArena.grid, tiles: raveArena.tiles },
  { title: festival.title, folder: festival.slug, grid: festival.grid, tiles: festival.tiles },
  { title: rainExchange.title, folder: rainExchange.slug, grid: rainExchange.grid, tiles: rainExchange.tiles },
  { title: westernTowers.title, folder: westernTowers.slug, grid: westernTowers.grid, tiles: westernTowers.tiles },
  { title: skyPorts.title, folder: skyPorts.slug, grid: skyPorts.grid, tiles: skyPorts.tiles },
  { title: civicModern.title, folder: civicModern.slug, grid: civicModern.grid, tiles: civicModern.tiles },
  { title: waterfront.title, folder: waterfront.slug, grid: waterfront.grid, tiles: waterfront.tiles },
  { title: grandSkyworks.title, folder: grandSkyworks.slug, grid: grandSkyworks.grid, tiles: grandSkyworks.tiles },
  { title: harbourAtlas.title, folder: harbourAtlas.slug, grid: harbourAtlas.grid, tiles: harbourAtlas.tiles },
  { title: airworks.title, folder: airworks.slug, grid: airworks.grid, tiles: airworks.tiles },
  { title: harbourCuriosities.title, folder: harbourCuriosities.slug, grid: harbourCuriosities.grid, tiles: harbourCuriosities.tiles },
  { title: southernShore.title, folder: southernShore.slug, grid: null, tiles: southernShore.tiles },
].filter(study => study.tiles.length > 0)

export const installCircusStudy = (map: AtlasMap) => {
  const panel = document.createElement('section')
  panel.className = 'circus-study'
  panel.setAttribute('aria-label', 'Atlas experiments')
  panel.innerHTML = `
    <header><h1><button class="study-disclosure" type="button" aria-expanded="true" aria-controls="study-controls">Atlas experiments</button></h1>
      <button type="button" aria-label="Choose experiments" aria-expanded="false" aria-controls="experiment-list" title="Choose experiments">☷</button>
    </header>
    <div id="study-controls">
    <fieldset id="experiment-list" hidden><legend>Include experiments <button type="button" class="study-show-all">Show all</button></legend></fieldset>
    <label>Result <select aria-label="Result"><option value="all">All selected results</option></select></label>
    <label><input type="checkbox"> Show clouds</label>
    <label><input type="checkbox" name="diagnostics"> Diagnostics</label>
    <label>Cloud chance per tile <input type="range" min="0" max="100" step="5" value="${defaultCloudCoverage * 100}"></label>
    <output aria-live="polite"></output></div>`
  const select = panel.querySelector('select')!
  const toggle = panel.querySelector<HTMLInputElement>('input[type=checkbox]')!
  const diagnostics = panel.querySelector<HTMLInputElement>('[name=diagnostics]')!
  const slider = panel.querySelector<HTMLInputElement>('[type=range]')!
  const output = panel.querySelector('output')!
  map.getContainer().append(panel)

  const list = panel.querySelector('fieldset')!
  const button = panel.querySelector<HTMLButtonElement>('[aria-controls=experiment-list]')!
  const disclosure = panel.querySelector<HTMLButtonElement>('.study-disclosure')!
  const controls = panel.querySelector<HTMLElement>('#study-controls')!
  disclosure.onclick = () => {
    controls.hidden = !controls.hidden
    button.hidden = controls.hidden
    disclosure.setAttribute('aria-expanded', String(!controls.hidden))
  }
  button.onclick = () => {
    list.hidden = !list.hidden
    button.setAttribute('aria-expanded', String(!list.hidden))
  }
  const selected = new Set([experiments.at(-1)!.title])
  const tileKey = tile => tile.x + '-' + tile.y
  const results = experiments.flatMap(study => study.tiles.map(tile => {
    const skyscraper = 'scene' in tile && tile.scene === 'skyscraper'
    const { cells, bounds } = drawingFootprint(tile)
    return { ...tile, study, id: study.folder + '/' + tileKey(tile), skyscraper, cells, bounds }
  }))
  const refreshOptions = () => {
    const previous = select.value
    select.replaceChildren(select.options[0])
    for (const study of experiments) {
      if (!selected.has(study.title)) continue
      const group = document.createElement('optgroup')
      group.label = study.title
      for (const result of results.filter(tile => tile.study === study)) group.append(new Option(result.title, result.id))
      select.append(group)
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'all'
    select.disabled = !selected.size
  }
  const showSelectedResults = () => {
    select.value = 'all'
    refreshOptions()
    update(true)
  }
  list.querySelector<HTMLButtonElement>('.study-show-all')!.onclick = () => {
    for (const input of list.querySelectorAll('input')) {
      input.checked = true
      selected.add(input.value)
    }
    showSelectedResults()
  }
  for (const study of experiments) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = study.title
    input.checked = selected.has(study.title)
    input.onchange = () => {
      if (input.checked) selected.add(study.title)
      else selected.delete(study.title)
      showSelectedResults()
    }
    label.append(input, study.title)
    list.append(label)
  }
  refreshOptions()
  // These qualifying sites span Kowloon beyond the minimum-zoom viewport.
  if (selected.has(grandSkyworks.title)) select.value = grandSkyworks.slug + '/' + tileKey(grandSkyworks.tiles[0])
  const fountain = airworks.tiles.find(tile => tile.glitterOrigin)!
  const fountainId = airworks.slug + '/' + tileKey(fountain)
  const showGlitter = installFountainGlitter(map, { ...fountain, glitterOrigin: fountain.glitterOrigin! })
  const theatre = airworks.tiles.find(tile => tile.auditoriumOriginPixels)!
  const theatreId = airworks.slug + '/' + tileKey(theatre)
  const showSpotlights = installTheatreSpotlights(map, theatre, theatre.auditoriumOriginPixels!)
  const figures = airworks.tiles.filter(tile => tile.motion).map(tile => ({
    id: airworks.slug + '/' + tileKey(tile),
    show: installAirworksFigure(map, tile, airworks.slug),
  }))
  if (selected.has(airworks.title)) select.value = fountainId
  const labelLayer = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id
  // Towers must cover ordinary images even when a later study supplies the neighbour.
  const paintOrder = [...results].sort((a, b) => Number(a.skyscraper) - Number(b.skyscraper) || (a.skyscraper ? a.y - b.y : 0))
  for (const tile of paintOrder) {
    const id = tile.id
    const { west, east, north, south } = tile.bounds
    map.addSource(id, {
      type: 'image', url: '/' + id + '.webp',
      coordinates: [[west, north], [east, north], [east, south], [west, south]],
    })
    map.addLayer({
      id, type: 'raster', source: id,
      paint: {
        'raster-fade-duration': 0,
        'raster-saturation': tile.study.folder === textiles.slug ? -0.3 : 0,
      },
    }, labelLayer)
  }

  const overlay = document.createElement('div')
  overlay.className = 'study-diagnostics'
  overlay.setAttribute('aria-hidden', 'true')
  map.getContainer().append(overlay)
  const cells: { element: HTMLElement, bounds: ReturnType<typeof tileBounds> }[] = []

  const positionDiagnostics = () => {
    for (const { element, bounds } of cells) {
      const { west, east, north, south } = bounds
      const points = [[west,north],[east,north],[east,south],[west,south]].map(([x,y]) => map.project([x,y]))
      const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y))
      const width = Math.max(...points.map(p => p.x)) - left
      const height = Math.max(...points.map(p => p.y)) - top
      element.style.transform = `translate(${left}px, ${top}px)`
      element.style.width = width + 'px'
      element.style.height = height + 'px'
      const label = element.querySelector('span')
      if (label) {
        const dimensions = `${Math.round(width)} × ${Math.round(height)} px`
        if (label.textContent !== dimensions) label.textContent = dimensions
      }
    }
  }
  const updateDiagnostics = () => {
    overlay.replaceChildren()
    cells.length = 0
    if (!diagnostics.checked) return
    const outlinedTiles = new Set(results.filter(tile => selected.has(tile.study.title) &&
      (select.value === 'all' || select.value === tile.id)).flatMap(tile => tile.cells.map(tileKey)))
    const drawn = new Set<string>()
    const addCell = (x: number, y: number) => {
      const id = tileKey({ x, y })
      if (drawn.has(id)) return
      drawn.add(id)
      const element = document.createElement('div')
      if (outlinedTiles.has(id)) element.append(document.createElement('span'))
      cells.push({ element, bounds: tileBounds({ x, y }) })
      overlay.append(element)
    }
    for (const { title, grid, tiles } of experiments) {
      if (!selected.has(title)) continue
      if (!grid) {
        for (const tile of tiles) addCell(tile.x, tile.y)
        continue
      }
      for (let y = grid.y; y < grid.y + grid.size; y++) {
        for (let x = grid.x; x < grid.x + grid.size; x++) addCell(x, y)
      }
    }
    positionDiagnostics()
  }
  map.on('move', positionDiagnostics)
  map.on('resize', positionDiagnostics)
  diagnostics.onchange = updateDiagnostics

  const artworkTileIds = new Set<string>()
  const seed = studyCloudSeed(new URLSearchParams(location.search).get('cloudSeed'))
  const draw = (x: number, y: number, channel: number) => cloudDraw(seed, x, y, channel)
  const shapeSeed = ({ x, y }) => draw(x, y, 3) * 65536
  let chance = Number(slider.value) / 100
  const studyCloud = ({ x, y }) => draw(x, y, 0xc10d) < chance
  const tileState = new Map<string, 'revealing' | 'generated'>()
  const drawingCells = new Map<string, string[]>()
  const fadingLayers = new Set<string>()
  const hasCloud = tile => studyCloud(tile) && !tileState.has(tileId(tile))
  const cloudBounds = tileBounds
  const isEligible = installStudyEligibility(map, () => { fog?.invalidate(); updateCloudCount() })
  const updateCloudCount = () => {
    if (!toggle.checked) {
      output.value = 'Clouds off'
      return
    }
    const tiles = viewportFogTiles(map).filter(isEligible)
    output.value = slider.value + '% chance · ' + tiles.filter(hasCloud).length + ' of ' + tiles.length + ' visible tiles clouded'
  }
  map.on('moveend', updateCloudCount)
  map.on('resize', updateCloudCount)
  let fog: ReturnType<typeof createFogCanvas> | undefined

  const destroyFog = () => {
    for (const layer of fadingLayers) {
      if (map.getLayer(layer)) map.setPaintProperty(layer, 'raster-opacity', 1)
    }
    fadingLayers.clear()
    tileState.clear()
    fog?.destroy()
    fog = undefined
    map.getCanvas().style.cursor = ''
  }

  const canClear = tile => Boolean(fog) && hasCloud(tile) && isEligible(tile)
  map.on('mousemove', event => {
    map.getCanvas().style.cursor = canClear(tileForPosition(event.lngLat)) ? 'pointer' : ''
  })
  map.on('click', event => {
    const tile = tileForPosition(event.lngLat)
    if (!fog || !canClear(tile)) return
    const id = tileId(tile)
    const ids = (drawingCells.get(id) ?? [id]).filter(cellId => !tileState.has(cellId))
    const layers = results.filter(result =>
      ids.includes(tileId(result)) && map.getLayoutProperty(result.id, 'visibility') === 'visible'
    ).map(result => result.id)
    for (const layer of layers) fadingLayers.add(layer)
    for (const cellId of ids) fog.poke(cellId)
    fog.animateReveal(ids, layers, 1, () => {
      for (const layer of layers) fadingLayers.delete(layer)
    })
    map.getCanvas().style.cursor = ''
    updateCloudCount()
  })

  const update = (frameSelection = false) => {
    const visible = results.filter(tile => selected.has(tile.study.title) && (select.value === 'all' || select.value === tile.id))
    const visibleIds = new Set(visible.map(tile => tile.id))
    showGlitter(visibleIds.has(fountainId))
    showSpotlights(visibleIds.has(theatreId))
    for (const figure of figures) figure.show(visibleIds.has(figure.id))
    for (const tile of visible) {
      if (!('northBackdrop' in tile)) continue
      const hasNeighbour = visible.some(other => other !== tile && other.x === tile.x && other.y === tile.y - 1)
      if (!hasNeighbour) visibleIds.add(tile.northBackdrop)
    }
    updateDiagnostics()
    chance = Number(slider.value) / 100
    artworkTileIds.clear()
    drawingCells.clear()
    for (const drawing of paintOrder) {
      if (!visibleIds.has(drawing.id)) continue
      const ids = drawing.cells.map(tileId)
      for (const id of ids) drawingCells.set(id, ids)
    }
    for (const tile of visible) {
      if (!map.getSource<ImageSource>(tile.id)?.image) continue
      for (const cell of tile.cells) {
        if (studyCloud(cell)) artworkTileIds.add(tileId(cell))
      }
    }
    for (const tile of results) {
      map.setLayoutProperty(tile.id, 'visibility', visibleIds.has(tile.id) ? 'visible' : 'none')
    }
    if (toggle.checked && !fog) {
      fog = createFogCanvas(map, tileState, artworkTileIds, isEligible, false, studyCloud, viewportFogTiles, undefined, cloudBounds, shapeSeed)
    } else if (!toggle.checked && fog) {
      destroyFog()
    }
    fog?.invalidate()
    slider.disabled = !toggle.checked
    updateCloudCount()
    if (frameSelection && visible.length) {
      const bounds = new LngLatBounds()
      for (const tile of visible) {
        const { west, south, east, north } = tile.bounds
        bounds.extend([west, south]).extend([east, north])
      }
      map.fitBounds(bounds, {
        padding: { top: 24, left: 24, right: 24, bottom: Math.min(panel.offsetHeight + 32, map.getContainer().clientHeight / 2) },
        maxZoom: 18.3, duration: 0,
      })
    }
  }
  map.on('sourcedata', event => {
    if (event.sourceDataType === 'metadata' && results.some(tile => tile.id === event.sourceId)) update()
  })
  select.onchange = () => update(true)
  toggle.onchange = () => update()
  slider.oninput = () => update()
  update(true)
  map.once('remove', () => { destroyFog(); panel.remove(); overlay.remove() })
}
