import { createFogSilhouette } from './fog-silhouette'

// Paint the cast light as artwork, like the orb itself. Automatic dark themes
// can turn a pale CSS background gradient into a dark overlay on the book.
export function paintOrbBloom(canvas: HTMLCanvasElement) {
  const size = 256
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const center = size / 2
  const glow = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    Math.SQRT2 * center,
  )
  glow.addColorStop(0, '#fffce9')
  glow.addColorStop(0.26, '#ffe6bda8')
  glow.addColorStop(0.68, '#ffe6bd00')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)
}

function colouredVapour(variant: number, colour: string) {
  const sprite = createFogSilhouette(variant, 0.57, 0, 64)
  const brush = sprite.getContext('2d')!
  brush.globalCompositeOperation = 'source-in'
  brush.fillStyle = colour
  brush.fillRect(0, 0, sprite.width, sprite.height)
  return sprite
}

export function createMist(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!
  const size = 224
  canvas.width = canvas.height = size
  const book = canvas.closest<HTMLElement>('.pavilion-book')!
  const blush = colouredVapour(3, '#edb5e7')
  const violet = colouredVapour(11, '#c2a8ec')
  const coreX = 109
  const coreY = 151
  const glowRadius = 61
  const pearl = ctx.createRadialGradient(coreX - 2, coreY, 2, coreX, coreY, glowRadius)
  pearl.addColorStop(0, '#fff')
  pearl.addColorStop(0.22, '#fffdfffa')
  pearl.addColorStop(0.38, '#fff6ffd9')
  pearl.addColorStop(0.54, '#f2e8ff8c')
  pearl.addColorStop(0.73, '#e9e1ff29')
  pearl.addColorStop(0.89, '#ede5ff0c')
  pearl.addColorStop(1, '#f1eaff00')

  // Offset two translucent banks behind the pearl so only their outer folds show.
  return (time: number) => {
    ctx.clearRect(0, 0, size, size)
    const sway = Math.sin(time * 0.69)
    const swell = Math.sin(time * 0.47 + 1.3)
    ctx.globalAlpha = 0.46
    ctx.drawImage(
      violet,
      coreX - 46 + 3 * sway,
      coreY - 51 + 2 * swell,
      95 + 4 * swell,
      91,
    )
    ctx.globalAlpha = 0.43
    ctx.drawImage(
      blush,
      coreX - 53 - 2 * swell,
      coreY - 46 - 3 * sway,
      94,
      89 + 4 * sway,
    )
    ctx.globalAlpha = 1
    ctx.fillStyle = pearl
    ctx.fillRect(coreX - glowRadius, coreY - glowRadius, glowRadius * 2, glowRadius * 2)
    const pulse = 0.89 + 0.025 * swell
    book.style.setProperty('--orb-radiance', pulse.toFixed(3))
  }
}
