import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('Bun server persists authenticated artwork decisions by image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-reviews-'))
  const release = path.join(root, 'releases/v2-reviews.json')
  const token = crypto.randomUUID()
  try {
    await cp('server', path.join(root, 'server'), { recursive: true })
    for (const name of ['src', 'node_modules']) await symlink(path.resolve(name), path.join(root, name))
    const server = spawn('bun', ['server/index.ts'], {
      cwd: root, env: { ...process.env, PORT: '0', NODE_ENV: 'production', ATLAS_ADMIN_TOKEN: token,
        ATLAS_ALLOWED_ORIGIN: 'http://localhost' }, stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      const [message] = await once(server.stdout, 'data', {signal: AbortSignal.timeout(15000)})
      const address = String(message).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      assert.ok(address)
      const headers = { Host: 'localhost', Origin: 'http://localhost', Authorization: 'Bearer ' + token }
      const session = await fetch(address + '/api/atlas-tiles/cached?admin=true', { headers })
      assert.equal(session.status, 200)
      const cookie = session.headers.get('set-cookie')!.split(';')[0]
      const endpoint = address + '/api/artwork-reviews'
      const art = { title: 'Review fixture', x: 10, y: 20, rows: 2, url: '/atlas-v2/fixture.webp' }
      const write = (status: string, authenticated: boolean) => fetch(endpoint + '?admin=true', {
        method: 'PUT',
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
    } finally {
      const stopped = once(server, 'exit')
      server.kill()
      await stopped
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
