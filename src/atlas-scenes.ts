export const atlasScenes = {
  circus: 'a Victorian circus',
  'balloon-festival': 'a balloon festival',
  'art-nouveau-palace': 'an elaborate Art Nouveau palace',
  ironworks: 'a glowing Victorian ironworks',
  'steam-railway': 'a grand Victorian steam railway terminus',
  'suspension-bridge': 'a monumental Victorian suspension bridge under construction',
  'canal-lock': 'a Victorian canal lock with steam barges',
  lighthouse: 'a Victorian lighthouse and signal station',
  'textile-mill': 'a vast Victorian textile mill',
  'luddite-rally': 'a secret gathering of Luddite machine-breakers',
  printworks: 'a bustling Victorian printing works',
  shipyard: 'a Victorian steamship shipyard',
  'telegraph-office': 'an enormous Victorian telegraph office',
  'photography-studio': 'an early Victorian photography studio',
  'mechanical-theatre': 'a Victorian mechanical theatre filled with automata',
  automata: 'an exhibition of uncanny Victorian automata',
  'anatomical-museum': 'a Victorian anatomical museum',
  'mesmerist-salon': 'an enormous candlelit Victorian mesmerist salon',
  'hall-of-mirrors': 'a grand Victorian hall of mirrors',
  'botanical-laboratory': 'an enormous Victorian botanical laboratory',
  'electrical-laboratory': 'an experimental Victorian electrical laboratory',
  observatory: 'a Victorian astronomical observatory',
  'weather-station': 'an enormous Victorian meteorological station',
  'orrery-hall': 'a grand Victorian orrery and celestial-instrument hall',
  'analytical-engine': 'a workshop containing a Victorian analytical engine',
  'utopian-garden': 'an idealised Victorian utopian garden city',
  'theme-park': 'a sprawling theme park packed with looping roller coasters',
  zoo: 'a sprawling zoo with radiating animal enclosures and winding paths',
  'rocket-launch': 'a retrofuturistic rocket-launch complex with a towering gantry',
  'raver-arena': 'a vast neon raver arena with lasers and geometric dance floors',
  'ferris-wheel': 'a giant illuminated Ferris wheel surrounded by fairground rides',
  aquarium: 'a monumental aquarium with a central glass dome and branching tanks',
  'water-park': 'a sprawling water park with twisting slides and turquoise pools',
  'race-circuit': 'a motor-racing circuit with grandstands, pit lanes, and hairpin turns',
  'medieval-castle': 'a sprawling medieval castle with concentric walls and courtyards',
  'pirate-harbour': 'a theatrical pirate harbour with ships, docks, and a crescent bay',
  'dinosaur-park': 'a dinosaur park with giant fossil-shaped exhibits and jungle paths',
  'film-backlot': 'a film-studio backlot with oversized sets and enormous sound stages',
  'ancient-temple': 'a monumental ancient temple complex with courtyards and colonnades',
  'japanese-garden': 'a formal Japanese garden with ponds, bridges, and winding paths',
  'maze-garden': 'a vast hedge maze surrounding a symmetrical garden pavilion',
  'floating-market': 'a busy floating market filled with boats, stalls, and canals',
  'spaceport': 'a futuristic spaceport with launch pads, terminals, and orbital shuttles',
  'solar-farm': 'a huge solar farm arranged in shimmering geometric fields',
  'wind-farm': 'a coastal wind farm with dozens of enormous turbines',
  'lunar-outpost': 'a lunar outpost with domes, rover tracks, and a rocket landing pad',
  'volcano-observatory': 'a dramatic volcano observatory overlooking a glowing crater',
} as const

export const atlasSeaScenes = new Set<keyof typeof atlasScenes>([
  'lighthouse',
  'pirate-harbour',
])

export const atlasSceneNames = Object.keys(atlasScenes) as Array<keyof typeof atlasScenes>

export type AtlasScene = keyof typeof atlasScenes

export const pickAtlasScene = (
  hasSea: boolean,
  excluded: Iterable<AtlasScene> = [],
): AtlasScene => {
  const candidates = hasSea
    ? atlasSceneNames
    : atlasSceneNames.filter(scene => !atlasSeaScenes.has(scene))
  const excludedSet = new Set(excluded)
  const unpicked = candidates.filter(scene => !excludedSet.has(scene))
  const available = unpicked.length ? unpicked : candidates
  return available[Math.floor(Math.random() * available.length)]
}
