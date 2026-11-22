import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  managedPair,
  releaseFileKey,
  releaseObjects,
  type ArchivedObject,
  type AssetBucket,
  type ReleaseObjects,
} from '../src/artwork-purge'
import { digest, readJson, type Catalog } from './release-plan'
import { productionStore } from './release'

type Listed = { key: string; size: number }
type Group = { bucket: AssetBucket; keys: string[]; stored: Listed[] }

export async function planBucket(
  bucket: AssetBucket,
  inventory: AsyncIterable<Listed> | Iterable<Listed>,
  keep: Set<string>,
) {
  const candidates = new Map<string, Group>()
  const retained = { referenced: 0, other: 0 }
  let scanned = 0
  for await (const object of inventory) {
    scanned++
    const keys = managedPair(bucket, object.key)
    if (!keys) {
      retained.other++
      continue
    }
    if (keys.some(key => keep.has(key))) {
      retained.referenced++
      continue
    }
    const group = candidates.get(keys[0]) ?? { bucket, keys, stored: [] }
    group.stored.push({ key: object.key, size: object.size })
    candidates.set(keys[0], group)
  }
  return { scanned, retained, candidates: [...candidates.values()] }
}

export async function archiveObject(
  directory: string,
  bucket: string,
  key: string,
  bytes: Uint8Array,
) {
  const sha256 = digest(bytes)
  if (key.startsWith('release-assets/') && releaseFileKey.exec(key)?.[1] !== sha256)
    throw new Error(`Content hash mismatch for ${key}`)
  const file = join(directory, bucket, key, sha256)
  await mkdir(dirname(file), { recursive: true })
  if (!existsSync(file)) {
    const temp = `${file}.${randomUUID()}`
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, file)
  }
  if (digest(await readFile(file)) !== sha256)
    throw new Error(`Archive verification failed for ${file}`)
  return { key, sha256 }
}

async function inBatches<T, R>(items: T[], perform: (item: T) => Promise<R>) {
  const results: R[] = []
  for (let i = 0; i < items.length; i += 4) {
    const batch = await Promise.allSettled(items.slice(i, i + 4).map(perform))
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      results.push(result.value)
    }
  }
  return results
}

async function main() {
  const args = process.argv.slice(2)
  if (
    args.length > 1 ||
    args.some(arg => !['--dry-run', '--local-catalog', '--apply'].includes(arg))
  )
    throw new Error('Usage: bun purge [--dry-run | --local-catalog | --apply]')
  const apply = args.includes('--apply')
  const local = args.includes('--local-catalog')
  const root = resolve(import.meta.dir, '..')
  const config = Bun.JSONC.parse(
    readFileSync(join(root, 'wrangler.jsonc'), 'utf8'),
  ) as {
    vars: { ATLAS_ALLOWED_ORIGIN: string }
    r2_buckets: { binding: string; bucket_name: string }[]
  }
  const endpoint = new URL('/api/artwork-purge?admin', config.vars.ATLAS_ALLOWED_ORIGIN)
  const headers = new Headers({ origin: endpoint.origin })
  let keep: ReleaseObjects
  if (local) {
    const catalog: Catalog = readJson(join(root, 'releases/catalog.json'))
    keep = releaseObjects(
      Object.values(readJson(join(root, 'releases/assets.json'))),
      catalog.sheets.flatMap(sheet => sheet.art.map(art => art.url)),
    )
  } else {
    if (apply) {
      if (!process.env.ATLAS_ADMIN_TOKEN)
        throw new Error('Set ATLAS_ADMIN_TOKEN for the deployed Worker')
      headers.set('authorization', `Bearer ${process.env.ATLAS_ADMIN_TOKEN}`)
    }
    const source = apply
      ? endpoint
      : new URL('/atlas-v2/release-objects.json', endpoint)
    const response = await fetch(source, {
      headers,
      redirect: 'error',
      cache: 'no-store',
    })
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw new Error(
        `Deployed inventory unavailable (HTTP ${response.status}). Deploy the updated Worker or preview against the checkout with --local-catalog.`,
      )
    const result = (await response.json()) as ReleaseObjects & { version?: number }
    if (
      result.version !== 2 ||
      !['media', 'tiles'].every(
        k =>
          Array.isArray(result[k]) &&
          result[k].every((key: unknown) => typeof key === 'string'),
      )
    )
      throw new Error('Invalid deployed release inventory')
    keep = result
    if (apply) {
      const token = response.headers
        .get('set-cookie')
        ?.match(/(?:^|;\s*)atlas_csrf=([^;]+)/)?.[1]
      if (!token) throw new Error('Missing production CSRF token')
      headers.set('cookie', `atlas_csrf=${token}`)
      headers.set('x-atlas-csrf-token', token)
      headers.set('content-type', 'application/json')
    }
  }

  const store = await productionStore()
  const buckets = { media: '', tiles: '' }
  const eligible: Group[] = []
  const summaries = []
  for (const scope of ['media', 'tiles'] as const) {
    const binding = scope === 'media' ? 'maps_romanticatlas_assets' : 'ATLAS_BUCKET'
    const name = config.r2_buckets.find(b => b.binding === binding)?.bucket_name
    if (!name) throw new Error(`Missing bucket binding ${binding}`)
    buckets[scope] = name
    const { candidates, ...summary } = await planBucket(
      scope,
      store.list(name),
      new Set(keep[scope]),
    )
    eligible.push(...candidates)
    summaries.push({ bucket: name, ...summary })
  }
  const directory = join(root, '.local/rejected')
  await mkdir(directory, { recursive: true })
  const catalogSource = local ? 'checkout' : 'deployed'
  const plan = {
    catalogSource,
    scannedAt: new Date().toISOString(),
    summaries,
    candidates: eligible,
  }
  await writeFile(join(directory, 'plan.tmp'), `${JSON.stringify(plan, null, 2)}\n`)
  await rename(join(directory, 'plan.tmp'), join(directory, 'plan.json'))
  const stored = eligible.flatMap(group => group.stored)
  console.log(
    `${catalogSource} catalog: ${stored.length} unreferenced R2 files, ${stored.reduce((n, o) => n + o.size, 0)} bytes. See .local/rejected/plan.json`,
  )
  if (!apply) return
  const archived = await inBatches(eligible, async item => {
    const bucket = buckets[item.bucket]
    const objects: ArchivedObject[] = []
    for (const key of item.keys) {
      const bytes = await store.get({ bucket, key, mime: 'application/octet-stream' })
      const listed = item.stored.find(object => object.key === key)
      if ((bytes?.length ?? null) !== (listed?.size ?? null))
        throw new Error(
          `R2 object appeared or changed size after listing: ${bucket}/${key}. Rerun purge.`,
        )
      objects.push(
        bytes
          ? await archiveObject(directory, bucket, key, bytes)
          : { key, sha256: null },
      )
    }
    const receipt = JSON.stringify({ bucket, objects })
    await mkdir(join(directory, 'receipts'), { recursive: true })
    await writeFile(
      join(directory, 'receipts', `${digest(Buffer.from(receipt))}.json`),
      `${receipt}\n`,
    )
    return { item, bucket, objects }
  })
  console.log('Verified backups for all', stored.length, 'files before deletion.')
  await inBatches(archived, async ({ item, bucket, objects }) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({ bucket: item.bucket, objects }),
    })
    if (!response.ok)
      throw new Error(
        `Purge stopped at ${bucket}/${item.keys[0]} (HTTP ${response.status}): ${await response.text()}`,
      )
    const result = (await response.json()) as { deleted?: string[] }
    if (JSON.stringify(result.deleted) !== JSON.stringify(item.keys))
      throw new Error('Missing deletion acknowledgement')
    for (const key of item.keys)
      if ((await store.get({ bucket, key, mime: '' })) !== null)
        throw new Error(`R2 still contains ${key}`)
    console.log('Purged', bucket, item.keys.join(', '))
  })
}

if (import.meta.main) await main()
