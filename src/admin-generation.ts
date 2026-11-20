import { Marker, type Map as AtlasMap, type GeoJSONSource } from 'maplibre-gl'
import { atlasSceneGridRadius } from './atlas-protocol'
import { atlasSceneTitle } from './atlas-title-cards'
import type { AtlasScene } from './atlas-scenes'
import { artworkReferences } from './revision-references'
import { type Revision } from './artwork-revision'
import { availableFamilies, familyIndex, generationEndpoint, scenesForFamily } from './generation-targets'
import { fogEligibilityChildSpan, fogEligibilitySourceZoom, type FogEligibility } from './fog-eligibility'
import { tileBounds, tileForPosition, tilePolygon } from './tile-geometry'

type Target = { tile: FogEligibility; families: AtlasScene[] }
type Parent = { eligibility: FogEligibility[]; cached: {x: number; y: number; scene: string}[] }
type Placement = Parameters<typeof familyIndex>[0]
const key = (tile: {x: number; y: number}) => tile.x + '/' + tile.y

export function installAdminGeneration(map: AtlasMap, inventory: () => Placement,
  submit: (endpoint: string, body: unknown, method: 'POST') => Promise<Revision>,
  queued: (job: Revision) => void, notice: HTMLElement) {
  const layer = 'admin-generation-targets'
  const empty = { type: 'FeatureCollection' as const, features: [] }
  map.addSource(layer, { type: 'geojson', data: empty })
  map.addLayer({ id: layer, source: layer, type: 'fill', paint: {
    'fill-color': '#408473', 'fill-opacity': 0.15, 'fill-outline-color': '#246454',
  }}, 'discovery-tile-edges')
  let targets = new Map<string, Target>()
  const markers = new Map<string, Marker>()
  const parents = new Map<string, Promise<Parent>>()
  const inFlight = new Set<string>()
  let epoch = 0
  let disposed = false
  const dialog = document.createElement('dialog')
  dialog.className = 'atlas-generation-dialog'
  dialog.setAttribute('aria-label', 'Choose a scene')
  dialog.innerHTML = '<form method="dialog"><h2>Choose a scene</h2><label>Scene family<select name="family" aria-label="Scene family"></select></label><label>Scene<select name="scene" aria-label="Scene"></select></label><p></p><footer><button value="cancel">Cancel</button><button value="queue">Queue scene</button></footer></form>'
  map.getContainer().append(dialog)
  const [family, scene] = dialog.querySelectorAll('select')
  const description = dialog.querySelector('p')!
  let selected: Target
  function describe() {
    description.textContent = scenesForFamily(family.value as AtlasScene).find(item => item.name === scene.value)?.prompt
  }
  family.onchange = () => {
    scene.replaceChildren(...scenesForFamily(family.value as AtlasScene).map(item => new Option(item.name)))
    describe()
  }
  scene.onchange = describe
  function open(target: Target) {
    if (dialog.open || inFlight.has(key(target.tile))) return
    selected = target
    family.replaceChildren(...target.families.map(id => new Option(atlasSceneTitle(id), id)))
    family.dispatchEvent(new Event('change'))
    dialog.showModal()
  }
  dialog.querySelector('form')!.onsubmit = event => {
    if ((event.submitter as HTMLButtonElement)?.value === 'queue')
      void enqueue(selected, { family: family.value, scene: scene.value })
  }
  async function enqueue(target: Target, choice: { random: true } | { family: string; scene: string }) {
    const { x, y } = target.tile
    const id = key(target.tile)
    if (inFlight.has(id)) return
    inFlight.add(id)
    notice.textContent = 'Preparing the map reference…'
    try {
      const { mapImage } = await artworkReferences({ x, y, rows: 1 })
      const job = await submit(generationEndpoint, { x, y, mapImage, ...choice }, 'POST')
      queued(job)
      notice.textContent = 'Queued ' + job.source.title + ' · ' + atlasSceneTitle(job.source.scene)
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : 'Could not queue the scene.'
    } finally {
      inFlight.delete(id)
      if (!disposed) void refresh()
    }
  }
  function parent(x: number, y: number) {
    const id = x + '/' + y
    if (!parents.has(id)) {
      const request = fetch('/api/fog-index/' + fogEligibilitySourceZoom + '/' + id).then(async response => {
        if (!response.ok) throw Error('Target map unavailable. Pan to retry.')
        const result: Parent = await response.json()
        if (!Array.isArray(result.eligibility) || !Array.isArray(result.cached)) throw Error('Target inventory unavailable.')
        return result
      }).catch(error => { parents.delete(id); throw error })
      parents.set(id, request)
    }
    return parents.get(id)!
  }
  function draw(next: Map<string, Target>) {
    targets = next
    map.getSource<GeoJSONSource>(layer)!.setData({ type: 'FeatureCollection', features: [...targets.values()].map(({tile}) => ({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [tilePolygon(tile)] },
    })) })
    for (const [id, marker] of markers) if (!next.has(id)) { marker.remove(); markers.delete(id) }
    for (const [id, {tile}] of next) {
      if (markers.has(id)) continue
      const control = document.createElement('div')
      control.className = 'atlas-generation-control'
      const choose = document.createElement('button')
      choose.textContent = 'Choose scene'
      choose.onclick = () => open(targets.get(id)!)
      const random = document.createElement('button')
      random.className = 'atlas-mystery-box'
      random.innerHTML = '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="m2 8 12-6 12 6-12 6Z M2 8v13l12 6 12-6V8 M14 14v13" fill="#eac27a" stroke="currentColor" stroke-width="1.6"/><text x="19" y="19" text-anchor="middle" fill="currentColor" font-size="11" font-weight="bold">?</text></svg>'
      random.title = 'Queue a random scene'
      random.setAttribute('aria-label', 'Queue a random scene on tile ' + id)
      random.onclick = () => void enqueue(targets.get(id)!, { random: true })
      control.append(choose, random)
      control.addEventListener('click', event => event.stopPropagation())
      const b = tileBounds(tile)
      markers.set(id, new Marker({element: control}).setLngLat([(b.west+b.east)/2, (b.south+b.north)/2]).addTo(map))
    }
  }
  async function refresh() {
    const current = ++epoch
    // At overview scales one tile cannot accommodate a usable map control.
    if (map.getZoom() < 16) {
      draw(new Map())
      parents.clear()
      return
    }
    const bounds = map.getBounds()
    const nw = tileForPosition(bounds.getNorthWest()), se = tileForPosition(bounds.getSouthEast())
    const requests: Promise<Parent>[] = []
    const needed = new Set<string>()
    const span = fogEligibilityChildSpan
    for (let y = Math.floor((nw.y-atlasSceneGridRadius)/span); y <= Math.floor((se.y+atlasSceneGridRadius)/span); y++) {
      for (let x = Math.floor((nw.x-atlasSceneGridRadius)/span); x <= Math.floor((se.x+atlasSceneGridRadius)/span); x++) {
        needed.add(x + '/' + y)
        requests.push(parent(x, y))
      }
    }
    for (const id of parents.keys()) if (!needed.has(id)) parents.delete(id)
    try {
      const groups = await Promise.all(requests)
      if (current !== epoch || disposed) return
      const index = familyIndex([...inventory(), ...groups.flatMap(group => group.cached)])
      const next = new Map<string, Target>()
      for (const tile of groups.flatMap(group => group.eligibility)) {
        if (tile.x < nw.x || tile.y < nw.y || tile.x > se.x || tile.y > se.y) continue
        const families = availableFamilies(tile, index)
        if (families.length) next.set(key(tile), { tile, families })
      }
      draw(next)
    } catch (error) {
      if (current !== epoch || disposed) return
      draw(new Map())
      notice.textContent = error instanceof Error ? error.message : 'Target map unavailable.'
    }
  }
  void refresh()
  map.on('moveend', refresh)
  map.once('remove', () => {
    disposed = true
    for (const marker of markers.values()) marker.remove()
    dialog.remove()
  })
  return { refresh, select(tile: {x: number; y: number}) {
    const target = targets.get(key(tile))
    if (target) open(target)
    return Boolean(target)
  } }
}
