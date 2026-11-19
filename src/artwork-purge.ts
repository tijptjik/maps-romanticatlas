// Shared identity checks for the purge planner and the deployed Worker.
import {
  atlasImageKey,
  atlasMetadataKey,
  atlasTileUrl,
  parseAtlasTilePath,
  requestedAtlasVariant,
  requestedCacheVersion,
} from './atlas-protocol'
import { atlasScenes } from './atlas-scenes'
import type { ArtworkReview } from './artwork-review'

export const releaseFileKey = /^release-assets\/([0-9a-f]{64})\.[a-z0-9]+$/

export function discoveryObjects(url: string, exact = true) {
  if (!url.startsWith('/generated-tiles/')) return null
  const parsed = new URL(url, 'https://atlas.invalid')
  const tile = parseAtlasTilePath(parsed.pathname, (s): s is keyof typeof atlasScenes =>
    Object.hasOwn(atlasScenes, s),
  )
  const version = requestedCacheVersion(parsed.searchParams)
  const variant = requestedAtlasVariant(parsed.searchParams)
  if (!tile || !version || !variant.startsWith('discovery-')) return null
  const canonical = atlasTileUrl(tile, version, variant)
  if (exact && url !== canonical) return null
  return {
    tile,
    version,
    variant,
    keys: [
      atlasImageKey(tile, version, variant),
      atlasMetadataKey(tile, version, variant),
    ],
  }
}

export function latestDecisions(reviews: ArtworkReview[]) {
  return new Map(reviews.map(review => [review.url, review.status]))
}

export type AssetBucket = 'media' | 'tiles'
export type ArchivedObject = { key: string; sha256: string | null }
export type ReleaseObjects = Record<AssetBucket, string[]>

export function managedPair(bucket: AssetBucket, key: string): string[] | null {
  if (bucket === 'media') return releaseFileKey.test(key) ? [key] : null
  // Includes the unversioned layout used before versioned tile generation.
  const match = /^(atlas\/\d+\/\d+\/\d+\/[a-z0-9-]+(?:\.v\d+(?:\.[a-z0-9-]+)?)?)\.(?:image|json)$/.exec(key)
  return match ? [match[1] + '.image', match[1] + '.json'] : null
}

// assets.json enumerates the published static media including interface assets,
// plates and sprites. Generated tile dependencies live in catalog.json.
export function releaseObjects(media: Iterable<string>, urls: Iterable<string>): ReleaseObjects {
  const tiles = new Set<string>()
  for (const path of urls) {
    if (!path.startsWith('/generated-tiles/')) continue
    const parsed = new URL(path, 'https://atlas.invalid')
    const tile = parseAtlasTilePath(parsed.pathname, (scene): scene is string => /^[a-z0-9-]+$/.test(scene))
    const version = requestedCacheVersion(parsed.searchParams)
    const variant = requestedAtlasVariant(parsed.searchParams)
    if (!tile || !version || (parsed.searchParams.has('variant') && parsed.searchParams.get('variant') !== variant))
      throw new Error('Unresolved catalog tile: ' + path)
    tiles.add(atlasImageKey(tile, version, variant))
    tiles.add(atlasMetadataKey(tile, version, variant))
  }
  return { media: [...new Set(media)].sort(), tiles: [...tiles].sort() }
}

export function orphanGroup(bucket: AssetBucket, key: string, keep: Set<string>) {
  const keys = managedPair(bucket, key)
  return keys && keys.every(k => !keep.has(k)) ? keys : null
}

type Bucket = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(keys: string[]): Promise<void>
}

// Validate the entire pair before removing either half. A retry can also finish
// a pair when one of its objects is already absent.
export async function removeArchivedObjects(
  bucket: Bucket,
  receipts: ArchivedObject[],
  media: boolean,
) {
  const existing: string[] = []
  for (const archived of receipts) {
    const object = await bucket.get(archived.key)
    if (!object) continue
    const hash = await crypto.subtle.digest('SHA-256', await object.arrayBuffer())
    const hex = Array.from(new Uint8Array(hash), n =>
      n.toString(16).padStart(2, '0'),
    ).join('')
    if (
      hex !== archived.sha256 ||
      (media && releaseFileKey.exec(archived.key)?.[1] !== hex)
    )
      return false
    existing.push(archived.key)
  }
  if (existing.length) await bucket.delete(existing)
  return true
}
