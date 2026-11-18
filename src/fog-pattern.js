const seed = 3161196857
const cloudDraw = (seed, x, y, channel) => {
  let hash = seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663)
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad)
  hash = Math.imul((hash ^ (hash >>> 15)) + channel, 0x735a2d97)
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b)
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32
}

export const defaultCloudCoverage = 0.75

// Shared by rendering, diagnostics and reveal hit testing. No checkerboard.
export const isFogPatternSelected = ({ x, y }) =>
  cloudDraw(seed, x, y, 0xc10d) < defaultCloudCoverage

export const fogShapeSeed = ({ x, y }) => cloudDraw(seed, x, y, 3) * 65536
