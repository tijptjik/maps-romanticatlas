import { test, expect, mock } from 'bun:test'
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }))
const { startSiGeneration, siGenerationStatus } = await import(
  '../../src/si-generation'
)
const actualFetch = globalThis.fetch
const tile = { zoom: 18, x: 214170, y: 114410, scene: 'circus' }

test('missing Si credentials fail before creating a pending job', async () => {
  for (const env of [
    { ATLAS_GENERATOR_ORIGIN: 'https://generator.test' },
    { ATLAS_GENERATOR_TOKEN: 'secret' },
  ]) {
    const response = await startSiGeneration(env, tile, 'data:image/png;base64,abc')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Si image generation is not configured.',
    })
  }
})

test('SI completion publishes both objects before the manifest and tolerates duplicate callbacks', async () => {
  const store = new Map()
  const writes = []
  let indexed = 0
  const env = {
    ATLAS_GENERATOR_ORIGIN: 'https://generator.test',
    ATLAS_GENERATOR_TOKEN: 'secret',
    ATLAS_BUCKET: {
      async put(key, value) {
        store.set(key, value)
        writes.push(key)
      },
      async get(key) {
        const value = store.get(key)
        return value ? { json: async () => JSON.parse(value) } : null
      },
    },
    ATLAS_MANIFEST: {
      getByName() {
        return {
          async upsert([entry]) {
            expect(writes.at(-1)).toEndWith('.json')
            expect(writes.at(-2)).toEndWith('.image')
            expect(entry.variant).toStartWith('discovery-')
            indexed++
          },
        }
      },
    },
  }
  const bytes = new Uint8Array(32)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 1024)
  view.setUint32(20, 1024)
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  let ready = false
  globalThis.fetch = async (url, options) => {
    expect(options.headers.authorization).toBe('Bearer secret')
    if (options.method === 'POST') return new Response('{}', { status: 202 })
    if (!ready) return new Response('{}', { status: 202 })
    if (url.endsWith('/image'))
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.length) },
      })
    return Response.json({ sha256, width: 1024, height: 1024, source: 'thread test' })
  }
  try {
    const start = await startSiGeneration(
      env,
      tile,
      'data:image/png;base64,abc',
      `discovery-${crypto.randomUUID()}`,
    )
    expect(start.status).toBe(202)
    const { statusUrl } = await start.json()
    const id = statusUrl.split('/').at(-1)
    const url = `https://atlas.test${statusUrl}`
    expect((await siGenerationStatus(new Request(url), env, id)).status).toBe(202)
    expect(
      (await siGenerationStatus(new Request(url, { method: 'POST' }), env, id)).status,
    ).toBe(403)
    expect(indexed).toBe(0)
    ready = true
    const complete = await siGenerationStatus(new Request(url), env, id)
    expect(complete.status).toBe(200)
    const payload = await complete.json()
    expect(payload.url).toContain('/generated-tiles/18/214170/114410/circus')
    const retry = await siGenerationStatus(
      new Request(url, { method: 'POST', headers: { authorization: 'Bearer secret' } }),
      env,
      id,
    )
    expect(await retry.json()).toEqual(payload)
    expect(indexed).toBe(1)
  } finally {
    globalThis.fetch = actualFetch
  }
})
