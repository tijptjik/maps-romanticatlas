// Render north-up site references directly from published SaanSeoi vector geometry.
// These simplified map plates have no labels, texture, masks or invented parcels.
import { readFile, writeFile } from 'node:fs/promises'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import sharp from 'sharp'
import { planAtlasRoads } from '../src/atlas-road-plan'

export const output = 'generated-tiles/dream-atlas'
export const references = output + '/revised/references'
const sourceSize = 8
const cache = new Map<string, VectorTile>()
export async function sourceTile(x: number, y: number) {
  const key = Math.floor(x / sourceSize) + '-' + Math.floor(y / sourceSize)
  if (!cache.has(key)) {
    const bytes = await readFile(output + '/vectors/' + key + '.mvt')
    cache.set(key, new VectorTile(new PbfReader(bytes)))
  }
  return cache.get(key)!
}

// Describe only polygons with a surveyed vertex inside this z18 tile. A parent
// feature's bounding box can include distant streets and unrelated parcels.
export async function siteContext(x: number, y: number) {
  const tile = await sourceTile(x, y)
  const sites = []
  for (const key of ['buildings', 'landuse']) {
    const layer = tile.layers[key]
    if (!layer) continue
    const span = layer.extent / sourceSize
    const left = (x % sourceSize) * span, top = (y % sourceSize) * span
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i)
      const [l,t,r,b] = feature.bbox()
      if (r <= left || b <= top || l >= left+span || t >= top+span) continue
      if (key === 'landuse' && !feature.properties.name) continue
      if (feature.type !== 3 || !feature.loadGeometry().some(ring => ring.some(p =>
        p.x >= left && p.x < left+span && p.y >= top && p.y < top+span))) continue
      const percent = (value: number) => Math.round(100*Math.max(0, Math.min(1,value/span)))
      const bounds = [percent(l-left),percent(t-top),percent(r-left),percent(b-top)]
      const area = (bounds[2]-bounds[0])*(bounds[3]-bounds[1])
      if (area < 5) continue
      const name = String(feature.properties.name || 'unnamed building')
      sites.push({name, bounds, area})
    }
  }
  sites.sort((a,b) => Number(b.name !== 'unnamed building') - Number(a.name !== 'unnamed building') || b.area-a.area)
  return sites.slice(0,5).map(({name,bounds}) => ({name,bounds}))
}

export const referenceRoadWidth = ({ kind, kind_detail: detail }) =>
  /path|footway|steps|pedestrian|track|cycleway/.test(String(detail)) ? 3 :
    kind === 'highway' ? 31 : kind === 'major_road' ? 23 : detail === 'service' ? 8 : 15

export const reference = (x: number, y: number) => references + '/18-' + x + '-' + y + '.png'
export const hkuId = 52776560557523
export async function renderReference(x: number, y: number) {
  const tile = await sourceTile(x, y)
  const roads = []
  const elements = ['<rect width="512" height="512" fill="#7d9fa0"/>']
  for (const name of ['earth', 'landuse', 'water', 'buildings', 'roads']) {
    const layer = tile.layers[name]
    if (!layer) continue
    const span = layer.extent / sourceSize
    const dx = x % sourceSize * span
    const dy = y % sourceSize * span
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i)
      const [l,t,r,b] = feature.bbox()
      if (l > dx + span || t > dy + span || r < dx || b < dy) continue
      const { kind } = feature.properties
      const polygon = feature.type === 3
      if (feature.type === 1 || (name !== 'roads' && !polygon) || (name === 'roads' && kind === 'rail')) continue
      if (name === 'roads') {
        roads.push(feature.toGeoJSON(Math.floor(x/8), Math.floor(y/8), 15))
        continue
      }
      const rings = feature.loadGeometry()
      const path = rings.map(ring => 'M' + ring.map(p =>
        [(p.x - dx) * 512 / span, (p.y - dy) * 512 / span].join(',')
      ).join('L') + (polygon ? 'Z' : '')).join('')
      const fill = ({ earth: '#ead5ab', landuse: kind === 'park' ? '#a7ae7c' : '#d9c997',
        water: '#7d9fa0', buildings: '#c99075', roads: 'none' })[name]
      const stroke = name === 'buildings' ? '#9e6657' : 'none'
      elements.push('<path d="' + path + '" fill-rule="evenodd" fill="' + fill + '" stroke="' + stroke + '"/>')
    }
  }
  const n = 2 ** 18
  const longitude = column => column * 360 / n - 180
  const latitude = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI
  const plan = planAtlasRoads(roads, {
    west: longitude(x), east: longitude(x+1), north: latitude(y), south: latitude(y+1)
  })
  for (const { geometry, properties } of plan.retained) {
    const path = 'M' + geometry.coordinates.map(([lon,lat]) => [
      ((lon+180)/360*n-x)*512,
      ((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)*n/2-y)*512
    ].join(',')).join('L')
    const width = referenceRoadWidth(properties)
    elements.push('<path d="' + path + '" fill="none" stroke="#a86f5b" stroke-width="' + (width + 1) + '"/>')
    elements.push('<path d="' + path + '" fill="none" stroke="#f8edcf" stroke-width="' + width + '"/>')
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">' + elements.join('') + '</svg>'
  await sharp(Buffer.from(svg)).png().toFile(reference(x,y))
  return plan.removedPaths
}

export async function hkuFootprint() {
  const x = 214184, y = 114419
  const layer = (await sourceTile(x,y)).layers.buildings
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.id !== hkuId) continue
    const span = layer.extent / sourceSize
    const rings = f.loadGeometry().map(ring => ring.map(p => [p.x/span - x%8, p.y/span-y%8]))
    let signedArea = 0, firstMomentX = 0, firstMomentY = 0
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x0,y0] = ring[i-1], [x1,y1] = ring[i]
        const cross = x0*y1 - x1*y0
        signedArea += cross
        firstMomentX += (x0+x1)*cross
        firstMomentY += (y0+y1)*cross
      }
    }
    const centroid = [firstMomentX,firstMomentY].map(value => value / (3*signedArea))
    if (!centroid.every(value => value >= 0 && value < 1)) throw Error('HKU centroid moved to another tile')
    const shape = rings.map(r => 'M' + r.map(p => p.join(',')).join('L') + 'Z').join('')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0.2 0.5 0.9 0.9"><rect width="3" height="3" fill="#f7f1e5"/><path d="' + shape + '" fill-rule="evenodd" stroke="#503c32" stroke-width=".004" fill="#cfb997"/></svg>'
    await sharp(Buffer.from(svg)).png().toFile(references + '/hku-main-building-footprint.png')
    await writeFile('releases/sources/hku-footprint.json', JSON.stringify({
      name: f.properties.name, featureId: String(f.id), sourceTile: [15,26773,14302],
      baseTile: [18,x,y], coordinatesInBaseTile: rings[0], holes: rings.slice(1),
      normalizedCentroid: centroid
    }, null, 2) + '\n')
    return
  }
  throw Error('Main Building geometry missing')
}

if (import.meta.main) {
  await hkuFootprint()
  await renderReference(214184,114419)
}
