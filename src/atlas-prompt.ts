import { atlasSeaScenes, atlasScenes, type AtlasScene } from './atlas-scenes.ts'

const atlasColourDirection =
  'Keep the surrounding map and its Victorian-brown palette unchanged. Within the event, use a lively, carefully balanced storybook palette with warm parchment and sandy cream foundations, plus clear accents of cobalt blue, coral vermilion, marigold yellow, leafy sage green, dusty rose, and soft lilac. Keep the colours richly pigmented, crisp, and pleasantly contrasty so the event stands out, while remaining slightly softened and paper-printed rather than neon, fluorescent, garish, or oversaturated.'

export const atlasPrompt = (scene: AtlasScene, hasSea: boolean) => {
  const seaRule = atlasSeaScenes.has(scene)
    ? hasSea
      ? 'The tile contains visible sea or coastal water; place this sea-side event beside that water and include a small amount of the sea within the tile.'
      : 'This tile does not contain visible sea or coastal water. Do not create the sea-side event; preserve the map unchanged.'
    : ''

  const tileRule = `Create ${atlasScenes[scene]} across the permitted land in this single z18 map tile, leaving a 10% safety margin.`
  const continuityRule =
    'This image is a cropped window onto one continuous world map, never a complete, framed illustration: neighbouring map tiles continue beyond every edge.'
  const referenceRule =
    'The first image is the source map. The second image is a zoning guide: green areas are safe to transform, while red areas are locked and must remain unchanged. Use the guide as an instruction, not as artwork.'
  const preservationRule =
    'Preserve the exact tile size, orientation, scale, coastline, water, roads, paths, boundaries, and labels.'
  const edgeRule =
    'At each image edge, preserve the source map and make any partial terrain, tree canopy, vegetation cluster, building, or event detail read as naturally continuing beyond the crop; never deliberately terminate an object, tree row, field, or vignette at the tile boundary.'
  const infrastructureRule =
    'Treat every existing road and path as hard pixel-registered infrastructure: trace its original centerline exactly, keep every junction and curve in the same position, and do not cover it with buildings, scenery, texture, or event artwork.'
  const roadRestrictionRule =
    'Do not invent, move, bend, widen, recolour, or erase any locked path or road, and do not draw road-like lines in the green areas.'
  const avoidRule =
    'Do not add text, shadows, gradients, lighting, borders, frames, or tile-shaped background patches.'
  const styleRule =
    'Use a flat, planimetric, strict overhead view integrated into the existing cartography.'

  return [
    tileRule,
    continuityRule,
    referenceRule,
    preservationRule,
    edgeRule,
    infrastructureRule,
    roadRestrictionRule,
    avoidRule,
    styleRule,
    atlasColourDirection,
    seaRule,
  ]
    .filter(Boolean)
    .join(' ')
}
