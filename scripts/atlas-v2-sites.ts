// Build the production route from the same pinned source geometry as the V2 basemap.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { output, reference, renderReference, siteContext, sourceTile } from './dream-atlas-reference.ts'
import { classifyFogEligibility } from '../src/fog-eligibility.ts'

const directory = output + '/production'
const source = JSON.parse(await readFile('releases/sources/source.json', 'utf8'))
const oldRoute = JSON.parse(await readFile('releases/sources/route.json', 'utf8'))
const old = new Map(oldRoute.map((t: any) => [t.x + '/' + t.y,t]))
const centre = {x:214184,y:114419}
const ring = (x:number,y:number) => Math.max(Math.abs(x-centre.x), centre.y-y, y-centre.y-1, 0)
// Southern limit follows the developed shoreline neighbourhoods, from Kennedy
// Town along the campus, downhill of Mid-Levels, through Wan Chai to the park.
const south = [
  [114.116,22.2802],[114.121,22.2797],[114.127,22.2800],[114.132,22.2811],
  [114.139,22.2815],[114.1445,22.2843],[114.151,22.2830],[114.157,22.2817],
  [114.163,22.2777],[114.170,22.2747],[114.178,22.2747],[114.184,22.2760],
  [114.190,22.2790],[114.193,22.2810],
]
// The northern bound deliberately extends offshore; measured land coverage
// below removes open water. In the east, stop at Victoria Park's eastern side.
const north = [
  [114.116,22.285],[114.125,22.289],[114.135,22.295],[114.148,22.295],
  [114.160,22.291],[114.169,22.289],[114.178,22.289],[114.186,22.288],
  [114.193,22.287],
]
const boundary = (points:number[][],lon:number) => {
  const i = points.findIndex(([x]) => x >= lon)
  if (i <= 0) return points[0][1]
  const [a,b]=points[i-1], [c,d]=points[i]
  return b+(d-b)*(lon-a)/(c-a)
}
const sites:any[] = []
const parents = new Map<string,string>()
const missing = new Set<string>()
for (let x=214166;x<=214226;x++) {
  const col = []
  for (let y=114407;y<=114431;y++) {
    const lon=(x+.5)/262144*360-180
    const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/262144)))*180/Math.PI
    const radius=ring(x,y)
    if (!radius) continue
    const campus = radius<=4 && y<=114423 // campus and its immediate urban fringe
    if (!campus && (lon<south[0][0] || lon>south.at(-1)![0] ||
        lat<boundary(south,lon) || lat>boundary(north,lon))) continue
    const parent=Math.floor(x/8)+'-'+Math.floor(y/8)
    const path=output+'/vectors/'+parent+'.mvt'
    if (!parents.has(parent)) {
      if (!(await access(path).then(()=>true,()=>false))) {
        if (!process.argv.includes('--fetch')) {
          missing.add(parent)
          continue
        }
        const url=source.origin+'/'+parent.replace('-','/')+'.mvt?v='+source.release
        const resp=await fetch(url)
        if (!resp.ok) throw Error('Source tile '+parent+': '+resp.status)
        await writeFile(path,new Uint8Array(await resp.arrayBuffer()))
      }
      const hash=createHash('sha256').update(await readFile(path)).digest('hex')
      if (source.hashes[parent] && source.hashes[parent]!==hash) throw Error('Source tile changed: '+parent)
      parents.set(parent,hash)
    }
    const loaded=await sourceTile(x,y)
    const e=classifyFogEligibility(loaded,{zoom:18,x,y})
    if (!e.regionalLandAvailable || e.landFraction===null || e.landFraction < (e.coastal?0.15:0.70)) continue
    col.push({ ...old.get(x+'/'+y) as any,x,y,z:18,region:campus?'HKU':'North Hong Kong Island',
      ring:campus?radius:undefined,landFraction:e.landFraction,coastal:e.coastal,
      usableFraction:e.usableFraction,isTargetable:e.isTargetable,reference:reference(x,y) })
  }
  sites.push(...(x%2 ? col.reverse() : col))
}
await mkdir(directory,{recursive:true})
await mkdir(output+'/revised/references',{recursive:true})
await writeFile(directory+'/sites.json',JSON.stringify({release:source.release,hashes:Object.fromEntries(parents),missingParents:[...missing].sort(),sites}))
if (process.argv.includes('--references')) {
  const requested=JSON.parse(await readFile(directory+'/selected-sites.json','utf8'))
  for (const site of requested) {
    if (!site.siteContext || !(await access(site.reference).then(()=>true,()=>false))) {
      site.reclaimedPaths=await renderReference(site.x,site.y)
      site.siteContext=await siteContext(site.x,site.y)
    }
  }
  await writeFile(directory+'/selected-sites.json',JSON.stringify(requested))
}
console.log('Surveyed',sites.length,'land and coastal sites from',parents.size,'pinned vector tiles')
