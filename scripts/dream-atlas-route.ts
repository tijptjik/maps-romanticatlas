// Rebuild the route from one pinned vector release. Run from the repository root.
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { atlasDrawingDirection, atlasIllustrationDirection } from '../src/atlas-prompt'
import { classifyFogEligibility } from '../src/fog-eligibility.ts'
import {
  hkuFootprint,
  output,
  reference,
  references,
  renderReference,
  sourceTile,
  siteContext,
} from './dream-atlas-reference.ts'

const release = 'eb78aacacfa67fc94a7b7a1915ea2354'
const vectorOrigin =
  'https://romanticatlas.hype.hk/map-assets/saanseoi/hongkong-latest/15'
const central = { x: 214184, y: 114419 }
import {
  contains,
  coordinate,
  island,
  mongKok,
  serpentine,
  tst,
  west,
  type Tile,
} from './atlas-route-geometry.ts'
const rings: Tile[] = []
for (let ring = 0; ring <= 4; ring++) {
  for (let dx = -ring; dx <= ring; dx++)
    for (let dy = -ring; dy <= ring; dy++) {
      const x = central.x + dx,
        y = central.y + dy
      if (x === central.x && (y === central.y || y === central.y + 1)) continue
      if (
        Math.max(Math.abs(dx), Math.abs(dy)) !== ring ||
        !contains(coordinate(x, y), island)
      )
        continue
      rings.push({ x, y, region: 'HKU', options: 5 - ring })
    }
}
const islandStrip = serpentine(island, 'North Hong Kong Island')
const groups = [
  rings,
  islandStrip,
  serpentine(west, 'Western Kowloon'),
  serpentine(mongKok, 'Mong Kok'),
  serpentine(tst, 'Tsim Sha Tsui and Kowloon Peninsula'),
]
await mkdir(`${output}/vectors`, { recursive: true })
await mkdir(references, { recursive: true })
const parentIds = [
  ...new Set(
    groups.flat().map(({ x, y }) => `${Math.floor(x / 8)}-${Math.floor(y / 8)}`),
  ),
]
if (process.argv.includes('--fetch')) {
  for (const id of parentIds) {
    const [x, y] = id.split('-')
    const dest = `${output}/vectors/${id}.mvt`
    if (
      await access(dest).then(
        () => true,
        () => false,
      )
    )
      continue
    const response = await fetch(`${vectorOrigin}/${x}/${y}.mvt?v=${release}`)
    if (!response.ok) throw Error(`Source tile ${id} HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const temp = `${dest}.${process.pid}.part`
    await writeFile(temp, bytes)
    await rename(temp, dest)
  }
  console.log('Prepared', parentIds.length, 'published source tiles')
  process.exit(0)
}

// Classify each child against the same geometry and rules as the atlas.
const seen = new Set([`${central.x}-${central.y}`, `${central.x}-${central.y + 1}`])
async function eligible(group: Tile[]) {
  const result = []
  for (const t of group) {
    const id = `${t.x}-${t.y}`
    if (seen.has(id)) continue
    const e = classifyFogEligibility(await sourceTile(t.x, t.y), {
      zoom: 18,
      x: t.x,
      y: t.y,
    })
    if (!e.isTargetable || !e.regionalLandAvailable) continue
    result.push({
      ...t,
      z: 18,
      reference: reference(t.x, t.y),
      landFraction: e.landFraction,
      coastal: e.coastal,
    })
  }
  return result
}
const mark = (rows: Tile[]) =>
  rows.forEach(t => {
    seen.add(`${t.x}-${t.y}`)
  })
const hku = await eligible(rings)
mark(hku)
const north = await eligible(islandStrip)
mark(north)
const takeSpread = <T>(rows: T[], count: number) => {
  if (count < 1 || rows.length < count)
    throw Error(`Requested ${count} from ${rows.length} sites`)
  return Array.from(
    { length: count },
    (_, i) => rows[Math.floor(((i + 0.5) * rows.length) / count)],
  )
}
const mk = takeSpread(await eligible(groups[3]), 20)
mark(mk)
const peninsula = takeSpread(await eligible(groups[4]), 20)
mark(peninsula)
const western = takeSpread(await eligible(groups[2]), 20)
const tiles = [...hku, ...north, ...western, ...mk, ...peninsula]
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
await hkuFootprint()
const footprint = JSON.parse(
  await readFile('releases/sources/hku-footprint.json', 'utf8'),
)
// The tower renderer registers against the southern tile. Keep the entire
// surveyed ring in that frame, including its negative-y northern portion.
const inSouth = ring => ring.map(([x, y]) => [x, y - 1])
await writeFile(
  'releases/sources/hku-site.json',
  json({
    grid: { zoom: 18 },
    selectionSize: 5,
    tiles: [
      {
        scene: 'skyscraper',
        x: central.x,
        y: central.y + 1,
        spansNorthernTile: true,
        clickTiles: [
          [18, central.x, central.y],
          [18, central.x, central.y + 1],
        ],
        footprint: {
          ...footprint,
          baseTile: [18, central.x, central.y + 1],
          normalizedCentroid: inSouth([footprint.normalizedCentroid])[0],
          coordinatesInBaseTile: inSouth(footprint.coordinatesInBaseTile),
          holes: footprint.holes.map(inSouth),
        },
      },
    ],
  }),
)
for (const tile of tiles)
  Object.assign(tile, {
    reclaimedPaths: await renderReference(tile.x, tile.y),
    siteContext: await siteContext(tile.x, tile.y),
  })
await writeFile(
  'releases/sources/drawing-direction.json',
  json([atlasDrawingDirection, atlasIllustrationDirection].join(' ')),
)
await writeFile(
  'releases/sources/source.json',
  json({
    release,
    origin: vectorOrigin,
    sourceZoom: 15,
    fieldZoom: 18,
    attribution: '© OpenStreetMap contributors, Natural Earth, Protomaps and SaanSeoi',
    hashes: Object.fromEntries(
      await Promise.all(
        parentIds.map(async key => [
          key,
          createHash('sha256')
            .update(await readFile(`${output}/vectors/${key}.mvt`))
            .digest('hex'),
        ]),
      ),
    ),
  }),
)
await writeFile('releases/sources/route.json.part', json(tiles))
await rename('releases/sources/route.json.part', 'releases/sources/route.json')
console.log(
  tiles.length,
  'tiles',
  tiles.reduce((s, t) => s + t.options, 0),
  'images',
)
