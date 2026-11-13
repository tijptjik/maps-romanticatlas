import { expect, test } from 'bun:test'
import { createMapAssetCache } from './map-asset-cache.ts'

test('shares concurrent downloads, keeps independent bodies and keys releases', async () => {
  let calls = 0
  const load = createMapAssetCache(async () => {
    calls++
    await Promise.resolve()
    return new Response('tile')
  })
  const url = 'https://tiles.example/map.mvt?v=one'
  const [a, b] = await Promise.all([load(url), load(url)])
  expect(await a.text()).toBe('tile')
  expect(await b.text()).toBe('tile')
  await load(url)
  expect(calls).toBe(1)
  await load(url.replace('one', 'two'))
  expect(calls).toBe(2)
})

test('evicts by bytes and retries failures and unversioned assets', async () => {
  let calls = 0
  const load = createMapAssetCache(async () => {
    calls++
    return new Response('1234', { status: calls === 1 ? 503 : 200 })
  }, 4)
  const url = 'https://tiles.example/map.mvt?v=one'
  expect((await load(url)).status).toBe(503)
  expect((await load(url)).status).toBe(200)
  await load(url.replace('one', 'two'))
  await load(url)
  expect(calls).toBe(4)
  await load('https://tiles.example/map.json')
  await load('https://tiles.example/map.json')
  expect(calls).toBe(6)
})

test('retries rejected downloads', async () => {
  let calls = 0
  const load = createMapAssetCache(async () => {
    if (++calls === 1) throw new Error('offline')
    return new Response('ok')
  })
  const url = 'https://tiles.example/map.mvt?v=one'
  await expect(load(url)).rejects.toThrow('offline')
  expect(await (await load(url)).text()).toBe('ok')
})
