export const atlasScenes = {
  circus: 'a Victorian circus',
  'balloon-festival': 'a balloon festival',
  'art-nouveau-palace': 'an elaborate Art Nouveau palace',

  ironworks: 'a glowing Victorian ironworks',
  'coal-mine': 'a Victorian coal mine with a pithead',
  'steam-railway': 'a grand Victorian steam railway terminus',
  'suspension-bridge': 'a monumental Victorian suspension bridge under construction',
  'canal-lock': 'a Victorian canal lock with steam barges',
  lighthouse: 'a Victorian lighthouse and signal station',

  'textile-mill': 'a vast Victorian textile mill',
  'luddite-rally': 'a secret gathering of Luddite machine-breakers',
  printworks: 'a bustling Victorian printing works',
  shipyard: 'a Victorian steamship shipyard',
  'telegraph-office': 'a Victorian telegraph office',
  'mutual-aid-hall': 'a workers’ mutual-aid hall',

  'magic-lantern': 'a Victorian magic-lantern theatre',
  panorama: 'a vast Victorian panorama rotunda',
  diorama: 'a Daguerre-style Victorian diorama pavilion',
  stereoscope: 'a Victorian stereoscope gallery',
  'photography-studio': 'an early Victorian photography studio',
  'mechanical-theatre': 'a Victorian mechanical theatre filled with automata',

  automata: 'an exhibition of uncanny Victorian automata',
  'anatomical-museum': 'a Victorian anatomical museum',
  'mesmerist-salon': 'a candlelit Victorian mesmerist salon',
  'hall-of-mirrors': 'a grand Victorian hall of mirrors',
  'botanical-laboratory': 'a Victorian botanical laboratory',
  'electrical-laboratory': 'an experimental Victorian electrical laboratory',

  observatory: 'a Victorian astronomical observatory',
  'weather-station': 'a Victorian meteorological station',
  'orrery-hall': 'a grand Victorian orrery and celestial-instrument hall',
  'analytical-engine': 'a workshop containing a Victorian analytical engine',
  'utopian-garden': 'an idealised Victorian utopian garden city',
} as const

export const atlasSceneNames = Object.keys(atlasScenes) as Array<keyof typeof atlasScenes>
