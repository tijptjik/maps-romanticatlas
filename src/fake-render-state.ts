// The page seed keeps assignment stable during a visit. Seed zero supports older clients.
export function isFakeRenderTile({ x, y }: { x: number; y: number }, visit = 0) {
  let hash = Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3) ^ visit
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000 < 0.5
}

export type RevealImage = { title?: string; url: string; scene: string; contentBounds?: { x: number; y: number; width: number; height: number } | null }
export type FakeRenderState = {
  ready: RevealImage | null
  claims: Record<string, RevealImage>
  job: string | null
  sourceImage: string
  scene: string
  seedSceneVerified?: boolean
  attempts: number
}

// Run this transition under the backend's per-cell lock/transaction.
export function claimImage(state: FakeRenderState, requestId: string, sourceImage: string) {
  if (state.claims[requestId]) return state.claims[requestId]
  if (!state.ready) return null
  const image = state.ready
  state.claims[requestId] = image
  state.ready = null
  state.sourceImage = sourceImage
  state.job = crypto.randomUUID()
  state.attempts = 0
  return image
}

export const isRotatingVariant = (variant: string) => variant.startsWith('discovery-rotating-')

export function rotationSnapshot(state: FakeRenderState | null | undefined, claims: Iterable<RevealImage>) {
  const released = new Map<string, RevealImage>()
  for (const image of claims) released.set(image.url, image)
  return { ready: !state || Boolean(state.ready), released: [...released.values()] }
}
