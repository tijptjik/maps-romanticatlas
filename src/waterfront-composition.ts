// The generated coastal tile already contains the basemap in the spaces between
// structures. Blend only at the tile boundary so its piers can cross the shore.
export const composeWaterfrontPixels = (
  source: Uint8Array,
  generated: Uint8Array,
  size: number,
) => {
  const result = new Uint8Array(source)
  const margin = Math.max(1, Math.round(size * 0.05))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      const offset = (y * size + x) * 4
      const opacity = (Math.min(1, edge / margin) * generated[offset + 3]) / 255
      for (let channel = offset; channel < offset + 3; channel++) {
        result[channel] = Math.round(
          source[channel] + (generated[channel] - source[channel]) * opacity,
        )
      }
    }
  }
  return result
}
