import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArtworkReview, type ArtworkReview } from '../src/artwork-review'
import { managedPair, releaseFileKey } from '../src/artwork-purge'
import { digest, readJson, type Asset, type Catalog } from './release-plan'

export type ProductionArtwork = {
  catalog: Catalog
  reviews: ArtworkReview[]
  media: Record<string, string>
}

type ObjectInfo = { key: string; size: number; etag?: string }
export type PullStore = {
  list(bucket: string): AsyncIterable<ObjectInfo>
  read(asset: Asset): Promise<{ bytes: Uint8Array } | 'unchanged' | null>
}

function configuration(root: string) {
  return Bun.JSONC.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as {
    vars: { ATLAS_ALLOWED_ORIGIN: string }
    r2_buckets: { binding: string; bucket_name: string }[]
  }
}

async function optionalFile(path: string) {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function install(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.' + randomUUID()
  await writeFile(tmp, bytes)
  try {
    await link(tmp, path)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !Buffer.from(bytes).equals(await readFile(path))
    )
      throw error
  } finally {
    await unlink(tmp)
  }
}

export async function productionArtwork(root: string): Promise<ProductionArtwork> {
  const config = configuration(root)
  const origin = config.vars.ATLAS_ALLOWED_ORIGIN
  async function json(path: string) {
    const response = await fetch(new URL(path, origin), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok)
      throw new Error(
        'Production artwork request failed: ' + path + ' HTTP ' + response.status,
      )
    return response.json()
  }
  const [catalog, records] = await Promise.all([
    json('/atlas-v2/catalog.json'),
    json('/api/artwork-reviews?admin'),
  ])
  if (
    catalog?.release !== 'v2' ||
    !Array.isArray(catalog.sheets) ||
    !Array.isArray(records)
  )
    throw new Error('Invalid production inventory')
  const media: Record<string, string> = {}
  function mapMedia(path: string, published?: string) {
    if (!published || (published === path && !path.startsWith('/release-assets/')))
      return
    const key = published.split(/[?#]/)[0].slice(1)
    if (!releaseFileKey.test(key) || !published.startsWith('/'))
      throw new Error('Invalid published media: ' + published)
    media[path.split('?')[0]] = key
  }
  for (const sheet of catalog.sheets) {
    for (const art of sheet.art) {
      if (!parseArtworkReview({ ...art, status: 'accepted' }))
        throw new Error('Invalid production painting: ' + art.url)
      mapMedia(art.url, art.imageUrl)
      delete art.imageUrl
      const animation = art.animation
      if (animation?.plate) mapMedia(animation.plate, animation.plate)
      if (animation?.spriteUrl) {
        mapMedia(
          '/' + animation.folder + '/' + animation.motion.sprite + '.webp',
          animation.spriteUrl,
        )
        delete animation.spriteUrl
      }
    }
  }
  const decisions = new Map<string, ArtworkReview>()
  for (const record of records) {
    const review = parseArtworkReview(record)
    if (!review) throw new Error('Invalid production artwork review')
    decisions.set(review.url, review)
  }
  return {
    catalog,
    media,
    reviews: [...decisions.values()].sort((a, b) => a.url.localeCompare(b.url)),
  }
}

export async function pullProduction(
  root: string,
  store: PullStore,
  snapshot: ProductionArtwork,
) {
  const config = configuration(root)
  const bucket = config.r2_buckets.find(
    (b: { binding: string }) => b.binding === 'ATLAS_BUCKET',
  )?.bucket_name
  if (!bucket) throw new Error('Missing production tile bucket')
  const objects = new Map<string, ObjectInfo>()
  for await (const item of store.list(bucket)) {
    if (item.key.startsWith('atlas/18/') && managedPair('tiles', item.key))
      objects.set(item.key, item)
  }
  let added = 0
  for (const base of new Set(
    [...objects.keys()].map(key => key.replace(/\.(image|json)$/, '')),
  )) {
    if (!objects.has(base + '.image') || !objects.has(base + '.json'))
      throw new Error('Incomplete production tile pair: ' + base)
    const pair = []
    for (const ext of ['image', 'json']) {
      const key = base + '.' + ext
      const obj = objects.get(key)!
      const file = join(root, 'generated-tiles', key.slice(6))
      const local = await optionalFile(file)
      const etag = obj.etag?.replace(/^"|"$/g, '')
      const matches =
        local &&
        local.length === obj.size &&
        createHash('md5').update(local).digest('hex') === etag
      const remote = matches
        ? { bytes: local }
        : await store.read({ bucket, key, mime: '' })
      if (!remote || remote === 'unchanged' || remote.bytes.length !== obj.size)
        throw new Error('Incomplete download: ' + key)
      if (
        !matches &&
        etag &&
        /^[a-f0-9]{32}$/i.test(etag) &&
        createHash('md5').update(remote.bytes).digest('hex') !== etag
      )
        throw new Error('Production tile changed during pull: ' + key)
      if (local && !local.equals(remote.bytes))
        throw new Error('Local and production bytes differ: ' + key)
      pair.push({ file, local, bytes: remote.bytes })
    }
    const [image, meta] = pair
    const metadata = JSON.parse(new TextDecoder().decode(meta.bytes))
    if (
      !image.bytes.length ||
      (metadata.sha256 && metadata.sha256 !== digest(image.bytes))
    )
      throw new Error('Invalid production tile: ' + base)
    for (const item of pair) if (!item.local) await install(item.file, item.bytes)
    if (!image.local || !meta.local) added++
  }
  // Keep the exact published edition when a production-only alias also exists on disk.
  const directory = join(root, '.local/release/pulled-media')
  const index = join(directory, 'identities.json')
  const prior = await optionalFile(index)
  const identities: Record<string, string> = prior ? JSON.parse(prior.toString()) : {}
  const working = join(root, 'public/atlas-v2/catalog.json')
  const localCatalog: Catalog = readJson(
    (await Bun.file(working).exists()) ? working : join(root, 'releases/catalog.json'),
  )
  const local = new Set(localCatalog.sheets.flatMap(s => s.art.map(a => a.url)))
  const mediaBucket = config.r2_buckets.find(
    b => b.binding === 'maps_romanticatlas_assets',
  )?.bucket_name
  // A concurrent older release may already have removed the catalog row while its
  // production acceptance still exists. Recover the previously published bytes.
  const historical = new Map<string, Set<string>>()
  const history = join(root, '.local/release/history')
  const historyFiles = await readdir(history).catch(error => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  for (const name of historyFiles.filter(n => n.endsWith('.json'))) {
    const release = readJson(join(history, name))
    for (const sheet of release.catalog.sheets)
      for (const art of sheet.art) {
        if (local.has(art.url)) continue
        const key = release.assets[art.url.split('?')[0]]
        if (!key) continue
        const keys = historical.get(art.url) ?? new Set<string>()
        keys.add(key)
        historical.set(art.url, keys)
      }
  }
  const localReviews = readJson(join(root,'releases/v2-reviews.json')) as ArtworkReview[]
  const released: Catalog = readJson(join(root, 'releases/catalog.json'))
  const releasedUrls = new Set(released.sheets.flatMap(sheet => sheet.art.map(art => art.url)))
  const arts = [
    ...localReviews.filter(r => r.status === 'accepted' && !releasedUrls.has(r.url)),
    ...snapshot.catalog.sheets.flatMap(s => s.art),
    ...snapshot.reviews.filter(r => r.status === 'accepted'),
  ]
  for (const url of new Set(arts.map(a => a.url))) {
    if (local.has(url)) continue
    const path = url.split('?')[0]
    const candidates = historical.get(url)
    let key = snapshot.media[path] ?? identities[url]
    if (!key && candidates) {
      if (candidates.size !== 1) throw new Error('Ambiguous prior editions for ' + url)
      key = [...candidates][0]
    }
    if (!key) continue
    const match = releaseFileKey.exec(key)
    if (!match || !mediaBucket)
      throw new Error('Invalid production artwork mapping: ' + url)
    const filename = join(directory, key)
    let bytes: Uint8Array = await optionalFile(filename)
    if (!bytes) {
      const object = await store.read({ bucket: mediaBucket, key, mime: '' })
      if (!object || object === 'unchanged')
        throw new Error('Missing published painting: ' + key)
      bytes = object.bytes
    }
    if (digest(bytes) !== match[1])
      throw new Error('Invalid published painting checksum: ' + key)
    if (!(await Bun.file(filename).exists())) await install(filename, bytes)
    identities[url] = key
  }
  await mkdir(directory, { recursive: true })
  const tempIndex = index + '.' + randomUUID()
  await writeFile(tempIndex, JSON.stringify(identities) + '\n')
  await rename(tempIndex, index)
  // Production revisions can be accepted before they acquire a release-media key.
  const localDecisions = new Map(
    localReviews.map(r => [
      r.url,
      r.status,
    ]),
  )
  for (const art of snapshot.reviews) {
    if (
      art.status !== 'accepted' ||
      localDecisions.get(art.url) === 'rejected' ||
      snapshot.media[art.url]
    )
      continue
    const match = /^\/artwork-revisions\/([a-f0-9]{32})\.png$/.exec(art.url)
    if (!match) continue
    const candidate = join(
      root,
      'generated-tiles/dream-atlas/review-revisions/jobs',
      match[1],
      'candidate.png',
    )
    if (await Bun.file(candidate).exists()) continue
    const response = await fetch(new URL(art.url, config.vars.ATLAS_ALLOWED_ORIGIN), {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error('Missing production revision: ' + art.url)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new Error('Invalid production revision: ' + art.url)
    await install(
      join(root, '.local/release/pulled-revisions', match[1] + '.png'),
      bytes,
    )
  }
  const path = join(root, '.local/release/production-artwork.json')
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.' + randomUUID()
  await writeFile(tmp, JSON.stringify(snapshot) + '\n')
  await rename(tmp, path)
  console.log(
    'Verified',
    objects.size / 2,
    'production tile pairs;',
    added,
    'added to the dev cache.',
  )
}
