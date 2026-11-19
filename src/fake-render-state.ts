// A stable, shuffled half of single-tile cells. Overrides never change ownership.
export function isFakeRenderTile({ x, y }: { x: number; y: number }) {
  let hash = Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3)
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
  state.scene = image.scene
  state.job = crypto.randomUUID()
  state.attempts = 0
  return image
}
