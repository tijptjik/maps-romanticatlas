import { allowsArtwork } from '../src/artwork-reservation'
import { releaseFileKey } from '../src/artwork-purge'
import type { ProductionArtwork } from './pull-production-artwork'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { revisionFile } from '../server/review-revisions'
import { revisionImagePattern } from '../src/artwork-revision'
import type { ArtworkReview, Painting } from '../src/artwork-review'
import {
  atlasImageKey,
  atlasMetadataKey,
  parseAtlasTilePath,
  requestedAtlasVariant,
  requestedCacheVersion,
} from '../src/atlas-protocol'
import { atlasScenes, isAtlasScene } from '../src/atlas-scenes'

type Sheet = { id: string; title: string; accepted?: boolean; art: Painting[] }
export type Catalog = { release: string; sheets: Sheet[] }
export type Asset = {
  bucket: string
  key: string
  file?: string
  digest?: string
  mime: string
}

export const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
export const readJson = (filename: string) => JSON.parse(readFileSync(filename, 'utf8'))

export function acceptedCatalog(source: Catalog, reviews: ArtworkReview[]): Catalog {
  if (source.release !== 'v2') throw new Error('Expected an Atlas V2 catalog')
  const decisions = new Map(reviews.map(review => [review.url, review]))
  const accepted = new Set(
    source.sheets
      .filter(sheet => sheet.accepted)
      .flatMap(sheet => sheet.art.map(art => art.url)),
  )
  for (const review of decisions.values()) {
    if (review.status === 'accepted') accepted.add(review.url)
    else accepted.delete(review.url)
  }
  const sheets = source.sheets
    .map(sheet => ({
      ...sheet,
      accepted: true,
      art: sheet.art.filter(art => accepted.has(art.url) && allowsArtwork(art)),
    }))
    .filter(sheet => sheet.art.length)
  const listed = new Set(sheets.flatMap(sheet => sheet.art.map(art => art.url)))
  const extras = []
  for (const { status, ...art } of decisions.values()) {
    if (status === 'accepted' && !listed.has(art.url) && allowsArtwork(art))
      extras.push(art)
  }
  if (extras.length) {
    const discoveries = sheets.find(sheet => sheet.id === 'accepted-discoveries')
    if (discoveries) discoveries.art.push(...extras)
    else
      sheets.push({
        id: 'accepted-discoveries',
        title: 'Accepted discoveries',
        accepted: true,
        art: extras,
      })
  }
  return { ...source, sheets }
}

function mediaPath(url: string) {
  const pathname = url.split('?')[0]
  if (!/^\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(pathname))
    throw new Error(`Invalid media path: ${url}`)
  return pathname
}

export function planRelease(root: string, production?: ProductionArtwork) {
  const config = Bun.JSONC.parse(
    readFileSync(join(root, 'wrangler.jsonc'), 'utf8'),
  ) as {
    r2_buckets: { binding: string; bucket_name: string }[]
  }
  const bucket = (binding: string): string => {
    const name = config.r2_buckets.find(entry => entry.binding === binding)?.bucket_name
    if (!name) throw new Error(`Missing R2 binding: ${binding}`)
    return name
  }
  const file = (name: string) => join(root, name)
  const snapshot = file('.local/release/production-artwork.json')
  production ??= existsSync(snapshot) ? readJson(snapshot) : undefined
  const previous: Record<string, string> = {
    ...production?.media,
    ...readJson(file('releases/assets.json')),
  }
  const working = file('public/atlas-v2/catalog.json')
  const source = existsSync(working) ? working : file('releases/catalog.json')
  const workingCatalog: Catalog = readJson(source)
  const priorCatalog: Catalog = readJson(file('releases/catalog.json'))
  const reviews: ArtworkReview[] = readJson(file('releases/v2-reviews.json'))
  // Carry forward released URLs even when the working contact sheets have moved on.
  const accepted = new Map<string, ArtworkReview>()
  for (const sheet of production?.catalog.sheets ?? [])
    for (const art of sheet.art) accepted.set(art.url, { ...art, status: 'accepted' })
  for (const review of production?.reviews ?? []) {
    const released = accepted.get(review.url)
    accepted.set(review.url, { ...released, ...review })
  }
  for (const review of reviews)
    accepted.set(review.url, { ...accepted.get(review.url), ...review })
  const catalog = acceptedCatalog(workingCatalog, [...accepted.values()])
  // Older review records kept only the image identity. Resolve revisions through
  // their recorded source, even when the parent has since been rejected.
  const scenes = new Map<string, string>()
  for (const sheet of [...priorCatalog.sheets, ...workingCatalog.sheets]) {
    for (const art of sheet.art)
      if (isAtlasScene(art.scene)) scenes.set(art.url, art.scene)
  }
  function sceneForArt(art: Painting, seen = new Set<string>()): string | undefined {
    if (isAtlasScene(art.scene)) return art.scene
    const scene =
      scenes.get(art.url) ??
      parseAtlasTilePath(art.url.split('?')[0], isAtlasScene)?.scene
    if (scene) return scene
    const revision = revisionImagePattern.exec(art.url)
    if (!revision || seen.has(art.url)) return
    seen.add(art.url)
    const record = join(revisionFile(revision[1], root), '..', 'revision.json')
    if (existsSync(record)) return sceneForArt(readJson(record).source, seen)
  }
  for (const sheet of catalog.sheets) {
    for (const art of sheet.art) {
      const scene = sceneForArt(art)
      if (scene) art.scene = scene
    }
  }
  const importedMedia = file('.local/release/pulled-media/identities.json')
  const identities: Record<string, string> = existsSync(importedMedia)
    ? readJson(importedMedia)
    : {}
  const localUrls = new Set(
    workingCatalog.sheets.flatMap(sheet => sheet.art.map(art => art.url)),
  )
  const imported = new Map<string, string>()
  const hasWorkingCatalog = existsSync(working)
  for (const sheet of catalog.sheets) {
    for (const art of sheet.art) {
      if ((hasWorkingCatalog && localUrls.has(art.url)) || !identities[art.url])
        continue
      const path = mediaPath(art.url)
      if (imported.has(path) && imported.get(path) !== identities[art.url])
        throw new Error(`Conflicting imported editions for ${path}`)
      imported.set(path, identities[art.url])
    }
  }
  const assets: Record<string, string> = {}
  const objects = new Map<string, Asset>()
  const generated = new Set<string>()
  // The previously released interface media are required even on a clean checkout.
  const paths = new Set(
    Object.keys(previous).filter(path =>
      /^\/(?:pavilion\/|atlas-audio\/|[^/]+$)/.test(path),
    ),
  )
  for (const sheet of catalog.sheets) {
    for (const art of sheet.art) {
      if (art.url.startsWith('/generated-tiles/')) generated.add(art.url)
      else paths.add(mediaPath(art.url))
      const animation = art.animation
      if (animation?.loopUrl) paths.add(mediaPath(animation.loopUrl))
      if (animation?.plate) paths.add(mediaPath(animation.plate))
      if (animation?.motion && animation.folder)
        paths.add(mediaPath(`/${animation.folder}/${animation.motion.sprite}.webp`))
    }
  }

  for (const urlPath of [...paths].sort()) {
    let path = mediaPath(urlPath)
    // Preserve the map's PNG review identity while serving its optimised WebP edition.
    const pulled = imported.get(path)
    if (pulled) {
      const hash = releaseFileKey.exec(pulled)?.[1]
      if (!hash) throw new Error(`Invalid pulled media: ${pulled}`)
      const filename = file(`.local/release/pulled-media/${pulled}`)
      if (digest(readFileSync(filename)) !== hash)
        throw new Error(`Pulled media changed: ${pulled}`)
      assets[path] = pulled
      objects.set(pulled, {
        bucket: bucket('maps_romanticatlas_assets'),
        key: pulled,
        file: filename,
        digest: hash,
        mime: Bun.file(filename).type,
      })
      continue
    }
    const webp = path.replace(/\.png$/, '.webp')
    if (webp !== path && (previous[webp] || existsSync(file(`public${webp}`))))
      path = webp
    const revision = revisionImagePattern.exec(path)
    let local = file(`public${path}`)
    if (revision) {
      local = revisionFile(revision[1], root)
      if (!existsSync(local))
        local = file(`.local/release/pulled-revisions/${revision[1]}.png`)
    }
    const exists = existsSync(local)
    const sha = exists ? digest(readFileSync(local)) : undefined
    const key = sha ? `release-assets/${sha}${extname(path)}` : previous[path]
    const match = key?.match(/^release-assets\/([a-f0-9]{64})\.[a-z0-9]+$/)
    if (!match) throw new Error(`Missing release media or prior R2 mapping: ${path}`)
    assets[urlPath] = key
    assets[path] = key
    objects.set(key, {
      bucket: bucket('maps_romanticatlas_assets'),
      key,
      digest: match[1],
      file: exists ? local : objects.get(key)?.file,
      mime: Bun.file(local).type,
    })
  }

  for (const path of generated) {
    const url = new URL(path, 'https://atlas.invalid')
    const tile = parseAtlasTilePath(
      url.pathname,
      (scene): scene is keyof typeof atlasScenes => Object.hasOwn(atlasScenes, scene),
    )
    const version = requestedCacheVersion(url.searchParams)
    const variant = requestedAtlasVariant(url.searchParams)
    if (
      !tile ||
      !version ||
      (url.searchParams.has('variant') && variant !== url.searchParams.get('variant'))
    )
      throw new Error(`Invalid versioned discovery URL: ${path}`)
    const metadataKey = atlasMetadataKey(tile, version, variant)
    const local = (key: string) => file(key.replace(/^atlas\//, 'generated-tiles/'))
    const metadata = existsSync(local(metadataKey))
      ? readJson(local(metadataKey))
      : null
    for (const [key, mime] of [
      [atlasImageKey(tile, version, variant), metadata?.contentType ?? 'image/png'],
      [metadataKey, 'application/json'],
    ]) {
      const filename = local(key)
      objects.set(key, {
        bucket: bucket('ATLAS_BUCKET'),
        key,
        mime,
        ...(existsSync(filename)
          ? { file: filename, digest: digest(readFileSync(filename)) }
          : {}),
      })
    }
  }
  return {
    source,
    catalog,
    assets: Object.fromEntries(
      Object.entries(assets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    objects: [...objects.values()],
  }
}
