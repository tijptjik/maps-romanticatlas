import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { atlasSceneNames, type AtlasScene } from '../src/atlas-scenes.ts'

const sampleRate = 44_100
const duration = 2.35
const outputDirectory = 'public/atlas-audio'
const temporaryDirectory = '.tmp/atlas-audio'

type RecordedSource = {
  sourceUrl: string
  sourcePage: string
  title: string
  creator: string
  license?: string
  start?: number
  segments?: Array<[number, number]>
  loop?: boolean
}

const sourceRecordings: Record<string, RecordedSource> = {
  balloon: {
    sourceUrl: 'https://cdn.freesound.org/previews/243/243763_877079-lq.mp3',
    sourcePage: 'https://freesound.org/people/NickPeeters/sounds/243763/',
    title: 'gas vuur dakwerken gasbrander luchtballon.wav',
    creator: 'NickPeeters',
  },
  bubbles: {
    sourceUrl: 'https://cdn.freesound.org/previews/199/199538_93137-lq.mp3',
    sourcePage: 'https://freesound.org/people/wjoojoo/sounds/199538/',
    title: 'toy_bubbling_underwater.flac',
    creator: 'wjoojoo',
  },
  canal: {
    sourceUrl: 'https://cdn.freesound.org/previews/829/829021_13183432-lq.mp3',
    sourcePage: 'https://freesound.org/people/JW_Audio/sounds/829021/',
    title: 'WATRFlow Outdoor, Canal, Lock, Filling Water',
    creator: 'JW_Audio',
  },
  castle: {
    sourceUrl: 'https://cdn.freesound.org/previews/244/244519_2479316-lq.mp3',
    sourcePage: 'https://freesound.org/people/Cheeseheadburger/sounds/244519/',
    title: 'Hawk crows Headingley castle joust.wav',
    creator: 'Cheeseheadburger',
  },
  city: {
    sourceUrl: 'https://cdn.freesound.org/previews/578/578486_6911631-lq.mp3',
    sourcePage: 'https://freesound.org/people/PostProdDog/sounds/578486/',
    title: 'City Square Ambience',
    creator: 'PostProdDog',
  },
  clanking: {
    sourceUrl: 'https://cdn.freesound.org/previews/565/565602_11547868-lq.mp3',
    sourcePage: 'https://freesound.org/people/Ntar10/sounds/565602/',
    title: 'Metallic_Clanking.mp3',
    creator: 'Ntar10',
    segments: [
      [2.48, 3.06],
      [4.94, 5.19],
      [7.62, 8.13],
      [8.94, 9.25],
      [11.68, 12.42],
    ],
  },
  clockwork: {
    sourceUrl: 'https://cdn.freesound.org/previews/641/641577_9813501-lq.mp3',
    sourcePage: 'https://freesound.org/people/apintofmild/sounds/641577/',
    title: 'Clockwork Timer 01',
    creator: 'apintofmild',
  },
  construction: {
    sourceUrl: 'https://cdn.freesound.org/previews/193/193351_2979997-lq.mp3',
    sourcePage: 'https://freesound.org/people/sengjinn/sounds/193351/',
    title: 'INDUSTRY CONSTRUCTION SITE 01.wav',
    creator: 'sengjinn',
  },
  digging: {
    sourceUrl: 'https://cdn.freesound.org/previews/451/451001_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/451001/',
    title: 'digging dirt ground and dried leaves with metal spades',
    creator: 'kyles',
  },
  dinosaur: {
    sourceUrl: 'https://cdn.freesound.org/previews/810/810951_3797507-lq.mp3',
    sourcePage: 'https://freesound.org/people/Logicogonist/sounds/810951/',
    title: 'dinosaur roar 1',
    creator: 'Logicogonist',
  },
  debate: {
    sourceUrl: 'https://cdn.freesound.org/previews/537/537989_11926345-lq.mp3',
    sourcePage: 'https://freesound.org/people/Ambientsoundapp/sounds/537989/',
    title: 'Argument.wav',
    creator: 'Ambientsoundapp',
  },
  electricity: {
    sourceUrl: 'https://cdn.freesound.org/previews/522/522690_11584853-lq.mp3',
    sourcePage: 'https://freesound.org/people/julianmateo_/sounds/522690/',
    title: 'Electricity, Arcs, Sparks, long',
    creator: 'julianmateo_',
  },
  exhibition: {
    sourceUrl: 'https://cdn.freesound.org/previews/842/842242_15636277-lq.mp3',
    sourcePage: 'https://freesound.org/people/bassimat/sounds/842242/',
    title: 'Voices - Biennale Exhibition Venice 2025',
    creator: 'bassimat',
  },
  factory: {
    sourceUrl: 'https://cdn.freesound.org/previews/412/412204_1784475-lq.mp3',
    sourcePage: 'https://freesound.org/people/editboy23/sounds/412204/',
    title: 'Factory with Robotic arm movements and metal sounds',
    creator: 'editboy23',
  },
  fallingRice: {
    sourceUrl: 'https://cdn.freesound.org/previews/838/838989_15636277-lq.mp3',
    sourcePage: 'https://freesound.org/people/bassimat/sounds/838989/',
    title: 'Pouring Rice on the Floor - Biennale Exhibition Venice 2025',
    creator: 'bassimat',
  },
  fairground: {
    sourceUrl: 'https://cdn.freesound.org/previews/635/635159_12863902-lq.mp3',
    sourcePage: 'https://freesound.org/people/HECKFRICKER/sounds/635159/',
    title: 'Fairground Ambience',
    creator: 'HECKFRICKER',
  },
  festival: {
    sourceUrl: 'https://cdn.freesound.org/previews/451/451445_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/451445/',
    title: 'Ganpati street festival large exterior crowd',
    creator: 'kyles',
  },
  fishMarket: {
    sourceUrl: 'https://cdn.freesound.org/previews/451/451392_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/451392/',
    title: 'fishermen busy pier near fish market shouting voices',
    creator: 'kyles',
  },
  fishJump: {
    sourceUrl: 'https://cdn.freesound.org/previews/507/507092_8682843-lq.mp3',
    sourcePage: 'https://freesound.org/people/paulprit/sounds/507092/',
    title: 'Fish Jumping Splash 1.wav',
    creator: 'paulprit',
  },
  foghorn: {
    sourceUrl: 'https://cdn.freesound.org/previews/477/477643_1481531-lq.mp3',
    sourcePage: 'https://freesound.org/people/richwise/sounds/477643/',
    title: 'Foggy morning at Weston Shore',
    creator: 'richwise',
  },
  garden: {
    sourceUrl: 'https://cdn.freesound.org/previews/637/637582_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/637582/',
    title: 'garden afternoon light birds crickets fountain water',
    creator: 'kyles',
  },
  grinding: {
    sourceUrl: 'https://cdn.freesound.org/previews/812/812360_14865205-lq.mp3',
    sourcePage: 'https://freesound.org/people/giuliorasi/sounds/812360/',
    title: 'Rail Grinding Machine with Rythmic Clang Berlin Night',
    creator: 'giuliorasi',
  },
  harbour: {
    sourceUrl: 'https://cdn.freesound.org/previews/328/328808_3474310-lq.mp3',
    sourcePage: 'https://freesound.org/people/ivolipa/sounds/328808/',
    title: 'Harbour Seagulls Day.WAV',
    creator: 'ivolipa',
  },
  jungle: {
    sourceUrl: 'https://cdn.freesound.org/previews/537/537793_2282212-lq.mp3',
    sourcePage: 'https://freesound.org/people/szegvari/sounds/537793/',
    title: 'Alien World Jungle Creatures Sci-fi SFX Ambience',
    creator: 'szegvari',
  },
  lion: {
    sourceUrl: 'https://cdn.freesound.org/previews/611/611721_13511310-lq.mp3',
    sourcePage: 'https://freesound.org/people/_justMonke_/sounds/611721/',
    title: 'Big Lion Roar',
    creator: '_justMonke_',
  },
  loom: {
    sourceUrl: 'https://cdn.freesound.org/previews/510/510266_8371354-lq.mp3',
    sourcePage: 'https://freesound.org/people/Na%C3%AFma/sounds/510266/',
    title: 'navette de métier à tisser.wav',
    creator: 'Naïma',
  },
  market: {
    sourceUrl: 'https://cdn.freesound.org/previews/659/659634_12458758-lq.mp3',
    sourcePage: 'https://freesound.org/people/ilmari_freesound/sounds/659634/',
    title: '2022-11-12-binaural-london-market-ambience.wav',
    creator: 'ilmari_freesound',
  },
  morse: {
    sourceUrl: 'https://cdn.freesound.org/previews/443/443014_2465261-lq.mp3',
    sourcePage: 'https://freesound.org/people/univ_lyon3/sounds/443014/',
    title: 'AGUILLON Anastasia MorseCode.wav',
    creator: 'univ_lyon3',
  },
  museum: {
    sourceUrl: 'https://cdn.freesound.org/previews/478/478368_2337290-lq.mp3',
    sourcePage: 'https://freesound.org/people/ecfike/sounds/478368/',
    title: 'Museum Gallery, Children in Other Room',
    creator: 'ecfike',
  },
  nightclub: {
    sourceUrl: 'https://cdn.freesound.org/previews/178/178016_706234-lq.mp3',
    sourcePage: 'https://freesound.org/people/LampEight/sounds/178016/',
    title: 'NightclubEntrance_quiet',
    creator: 'LampEight',
  },
  pirate: {
    sourceUrl: 'https://cdn.freesound.org/previews/476/476325_6832358-lq.mp3',
    sourcePage: 'https://freesound.org/people/JD_Brick_Productions/sounds/476325/',
    title: 'pirate Arr! 2',
    creator: 'JD_Brick_Productions',
    loop: true,
  },
  press: {
    sourceUrl: 'https://cdn.freesound.org/previews/405/405009_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/405009/',
    title: 'printing press machine start running slow and fast',
    creator: 'kyles',
  },
  projector: {
    sourceUrl: 'https://cdn.freesound.org/previews/412/412145_3821443-lq.mp3',
    sourcePage: 'https://freesound.org/people/Stefan021/sounds/412145/',
    title: 'Film Projector - Long Run with Finish',
    creator: 'Stefan021',
  },
  protest: {
    sourceUrl: 'https://cdn.freesound.org/previews/686/686012_10097853-lq.mp3',
    sourcePage: 'https://freesound.org/people/Mathias.Arrignon/sounds/686012/',
    title: 'Protest cortege with crowd and percussion fanfare',
    creator: 'Mathias.Arrignon',
  },
  race: {
    sourceUrl: 'https://cdn.freesound.org/previews/701/701101_7066879-lq.mp3',
    sourcePage: 'https://freesound.org/people/jumpbug99/sounds/701101/',
    title: 'Racing Car Roar.wav',
    creator: 'jumpbug99',
  },
  rocket: {
    sourceUrl: 'https://cdn.freesound.org/previews/803/803852_13017680-lq.mp3',
    sourcePage: 'https://freesound.org/people/Sanderboah/sounds/803852/',
    title: 'Rocket launch',
    creator: 'Sanderboah',
  },
  robot: {
    sourceUrl: 'https://cdn.freesound.org/previews/505/505670_9159316-lq.mp3',
    sourcePage: 'https://freesound.org/people/Breviceps/sounds/505670/',
    title: 'Robot / Mech movement',
    creator: 'Breviceps',
    loop: true,
  },
  shipyard: {
    sourceUrl: 'https://cdn.freesound.org/previews/831/831634_1787516-lq.mp3',
    sourcePage: 'https://freesound.org/people/WattnotSounds/sounds/831634/',
    title: 'Shipyard Construction Ambience – Saint-Nazaire',
    creator: 'WattnotSounds',
  },
  shutter: {
    sourceUrl: 'https://cdn.freesound.org/previews/579/579884_2391840-lq.mp3',
    sourcePage: 'https://freesound.org/people/yfjesse/sounds/579884/',
    title: 'Yunon YN500 Camera Shutter',
    creator: 'yfjesse',
  },
  space: {
    sourceUrl: 'https://cdn.freesound.org/previews/174/174450_746632-lq.mp3',
    sourcePage: 'https://freesound.org/people/Sonicfreak/sounds/174450/',
    title: 'Space Ambience.wav',
    creator: 'Sonicfreak',
  },
  sushiWelcome: {
    sourceUrl: 'https://cdn.freesound.org/previews/364/364897_179538-lq.mp3',
    sourcePage: 'https://freesound.org/people/RutgerMuller/sounds/364897/',
    title: 'Japan_Tokyo_Shinjuku_Street_Promoter_Yelling_City.wav',
    creator: 'RutgerMuller',
  },
  steam: {
    sourceUrl: 'https://cdn.freesound.org/previews/593/593088_6456158-lq.mp3',
    sourcePage: 'https://freesound.org/people/FunWithSound/sounds/593088/',
    title: 'Train Passing By with Bells, Horn, Screeching, Steam',
    creator: 'FunWithSound',
  },
  temple: {
    sourceUrl: 'https://cdn.freesound.org/previews/131/131348_1513948-lq.mp3',
    sourcePage: 'https://freesound.org/people/nahmandub/sounds/131348/',
    title: 'Bell at Daitokuji temple, Kyoto.wav',
    creator: 'nahmandub',
  },
  volcano: {
    sourceUrl: 'https://cdn.freesound.org/previews/217/217657_950925-lq.mp3',
    sourcePage: 'https://freesound.org/people/Reitanna/sounds/217657/',
    title: 'earth rumble.wav',
    creator: 'Reitanna',
  },
  water: {
    sourceUrl: 'https://cdn.freesound.org/previews/333/333223_2364707-lq.mp3',
    sourcePage: 'https://freesound.org/people/gladkiy/sounds/333223/',
    title: 'Borneo rain forest ambience near a water stream',
    creator: 'gladkiy',
  },
  weather: {
    sourceUrl: 'https://cdn.freesound.org/previews/400/400988_3798635-lq.mp3',
    sourcePage: 'https://freesound.org/people/Techienanna/sounds/400988/',
    title: 'Rain with thunder.wav',
    creator: 'Techienanna',
  },
  wind: {
    sourceUrl: 'https://cdn.freesound.org/previews/706/706416_1661766-lq.mp3',
    sourcePage: 'https://freesound.org/people/felix.blume/sounds/706416/',
    title: 'House garden ambience with muffled wind',
    creator: 'felix.blume',
  },
  arcologyCity: {
    sourceUrl: 'https://cdn.freesound.org/previews/727/727078_8378872-lq.mp3',
    sourcePage: 'https://freesound.org/people/Simonus18/sounds/727078/',
    title: 'Blade Runner ambient 03 - vehicles outside the streets',
    creator: 'Simonus18',
  },
  frenchParty: {
    sourceUrl: 'https://cdn.freesound.org/previews/718/718568_11519060-lq.mp3',
    sourcePage: 'https://freesound.org/people/bruno.auzet/sounds/718568/',
    title: 'crowded small french bar',
    creator: 'bruno.auzet',
  },
  arabicBazaar: {
    sourceUrl: 'https://cdn.freesound.org/previews/511/511005_571436-lq.mp3',
    sourcePage: 'https://freesound.org/people/3bagbrew/sounds/511005/',
    title: 'Khan El Khalili bazaar .wav',
    creator: '3bagbrew',
    start: 0.8,
  },
  astronomicalClock: {
    sourceUrl: 'https://cdn.freesound.org/previews/550/550851_3662372-lq.mp3',
    sourcePage: 'https://freesound.org/people/SoundEnsemble/sounds/550851/',
    title: 'OLOMUC Astronomical Clock Olomuc main square at noon.wav',
    creator: 'SoundEnsemble',
  },
  botanicalGarden: {
    sourceUrl: 'https://cdn.freesound.org/previews/426/426570_2355118-lq.mp3',
    sourcePage: 'https://freesound.org/people/nyoz/sounds/426570/',
    title: 'Singapore Botanic Gardens - Ambiance',
    creator: 'nyoz',
  },
  beerGarden: {
    sourceUrl: 'https://cdn.freesound.org/previews/767/767554_2337062-lq.mp3',
    sourcePage: 'https://freesound.org/people/henner1964/sounds/767554/',
    title: '240908-city-murmur-biergarten-river-weser',
    creator: 'henner1964',
  },
  bladeRunnerHarmony: {
    sourceUrl: 'https://cdn.freesound.org/previews/260/260985_4434608-lq.mp3',
    sourcePage: 'https://freesound.org/people/Andy_de_Rue/sounds/260985/',
    title: 'Blade_Runners_Harmony.MP3',
    creator: 'Andy_de_Rue',
  },
  carousel: {
    sourceUrl: 'https://cdn.freesound.org/previews/474/474195_5474387-lq.mp3',
    sourcePage: 'https://freesound.org/people/OneTwo_BER/sounds/474195/',
    title: 'carousel_brighton.wav',
    creator: 'OneTwo_BER',
  },
  circus: {
    sourceUrl: 'https://cdn.freesound.org/previews/448/448105_2188-lq.mp3',
    sourcePage: 'https://freesound.org/people/balloonhead/sounds/448105/',
    title: 'circus-normal.wav',
    creator: 'balloonhead',
  },
  dreamyAmbience: {
    sourceUrl: 'https://cdn.freesound.org/previews/663/663789_3674972-lq.mp3',
    sourcePage: 'https://freesound.org/people/AquantiuM/sounds/663789/',
    title: 'mysterious_dreamy_ambience_18392.wav',
    creator: 'AquantiuM',
  },
  clock: {
    sourceUrl: 'https://cdn.freesound.org/previews/171/171043_2449563-lq.mp3',
    sourcePage: 'https://freesound.org/people/ST303/sounds/171043/',
    title: 'Mechanical alarm clock is ticking (SLAVA).wav',
    creator: 'ST303',
  },
  fairgroundRides: {
    sourceUrl: 'https://cdn.freesound.org/previews/269/269246_4050773-lq.mp3',
    sourcePage: 'https://freesound.org/people/sapjjr/sounds/269246/',
    title: 'Theme Park Terra Mittica Benidorm.WAV',
    creator: 'sapjjr',
  },
  greenhouse: {
    sourceUrl: 'https://cdn.freesound.org/previews/725/725603_15753134-lq.mp3',
    sourcePage: 'https://freesound.org/people/WhiteNoiseSleeper/sounds/725603/',
    title: 'Rain Falling On The Greenhouse',
    creator: 'WhiteNoiseSleeper',
  },
  hall: {
    sourceUrl: 'https://cdn.freesound.org/previews/506/506454_2247456-lq.mp3',
    sourcePage: 'https://freesound.org/people/Kinoton/sounds/506454/',
    title: 'Sports Hall Ambience, Walla',
    creator: 'Kinoton',
  },
  hospital: {
    sourceUrl: 'https://cdn.freesound.org/previews/348/348110_2364707-lq.mp3',
    sourcePage: 'https://freesound.org/people/gladkiy/sounds/348110/',
    title: 'Suburban hospital ambience - Moscow region',
    creator: 'gladkiy',
  },
  japaneseGarden: {
    sourceUrl: 'https://cdn.freesound.org/previews/107/107226_1848966-lq.mp3',
    sourcePage: 'https://freesound.org/people/keithpeter/sounds/107226/',
    title: 'water-spout-japanese-garden-botanical-gardens.wav',
    creator: 'keithpeter',
  },
  mazeGarden: {
    sourceUrl: 'https://cdn.freesound.org/previews/399/399865_7553603-lq.mp3',
    sourcePage: 'https://freesound.org/people/chromakei/sounds/399865/',
    title: 'Denver Botanic Gardens eveningtime insects',
    creator: 'chromakei',
  },
  moon: {
    sourceUrl: 'https://cdn.freesound.org/previews/832/832832_17247322-lq.mp3',
    sourcePage: 'https://freesound.org/people/sounds_from_palestine/sounds/832832/',
    title: 'Family Astronomy Night in Ramallah – Saturn and Moon Observation',
    creator: 'sounds_from_palestine',
  },
  oneSmallStep: {
    sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/3e/One_Small_Step_-_NASA.webm',
    sourcePage: 'https://commons.wikimedia.org/wiki/File:One_Small_Step_-_NASA.webm',
    title: 'One Small Step',
    creator: 'NASA',
    license: 'Public domain (NASA)',
    start: 0.9,
  },
  observatory: {
    sourceUrl: 'https://cdn.freesound.org/previews/785/785121_13973196-lq.mp3',
    sourcePage: 'https://freesound.org/people/Vrymaa/sounds/785121/',
    title: 'Astronomy Instrument - Rattle',
    creator: 'Vrymaa',
  },
  rave: {
    sourceUrl: 'https://cdn.freesound.org/previews/607/607876_2282212-lq.mp3',
    sourcePage: 'https://freesound.org/people/szegvari/sounds/607876/',
    title: 'Dj Club Crowd Party Atmo Peoples Reverb DeeJay Dance Mix',
    creator: 'szegvari',
  },
  river: {
    sourceUrl: 'https://cdn.freesound.org/previews/194/194437_2737063-lq.mp3',
    sourcePage: 'https://freesound.org/people/peridactyloptrix/sounds/194437/',
    title: 'City river ambience 2 (chatter)',
    creator: 'peridactyloptrix',
  },
  salon: {
    sourceUrl: 'https://cdn.freesound.org/previews/143/143904_1267745-lq.mp3',
    sourcePage: 'https://freesound.org/people/cormi/sounds/143904/',
    title: 'elderly_meeting.wav',
    creator: 'cormi',
  },
  solar: {
    sourceUrl: 'https://cdn.freesound.org/previews/637/637511_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/637511/',
    title: 'electric crackle buzz high tension powerline hydro dam',
    creator: 'kyles',
  },
  steampunk: {
    sourceUrl: 'https://cdn.freesound.org/previews/453/453462_612689-lq.mp3',
    sourcePage: 'https://freesound.org/people/kyles/sounds/453462/',
    title: 'industrial steam pipes hiss hum',
    creator: 'kyles',
  },
  waterPark: {
    sourceUrl: 'https://cdn.freesound.org/previews/333/333223_2364707-lq.mp3',
    sourcePage: 'https://freesound.org/people/gladkiy/sounds/333223/',
    title: 'Borneo rain forest ambience near a water stream',
    creator: 'gladkiy',
  },
  worldFair: {
    sourceUrl: 'https://cdn.freesound.org/previews/516/516660_3662372-lq.mp3',
    sourcePage: 'https://freesound.org/people/SoundEnsemble/sounds/516660/',
    title: 'DELHI ATMO World Book Fair inside indoor crowd',
    creator: 'SoundEnsemble',
  },
  windTurbine: {
    sourceUrl: 'https://cdn.freesound.org/previews/648/648493_1433145-lq.mp3',
    sourcePage: 'https://freesound.org/people/nicola_ariutti/sounds/648493/',
    title: 'wind_turbine',
    creator: 'nicola_ariutti',
  },
}

const recordedScenes: Record<AtlasScene, keyof typeof sourceRecordings> = {
  circus: 'circus',
  'balloon-festival': 'balloon',
  'art-nouveau-palace': 'frenchParty',
  ironworks: 'clanking',
  'steam-railway': 'steam',
  'suspension-bridge': 'construction',
  'canal-lock': 'canal',
  lighthouse: 'foghorn',
  'textile-mill': 'loom',
  'luddite-rally': 'protest',
  printworks: 'press',
  shipyard: 'shipyard',
  'telegraph-office': 'morse',
  'photography-studio': 'shutter',
  'mechanical-theatre': 'clockwork',
  automata: 'clock',
  'anatomical-museum': 'hospital',
  'mesmerist-salon': 'salon',
  'hall-of-mirrors': 'hall',
  'botanical-laboratory': 'greenhouse',
  'electrical-laboratory': 'electricity',
  'tropical-aquarium': 'fishJump',
  'sushi-restaurant': 'sushiWelcome',
  'thrifting-paradise': 'market',
  'beer-garden': 'beerGarden',
  'grand-library': 'museum',
  'rice-sculpture-festival': 'fallingRice',
  'cyber-deck-alley': 'bladeRunnerHarmony',
  'marshmallow-factory': 'dreamyAmbience',
  observatory: 'observatory',
  'weather-station': 'weather',
  'orrery-hall': 'astronomicalClock',
  'analytical-engine': 'grinding',
  'utopian-garden': 'garden',
  'theme-park': 'fairgroundRides',
  zoo: 'lion',
  'rocket-launch': 'rocket',
  'raver-arena': 'rave',
  'ferris-wheel': 'carousel',
  aquarium: 'bubbles',
  'water-park': 'waterPark',
  'race-circuit': 'race',
  'medieval-castle': 'castle',
  'pirate-harbour': 'pirate',
  'dinosaur-park': 'dinosaur',
  'film-backlot': 'projector',
  'ancient-temple': 'temple',
  'japanese-garden': 'japaneseGarden',
  'maze-garden': 'mazeGarden',
  'floating-market': 'fishMarket',
  spaceport: 'space',
  'solar-farm': 'solar',
  'wind-farm': 'windTurbine',
  'lunar-outpost': 'oneSmallStep',
  'volcano-observatory': 'volcano',
  'grand-exhibition': 'exhibition',
  'market-quarter': 'arabicBazaar',
  'steampunk-city': 'steampunk',
  'civic-centre': 'debate',
  'worlds-fair': 'worldFair',
  'floating-city': 'river',
  arcology: 'arcologyCity',
  'robot-factory': 'robot',
  'festival-city': 'festival',
  'giant-fairground': 'fairground',
  'botanical-city': 'botanicalGarden',
  'archaeological-excavation': 'digging',
}

type Profile =
  | 'calliope'
  | 'balloon'
  | 'glass'
  | 'forge'
  | 'steam'
  | 'water'
  | 'bell'
  | 'loom'
  | 'rally'
  | 'press'
  | 'morse'
  | 'shutter'
  | 'clockwork'
  | 'candle'
  | 'electric'
  | 'celestial'
  | 'garden'
  | 'fairground'
  | 'wildlife'
  | 'rocket'
  | 'neon'
  | 'engine'
  | 'castle'
  | 'harbour'
  | 'jungle'
  | 'cinema'
  | 'temple'
  | 'market'
  | 'space'
  | 'wind'
  | 'volcano'
  | 'exhibition'
  | 'city'
  | 'excavation'

const profiles: Record<AtlasScene, Profile> = {
  circus: 'calliope',
  'balloon-festival': 'balloon',
  'art-nouveau-palace': 'glass',
  ironworks: 'forge',
  'steam-railway': 'steam',
  'suspension-bridge': 'forge',
  'canal-lock': 'water',
  lighthouse: 'bell',
  'textile-mill': 'loom',
  'luddite-rally': 'rally',
  printworks: 'press',
  shipyard: 'harbour',
  'telegraph-office': 'morse',
  'photography-studio': 'shutter',
  'mechanical-theatre': 'clockwork',
  automata: 'clockwork',
  'anatomical-museum': 'candle',
  'mesmerist-salon': 'candle',
  'hall-of-mirrors': 'glass',
  'botanical-laboratory': 'garden',
  'electrical-laboratory': 'electric',
  'tropical-aquarium': 'water',
  'sushi-restaurant': 'market',
  'thrifting-paradise': 'market',
  'beer-garden': 'garden',
  'grand-library': 'candle',
  'rice-sculpture-festival': 'fairground',
  'cyber-deck-alley': 'neon',
  'marshmallow-factory': 'engine',
  observatory: 'celestial',
  'weather-station': 'wind',
  'orrery-hall': 'celestial',
  'analytical-engine': 'engine',
  'utopian-garden': 'garden',
  'theme-park': 'fairground',
  zoo: 'wildlife',
  'rocket-launch': 'rocket',
  'raver-arena': 'neon',
  'ferris-wheel': 'fairground',
  aquarium: 'water',
  'water-park': 'water',
  'race-circuit': 'engine',
  'medieval-castle': 'castle',
  'pirate-harbour': 'harbour',
  'dinosaur-park': 'jungle',
  'film-backlot': 'cinema',
  'ancient-temple': 'temple',
  'japanese-garden': 'garden',
  'maze-garden': 'garden',
  'floating-market': 'market',
  spaceport: 'space',
  'solar-farm': 'celestial',
  'wind-farm': 'wind',
  'lunar-outpost': 'space',
  'volcano-observatory': 'volcano',
  'grand-exhibition': 'exhibition',
  'market-quarter': 'market',
  'steampunk-city': 'city',
  'civic-centre': 'exhibition',
  'worlds-fair': 'exhibition',
  'floating-city': 'water',
  arcology: 'city',
  'robot-factory': 'engine',
  'festival-city': 'fairground',
  'giant-fairground': 'fairground',
  'botanical-city': 'garden',
  'archaeological-excavation': 'excavation',
}

const hash = (value: string) => {
  let result = 2_166_136_261
  for (const character of value) {
    result ^= character.charCodeAt(0)
    result = Math.imul(result, 16_777_619)
  }
  return result >>> 0
}

const random = (seed: number) => {
  let state = seed || 1
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const envelope = (time: number, start: number, length: number, attack = 0.02) => {
  const relative = time - start
  if (relative < 0 || relative > length) return 0
  const inLevel = Math.min(1, relative / attack)
  const outLevel = Math.min(1, (length - relative) / Math.min(0.18, length * 0.45))
  return inLevel * outLevel
}

const waveform = (phase: number, kind: 'sine' | 'triangle' | 'square' | 'saw') => {
  const cycle = phase / (Math.PI * 2)
  if (kind === 'sine') return Math.sin(phase)
  if (kind === 'triangle') return (2 * Math.asin(Math.sin(phase))) / Math.PI
  if (kind === 'square') return Math.sin(phase) >= 0 ? 1 : -1
  return 2 * (cycle - Math.floor(cycle + 0.5))
}

const addTone = (
  samples: Float32Array,
  frequency: number,
  start: number,
  length: number,
  volume: number,
  kind: 'sine' | 'triangle' | 'square' | 'saw' = 'sine',
  vibrato = 0,
) => {
  const first = Math.max(0, Math.floor(start * sampleRate))
  const last = Math.min(samples.length, Math.ceil((start + length) * sampleRate))
  for (let index = first; index < last; index += 1) {
    const time = index / sampleRate
    const wobble = vibrato ? Math.sin(time * Math.PI * 2 * 5.2) * vibrato : 0
    samples[index] +=
      waveform((time - start) * Math.PI * 2 * frequency * (1 + wobble), kind) *
      envelope(time, start, length) *
      volume
  }
}

const addBell = (
  samples: Float32Array,
  frequency: number,
  start: number,
  volume: number,
) => {
  ;[1, 2.01, 2.71, 4.08].forEach((partial, index) => {
    addTone(
      samples,
      frequency * partial,
      start,
      1.5 - index * 0.18,
      volume / (1 + index * 1.4),
    )
  })
}

const addNoise = (
  samples: Float32Array,
  start: number,
  length: number,
  volume: number,
  seed: number,
  brightness = 0.5,
) => {
  const next = random(seed)
  const first = Math.max(0, Math.floor(start * sampleRate))
  const last = Math.min(samples.length, Math.ceil((start + length) * sampleRate))
  let filtered = 0
  let previous = 0
  // Keep texture behind the recognisable motif. The earlier high-frequency
  // layer made too many otherwise unrelated scenes read as escaping steam.
  const smoothing = 0.018 + (1 - brightness) * 0.28
  for (let index = first; index < last; index += 1) {
    const white = next() * 2 - 1
    filtered += (white - filtered) * smoothing
    const high = (white - previous) * 0.12
    previous = white
    const value = filtered * (0.72 - brightness * 0.3) + high * brightness
    const time = index / sampleRate
    samples[index] += value * envelope(time, start, length, 0.05) * volume * 0.42
  }
}

const addPulse = (
  samples: Float32Array,
  frequency: number,
  start: number,
  volume: number,
) => {
  addTone(samples, frequency, start, 0.12, volume, 'triangle')
  addTone(samples, frequency * 0.48, start, 0.16, volume * 0.55, 'sine')
}

const _renderScene = (scene: AtlasScene) => {
  const samples = new Float32Array(Math.floor(sampleRate * duration))
  const seed = hash(scene)
  const next = random(seed)
  const base = 180 + Math.floor(next() * 120)
  const profile = profiles[scene]

  switch (profile) {
    case 'calliope':
      ;[0, 4, 7, 12, 7, 4].forEach(
        (semitones, index) =>
          void addTone(
            samples,
            base * 2 ** (semitones / 12),
            0.08 + index * 0.22,
            0.24,
            0.17,
            'saw',
            0.009,
          ),
      )
      addNoise(samples, 0.1, 1.4, 0.025, seed, 0.7)
      break
    case 'balloon':
      addNoise(samples, 0, 2.1, 0.12, seed, 0.72)
      ;[0, 4, 7, 12].forEach(
        (semitones, index) =>
          void addBell(samples, base * 2 ** (semitones / 12), 0.32 + index * 0.22, 0.1),
      )
      break
    case 'glass':
      ;[0, 7, 12, 16].forEach(
        (semitones, index) =>
          void addBell(
            samples,
            base * 2.2 * 2 ** (semitones / 12),
            0.14 + index * 0.17,
            0.09,
          ),
      )
      break
    case 'forge':
      ;[0.18, 0.56, 0.98].forEach((at, index) => {
        addPulse(samples, 72 + index * 12, at, 0.22)
        addNoise(samples, at, 0.13, 0.13, seed + index, 0.82)
      })
      addTone(samples, base * 0.42, 0.05, 1.45, 0.08, 'saw')
      break
    case 'steam':
      addNoise(samples, 0.08, 0.72, 0.06, seed, 0.38)
      addTone(samples, base * 2.25, 0.52, 0.9, 0.13, 'sine', 0.018)
      addTone(samples, base * 0.25, 0.08, 1.5, 0.11, 'triangle')
      break
    case 'water':
      addNoise(samples, 0, 2.15, 0.14, seed, 0.35)
      ;[0, 5, 9].forEach(
        (semitones, index) =>
          void addTone(
            samples,
            base * 1.4 * 2 ** (semitones / 12),
            0.35 + index * 0.33,
            0.42,
            0.07,
            'sine',
            0.025,
          ),
      )
      break
    case 'bell':
      addNoise(samples, 0, 2.1, 0.1, seed, 0.32)
      addBell(samples, base * 1.5, 0.25, 0.18)
      addBell(samples, base * 2, 0.94, 0.11)
      break
    case 'loom':
      for (let index = 0; index < 8; index += 1) {
        addPulse(samples, base * 0.28, 0.09 + index * 0.19, 0.09)
        if (index % 2 === 0)
          addNoise(samples, 0.1 + index * 0.19, 0.06, 0.055, seed + index, 0.9)
      }
      break
    case 'rally':
      ;[0.12, 0.46, 0.8].forEach((at, index) => {
        addPulse(samples, 65, at, 0.24)
        addNoise(samples, at, 0.2, 0.09, seed + index, 0.72)
      })
      break
    case 'press':
      ;[0.16, 0.58, 1.0, 1.42].forEach((at, index) => {
        addPulse(samples, 90, at, 0.16)
        addNoise(samples, at, 0.09, 0.09, seed + index, 0.9)
      })
      break
    case 'morse':
      ;[0.12, 0.28, 0.47, 0.78, 0.95, 1.12].forEach(
        (at, index) =>
          void addTone(samples, 740, at, index < 3 ? 0.08 : 0.2, 0.1, 'sine'),
      )
      addTone(samples, 92, 0.05, 1.5, 0.035, 'triangle')
      break
    case 'shutter':
      addNoise(samples, 0.16, 0.05, 0.24, seed, 0.95)
      addNoise(samples, 0.28, 0.08, 0.18, seed + 1, 0.88)
      addBell(samples, base * 2.8, 0.52, 0.08)
      break
    case 'clockwork':
      for (let index = 0; index < 9; index += 1) {
        addBell(samples, base * (index % 3 === 0 ? 2 : 1), 0.08 + index * 0.15, 0.045)
        addNoise(samples, 0.08 + index * 0.15, 0.035, 0.035, seed + index, 0.95)
      }
      break
    case 'candle':
      addNoise(samples, 0.05, 1.7, 0.05, seed, 0.18)
      addBell(samples, base * 1.15, 0.42, 0.09)
      addTone(samples, base * 0.5, 0.1, 1.55, 0.05, 'sine')
      break
    case 'electric':
      addNoise(samples, 0.05, 1.2, 0.09, seed, 0.92)
      ;[0.12, 0.41, 0.71, 1.05].forEach(
        (at, index) =>
          void addTone(samples, base * (2.7 + index * 0.25), at, 0.12, 0.12, 'square'),
      )
      break
    case 'celestial':
      ;[0, 7, 12, 19].forEach(
        (semitones, index) =>
          void addBell(
            samples,
            base * 1.6 * 2 ** (semitones / 12),
            0.16 + index * 0.24,
            0.1,
          ),
      )
      addTone(samples, base * 0.5, 0.05, 1.75, 0.045, 'sine')
      break
    case 'garden':
      addNoise(samples, 0.04, 1.75, 0.08, seed, 0.74)
      ;[0.25, 0.67, 1.16].forEach(
        (at, index) =>
          void addTone(
            samples,
            base * (2.6 + index * 0.45),
            at,
            0.13,
            0.1,
            'sine',
            0.025,
          ),
      )
      break
    case 'fairground':
      ;[0, 3, 7, 10, 12].forEach(
        (semitones, index) =>
          void addTone(
            samples,
            base * 2 ** (semitones / 12),
            0.1 + index * 0.19,
            0.2,
            0.12,
            'triangle',
            0.012,
          ),
      )
      break
    case 'wildlife':
      addNoise(samples, 0.06, 1.8, 0.07, seed, 0.78)
      ;[0.18, 0.55, 1.03].forEach(
        (at, index) =>
          void addTone(
            samples,
            base * (3 + index * 0.25),
            at,
            0.15,
            0.12,
            'sine',
            0.06,
          ),
      )
      break
    case 'rocket':
      addNoise(samples, 0.1, 1.25, 0.1, seed, 0.38)
      addTone(samples, base * 0.18, 0.08, 1.7, 0.19, 'saw')
      addTone(samples, base * 1.8, 0.38, 0.9, 0.09, 'sine', 0.03)
      break
    case 'neon':
      for (let index = 0; index < 7; index += 1) {
        addPulse(samples, base * 0.65, 0.1 + index * 0.17, 0.13)
      }
      addTone(samples, base * 3.2, 0.18, 1.05, 0.08, 'square', 0.02)
      break
    case 'engine':
      addTone(samples, base * 0.2, 0.06, 1.5, 0.17, 'saw', 0.022)
      ;[0.15, 0.47, 0.79, 1.11].forEach(
        (at, index) => void addPulse(samples, 66 + index * 7, at, 0.11),
      )
      break
    case 'castle':
      addBell(samples, base * 0.72, 0.22, 0.18)
      addBell(samples, base * 0.95, 0.92, 0.12)
      addTone(samples, base * 0.18, 0.05, 1.6, 0.08, 'triangle')
      break
    case 'harbour':
      addNoise(samples, 0.04, 2.05, 0.13, seed, 0.34)
      addTone(samples, base * 0.38, 0.35, 0.95, 0.14, 'sine', 0.015)
      addBell(samples, base * 0.8, 1.12, 0.1)
      break
    case 'jungle':
      addNoise(samples, 0.04, 1.9, 0.11, seed, 0.72)
      ;[0.18, 0.62, 1.05].forEach(
        (at, index) =>
          void addTone(
            samples,
            base * (1.9 + index * 0.35),
            at,
            0.2,
            0.13,
            'saw',
            0.04,
          ),
      )
      break
    case 'cinema':
      addNoise(samples, 0.05, 1.45, 0.07, seed, 0.62)
      ;[0, 4, 7, 12].forEach(
        (semitones, index) =>
          void addTone(
            samples,
            base * 2 ** (semitones / 12),
            0.16 + index * 0.2,
            0.32,
            0.09,
            'triangle',
          ),
      )
      break
    case 'temple':
      addBell(samples, base * 0.58, 0.14, 0.21)
      addTone(samples, base * 0.3, 0.1, 1.65, 0.07, 'sine')
      break
    case 'market':
      addNoise(samples, 0.04, 1.7, 0.12, seed, 0.72)
      ;[0, 4, 7].forEach(
        (semitones, index) =>
          void addTone(
            samples,
            base * 1.8 * 2 ** (semitones / 12),
            0.3 + index * 0.25,
            0.19,
            0.08,
            'triangle',
          ),
      )
      break
    case 'space':
      addTone(samples, base * 0.3, 0.08, 1.65, 0.1, 'sine', 0.014)
      ;[0, 7, 14].forEach(
        (semitones, index) =>
          void addBell(
            samples,
            base * 2.5 * 2 ** (semitones / 12),
            0.35 + index * 0.28,
            0.07,
          ),
      )
      break
    case 'wind':
      addNoise(samples, 0.03, 2.05, 0.18, seed, 0.62)
      addTone(samples, base * 0.45, 0.35, 0.9, 0.055, 'sine', 0.04)
      break
    case 'volcano':
      addTone(samples, base * 0.15, 0.06, 1.75, 0.23, 'saw')
      addNoise(samples, 0.18, 1.45, 0.16, seed, 0.38)
      addBell(samples, base * 0.8, 1.25, 0.07)
      break
    case 'exhibition':
      ;[0, 4, 7, 12].forEach(
        (semitones, index) =>
          void addBell(
            samples,
            base * 2 ** (semitones / 12),
            0.12 + index * 0.18,
            0.09,
          ),
      )
      addNoise(samples, 0.08, 1.35, 0.055, seed, 0.7)
      break
    case 'city':
      addTone(samples, base * 0.32, 0.05, 1.65, 0.1, 'saw')
      for (let index = 0; index < 6; index += 1)
        addPulse(samples, base * 0.48, 0.12 + index * 0.2, 0.07)
      addNoise(samples, 0.05, 1.6, 0.06, seed, 0.78)
      break
    case 'excavation':
      addNoise(samples, 0.08, 1.6, 0.12, seed, 0.3)
      ;[0.24, 0.74, 1.23].forEach(
        (at, index) => void addPulse(samples, 72 + index * 5, at, 0.14),
      )
      addBell(samples, base * 1.1, 1.28, 0.07)
      break
  }

  let peak = 0
  samples.forEach(value => {
    peak = Math.max(peak, Math.abs(value))
  })
  const gain = peak > 0 ? 0.62 / peak : 1
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => {
    pcm.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, value * gain)) * 32_767),
      index * 2,
    )
  })
  return pcm
}

const _encode = (inputPath: string, outputPath: string) => {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      inputPath,
      '-t',
      String(duration),
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-application',
      'audio',
      outputPath,
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`Could not encode ${outputPath}.`)
}

const recordedSourcePaths = new Map<string, string>()

const downloadRecordedSource = async (source: RecordedSource) => {
  const cached = recordedSourcePaths.get(source.sourceUrl)
  if (cached) return cached

  const response = await fetch(source.sourceUrl)
  if (!response.ok) throw new Error(`Could not download ${source.title}.`)
  const sourcePath = join(
    temporaryDirectory,
    `recording-${source.sourceUrl.split('/').at(-1)}`,
  )
  await writeFile(sourcePath, new Uint8Array(await response.arrayBuffer()))
  recordedSourcePaths.set(source.sourceUrl, sourcePath)
  return sourcePath
}

const clipRecordedScene = (
  inputPath: string,
  outputPath: string,
  { start = 0, segments, loop = false }: RecordedSource,
) => {
  const filter = segments
    ? `${segments
        .map(
          ([segmentStart, segmentEnd], index) =>
            `[0:a]atrim=start=${segmentStart}:end=${segmentEnd},asetpts=PTS-STARTPTS[clank${index}]`,
        )
        .join(';')};${segments.map((_, index) => `[clank${index}]`).join('')}concat=n=${segments.length}:v=0:a=1,afade=t=in:st=0:d=0.04,afade=t=out:st=2.1:d=0.25,loudnorm=I=-20:TP=-2:LRA=7[output]`
    : 'afade=t=in:st=0:d=0.04,afade=t=out:st=2.1:d=0.25,loudnorm=I=-20:TP=-2:LRA=7'
  const inputArguments = segments
    ? ['-i', inputPath, '-filter_complex', filter, '-map', '[output]']
    : [
        ...(loop ? ['-stream_loop', '-1'] : []),
        '-ss',
        String(start),
        '-i',
        inputPath,
        '-af',
        filter,
      ]
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...inputArguments,
      '-t',
      String(duration),
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-application',
      'audio',
      outputPath,
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`Could not clip ${outputPath}.`)
}

const thirdPartyNotices = () => {
  const backgroundTrack = '`public/atlas-audio/awestruck.ogg`'
  const rows = atlasSceneNames.map(scene => {
    const source = sourceRecordings[recordedScenes[scene]]
    return `| \`public/atlas-audio/${scene}.ogg\` | [${source.title}](${source.sourcePage}) | ${source.creator} | ${source.license ?? 'CC0 1.0'} |`
  })
  return `# Third-party audio notices

The background theme is a full, seamlessly looping CC0 track from OpenGameArt. Every
scene cue is a 2.35-second excerpt from public-domain material. Freesound
recordings are published under the
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) dedication;
the NASA recording is United States government public-domain material. The local Ogg
files are clipped and transcoded versions of the linked source recordings.

| Local track | Source | Creator | Licence |
| --- | --- | --- | --- |
| ${backgroundTrack} | [Awestruck](https://opengameart.org/content/awestruck) | isaiah658 | CC0 |

| Local cue | Source recording | Creator | Licence |
| --- | --- | --- | --- |
${rows.join('\n')}
`
}

await rm(temporaryDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await mkdir(temporaryDirectory, { recursive: true })

const requestedScenes = process.argv.slice(2)
const unknownScenes = requestedScenes.filter(
  scene => !atlasSceneNames.includes(scene as AtlasScene),
)
if (unknownScenes.length) {
  throw new Error(`Unknown scene cue(s): ${unknownScenes.join(', ')}`)
}
const selectedScenes = requestedScenes.length
  ? atlasSceneNames.filter(scene => requestedScenes.includes(scene))
  : atlasSceneNames
const uniqueRecordings = [...new Map(
  selectedScenes.map(scene => {
    const source = sourceRecordings[recordedScenes[scene]]
    return [source.sourceUrl, source]
  }),
).values()]
let nextRecording = 0
const downloadWorker = async () => {
  while (nextRecording < uniqueRecordings.length) {
    const source = uniqueRecordings[nextRecording]
    nextRecording += 1
    await downloadRecordedSource(source)
  }
}
await Promise.all(Array.from({ length: 4 }, downloadWorker))

for (const scene of selectedScenes) {
  const outputPath = join(outputDirectory, `${scene}.ogg`)
  const recorded = sourceRecordings[recordedScenes[scene]]
  const sourcePath = await downloadRecordedSource(recorded)
  clipRecordedScene(sourcePath, outputPath, recorded)
}

await rm(temporaryDirectory, { recursive: true, force: true })
await writeFile('THIRD_PARTY_NOTICES.md', thirdPartyNotices())
console.info(`Generated ${selectedScenes.length} scene cues in ${outputDirectory}.`)
