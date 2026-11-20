import { restoreSeedScene } from './fake-render-seed'
import { DurableObject } from 'cloudflare:workers'
import { claimImage, rotationSnapshot, type FakeRenderState, type RevealImage } from './fake-render-state'
import { startSiGeneration, siGenerationStatus } from './si-generation'
import type { AtlasScene } from './atlas-scenes'

type Position = { zoom: number; x: number; y: number }
export class FakeRenderCloud extends DurableObject<Env> {
  async hasReadyImage() {
    const state = await this.ctx.storage.get<FakeRenderState>('state')
    return !state || Boolean(state.ready)
  }

  async snapshot() {
    // Existing claim receipts are also the release history. Read every page so
    // tiles that predate this feature participate without a migration.
    return this.ctx.storage.transaction(async txn => {
      const images: RevealImage[] = []
      let startAfter: string | undefined
      for (;;) {
        const page = await txn.list<RevealImage>({ prefix: 'claim:', startAfter, limit: 256 })
        images.push(...Array.from(page.values(), restoreSeedScene))
        if (page.size < 256) break
        startAfter = [...page.keys()].at(-1)
      }
      return rotationSnapshot(await txn.get<FakeRenderState>('state'), images)
    })
  }

  async claim(position: Position, seed: RevealImage | null, requestId: string, sourceImage: string) {
    const priorClaim = await this.ctx.storage.get<RevealImage>('claim:' + requestId)
    if (priorClaim) return restoreSeedScene(priorClaim)
    const sourceKey = `fake-render-sources/${position.zoom}/${position.x}/${position.y}/${requestId}.txt`
    const previous = await this.ctx.storage.get<FakeRenderState>('state')
    if (previous && !previous.ready) return null
    await this.env.ATLAS_BUCKET.put(sourceKey, sourceImage)
    // The storage transaction serializes claims, including across Worker instances.
    const result = await this.ctx.storage.transaction(async txn => {
      const prior = await txn.get<RevealImage>('claim:' + requestId)
      if (prior) return restoreSeedScene(prior)
      let state = await txn.get<FakeRenderState>('state')
      if (!state) {
        if (!seed) return null
        state = { ready: seed, claims: {}, job: null, sourceImage: '', scene: seed.scene, seedSceneVerified: true, attempts: 0 }
      }
      if (!state.seedSceneVerified && state.scene === 'maze-garden') {
        let startAfter: string | undefined
        for (;;) {
          const page = await txn.list<RevealImage>({ prefix: 'claim:', startAfter, limit: 256 })
          for (const image of page.values()) {
            const restored = restoreSeedScene(image)
            if (restored !== image) state.scene = restored.scene
          }
          if (state.scene !== 'maze-garden' || page.size < 256) break
          startAfter = [...page.keys()].at(-1)
        }
      }
      state.seedSceneVerified = true
      const image = claimImage(state, requestId, sourceKey)
      if (image) await txn.put('claim:' + requestId, image)
      state.claims = {}
      await txn.put({ state, position })
      if (state.job && state.attempts < 3 && !await txn.getAlarm()) await txn.setAlarm(Date.now() + 100)
      return image
    })
    const current = await this.ctx.storage.get<FakeRenderState>('state')
    if (current?.sourceImage !== sourceKey) await this.env.ATLAS_BUCKET.delete(sourceKey)
    return result
  }

  async alarm() {
    const state = await this.ctx.storage.get<FakeRenderState>('state')
    const position = await this.ctx.storage.get<Position>('position')
    if (!state?.job || !position) return
    // Arm before network I/O so eviction or an upstream failure cannot lose work.
    await this.ctx.storage.setAlarm(Date.now() + 15_000)
    try {
      const source = await this.env.ATLAS_BUCKET.get(state.sourceImage)
      if (!source) throw Error('Missing replacement source')
      await startSiGeneration(this.env, { ...position, scene: state.scene as AtlasScene }, await source.text(), 'discovery-rotating', state.job)
      const response = await siGenerationStatus(new Request('https://atlas.internal/status'), this.env, state.job)
      if (response.status === 202) return
      if (!response.ok) {
        const latest = await this.ctx.storage.get<FakeRenderState>('state')
        if (latest?.job === state.job) {
          latest.job = crypto.randomUUID()
          latest.attempts++
          await this.ctx.storage.put('state', latest)
          if (latest.attempts >= 3) await this.ctx.storage.deleteAlarm()
          else await this.ctx.storage.setAlarm(Date.now() + 60_000)
        }
        return
      }
      const image = await response.json<RevealImage>()
      await this.ctx.storage.transaction(async txn => {
        const latest = await txn.get<FakeRenderState>('state')
        if (latest?.job !== state.job) return
        latest.ready = image
        latest.job = null
        latest.sourceImage = ''
        await txn.put('state', latest)
        await txn.deleteAlarm()
      })
      await this.env.ATLAS_BUCKET.delete(state.sourceImage)
    } catch (error) {
      console.error('Fake render replacement failed', state.job, String(error))
      // Bound retries; leave the image consumed, never hand it out again.
      await this.ctx.storage.transaction(async txn => {
        const latest = await txn.get<FakeRenderState>('state')
        if (latest?.job !== state.job) return
        latest.attempts++
        if (latest.attempts >= 3) await txn.deleteAlarm()
        else await txn.setAlarm(Date.now() + 60_000)
        await txn.put('state', latest)
      })
    }
  }
}
