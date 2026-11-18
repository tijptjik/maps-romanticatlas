import { createPavilionSky } from './pavilion-sky'
import { createPageMist } from './pavilion-page-mist'
import { createHarbourWater } from './pavilion-water'
import { createMist } from './pavilion-mist'

export function installPavilionScene(splash: HTMLElement) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const render = createMist(
    splash.querySelector<HTMLCanvasElement>('.pavilion-orb canvas')!,
  )
  const water = splash.querySelector<HTMLCanvasElement>('.pavilion-water')!
  const renderWater = createHarbourWater(water)
  const pageMist = splash.querySelector<HTMLCanvasElement>(
    '.pavilion-page-mist canvas',
  )!
  const renderPages = createPageMist(pageMist)
  const drawSky = createPavilionSky(splash)
  let visible = false
  let frame = 0
  let last = 0
  let elapsed = 0
  let lastDetail = 0

  function draw(now: number) {
    if (!visible || document.hidden) return
    if (last && !motion.matches) elapsed += (now - last) / 1000
    last = now
    render(elapsed)
    drawSky(elapsed)
    if (!lastDetail || now - lastDetail >= 32) {
      lastDetail = now
      renderWater(elapsed, splash.classList.contains('is-night'))
      renderPages(elapsed)
    }
    if (!motion.matches) frame = requestAnimationFrame(draw)
  }
  function refresh() {
    cancelAnimationFrame(frame)
    last = lastDetail = 0
    if (visible && !document.hidden) frame = requestAnimationFrame(draw)
  }
  splash.addEventListener('sky-ready', refresh)
  water.addEventListener('water-ready', refresh)
  pageMist.addEventListener('mist-ready', refresh)
  new ResizeObserver(refresh).observe(splash)
  document.addEventListener('visibilitychange', refresh)
  motion.addEventListener('change', refresh)
  return (active: boolean) => {
    visible = active
    refresh()
  }
}
