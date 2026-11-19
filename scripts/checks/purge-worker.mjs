// Run against the Wrangler dry-run bundle. Both R2 and the manifest are ephemeral.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const sha = text => createHash('sha256').update(text).digest('hex')
const origin = 'https://atlas.test'
const bundle = path.resolve('.local/purge-worker')
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    modulesRoot: bundle,
    modules: [
      { type: 'ESModule', path: path.join(bundle, 'fixture.js'), contents: `
        import app from './worker.js'
        export * from './worker.js'
        export default { fetch(request, env, ctx) {
          // Miniflare validates Origin at its localhost proxy. Restore the
          // simulated public request headers on the Worker side of that proxy.
          const headers = new Headers(request.headers)
          headers.set('host', new URL(request.url).host)
          if (headers.has('x-fixture-origin')) headers.set('origin', headers.get('x-fixture-origin'))
          return app.fetch(new Request(request, { headers }), env, ctx)
        } }
      ` },
      { type: 'ESModule', path: path.join(bundle, 'worker.js') },
      ...readdirSync(bundle, { recursive: true })
        .filter(name => name.endsWith('.wasm'))
        .map(name => ({ type: 'CompiledWasm', path: path.join(bundle, name) })),
    ],
    compatibilityDate: '2026-07-18',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ATLAS_ADMIN_TOKEN: 'fixture', ATLAS_ALLOWED_ORIGIN: origin, ATLAS_SHARE_ASSET_ORIGIN: 'https://media.test' },
    outboundService: request => new Response(new URL(request.url).pathname, { headers: { etag: '"fixture"' } }),
    r2Buckets: ['ATLAS_BUCKET', 'maps_romanticatlas_assets'],
    durableObjects: { ATLAS_MANIFEST: { className: 'AtlasManifest', useSQLite: true } },
  }),
)
try {
  const worker = await mf.getWorker()
  const tiles = await mf.getR2Bucket('ATLAS_BUCKET')
  const media = await mf.getR2Bucket('maps_romanticatlas_assets')
  const catalog = await (await worker.fetch(origin + '/atlas-v2/catalog.json')).json()
  const painting = catalog.sheets.flatMap(s => s.art).find(a => a.imageUrl?.startsWith('/release-assets/'))
  assert.match(painting.imageUrl, /^\/release-assets\/[a-f0-9]{64}\./)
  const immutable = await worker.fetch(origin + painting.imageUrl)
  assert.match(immutable.headers.get('cache-control'), /immutable/)
  assert.equal(await immutable.text(), painting.imageUrl.split('#')[0])
  const alias = await worker.fetch(origin + painting.url)
  assert.equal(alias.headers.get('cache-control'), 'no-cache')
  assert.equal(await alias.text(), painting.imageUrl.split('#')[0])
  const unknown = await worker.fetch(origin + '/release-assets/' + '0'.repeat(64) + '.webp')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers.get('cache-control'), 'no-store')
  const endpoint = origin + '/api/artwork-purge?admin'
  const headers = {
    'x-fixture-origin': origin,
    authorization: 'Bearer fixture',
    'content-type': 'application/json',
  }
  assert.equal((await worker.fetch(endpoint)).status, 403)
  const inventory = await worker.fetch(endpoint, { headers })
  assert.equal(inventory.status, 200, inventory.ok ? undefined : await inventory.text())
  const cookie = inventory.headers.get('set-cookie').split(';')[0]
  const post = (bucket, objects, csrf = true) =>
    worker.fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        ...(csrf ? { cookie, 'x-atlas-csrf-token': cookie.split('=')[1] } : {}),
      },
      body: JSON.stringify({ bucket, objects }),
    })
  const review = async (url, status) =>
    tiles.put('v2-artwork-reviews/' + encodeURIComponent(url), '', {
      customMetadata: {
        review: encodeURIComponent(
          JSON.stringify({ url, title: 'Fixture', x: 2, y: 3, rows: 1, status }),
        ),
      },
    })
  const url = '/study/discard.webp'
  const key = 'release-assets/' + sha('painting') + '.webp'
  const objects = [{ key, sha256: sha('painting') }]
  await media.put(key, 'painting')
  await review(url, 'rejected')
  assert.equal((await post('media', objects, false)).status, 403)
  const reviewsUrl = origin + '/api/artwork-reviews'
  const decision = async () => (await (await worker.fetch(reviewsUrl)).json()).findLast(r => r.url === url)?.status
  assert.equal(await decision(), 'rejected')
  await review(url, 'accepted')
  assert.equal(await decision(), 'rejected') // Direct bucket writes bypass invalidation.
  const saved = await worker.fetch(reviewsUrl + '?admin', {
    method: 'PUT',
    headers: { ...headers, cookie, 'x-atlas-csrf-token': cookie.split('=')[1] },
    body: JSON.stringify({ url, status: 'accepted', title: 'Fixture', x: 2, y: 3, rows: 1 }),
  })
  assert.equal(saved.status, 200)
  assert.equal(await decision(), 'accepted')
  const published = await (await worker.fetch(origin + '/atlas-v2/release-objects.json')).json()
  assert.equal(published.version, 2)
  assert.deepEqual(await inventory.json(), published)
  assert.ok(published.tiles.length)
  const publishedTile = published.tiles.find(key => key.endsWith('.image'))
  assert.equal((await post('tiles', [publishedTile, publishedTile.replace(/\.image$/, '.json')].map(key => ({ key, sha256: null })))).status, 409)
  assert.equal((await post('media', [{ key: published.media[0], sha256: null }])).status, 409)
  assert.equal((await post('media', [{ key: 'shared-maps/keep.png', sha256: null }])).status, 409)
  assert.equal((await post('tiles', [{ key: 'v2-artwork-reviews/example', sha256: null }])).status, 409)
  assert.equal((await post('media', objects)).status, 200)
  assert.equal(await media.head(key), null)
  assert.equal(await decision(), 'accepted')

  const pair = ['image', 'json'].map(ext => ({
    key: 'atlas/18/2/3/wind-farm.v6.discovery-test.' + ext,
    sha256: sha(ext),
  }))
  await tiles.put(pair[0].key, 'image')
  await tiles.put(pair[1].key, 'json')
  assert.equal(
    (await post('tiles', [pair[0], { ...pair[1], sha256: sha('other') }])).status,
    409,
  )
  assert.ok(await tiles.head(pair[0].key))
  assert.equal((await post('tiles', pair)).status, 200)
  assert.equal(await tiles.head(pair[0].key), null)
  assert.equal(await tiles.head(pair[1].key), null)
  assert.equal((await post('tiles', pair)).status, 200)
  console.log('Verified guarded purge with ephemeral R2 buckets and a SQLite manifest')
} finally {
  await mf.dispose()
}
