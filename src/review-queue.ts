import type { ImageSource, Map as AtlasMap } from 'maplibre-gl'
import type { Revision, RevisionMode } from './artwork-revision'
import type { ArtworkReview, Painting } from './artwork-review'
import { createAtlasTitleCard, positionAtlasTitleCard } from './atlas-title-cards'
import type { drawingFootprint } from './tile-geometry'

type Unit = { art: Painting; footprint: ReturnType<typeof drawingFootprint>; layer: string }

export function installReviewQueue(map: AtlasMap, units: Unit[],
  write: (review: ArtworkReview, method: 'PUT' | 'DELETE') => Promise<ArtworkReview>,
  select: (unit?: Unit) => void,
  revise: (art: Painting, mode: RevisionMode) => Promise<void>,
  remainingUnits: () => Unit[], renderingCount: () => number, failedRevision: () => Revision | undefined) {
  function ordered(items: Unit[]) {
    const rows = [...new Set(items.map(unit => unit.art.y))].sort((a, b) => b - a)
    const direction = new Map(rows.map((y, index) => [y, index % 2 ? -1 : 1]))
    return items.sort(({ art: a }, { art: b }) =>
      b.y - a.y || direction.get(a.y)! * (a.x - b.x) || a.url.localeCompare(b.url))
  }
  ordered(units)

  const card = createAtlasTitleCard(map.getContainer(), '', 'Artwork review')
  card.classList.remove('is-awaiting-focus')
  card.classList.add('atlas-review-queue')
  const title = card.querySelector<HTMLElement>('.atlas-title-card__title')!
  const output = document.createElement('output')
  output.className = 'atlas-title-card__kicker'
  output.setAttribute('aria-live', 'polite')
  card.append(output)
  const tools = document.createElement('div')
  tools.className = 'atlas-revision-actions'
  tools.innerHTML = '<button type="button" aria-keyshortcuts="A" title="Adjust roads and edges [A]">[A]djust</button><button type="button" aria-keyshortcuts="S" title="Spread this concept across the tile [S]">[S]pread</button>'
  card.append(tools)
  const [adjust, spread] = tools.querySelectorAll('button')
  const failedActions = document.createElement('div')
  failedActions.className = 'atlas-revision-actions'
  const retryRevision = document.createElement('button')
  failedActions.append(retryRevision)
  card.append(failedActions)
  const retry = document.createElement('button')
  retry.className = 'atlas-review-retry'
  retry.textContent = 'Retry image'
  retry.hidden = true
  retry.onclick = () => location.reload()
  map.getContainer().append(retry)
  const decisions: ArtworkReview[] = []
  let current: Unit | undefined
  let busy = false
  let removed = false

  function position() {
    if (current) positionAtlasTitleCard(map, card, current.art, undefined, current.footprint.bounds)
  }
  function ready() {
    return current && map.getSource<ImageSource>(current.layer)?.image
  }
  function updateLoading() {
    const waiting = Boolean(current && !ready()) || busy
    card.setAttribute('aria-busy', String(waiting))
    adjust.disabled = spread.disabled = waiting
    retryRevision.disabled = busy
  }
  function focus() {
    if (!current) return
    const { west, east, south, north } = current.footprint.bounds
    const { clientWidth, clientHeight } = map.getContainer()
    const horizontal = clientWidth * 0.05
    const vertical = clientHeight * 0.05
    map.fitBounds([[west, south], [east, north]], {
      padding: { left: horizontal, right: horizontal, top: vertical, bottom: vertical },
      duration: 0, maxZoom: 22,
    })
  }
  function progress() {
    const failed = failedRevision()
    failedActions.hidden = !failed
    if (failed) {
      retryRevision.textContent = 'Retry failed ' + failed.mode + ' · ' + failed.source.title
      retryRevision.onclick = () => void act(failed.mode, failed.source)
    }
    const rendering = renderingCount()
    const total = units.length + rendering
    const position = decisions.length + (current ? 1 : 0)
    const count = position + ' / ' + total
    output.value = rendering ? count + ' · ' + rendering + ' rendering' : count
    output.setAttribute('aria-label', current ? 'Image ' + output.value : output.value + ' reviewed')
  }
  function show() {
    retry.hidden = true
    current = units[decisions.length]
    focus()
    select(current)
    title.textContent = current?.art.title ?? ''
    tools.hidden = title.hidden = !current
    progress()
    card.dataset.complete = String(!current)
    card.hidden = false
    if (current) {
      const unit = current
      const source = map.getSource<ImageSource>(unit.layer)
      source?.once('error', () => { if (current === unit) retry.hidden = false })
    }
    position()
    updateLoading()
  }
  function reconcile() {
    if (busy) return
    const pending = remainingUnits()
    const remaining = units.slice(decisions.length).filter(unit => pending.includes(unit))
    const known = new Set(remaining)
    remaining.push(...ordered(pending.filter(unit => !known.has(unit))))
    units.splice(decisions.length, Infinity, ...remaining)
    if (units[decisions.length] !== current) show()
    else progress()
  }
  async function act(action: 'accepted' | 'rejected' | 'undo' | RevisionMode, retrySource?: Painting) {
    const reversing = action === 'undo'
    if (busy || (reversing ? !decisions.length : !retrySource && !ready())) return
    busy = true
    updateLoading()
    try {
      if (action === 'adjust' || action === 'spread') {
        output.value = 'Queuing revision…'
        await revise(retrySource ?? current!.art, action)
        return
      }
      if (reversing) {
        await write(decisions.at(-1)!, 'DELETE')
        decisions.pop()
      } else {
        decisions.push(await write({ ...current!.art, status: action }, 'PUT'))
      }
      if (!removed) show()
    } catch (error) {
      window.alert('Could not save the artwork review. ' + error.message)
    } finally {
      busy = false
      if (!removed) {
        reconcile()
        updateLoading()
      }
    }
  }
  function keydown(event: KeyboardEvent) {
    if (event.repeat || event.isComposing || event.altKey || (event.shiftKey && !['A', 'S'].includes(event.key)) ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) return
    const action = event.ctrlKey || event.metaKey ? (event.key.toLowerCase() === 'z' ? 'undo' : null)
      : event.key.toLowerCase() === 'a' ? 'adjust' : event.key.toLowerCase() === 's' ? 'spread'
      : event.key === '=' ? 'accepted' : event.key === '-' ? 'rejected' : null
    if (!action) return
    event.preventDefault()
    void act(action)
  }
  adjust.onclick = () => void act('adjust')
  spread.onclick = () => void act('spread')
  map.on('sourcedata', updateLoading)
  map.on('move', position)
  map.on('resize', focus)
  window.addEventListener('keydown', keydown)
  map.once('remove', () => {
    removed = true
    window.removeEventListener('keydown', keydown)
  })
  show()
  return reconcile
}
