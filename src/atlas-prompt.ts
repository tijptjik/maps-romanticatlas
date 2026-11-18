import { coastalSceneCoverage } from './fog-eligibility.ts'
import { atlasSeaScenes, atlasScenes, type AtlasScene } from './atlas-scenes.ts'

export const edgesAndFigures = {
  edges: [
    "Plan the complete intervention inside the available site.",
    "Follow the surveyed footprint and let the activity occupy its connected terraces, courts and approaches.",
    "Finish each exposed edge at a real feature: a retaining wall turns the corner, a stair reaches its last landing, and a gate meets the existing path at grade.",
    "Use parcel lines to place objects. Where a roof, stall or workshop would protrude past the usable site, shorten its span or move it inward so its end gable, projecting eave and return wall are all visible.",
    "Trace each exposed outline as if the basemap were hidden. Give it a built or living end even where it runs alongside a straight street. Preserve fine projections and the openings between them when isolating the painting.",
    "Allow clearance for the projected tops of structures, foliage, animals, people and contact shade inside the outer frame.",
    "For a multi-tile composition apply this clearance to the outside of the combined frame; carry continuous features through its internal seam.",
    "Preserve the source map's exact ground colour and registered streets in all untouched areas.",
    "At native resolution follow the actual painted silhouette around parapets, railings, treads, branches and openings.",
    "For a keyed overlay, carry the uniform key right up to that silhouette and through exposed gaps.",
    "Keep a raised object continuous wherever it passes in front of a mapped feature behind it. Open a gap only where the viewer can see through the painted structure. Leave detached outlines of existing roads and roofs to the basemap.",
    "Keep the edge crisp: no rectangular feather, haze, colour halo, clipped steps or stray fragments of neighbouring paths.",
  ].join(' '),
  figures: [
    "Use the tile's ground scale and the same vertical projection for every person.",
    "At Hong Kong z18 a 141 m-wide tile rendered 1024 px wide gives a 1.7 m standing adult about 7.4 vertical pixels and a 2.1 m doorway about 9 pixels at the 0.60 height projection.",
    "Scale those measurements with the actual ground width and pixel resolution.",
    "Use a correctly scaled standing pedestrian by a doorway as the reference throughout, including the nearest terrace.",
    "Match head size and shoulder width across diners, staff and passers-by.",
    "A seated adult has a lower crown than a standing companion on the same floor.",
    "Size stools, counters, rails and hand-held objects against those people: feet meet the floor or pedals, knees fit below the table and a hand reaches the serving surface from the seat.",
    "Preserve tiny figures at map zoom; communicate the brief through the site's layout and working parts.",
    "Check the largest foreground figure against a nearby walker at native resolution, and check the complete perimeter against the neighbouring map.",
  ].join(' '),
}

export const atlasCompositionDirection = [
  'Read the surveyed paths and parcels first. For a broad inland tile, aim for roughly 65–75% of the full tile in actual painted site area where the ground permits. Respect protected streets, site boundaries and any scene-specific footprint or coastal coverage. Measure painted coverage, excluding open gaps, against the full tile: a bounding rectangle overstates coverage.',
  'Let the central activity grow across the site in two dimensions. Give its stages distinct spaces linked by a real walk or working connection. Place preparation, transformation and use where their entrances and levels make sense. Keep buildings ancillary unless the brief calls for the building itself.',
  'Make the idea readable on a thumbnail without its caption. Show the material, the part that acts on it and the visible result close enough to trace their relationship. A run of distinct phases can lead a viewer through several courts. Extend the operation to gain coverage; keep people, furniture and tools at the measured scale.',
].join(' ')

export const atlasIllustrationDirection = [
  atlasCompositionDirection,
  'Draw a hand-coloured architectural atlas miniature in fine sepia ink on warm paper. At map zoom, make the site legible from its silhouette, open spaces and pattern of roofs. At native resolution let the eye discover who works here, what they handle and how they move through the place.',
  'Use the museum garden as a reference for composition: a path leads from the entrance past beds and glasshouses to specimen courts. Use the tidal observatory for architectural depth: curved copper-green wings enclose a brass pendulum, with galleries behind it and stepped basins below. Use the kite yard for human scale and colour: indigo and vermilion wings fill the yard while seated makers, bamboo spars, pigment bowls and drying cloth explain how the wings are made. Translate those relationships into the requested subject.',
  'Choose pigments from the materials of this site. Warm stone, inked timber and slate can frame expanses of signature colour such as patinated turquoise metal or patterned silk. Draw glazing ribs on glass, joints in stone, folds in fabric and wear at thresholds. Concentrate fine marks around use and construction; give the adjacent roof or court enough quiet space for that activity to read.',
].join(' ')

const atlasProjectionDirection = [
  'Keep the map dead overhead and north-up. Use one parallel oblique projection for everything drawn on it. Ground contact points stay on the source plan. For a point above ground, start at its own plan position and shift it straight up the page by 0.60 times its physical height at local ground scale. Equal heights use equal offsets everywhere.',
  'Lay out each roof, landing and bridge at its own elevation. Horizontal planes retain their plan shapes and orientation; parallels stay parallel without a vanishing point. Join matching structural points across levels. Trace the near lip of an opening, its inner return and the far surface visible through it. Draw from back to front, letting a nearer eave hide part of a gallery. Use line weight, hatching and contact shade beneath overhangs to distinguish the layers.',
  'Use a 1.7-metre adult and 2.1-metre doorway at the same scale throughout. Carry a believable storey spacing up the occupied wings. Show larger spans where a performance hall, aviary or instrument actually needs them.',
  edgesAndFigures.edges,
  edgesAndFigures.figures,
].join(' ')

const atlasSiteDirection = [
  atlasProjectionDirection,
  'Prioritise mapped building footprints for the principal architecture. Distribute related activities across the usable parcels; align secondary benches, planting beds and installations with narrower strips.',
].join(' ')

export const atlasDrawingDirection = [
  atlasSiteDirection,
  'A raised roof may hide an amber street behind the building. Keep the street aligned where it reappears on both sides. Leave foreground streets visible and finish every roof and rear corner inside the safety margin.',
].join(' ')

export const atlasPrompt = (scene: AtlasScene, hasSea: boolean) => {
  const waterfront = hasSea && atlasSeaScenes.has(scene)
  const seaRule = atlasSeaScenes.has(scene)
    ? hasSea
      ? 'The tile contains visible sea or coastal water; build this waterfront scene from the available coastal strip out over the blue nearshore water zone on piles, piers or floating pontoons connected to shore. A narrow strip of land is sufficient for the entrance and gangways. Preserve the coastline beneath the structure; do not fill in the sea. Leave open water visible between supports and around platforms.'
      : 'This tile does not contain visible sea or coastal water. Do not create the sea-side event; preserve the map unchanged.'
    : hasSea ? 'Connect the activity on shore to the water with a loading yard and a moored cargo boat suited to the scene. Leave open water visible around each hull.' : ''

  const tileRule = `Create ${atlasScenes[scene]} on the mapped parcels in this single z18 map tile, leaving a ${waterfront ? 5 : 10}% safety margin.`
  const continuityRule =
    'This image is a cropped window onto one continuous world map, never a complete, framed illustration: neighbouring map tiles continue beyond every edge.'
  const referenceRule =
    'The first image is the source map. The second image is a zoning guide: brighter green marks priority building footprints and the remaining green areas are safe to transform, amber permits upper architecture to overlap a background street, blue permits moored vessels and shore-connected piers, piled buildings or floating platforms over existing sea, and red is protected. Use the guide as an instruction, not as artwork.'
  const preservationRule =
    'Preserve the exact tile size, orientation, scale, coastline, roads, paths, boundaries, and labels. Preserve water except where an allowed waterfront structure covers it; never replace water with land.'
  const edgeRule = 'Keep the original basemap visible through the outer margin and between the added sites.'
  const infrastructureRule =
    'Treat every existing road and path as hard pixel-registered infrastructure: trace its original centerline exactly, keep every junction and curve in the same position, and preserve the road surface anywhere it is visible around an upright building. Only raised architecture on a southern footprint may obscure an amber segment.'
  const roadRestrictionRule =
    'Do not invent, move, bend, widen, recolour, or erase any locked path or road, and do not draw road-like lines in the green areas.'
  const avoidRule =
    'Keep contact shade inside the illustration. Leave the surrounding map free of cast shadows, atmospheric gradients, added text, borders, frames and tile-shaped background patches.'

  return [
    tileRule,
    continuityRule,
    waterfront
      ? 'The first image is the source map. The second is a placement guide: green indicates ground and blue indicates nearshore water. Red and amber street or shoreline markings can pass underneath the illustrated facility. Keep guide colours out of the artwork.'
      : referenceRule,
    waterfront
      ? 'Preserve the tile size, orientation and map scale. Keep exposed roads, paths and coastlines aligned on both sides of each structure.'
      : preservationRule,
    edgeRule,
    waterfront
      ? 'Paint bridges, gangways, hulls, platforms and buildings continuously over any roads, paths and shoreline beneath them. Show the underlying map again in actual openings and beyond the silhouette.'
      : infrastructureRule,
    !waterfront && roadRestrictionRule,
    avoidRule,
    waterfront ? atlasSiteDirection : atlasDrawingDirection,
    atlasIllustrationDirection,
    seaRule,
    waterfront && `Target ${coastalSceneCoverage * 100}% of the entire tile in actual illustrated footprint. Carry one working waterfront complex well out over the water with broad connected decks, distinct buildings and populated working areas. Keep the people and doorways at atlas scale. Leave water channels between structures.`,
  ]
    .filter(Boolean)
    .join(' ')
}
