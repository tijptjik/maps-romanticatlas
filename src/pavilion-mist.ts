import { createFogSilhouette } from './fog-silhouette'

function colouredVapour(variant: number, colour: string) {
  const sprite = createFogSilhouette(variant, .57, 0, 64)
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
  pearl.addColorStop(.22, '#fffdfffa')
  pearl.addColorStop(.38, '#fff6ffd9')
  pearl.addColorStop(.54, '#f2e8ff8c')
  pearl.addColorStop(.73, '#e9e1ff29')
  pearl.addColorStop(.89, '#ede5ff0c')
  pearl.addColorStop(1, '#f1eaff00')

  // Offset two translucent banks behind the pearl so only their outer folds show.
  return (time: number) => {
    ctx.clearRect(0, 0, size, size)
    const sway = Math.sin(time * .69)
    const swell = Math.sin(time * .47 + 1.3)
    ctx.globalAlpha = .46
    ctx.drawImage(violet, coreX - 46 + 3 * sway, coreY - 51 + 2 * swell, 95 + 4 * swell, 91)
    ctx.globalAlpha = .43
    ctx.drawImage(blush, coreX - 53 - 2 * swell, coreY - 46 - 3 * sway, 94, 89 + 4 * sway)
    ctx.globalAlpha = 1
    ctx.fillStyle = pearl
    ctx.fillRect(coreX - glowRadius, coreY - glowRadius, glowRadius * 2, glowRadius * 2)
    const pulse = .89 + .025 * swell
    book.style.setProperty('--orb-radiance', pulse.toFixed(3))
  }
}
