import './fountain-glitter.css'
import type { Painting } from './artwork-review'
import { LngLatBounds, type Map as AtlasMap } from 'maplibre-gl'
import { drawingFootprint, tileBounds } from './tile-geometry.ts'

export function installFountainGlitter(map: AtlasMap, tile: { x: number, y: number, glitterOrigin: number[] }) {
  const plume = document.createElement('div')
  plume.className = 'fountain-glitter'
  plume.hidden = true
  plume.setAttribute('aria-hidden', 'true')
  map.getCanvasContainer().append(plume)
  // Each local unit is one hundredth of a map tile.
  for (let i = 0; i < 40; i++) {
    const flake = document.createElement('i')
    flake.style.setProperty('--drift', (65 + i * 29 % 73) + 'px')
    flake.style.setProperty('--rise', (-12 - i * 7 % 15) + 'px')
    flake.style.setProperty('--fall', (4 + i * 11 % 33) + 'px')
    flake.style.animationDuration = (4 + (i % 7) / 3) + 's'
    flake.style.animationDelay = -(i * 1.618) + 's'
    plume.append(flake)
  }

  return anchorArtwork(map, plume, tile, tile.glitterOrigin, 100)
}

export function installAirworksFigure(map: AtlasMap, tile, folder: string, spriteUrl?: string) {
  const { box, sprite } = tile.motion
  const size = tile.illustration.pixelsPerTile
  const actor = document.createElement('div')
  actor.className = 'airworks-figure'
  actor.hidden = true
  actor.setAttribute('aria-hidden', 'true')
  const track = document.createElement('div')
  track.className = sprite
  const image = new Image(box[2] - box[0], box[3] - box[1])
  image.src = spriteUrl ?? '/' + folder + '/' + sprite + '.webp'
  image.alt = ''
  track.append(image)
  actor.append(track)
  map.getCanvasContainer().append(actor)
  // Registered plates start one tile north of their ground tile.
  return anchorArtwork(map, actor, tile, [box[0] / size, box[1] / size - 1], size)
}

export function installTheatreSpotlights(map: AtlasMap, tile, origin: number[]) {
  const bowl = document.createElement('div')
  bowl.className = 'eclipse-spotlights'
  bowl.hidden = true
  bowl.setAttribute('aria-hidden', 'true')
  const canvas = document.createElement('canvas')
  // Leave headroom for the two lamps along the rail beneath the bronze disc.
  const headroom = 60
  canvas.width = 700
  canvas.height = 520
  bowl.append(canvas)
  map.getCanvasContainer().append(bowl)
  const context = canvas.getContext('2d')!
  context.setTransform(2, 0, 0, 2, 0, headroom * 2)
  const lights = [
    { path: 'M 64 103 C 47 77 77 51 130 53 S 238 82 235 100 S 188 153 155 161 C 119 167 82 123 64 103 Z', lamp: [146, -28], rx: 48.5, ry: 18 },
    { path: 'M 268 57 C 248 47 211 62 197 94 S 177 152 155 161 C 126 166 88 119 112 94 S 230 49 268 57 Z', lamp: [250, -40], rx: 42.5, ry: 16 },
  ].map(light => {
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    track.setAttribute('d', light.path)
    return { ...light, track, length: track.getTotalLength() }
  })
  const mask = new Path2D('M 8 116 C 7 61 66 29 148 25 C 222 17 279 20 335 28 Q 297 100 152 195 L 84 185 Q 80 157 32 150 Z')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let start = 0
  const draw = (now: number) => {
    frame = 0
    const phase = reduced.matches ? 0 : ((now - start) % 12000) / 12000
    const distance = phase - Math.sin(phase * 2 * Math.PI) / (2 * Math.PI)
    context.clearRect(0, -headroom, 350, 260)
    for (const { track, length, lamp, rx, ry } of lights) {
      const { x, y } = track.getPointAtLength(distance * length)
      context.save()
      context.translate(x, y)
      context.rotate(-Math.PI / 12)
      context.scale(rx, ry)
      // In the pool's unit-circle coordinates, the two tangent points give
      // the cone a continuous silhouette at every angle of its sweep.
      const inverse = context.getTransform().inverse()
      const tip = new DOMPoint(lamp[0] * 2, (lamp[1] + headroom) * 2).matrixTransform(inverse)
      const squared = tip.x ** 2 + tip.y ** 2
      const tangent = Math.sqrt(squared - 1)
      const haze = context.createLinearGradient(tip.x, tip.y, 0, 0)
      haze.addColorStop(0, 'rgba(255,224,158,.27)')
      haze.addColorStop(1, 'rgba(255,213,129,.12)')
      context.fillStyle = haze
      context.beginPath()
      context.moveTo(tip.x, tip.y)
      context.lineTo((tip.x - tip.y * tangent) / squared, (tip.y + tip.x * tangent) / squared)
      context.lineTo((tip.x + tip.y * tangent) / squared, (tip.y - tip.x * tangent) / squared)
      context.fill()
      context.restore()

      context.save()
      context.clip(mask)
      context.translate(x, y)
      context.rotate(-Math.PI / 12)
      context.scale(rx, ry)
      const pool = context.createRadialGradient(0, 0, 0, 0, 0, 1)
      pool.addColorStop(0, '#ffe598b5')
      pool.addColorStop(.74, '#ffd2739c')
      pool.addColorStop(1, '#ffce6d00')
      context.fillStyle = pool
      context.fillRect(-1, -1, 2, 2)
      context.restore()
    }
    if (!reduced.matches) frame = requestAnimationFrame(draw)
  }
  const refresh = () => {
    cancelAnimationFrame(frame)
    if (!bowl.hidden) draw(performance.now())
  }
  reduced.addEventListener('change', refresh)
  map.once('remove', () => {
    cancelAnimationFrame(frame)
    reduced.removeEventListener('change', refresh)
  })
  const size = tile.illustration.pixelsPerTile
  return anchorArtwork(map, bowl, tile, [origin[0] / size, origin[1] / size - 1], size, () => {
    start = performance.now()
    refresh()
  })
}

function anchorArtwork(map: AtlasMap, element: HTMLElement, tile: Parameters<typeof drawingFootprint>[0],
  [x, y]: number[], unitsPerTile: number, onVisibilityChange?: () => void) {
  const { west, south, east, north } = drawingFootprint(tile).bounds
  const imageBounds = new LngLatBounds([west, south], [east, north])
  let selected = false
  const project = (dx: number, dy: number) => {
    const { west, north } = tileBounds({ x: tile.x + x + dx, y: tile.y + y + dy })
    return map.project([west, north])
  }
  const position = () => {
    const visible = selected && !document.hidden && map.getBounds().intersects(imageBounds)
    if (element.hidden === visible) {
      element.hidden = !visible
      onVisibilityChange?.()
    }
    if (!visible) return
    const origin = project(0, 0)
    const east = project(1 / unitsPerTile, 0).sub(origin)
    const south = project(0, 1 / unitsPerTile).sub(origin)
    element.style.transform = `matrix(${east.x}, ${east.y}, ${south.x}, ${south.y}, ${origin.x}, ${origin.y})`
  }
  map.on('move', position)
  map.on('resize', position)
  document.addEventListener('visibilitychange', position)
  map.once('remove', () => {
    map.off('move', position)
    map.off('resize', position)
    document.removeEventListener('visibilitychange', position)
    element.remove()
  })
  return (visible: boolean) => {
    selected = visible
    position()
  }
}

// A painting can occur in several catalog sheets. Keep one overlay per artwork
// and let its existing map anchor handle zoom, pan and document visibility.
export function installArtworkAnimations(map: AtlasMap) {
  const overlays = new Map<string, (visible: boolean) => void>()
  return (displayed: Iterable<Painting>) => {
    const visible = new Set<string>()
    for (const art of displayed) {
      const animation = art.animation
      if (!animation) continue
      visible.add(art.url)
      if (overlays.has(art.url)) continue
      const tile = { ...art, scene: 'skyscraper', illustration: { pixelsPerTile: animation.pixelsPerTile } }
      if (animation.glitterOrigin) {
        overlays.set(art.url, installFountainGlitter(map, { ...tile, glitterOrigin: animation.glitterOrigin }))
      } else if (animation.auditoriumOriginPixels) {
        overlays.set(art.url, installTheatreSpotlights(map, tile, animation.auditoriumOriginPixels))
      } else if (animation.motion && animation.folder) {
        overlays.set(art.url, installAirworksFigure(map, { ...tile, motion: animation.motion }, animation.folder, animation.spriteUrl))
      }
    }
    for (const [url, show] of overlays) show(visible.has(url))
  }
}
