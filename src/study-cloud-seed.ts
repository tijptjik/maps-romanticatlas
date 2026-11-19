// Generated once so unparameterised experiment links share the same sky.
const defaultSeed = 3161196857

export const studyCloudSeed = (value: string | null) => {
  if (value === null || !/^\d+$/.test(value)) return defaultSeed
  const seed = Number(value)
  return seed <= 0xffffffff ? seed : defaultSeed
}

export const cloudDraw = (seed: number, x: number, y: number, channel: number) => {
  let hash = seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663)
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad)
  hash = Math.imul((hash ^ (hash >>> 15)) + channel, 0x735a2d97)
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b)
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32
}
