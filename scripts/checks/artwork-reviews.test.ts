import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { PbfWriter } from 'pbf'
import { isFogPatternSelected } from '../../src/fog-pattern.js'

test('Bun server persists authenticated artwork decisions by image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-reviews-'))
  const release = path.join(root, 'releases/v2-reviews.json')
  const token = crypto.randomUUID()
  try {
    await cp('server', path.join(root, 'server'), { recursive: true })
    for (const name of ['src', 'node_modules']) await symlink(path.resolve(name), path.join(root, name))
    await mkdir(path.join(root, 'scripts'))
    for (const name of ['dream-atlas.py', 'review-revisions.py']) {
      await cp(path.join('scripts', name), path.join(root, 'scripts', name))
    }
    // Exercise the actual queue, prompt assembly, thread recovery and PNG extraction
    // with an isolated image-tool receipt instead of spending a generation.
    await writeFile(path.join(root, 'codex'), `#!/usr/bin/env python3
import json, os, shutil, signal, sys, uuid
from pathlib import Path
folder = Path(os.environ['ATLAS_TEST_ROOT'])
args = sys.argv[1:]
prompt = sys.stdin.read()
if args.count('--image') == 1:
    assert 'The Procession of Feet' in prompt and 'striped wooden shoes' in prompt
else:
    assert args.count('--image') == 2
    assert 'road intersection' in prompt or 'roughly 20% less density' in prompt
    assert 'fixture concept' in prompt
if 'roughly 20% less density' in prompt and not (folder/'interrupted').exists():
    (folder/'interrupted').touch()
    os.kill(os.getppid(), signal.SIGINT)
    sys.exit(0)
thread = str(uuid.uuid4())
target = Path(os.environ['CODEX_HOME'])/'generated_images'/thread
target.mkdir(parents=True)
shutil.copyfile(folder/'generated.png',target/'result.png')
print(json.dumps({'type':'thread.started','thread_id':thread}))
`, { mode: 0o700 })
    const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ff00ff' } })
      .composite([{ input: await sharp({ create: { width: 200, height: 220, channels: 3, background: 'green' } }).png().toBuffer() }])
      .png().toBuffer()
    await writeFile(path.join(root, 'generated.png'), generated)
    // A surveyed all-land parent lets the real eligibility classifier run offline.
    const vector = new PbfWriter()
    vector.writeMessage(3, (_, layer) => {
      layer.writeVarintField(15, 2)
      layer.writeStringField(1, 'earth')
      layer.writeStringField(3, 'saanseoi:base')
      layer.writeMessage(4, (_, value) => value.writeBooleanField(7, true), null)
      layer.writeMessage(2, (_, feature) => {
        feature.writePackedVarint(2, [0, 0])
        feature.writeVarintField(3, 3)
        feature.writePackedVarint(4, [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15])
      }, null)
    }, null)
    await writeFile(path.join(root, 'land.mvt'), vector.finish())
    await writeFile(path.join(root, 'map-fixture.ts'), `const upstream = globalThis.fetch
globalThis.fetch = (url, options) => String(url).endsWith('hongkong-latest.json')
  ? Response.json({tiles:['https://fixture.test/{z}/{x}/{y}.mvt']})
  : String(url).startsWith('https://fixture.test/') ? new Response(Bun.file('land.mvt')) : upstream(url, options)`)
    const server = spawn('bun', ['--preload', './map-fixture.ts', 'server/index.ts'], {
      cwd: root, env: { ...process.env, PORT: '0', NODE_ENV: 'production', ATLAS_ADMIN_TOKEN: token,
        ATLAS_ALLOWED_ORIGIN: 'http://localhost', ATLAS_TEST_ROOT: root, CODEX_HOME: path.join(root, 'isolated'),
        PATH: root + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      const [message] = await once(server.stdout, 'data', {signal: AbortSignal.timeout(15000)})
      const address = String(message).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      assert.ok(address)
      const headers = { Host: 'localhost', Origin: 'http://localhost', Authorization: 'Bearer ' + token }
      const session = await fetch(address + '/api/atlas-tiles/cached?admin', { headers })
      assert.equal(session.status, 200)
      const cookie = session.headers.get('set-cookie')!.split(';')[0]
      const directory = path.join(root, 'generated-tiles/18/10/20')
      await mkdir(directory, { recursive: true })
      const variant = 'discovery-' + crypto.randomUUID() + '-0123456789ab'
      const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer()
      for (const name of ['circus.v5.' + variant, 'circus.v6']) {
        await writeFile(path.join(directory, name + '.image'), png)
        await writeFile(path.join(directory, name + '.json'), JSON.stringify({ contentType: 'image/png' }))
      }
      const listing = await fetch(address + '/api/atlas-tiles/cached?diagnostics&collection=discovery')
      const { tiles } = await listing.json()
      const url = '/generated-tiles/18/10/20/circus?version=5&variant=' + variant
      assert.deepEqual(tiles.map(tile => tile.url), [url])
      const endpoint = address + '/api/artwork-reviews'
      const art = { title: 'Circus', x: 10, y: 20, rows: 1, url }
      const write = (status: string, authenticated: boolean, method = 'PUT') => fetch(endpoint + '?admin', {
        method,
        headers: { ...headers, 'content-type': 'application/json', ...(authenticated
          ? { cookie, 'x-atlas-csrf-token': cookie.slice(cookie.indexOf('=') + 1) } : {}) },
        body: JSON.stringify({ ...art, status }),
      })
      assert.equal((await write('accepted', false)).status, 403)
      for (const status of ['accepted', 'rejected']) {
        assert.equal((await write(status, true)).status, 200)
        const expected = [{ ...art, status }]
        assert.deepEqual(await (await fetch(endpoint)).json(), expected)
        assert.deepEqual(JSON.parse(await readFile(release, 'utf8')), expected)
      }
      assert.equal((await write('rejected', false, 'DELETE')).status, 403)
      assert.equal((await write('rejected', true, 'DELETE')).status, 200)
      assert.deepEqual(await (await fetch(endpoint)).json(), [])
      assert.deepEqual(JSON.parse(await readFile(release, 'utf8')), [])
      const revisionUrl = address + '/api/artwork-revisions'
      const reference = await sharp(generated).negate().png().toBuffer()
      const mapImage = 'data:image/png;base64,' + reference.toString('base64')
      for (const mode of ['adjust', 'spread']) {
        const source = { ...art, title: 'fixture concept', rows: 2, url: '/fixture/' + mode + '.png' }
        const submit = (authenticated: boolean) => fetch(revisionUrl + '?admin', {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json',
            ...(authenticated ? { cookie, 'x-atlas-csrf-token': cookie.split('=')[1] } : {}) },
          body: JSON.stringify({ source, mode, mapImage, previousImage: mapImage }),
        })
        assert.equal((await submit(false)).status, 403)
        const response = await submit(true)
        assert.equal(response.status, 202)
        const job = await response.json()
        if (mode === 'spread') {
          const marker = Bun.file(path.join(root, 'interrupted'))
          const deadline = Date.now() + 10000
          while (!await marker.exists() && Date.now() < deadline) await Bun.sleep(50)
          assert.ok(await marker.exists())
          // Older workers left this sentinel behind when stopped mid-render.
          await writeFile(path.join(root, 'generated-tiles/dream-atlas/review-revisions/jobs', job.id, 'started'), '')
        }
        assert.equal((await (await submit(true)).json()).id, job.id)
        let result = job
        const deadline = Date.now() + 15000
        while (result.state === 'pending' && Date.now() < deadline) {
          await Bun.sleep(100)
          result = (await (await fetch(revisionUrl)).json()).find(r => r.id === job.id)
        }
        assert.equal(result.state, 'ready')
        assert.equal(result.candidate.title, source.title)
        const image = await fetch(address + result.candidate.url)
        assert.equal(image.status, 200)
        const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata()
        assert.equal(meta.hasAlpha, true)
        assert.deepEqual([meta.width, meta.height], [512, 1024])
        const withdraw = (authenticated: boolean) => fetch(revisionUrl + '?admin', {
          method: 'DELETE', headers: { ...headers, 'content-type': 'application/json',
            ...(authenticated ? { cookie, 'x-atlas-csrf-token': cookie.split('=')[1] } : {}) },
          body: JSON.stringify({ id: job.id }),
        })
        assert.equal((await withdraw(false)).status, 403)
        assert.equal((await withdraw(true)).status, 200)
        assert.deepEqual(await (await fetch(revisionUrl)).json(), [])
        assert.deepEqual(await (await fetch(endpoint)).json(), [])
      }
      const target = {x: 100, y: 100}
      while (!isFogPatternSelected(target)) target.x++
      const generate = (auth: boolean) => fetch(address + '/api/artwork-generation?admin', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json',
          ...(auth && {cookie, 'x-atlas-csrf-token': cookie.split('=')[1]}) },
        body: JSON.stringify({...target, family: 'circus', scene: 'The Procession of Feet', mapImage}),
      })
      assert.equal((await generate(false)).status, 403)
      const simultaneous = await Promise.all([generate(true), generate(true)])
      assert.deepEqual(simultaneous.map(response => response.status).sort(), [202, 409])
      const job = await simultaneous.find(response => response.status === 202)!.json()
      const deadline = Date.now() + 15000
      let result = job
      while (result.state === 'pending' && Date.now() < deadline) {
        await Bun.sleep(100)
        result = (await (await fetch(revisionUrl)).json()).find(record => record.id === job.id)
      }
      assert.equal(result.state, 'ready')
      assert.equal(result.candidate.scene, 'circus')
      assert.equal(result.candidate.title, 'The Procession of Feet')
      assert.equal((await fetch(address + result.candidate.url)).status, 200)
    } finally {
      const stopped = once(server, 'exit')
      server.kill()
      await stopped
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
