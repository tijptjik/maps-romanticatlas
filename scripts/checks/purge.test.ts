import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveObject, planBucket } from '../purge'
import { digest } from '../release-plan'
import {
  discoveryObjects,
  releaseObjects,
  removeArchivedObjects,
} from '../../src/artwork-purge'

test('bucket-first comparison covers unreviewed files, legacy pairs, and incomplete pairs', async () => {
  const key = 'release-assets/' + 'a'.repeat(64) + '.ogg'
  const other = 'release-assets/' + 'b'.repeat(64) + '.webp'
  const url = '/generated-tiles/18/2/3/wind-farm?variant=discovery-test&version=6'
  const keep = releaseObjects([key, key], [url])
  const entry = (key: string) => ({ key, size: 5 })
  const media = await planBucket('media', [key, other, 'shared-maps/map.png'].map(entry), new Set(keep.media))
  expect(media.retained).toEqual({ referenced: 1, other: 1 })
  expect(media.candidates.map(item => item.keys)).toEqual([[other]])
  const old = 'atlas/18/2/3/wind-farm'
  const leftover = old + '.v5.study'
  const tiles = await planBucket('tiles', [...keep.tiles, old + '.image', old + '.json', leftover + '.json',
    'v2-artwork-reviews/x', 'indexes/cache', 'generation-jobs/1.json'].map(entry), new Set(keep.tiles))
  expect(tiles.retained).toEqual({ referenced: 2, other: 3 })
  expect(tiles.candidates.map(item => item.stored.map(o => o.key))).toEqual([
    [old + '.image', old + '.json'], [leftover + '.json'],
  ])
})

test('archives exact object bytes and detects damaged local copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-purge-'))
  try {
    const bytes = Buffer.from('painting')
    const key = 'release-assets/' + digest(bytes) + '.webp'
    const archive = await archiveObject(root, 'media', key, bytes)
    const file = join(root, 'media', key, archive.sha256)
    expect(await readFile(file)).toEqual(bytes)
    await writeFile(file, 'corrupt')
    await expect(archiveObject(root, 'media', key, bytes)).rejects.toThrow(
      'Archive verification failed',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generated tile cleanup checks both archived revisions and supports partial retries', async () => {
  const url = '/generated-tiles/18/2/3/wind-farm?version=6&variant=discovery-test'
  const keys = discoveryObjects(url)!.keys
  const bytes = new Uint8Array([12])
  const objects = new Set(keys)
  const bucket = {
    get: async (key: string) =>
      objects.has(key) ? { arrayBuffer: async () => bytes.buffer } : null,
    delete: async (batch: string[]) => {
      for (const key of batch) objects.delete(key)
    },
  }
  const receipts = keys.map(key => ({ key, sha256: digest(bytes) }))
  expect(
    await removeArchivedObjects(
      bucket,
      [receipts[0], { key: keys[1], sha256: null }],
      false,
    ),
  ).toBe(false)
  expect(objects.size).toBe(2)
  objects.delete(keys[0])
  expect(await removeArchivedObjects(bucket, receipts, false)).toBe(true)
  expect(objects.size).toBe(0)
})
