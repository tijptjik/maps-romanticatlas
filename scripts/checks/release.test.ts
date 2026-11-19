import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artworkPresentation, publishedArtworkUrl } from '../../src/artwork-presentation'
import { release } from '../release'
import { acceptedCatalog, digest, type Asset, type Catalog } from '../release-plan'

const art = { title: 'A', x: 2, y: 3, rows: 1, url: '/study/a.webp?v=42' }
const catalog = {
  release: 'v2',
  sheets: [{ id: 'a', title: 'A', accepted: true, art: [art] }],
}

test('review decisions override sheet defaults and preserve independent URL versions', () => {
  const second = { ...art, url: '/study/a.webp?v=43', status: 'accepted' as const }
  const reviews = [{ ...art, status: 'rejected' as const }, second]
  const compiled = acceptedCatalog(catalog, reviews)
  expect(compiled.sheets.flatMap(s => s.art)).toEqual([{ ...art, url: second.url }])
  expect(acceptedCatalog(compiled, reviews)).toEqual(compiled)
})

test('release validates and uploads dependencies before installing manifests and deploying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-release-test-'))
  try {
    for (const dir of [
      'releases',
      'public/atlas-v2',
      'public/study',
      'generated-tiles/18/2/3',
    ])
      await mkdir(join(root, dir), { recursive: true })
    const save = (path: string, value: unknown) =>
      writeFile(join(root, path), JSON.stringify(value))
    await save('wrangler.jsonc', {
      r2_buckets: [
        { binding: 'ATLAS_BUCKET', bucket_name: 'tiles' },
        { binding: 'maps_romanticatlas_assets', bucket_name: 'media' },
      ],
    })
    await save('releases/catalog.json', { release: 'v2', sheets: [] })
    const frame = new Uint8Array([15])
    const key = `release-assets/${digest(frame)}.webp`
    await save('releases/assets.json', { '/pavilion/frame.webp': key })
    const revisionId = '0a2ad6a81ad147219b9ee1ba2ebc954e'
    const revisionUrl = `/artwork-revisions/${revisionId}.png`
    const job = join(root, 'generated-tiles/dream-atlas/review-revisions/jobs', revisionId)
    await mkdir(job, { recursive: true })
    const candidate = new Uint8Array([19])
    await writeFile(join(job, 'candidate.png'), candidate)
    const revisionKey = `release-assets/${digest(candidate)}.png`
    await save('releases/v2-reviews.json', [
      { ...art, url: revisionUrl, status: 'accepted' },
      {
        ...art,
        url: '/generated-tiles/18/2/3/wind-farm?version=6&variant=discovery-test',
        status: 'accepted',
      },
    ])
    await save('public/atlas-v2/catalog.json', {
      ...catalog,
      sheets: [
        {
          ...catalog.sheets[0],
          art: [
            {
              ...art,
              animation: {
                folder: 'study',
                plate: '/study/plate.webp',
                motion: { sprite: 'figure' },
              },
            },
          ],
        },
      ],
    })
    for (const name of ['a', 'plate', 'figure'])
      await writeFile(join(root, `public/study/${name}.webp`), name)
    const prefix = 'generated-tiles/18/2/3/wind-farm.v6.discovery-test'
    await writeFile(join(root, `${prefix}.image`), 'generated image')
    await save(`${prefix}.json`, { contentType: 'image/png' })
    const remote = new Map<string, Uint8Array>()
    let downloads = 0
    let uploads = 0
    const store = {
      read: async (asset: Asset, validator?: string) => {
        const bytes = remote.get(`${asset.bucket}/${asset.key}`)
        if (!bytes) return null
        const etag = '"' + digest(bytes) + '"'
        if (etag === validator) return 'unchanged' as const
        downloads++
        return { bytes, etag }
      },
      put: async (asset: Asset, bytes: Uint8Array) => {
        remote.set(`${asset.bucket}/${asset.key}`, bytes)
        uploads++
      },
    }
    let deployed = 0
    const deploy = async () => {
      const compiled: Catalog = JSON.parse(
        await readFile(join(root, 'releases/catalog.json'), 'utf8'),
      )
      expect(compiled.sheets.flatMap(s => s.art)).toHaveLength(3)
      expect(remote.has('tiles/atlas/18/2/3/wind-farm.v6.discovery-test.json')).toBe(
        true,
      )
      const assets = JSON.parse(await readFile(join(root, 'releases/assets.json'), 'utf8'))
      expect(Object.keys(assets)).toHaveLength(5)
      expect(assets[revisionUrl]).toBe(revisionKey)
      expect(remote.get(`media/${revisionKey}`)).toEqual(candidate)
      deployed++
    }
    await release(
      root,
      true,
      async () => {
        throw Error('dry run used network')
      },
      deploy,
    )
    await expect(release(root, false, async () => store, deploy)).rejects.toThrow(
      'Missing locally and in R2',
    )
    expect(deployed).toBe(0)
    expect(
      JSON.parse(await readFile(join(root, 'releases/catalog.json'), 'utf8')).sheets,
    ).toHaveLength(0)
    remote.set(`media/${key}`, frame)
    await release(root, false, async () => store, deploy)
    await rm(job, { recursive: true })
    const firstDownloads = downloads
    const firstUploads = uploads
    await release(root, false, async () => store, deploy)
    expect(downloads).toBe(firstDownloads)
    const receiptsFile = '.local/release/verified-objects.json'
    const receipts = JSON.parse(await readFile(join(root, receiptsFile), 'utf8'))
    receipts['media/' + key].verifiedAt = 0
    await save(receiptsFile, receipts)
    await release(root, false, async () => store, deploy)
    expect(downloads).toBe(firstDownloads + 1)
    await release(root, false, async () => store, deploy, true)
    expect(downloads).toBe(firstDownloads + 1 + remote.size)
    expect(uploads).toBe(firstUploads)
    expect(deployed).toBe(4)
    remote.set(`media/${key}`, new Uint8Array([16]))
    await expect(release(root, false, async () => store, deploy)).rejects.toThrow(
      'R2 content differs',
    )
    expect(deployed).toBe(4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared immutable bytes retain per-painting map presentation', () => {
  const path = '/release-assets/' + 'a'.repeat(64) + '.webp'
  const release = new URL(publishedArtworkUrl(path, '/atlas-v2/coasters/counterweight-ballet-cleared.png'), 'https://atlas.test')
  expect(release.pathname).toBe(path)
  expect(artworkPresentation(release)?.waterFadeStart).toBe(0.72)
  expect(publishedArtworkUrl(path, '/study/other.png')).toBe(path)
  release.hash = ''
  expect(artworkPresentation(release)).toBeUndefined()
})
