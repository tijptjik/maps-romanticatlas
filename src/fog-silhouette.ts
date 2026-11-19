export function createFogSilhouette(
  variant: number,
  radius: number,
  padding: number,
  unit = 80,
) {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = Math.ceil(unit * (1 + padding * 2))
  const context = sprite.getContext('2d')
  if (!context) throw new Error('Could not create the cloud silhouette canvas.')
  // Broad circular banks overlap across cells. Seeded harmonics soften
  // their outline without introducing straight tile edges.
  const pixels = context.createImageData(sprite.width, sprite.height)
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      const dx = (x / unit - padding - 0.5) / radius
      const dy = (y / unit - padding - 0.5) / radius
      const angle = Math.atan2(dy, dx)
      const distance = Math.hypot(dx, dy)
      const edge =
        0.75 +
        0.09 * Math.sin(angle * 3 + variant) +
        0.045 * Math.sin(angle * 5 - variant * 0.7)
      const fade = Math.max(0, Math.min(1, (distance - 0.16) / (edge - 0.16)))
      const offset = (y * sprite.width + x) * 4
      pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = 255
      pixels.data[offset + 3] = Math.round(255 * (1 - fade * fade * (3 - 2 * fade)))
    }
  }
  context.putImageData(pixels, 0, 0)
  return sprite
}
