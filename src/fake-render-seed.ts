import { releaseCatalog } from './release-media'
import { atlasSceneNames } from './atlas-scenes'
import { parseAtlasTilePath } from './atlas-protocol'
import type { RevealImage } from './fake-render-state'

export function fakeRenderSeed(position: { x: number; y: number }): RevealImage | null {
  const art = releaseCatalog.sheets.flatMap(sheet => sheet.art).find(art =>
    art.x === position.x && art.y === position.y && art.rows === 1 && (art.columns ?? 1) === 1)
  if (!art) return null
  const tile = parseAtlasTilePath(new URL(art.url, 'https://atlas.internal').pathname,
    (scene): scene is typeof atlasSceneNames[number] => atlasSceneNames.includes(scene as typeof atlasSceneNames[number]))
  return { url: art.imageUrl ?? art.url, scene: tile?.scene ?? 'maze-garden', contentBounds: null }
}
