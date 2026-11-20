import { releaseCatalog } from './release-media'
import { isAtlasScene } from './atlas-scenes'
import { parseAtlasTilePath } from './atlas-protocol'
import type { Painting } from './artwork-review'
import type { RevealImage } from './fake-render-state'

export function seedForPainting(art: Painting): RevealImage | null {
  if (art.rows !== 1 || (art.columns ?? 1) !== 1) return null
  const scene = art.scene ?? parseAtlasTilePath(art.url.split('?')[0], isAtlasScene)?.scene
  if (!isAtlasScene(scene)) return null
  return { title: art.title, url: art.imageUrl ?? art.url, scene, contentBounds: null }
}

const releaseScenes = new Map<string, string>()

export function restoreSeedScene(image: RevealImage): RevealImage {
  if (image.scene !== 'maze-garden') return image
  const scene = releaseScenes.get(image.url)
  return scene && scene !== image.scene ? { ...image, scene } : image
}

const seeds = new Map<string, RevealImage>()
for (const sheet of releaseCatalog.sheets) {
  for (const art of sheet.art) {
    const key = art.x + '/' + art.y
    const seed = seedForPainting(art)
    if (!seed) continue
    releaseScenes.set(art.url, seed.scene)
    releaseScenes.set(seed.url, seed.scene)
    if (!seeds.has(key)) seeds.set(key, seed)
  }
}

export function fakeRenderSeed(position: { x: number; y: number }): RevealImage | null {
  return seeds.get(position.x + '/' + position.y) ?? null
}
