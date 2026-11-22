import {
  productionArtwork,
  pullProduction,
  type PullStore,
} from './pull-production-artwork'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digest, planRelease, type Asset } from './release-plan'

type RemoteObject = { bytes: Uint8Array; etag: string | null }
type Receipt = { sha256: string; etag: string; verifiedAt: number }
type Store = Pick<PullStore, 'list'> & {
  read(asset: Asset, etag?: string): Promise<RemoteObject | null | 'unchanged'>
  put(asset: Asset, bytes: Uint8Array): Promise<void>
}

const auditInterval = 30 * 24 * 60 * 60 * 1000

export async function ensureObject(
  asset: Asset,
  store: Store,
  previous?: Receipt,
  audit = false,
) {
  const age = Date.now() - (previous?.verifiedAt ?? 0)
  const reuse =
    !audit &&
    previous &&
    age >= 0 &&
    age < auditInterval &&
    /^"[a-zA-Z0-9-]+"$/.test(previous.etag) &&
    /^[a-f0-9]{64}$/.test(previous.sha256) &&
    (!asset.digest || asset.digest === previous.sha256)
  let current = await store.read(asset, reuse ? previous.etag : undefined)
  if (current === 'unchanged') {
    if (!reuse) throw new Error('Unexpected R2 conditional response')
    return previous
  }
  if (!current) {
    if (!asset.file) throw new Error(`Missing locally and in R2: ${asset.key}`)
    const bytes = await readFile(asset.file)
    if (!bytes.length || digest(bytes) !== asset.digest)
      throw new Error(`Release input changed: ${asset.file}`)
    await store.put(asset, bytes)
    current = await store.read(asset)
    if (!current || current === 'unchanged')
      throw new Error(`R2 verification failed: ${asset.key}`)
  }
  const sha256 = digest(current.bytes)
  if (!current.bytes.length || (asset.digest && sha256 !== asset.digest))
    throw new Error(`R2 content differs: ${asset.key}`)
  if (asset.key.endsWith('.json')) JSON.parse(new TextDecoder().decode(current.bytes))
  if (current.etag) return { sha256, etag: current.etag, verifiedAt: Date.now() }
}

const wrangler = resolve(import.meta.dir, '../node_modules/.bin/wrangler')
async function wranglerJson(args: string[]) {
  const proc = Bun.spawn([wrangler, ...args, '--json'], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const [code, text] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ])
  if (code) throw new Error('Wrangler authentication failed')
  return JSON.parse(text)
}

function strongETag(value: string | null) {
  const match = value?.match(/^(?:"([0-9a-f]+(?:-\d+)?)"|([0-9a-f]+(?:-\d+)?))$/i)
  return match ? `"${match[1] ?? match[2]}"` : null
}

export async function productionStore() {
  let account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!account) {
    const { accounts } = await wranglerJson(['whoami'])
    if (accounts?.length !== 1)
      throw new Error('Set CLOUDFLARE_ACCOUNT_ID to select the release account')
    account = accounts[0].id
  }
  const auth = await wranglerJson(['auth', 'token'])
  const headers = new Headers()
  if (auth.token) headers.set('authorization', `Bearer ${auth.token}`)
  else if (auth.type === 'api_key') {
    headers.set('x-auth-key', auth.key)
    headers.set('x-auth-email', auth.email)
  } else throw new Error('Missing Wrangler credentials')

  async function request(
    asset: Asset,
    method: 'GET' | 'PUT',
    body?: Uint8Array,
    listing?: URLSearchParams,
  ) {
    const url =
      'https://api.cloudflare.com/client/v4/accounts/' +
      account +
      '/r2/buckets/' +
      encodeURIComponent(asset.bucket) +
      '/objects' +
      (listing
        ? `?${listing}`
        : `/${asset.key.split('/').map(encodeURIComponent).join('/')}`)
    const options = new Headers(headers)
    if (body) {
      options.set('content-type', asset.mime)
      options.set('cache-control', 'public, max-age=31536000, immutable')
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: options,
        body: body ? new Uint8Array(body).buffer : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(90000),
      })
      if (response.ok || (method === 'GET' && response.status === 404)) return response
      await response.body?.cancel()
      if (attempt === 3 || (response.status !== 429 && response.status < 500))
        throw new Error(
          method +
            ' ' +
            asset.bucket +
            '/' +
            asset.key +
            ' returned HTTP ' +
            response.status,
        )
      await Bun.sleep(
        1000 * Math.max(2 ** attempt, Number(response.headers.get('retry-after')) || 0),
      )
    }
  }
  return {
    async *list(bucket: string) {
      const params = new URLSearchParams({ per_page: '1000' })
      const seen = new Set<string>()
      while (true) {
        const response = await request(
          { bucket, key: '', mime: '' },
          'GET',
          undefined,
          params,
        )
        const page = (await response.json()) as {
          success: boolean
          result: { key: string; size: number }[]
          result_info?: { cursor?: string; is_truncated?: boolean }
        }
        if (!response.ok || !page.success || !Array.isArray(page.result))
          throw new Error(`Incomplete R2 listing for ${bucket}`)
        for (const object of page.result) {
          if (
            typeof object.key !== 'string' ||
            !Number.isSafeInteger(object.size) ||
            object.size < 0
          )
            throw new Error(`Invalid R2 object in ${bucket}`)
          yield object
        }
        const { cursor, is_truncated } = page.result_info ?? {}
        if (!cursor && !is_truncated) {
          if (!page.result.length) return
          const last = page.result.at(-1)?.key
          if (params.get('start_after') === last)
            throw new Error(`R2 listing did not advance in ${bucket}`)
          params.delete('cursor')
          params.set('start_after', last)
          continue
        }
        params.delete('start_after')
        if (!cursor || seen.has(cursor))
          throw new Error(`Incomplete R2 pagination for ${bucket}`)
        seen.add(cursor)
        params.set('cursor', cursor)
      }
    },
    async read(
      asset: Asset,
      etag?: string,
    ): Promise<RemoteObject | null | 'unchanged'> {
      if (etag) {
        const metadata = await request(
          asset,
          'GET',
          undefined,
          new URLSearchParams({ prefix: asset.key, per_page: '1' }),
        )
        if (!metadata.ok)
          throw new Error(`Cannot list release metadata in ${asset.bucket}`)
        const page = (await metadata.json()) as {
          success: boolean
          result: { key: string; etag: string }[]
        }
        if (!page.success || !Array.isArray(page.result))
          throw new Error('Invalid R2 metadata listing')
        const object = page.result.find(item => item.key === asset.key)
        if (object && strongETag(object.etag) === etag) return 'unchanged'
      }
      const response = await request(asset, 'GET')
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        etag: strongETag(response.headers.get('etag')),
      }
    },
    async get(asset: Asset) {
      const result = await this.read(asset)
      if (result === 'unchanged') throw new Error('Unexpected R2 conditional response')
      return result?.bytes ?? null
    },
    async put(asset: Asset, bytes: Uint8Array) {
      const response = await request(asset, 'PUT', bytes)
      await response.body?.cancel()
    },
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export async function release(
  root: string,
  dryRun: boolean,
  openStore: () => Promise<Store> = productionStore,
  deploy = deployProduction,
  audit = false,
  readProduction = productionArtwork,
  pullOnly = false,
) {
  const store = dryRun ? undefined : await openStore()
  const snapshot = store && (await readProduction(root))
  if (store && snapshot) await pullProduction(root, store, snapshot)
  const plan = planRelease(root, snapshot)
  const directory = join(root, '.local/release')
  await mkdir(directory, { recursive: true })
  const files = ['assets.json', 'catalog.json']
  const staged = [json(plan.assets), json(plan.catalog)]
  for (const [i, name] of files.entries())
    await writeFile(join(directory, name), staged[i])
  console.log('Catalog source:', plan.source)
  console.log(
    plan.catalog.sheets.length,
    'accepted sheets;',
    new Set(plan.catalog.sheets.flatMap(s => s.art.map(a => a.url))).size,
    'unique paintings;',
    plan.objects.length,
    'R2 objects. Planned manifests:',
    directory,
  )
  if (!store || pullOnly) return
  const receiptPath = join(directory, 'verified-objects.json')
  let receipts: Record<string, Receipt> = {}
  try {
    receipts = JSON.parse(await readFile(receiptPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const verified: Record<string, Receipt> = {}
  // Settle all in-flight reads/writes before releasing the checkout lock.
  const pending = plan.objects.values()
  let failed = false
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      for (const asset of pending) {
        if (failed) return
        try {
          const id = `${asset.bucket}/${asset.key}`
          const receipt = await ensureObject(asset, store, receipts[id], audit)
          if (receipt) verified[id] = receipt
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  for (const result of results) if (result.status === 'rejected') throw result.reason
  await writeFile(`${receiptPath}.tmp`, json(verified))
  await rename(`${receiptPath}.tmp`, receiptPath)
  // Reviews or exports can change while a large batch is uploading.
  const currentProduction = await readProduction(root)
  if (json(currentProduction) !== json(snapshot))
    throw new Error('Production artwork changed during upload. Run bun release again.')
  const latest = planRelease(root, currentProduction)
  if (
    json(latest.catalog) !== staged[1] ||
    json(latest.assets) !== staged[0] ||
    json(latest.objects) !== json(plan.objects)
  )
    throw new Error('Release inputs changed during upload. Run bun release again.')
  // Keep URL-to-object provenance even when two releases happen between commits.
  const previous = JSON.stringify({
    assets: JSON.parse(await readFile(join(root, 'releases/assets.json'), 'utf8')),
    catalog: JSON.parse(await readFile(join(root, 'releases/catalog.json'), 'utf8')),
  })
  const history = join(directory, 'history')
  await mkdir(history, { recursive: true })
  const record = join(history, `${digest(Buffer.from(previous))}.json`)
  await writeFile(`${record}.tmp`, previous)
  await rename(`${record}.tmp`, record)
  for (const name of files)
    await rename(join(directory, name), join(root, 'releases', name))
  await deploy(root)
}

async function deployProduction(root: string) {
  const revision = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
    cwd: root,
  })
  if (revision.exitCode) throw new Error('Could not identify the release commit')
  const env = { ...process.env, VITE_DEPLOY_COMMIT: revision.stdout.toString().trim() }
  for (const cmd of [
    ['bun', 'run', 'build'],
    ['bash', 'scripts/deploy/si.sh'],
    [wrangler, 'deploy'],
  ]) {
    const child = Bun.spawn(cmd, {
      cwd: root,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (await child.exited) throw new Error(`Failed release step: ${cmd.join(' ')}`)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (
    args.length &&
    !(args.length === 1 && ['--dry-run', '--audit', '--pull-only'].includes(args[0]))
  )
    throw new Error('Usage: bun release [--dry-run | --audit | --pull-only]')
  await release(
    resolve(import.meta.dir, '..'),
    args.includes('--dry-run'),
    productionStore,
    deployProduction,
    args.includes('--audit'),
    productionArtwork,
    args.includes('--pull-only'),
  )
}
