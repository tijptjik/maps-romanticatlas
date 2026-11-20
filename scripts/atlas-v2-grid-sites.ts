// Find eligible replacement sites against the same seeded grid used for reveal.
import { createHash } from 'node:crypto'
import { readFile, access } from 'node:fs/promises'
import { cloudSeed } from '../src/cloud-seed.ts'
import { isFogPatternSelected } from '../src/fog-pattern.js'
import { classifyFogEligibility } from '../src/fog-eligibility.ts'
import { atlasSeaScenes, atlasScenes } from '../src/atlas-scenes.ts'
import { atlasPrompt } from '../src/atlas-prompt.ts'
import { west, mongKok, tst, serpentine } from './atlas-route-geometry.ts'
import { output, reference, renderReference, siteContext, sourceTile } from './dream-atlas-reference.ts'

const request = await Bun.stdin.json()
if (request.action === 'cloud-seed') {
  console.log(JSON.stringify(cloudSeed))
} else if (request.action === 'coastal-catalog') {
  console.log(JSON.stringify(Object.fromEntries([...atlasSeaScenes].map(scene =>
    [scene, {brief:atlasScenes[scene], direction:atlasPrompt(scene,true)}]))))
} else if (request.action === 'eligible') {
  console.log(JSON.stringify(request.tiles.filter(isFogPatternSelected)))
} else if (request.action === 'inspect') {
  const survey = await Bun.file(output + '/production/sites.json').json()
  const pinned = await Bun.file('releases/sources/source.json').json()
  const extra = request.centralWestern ? await Bun.file('releases/sources/central-western/vectors.json').json() : null
  if (extra && extra.release !== pinned.release) throw Error('Central and Western source release differs')
  const hashes = new Map<string, string>()
  const sites = []
  for (const site of request.tiles) {
    const parent = Math.floor(site.x / 8) + '-' + Math.floor(site.y / 8)
    if (!hashes.has(parent)) {
      const bytes = await readFile(output + '/vectors/' + parent + '.mvt')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (hash !== (survey.hashes[parent] ?? pinned.hashes[parent] ?? extra?.hashes[parent])) {
        throw Error('Unpinned or changed source vector ' + parent)
      }
      hashes.set(parent, hash)
    }
    const eligibility = classifyFogEligibility(await sourceTile(site.x, site.y), {
      zoom: 18, x: site.x, y: site.y,
    })
    sites.push({ ...site, ...eligibility, selected: isFogPatternSelected(site),
      vectorSha256: hashes.get(parent) })
  }
  console.log(JSON.stringify(sites))
} else if (request.action === 'prepare') {
  const sites = []
  for (const s of request.tiles) {
    if (!isFogPatternSelected(s)) throw Error('Permanently clear tile ' + JSON.stringify(s))
    const reclaimedPaths = await renderReference(s.x, s.y)
    const path = reference(s.x,s.y)
    sites.push({...s, reference:path, reclaimedPaths, siteContext:await siteContext(s.x,s.y),
      referenceSha256:createHash('sha256').update(await readFile(path)).digest('hex')})
  }
  console.log(JSON.stringify(sites))
} else if (request.action === 'candidates') {
  const survey = await Bun.file(output + '/production/sites.json').json()
  const pinned = await Bun.file('releases/sources/source.json').json()
  const key = (s: {x:number,y:number}) => s.x + '/' + s.y
  const used = new Set(request.occupied.map(key))
  const northern = 'North Hong Kong Island'
  const groups = [survey.sites.filter(s => s.region === northern),
    // Search the remaining low-lying waterfront north of the existing route,
    // plus Victoria Park, the Wan Chai harbourfront and the Central piers.
    serpentine([[114.119,22.282],[114.137,22.287],[114.150,22.286],[114.16,22.282],
      [114.166,22.279],[114.175,22.277],[114.184,22.277],[114.192,22.279],
      [114.193,22.288],[114.181,22.289],[114.172,22.289],[114.155,22.291],
      [114.14,22.294],[114.119,22.291]], northern),
    // The low-lying Causeway Bay street grid around the racecourse's north
    // entrance, Times Square and Leighton Road extends south of the waterfront.
    serpentine([[114.176,22.275],[114.178,22.2733],[114.181,22.2733],
      [114.1855,22.2749],[114.1895,22.2773],[114.191,22.2805],
      [114.188,22.283],[114.177,22.281]], northern),
    // Admiralty's built frontage between Queensway and Harcourt Road.
    serpentine([[114.158,22.2802],[114.163,22.2772],[114.167,22.2766],
      [114.168,22.2796],[114.160,22.2834]], northern),
    serpentine(mongKok,'Mong Kok'),serpentine(tst,'Tsim Sha Tsui and Kowloon Peninsula'),
    serpentine(west,'Western Kowloon')]
  const candidates = []
  const parents = new Map<string,string>()
  for (const group of groups) for (const s of group) {
    if (used.has(key(s)) || !isFogPatternSelected(s)) continue
    used.add(key(s))
    if (s.region === northern && Math.max(Math.abs(s.x-214184),114419-s.y,s.y-114420)<=4) continue
    const parent = Math.floor(s.x/8)+'-'+Math.floor(s.y/8)
    const path = output + '/vectors/' + parent + '.mvt'
    if (!parents.has(parent)) {
      if (!(await access(path).then(()=>true,()=>false))) continue
      const hash = createHash('sha256').update(await readFile(path)).digest('hex')
      if (hash !== (survey.hashes[parent] ?? pinned.hashes[parent])) continue
      parents.set(parent, hash)
    }
    const e = classifyFogEligibility(await sourceTile(s.x,s.y),{zoom:18,x:s.x,y:s.y})
    if (!e.regionalLandAvailable || !e.isTargetable) continue
    candidates.push({x:s.x,y:s.y,z:18,region:s.region,landFraction:e.landFraction,
      coastal:e.coastal,usableFraction:e.usableFraction,vectorSha256:parents.get(parent)})
  }
  console.log(JSON.stringify(candidates))
} else {
  throw Error('Unknown grid survey action')
}
