import { restoreSeedScene } from '../src/fake-render-seed'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { claimImage, rotationSnapshot, type FakeRenderState, type RevealImage } from '../src/fake-render-state'

export function createFakeRenderStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(directory + '/clouds.sqlite', { create: true })
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS clouds (id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  const read = (id: string) => {
    const row = db.query('SELECT state FROM clouds WHERE id = ?').get(id) as { state: string } | null
    if (!row) return null
    const state = JSON.parse(row.state) as FakeRenderState
    if (!state.seedSceneVerified && state.scene === 'maze-garden') {
      for (const [request, image] of Object.entries(state.claims)) {
        const restored = restoreSeedScene(image)
        if (restored !== image) {
          state.claims[request] = restored
          state.scene = restored.scene
        }
      }
    }
    state.seedSceneVerified = true
    return state
  }
  const save = (id: string, state: FakeRenderState) => db.query('INSERT OR REPLACE INTO clouds VALUES (?, ?)').run(id, JSON.stringify(state))
  return {
    read, save,
    snapshot(id: string) {
      const state = read(id)
      return rotationSnapshot(state, Object.values(state?.claims ?? {}))
    },
    claim: db.transaction((id: string, seed: RevealImage | null, requestId: string, source: string) => {
      const state = read(id) ?? (seed ? { ready: seed, claims: {}, job: null, sourceImage: '', scene: seed.scene, seedSceneVerified: true, attempts: 0 } : null)
      if (!state) return null
      const result = claimImage(state, requestId, source)
      save(id, state)
      return result
    }),
  }
}
