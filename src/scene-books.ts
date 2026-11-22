import analyticalEngine from '../releases/sources/families/analytical-engine.json'
import anatomicalMuseum from '../releases/sources/families/anatomical-museum.json'
import archaeologicalExcavation from '../releases/sources/families/archaeological-excavation.json'
import artNouveauPalace from '../releases/sources/families/art-nouveau-palace.json'
import automata from '../releases/sources/families/automata.json'
import ancientTemple from '../releases/sources/families/backfill/ancient-temple.json'
import aquarium from '../releases/sources/families/backfill/aquarium.json'
import arcology from '../releases/sources/families/backfill/arcology.json'
import beerGarden from '../releases/sources/families/backfill/beer-garden.json'
import botanicalCity from '../releases/sources/families/backfill/botanical-city.json'
import dinosaurPark from '../releases/sources/families/backfill/dinosaur-park.json'
import festivalCity from '../releases/sources/families/backfill/festival-city.json'
import floatingCity from '../releases/sources/families/backfill/floating-city.json'
import floatingMarket from '../releases/sources/families/backfill/floating-market.json'
import giantFairground from '../releases/sources/families/backfill/giant-fairground.json'
import grandExhibition from '../releases/sources/families/backfill/grand-exhibition.json'
import ludditeRally from '../releases/sources/families/backfill/luddite-rally.json'
import lunarOutpost from '../releases/sources/families/backfill/lunar-outpost.json'
import medievalCastle from '../releases/sources/families/backfill/medieval-castle.json'
import raceCircuit from '../releases/sources/families/backfill/race-circuit.json'
import robotFactory from '../releases/sources/families/backfill/robot-factory.json'
import rocketLaunch from '../releases/sources/families/backfill/rocket-launch.json'
import shipyard from '../releases/sources/families/backfill/shipyard.json'
import spaceport from '../releases/sources/families/backfill/spaceport.json'
import steampunkCity from '../releases/sources/families/backfill/steampunk-city.json'
import volcanoObservatory from '../releases/sources/families/backfill/volcano-observatory.json'
import waterPark from '../releases/sources/families/backfill/water-park.json'
import windFarm from '../releases/sources/families/backfill/wind-farm.json'
import worldsFair from '../releases/sources/families/backfill/worlds-fair.json'
import balloonFestival from '../releases/sources/families/balloon-festival.json'
import botanicalLaboratory from '../releases/sources/families/botanical-laboratory.json'
import circus from '../releases/sources/families/circus.json'
import civicCentre from '../releases/sources/families/civic-centre.json'
import cyberDeckAlley from '../releases/sources/families/cyber-deck-alley.json'
import cloudLauncher from '../releases/sources/families/editorial/cloud-launcher.json'
import electricalLaboratory from '../releases/sources/families/electrical-laboratory.json'
import ferrisWheel from '../releases/sources/families/ferris-wheel.json'
import filmBacklot from '../releases/sources/families/film-backlot.json'
import grandLibrary from '../releases/sources/families/grand-library.json'
import hallOfMirrors from '../releases/sources/families/hall-of-mirrors.json'
import ironworks from '../releases/sources/families/ironworks.json'
import japaneseGarden from '../releases/sources/families/japanese-garden.json'
import marketQuarter from '../releases/sources/families/market-quarter.json'
import marshmallowFactory from '../releases/sources/families/marshmallow-factory.json'
import mazeGarden from '../releases/sources/families/maze-garden.json'
import mechanicalTheatre from '../releases/sources/families/mechanical-theatre.json'
import mesmeristSalon from '../releases/sources/families/mesmerist-salon.json'
import observatory from '../releases/sources/families/observatory.json'
import orreryHall from '../releases/sources/families/orrery-hall.json'
import photographyStudio from '../releases/sources/families/photography-studio.json'
import printworks from '../releases/sources/families/printworks.json'
import raverArena from '../releases/sources/families/raver-arena.json'
import riceSculptureFestival from '../releases/sources/families/rice-sculpture-festival.json'
import solarFarm from '../releases/sources/families/solar-farm.json'
import steamRailway from '../releases/sources/families/steam-railway.json'
import sushiRestaurant from '../releases/sources/families/sushi-restaurant.json'
import suspensionBridge from '../releases/sources/families/suspension-bridge.json'
import telegraphOffice from '../releases/sources/families/telegraph-office.json'
import textileMill from '../releases/sources/families/textile-mill.json'
import themePark from '../releases/sources/families/theme-park.json'
import thriftingParadise from '../releases/sources/families/thrifting-paradise.json'
import tropicalAquarium from '../releases/sources/families/tropical-aquarium.json'
import utopianGarden from '../releases/sources/families/utopian-garden.json'
import weatherStation from '../releases/sources/families/weather-station.json'
import zoo from '../releases/sources/families/zoo.json'

export const sceneBooks: Record<string, { name: string; prompt: string }[]> = {
  'analytical-engine': analyticalEngine,
  'anatomical-museum': anatomicalMuseum,
  'archaeological-excavation': archaeologicalExcavation,
  'art-nouveau-palace': artNouveauPalace,
  automata: automata,
  'ancient-temple': ancientTemple,
  aquarium: aquarium,
  arcology: arcology,
  'beer-garden': beerGarden,
  'botanical-city': botanicalCity,
  'dinosaur-park': dinosaurPark,
  'festival-city': festivalCity,
  'floating-city': floatingCity,
  'floating-market': floatingMarket,
  'giant-fairground': giantFairground,
  'grand-exhibition': grandExhibition,
  'luddite-rally': ludditeRally,
  'lunar-outpost': lunarOutpost,
  'medieval-castle': medievalCastle,
  'race-circuit': raceCircuit,
  'robot-factory': robotFactory,
  'rocket-launch': rocketLaunch,
  shipyard: shipyard,
  spaceport: spaceport,
  'steampunk-city': steampunkCity,
  'volcano-observatory': volcanoObservatory,
  'water-park': waterPark,
  'wind-farm': windFarm,
  'worlds-fair': worldsFair,
  'balloon-festival': balloonFestival,
  'botanical-laboratory': botanicalLaboratory,
  circus: circus,
  'civic-centre': civicCentre,
  'cyber-deck-alley': cyberDeckAlley,
  'cloud-launcher': cloudLauncher,
  'electrical-laboratory': electricalLaboratory,
  'ferris-wheel': ferrisWheel,
  'film-backlot': filmBacklot,
  'grand-library': grandLibrary,
  'hall-of-mirrors': hallOfMirrors,
  ironworks: ironworks,
  'japanese-garden': japaneseGarden,
  'market-quarter': marketQuarter,
  'marshmallow-factory': marshmallowFactory,
  'maze-garden': mazeGarden,
  'mechanical-theatre': mechanicalTheatre,
  'mesmerist-salon': mesmeristSalon,
  observatory: observatory,
  'orrery-hall': orreryHall,
  'photography-studio': photographyStudio,
  printworks: printworks,
  'raver-arena': raverArena,
  'rice-sculpture-festival': riceSculptureFestival,
  'solar-farm': solarFarm,
  'steam-railway': steamRailway,
  'sushi-restaurant': sushiRestaurant,
  'suspension-bridge': suspensionBridge,
  'telegraph-office': telegraphOffice,
  'textile-mill': textileMill,
  'theme-park': themePark,
  'thrifting-paradise': thriftingParadise,
  'tropical-aquarium': tropicalAquarium,
  'utopian-garden': utopianGarden,
  'weather-station': weatherStation,
  zoo: zoo,
}
