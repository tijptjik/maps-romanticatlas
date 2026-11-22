// Rebuild the illustrated summit tile from the MVT recorded in site.json.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { VectorTile } from '@mapbox/vector-tile'
import { fromVectorTileJs } from '@maplibre/vt-pbf'
import { PbfReader } from 'pbf'

const site = JSON.parse(
  await readFile(
    new URL('../releases/sources/peak-maquette/site.json', import.meta.url),
  ),
)
const bytes = await readFile(process.argv[2])
assert.equal(createHash('sha256').update(bytes).digest('hex'), site.source.sha256)
const tile = new VectorTile(new PbfReader(bytes))

const buildings = new Set([
  35184657192652, 35184931404201, 35184993158956, 35184993158957, 35185026390750,
  35185026390751, 35185026390753, 35185708880638,
])

// MVT coordinates in 15/26773/14303. The artwork occupies x=512..2048, y=1024..1536.
const bend = points => points.map(([x, y]) => ({ x, y }))
const east = bend([
  [2079, 633],
  [2055, 681],
  [2037, 737],
  [2028, 793],
  [2031, 848],
  [2044, 900],
  [2068, 961],
  [2086, 1024],
  [2098, 1098],
  [2099, 1185],
  [2091, 1263],
  [2070, 1338],
  [2038, 1403],
  [1994, 1463],
  [1944, 1510],
  [1881, 1549],
  [1811, 1574],
])
const south = bend([
  [1811, 1574],
  [1749, 1588],
  [1668, 1599],
  [1579, 1600],
  [1474, 1592],
  [1381, 1588],
  [1290, 1591],
  [1202, 1602],
  [1115, 1621],
  [1031, 1646],
  [939, 1668],
  [847, 1684],
  [766, 1700],
  [702, 1717],
])

for (const name of ['buildings', 'water', 'roads', 'landuse']) {
  const layer = tile.layers[name]
  const features = []
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (name === 'buildings' && buildings.has(f.id)) continue
    if (name === 'water' && f.id === 5521822192) continue
    const geometry = f.loadGeometry()
    if (name === 'landuse' && f.id === 52776569927817) geometry.splice(1, 1) // woodland clearing
    if (name === 'roads' && f.id === 35184528424430) geometry.splice(0, 5) // residential driveways
    if (name === 'roads' && f.id === 35184672586780)
      geometry[1].splice(2, Infinity, ...east)
    if (name === 'roads' && f.id === 35185148845215) geometry[0].splice(0, 19, ...south)
    features.push({ ...f, loadGeometry: () => geometry })
  }
  tile.layers[name] = { ...layer, length: features.length, feature: i => features[i] }
}

await writeFile(
  new URL('../src/peak-woodland.mvt', import.meta.url),
  fromVectorTileJs(tile),
)
