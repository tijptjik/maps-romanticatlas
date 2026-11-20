import { atlasSceneNames, atlasSeaScenes, atlasScenes, type AtlasScene } from './atlas-scenes'
import { atlasSceneGridRadius, isValidAtlasPosition, atlasZoom } from './atlas-protocol'
import { overlapsPeakMaquette } from './artwork-reservation'
import { isFogPatternSelected, type FogEligibility } from './fog-eligibility'
import { sceneBooks } from './scene-books'
import type { Revision } from './artwork-revision'

export const generationEndpoint = '/api/artwork-generation'
export const scenesForFamily = (family: AtlasScene) => sceneBooks[family] ?? [{
  name: family.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
  prompt: atlasScenes[family],
}]
const familyByTitle = new Map(atlasSceneNames.flatMap(family =>
  scenesForFamily(family).map(scene => [scene.name, family] as const)))

type Placement = { x: number; y: number; rows?: number; columns?: number; scene?: string; title?: string }
export function familyIndex(placements: Iterable<Placement>) {
  const index = new Map<string, Set<string>>()
  for (const art of placements) {
    const family = art.scene ?? familyByTitle.get(art.title)
    if (!family) continue
    for (let row = 0; row < (art.rows ?? 1); row++) {
      for (let col = 0; col < (art.columns ?? 1); col++) {
        const id = (art.x + col) + '/' + (art.y - row)
        if (!index.has(id)) index.set(id, new Set())
        index.get(id).add(family)
      }
    }
  }
  return index
}

export function availableFamilies(tile: FogEligibility, index: ReturnType<typeof familyIndex>) {
  if (!tile?.regionalLandAvailable || !tile.isTargetable || !isFogPatternSelected(tile) || overlapsPeakMaquette(tile)) return []
  const nearby = new Set<string>()
  for (let x = tile.x - atlasSceneGridRadius; x <= tile.x + atlasSceneGridRadius; x++)
    for (let y = tile.y - atlasSceneGridRadius; y <= tile.y + atlasSceneGridRadius; y++)
      for (const family of index.get(x + '/' + y) ?? []) nearby.add(family)
  return atlasSceneNames.filter(family => atlasSeaScenes.has(family) === Boolean(tile.coastal) && !nearby.has(family))
}

export const reservedArt = (jobs: Revision[]) => jobs.flatMap(job =>
  job.state === 'failed' ? [] : [job.candidate ?? job.source])

export function generationPosition(body: any) {
  const tile = { zoom: atlasZoom, x: body?.x, y: body?.y }
  if (isValidAtlasPosition(tile) && typeof body?.mapImage === 'string' && body.mapImage.length <= 4_500_000 &&
    body.mapImage.startsWith('data:image/png;base64,')) return tile
}

export function generationJob(body: any, tile: FogEligibility, nearby: Iterable<Placement>) {
  const families = availableFamilies(tile, familyIndex(nearby))
  const family = body.random === true ? families[Math.floor(Math.random() * families.length)] :
    families.find(family => family === body.family)
  if (!family) return null
  const scenes = scenesForFamily(family)
  const scene = body.random === true ? scenes[Math.floor(Math.random() * scenes.length)] :
    scenes.find(scene => scene.name === body.scene)
  if (!scene) return null
  return { mode: 'generate', mapImage: body.mapImage, prompt: scene.prompt,
    source: { x: tile.x, y: tile.y, rows: 1, scene: family, title: scene.name,
      url: '/generation-targets/' + tile.x + '/' + tile.y + '/' + family } }
}
