import { expect, test } from 'bun:test'
import { classifyFogEligibility } from './fog-eligibility.ts'

const layer = features => ({
  extent: 4096,
  length: features.length,
  feature: index => features[index],
})
const earth = {
  type: 3,
  properties: { 'saanseoi:base': true },
  loadGeometry: () => [
    [
      { x: 0, y: 0 },
      { x: 4096, y: 0 },
      { x: 4096, y: 4096 },
      { x: 0, y: 4096 },
    ],
  ],
}
const road = y => ({
  type: 2,
  properties: { kind: 'major_road' },
  loadGeometry: () => [
    [
      { x: -100, y },
      { x: 4200, y },
    ],
  ],
})
const classify = roads =>
  classifyFogEligibility(
    {
      layers: {
        earth: layer([earth]),
        roads: layer(roads),
      },
    },
    { zoom: 18, x: 0, y: 0 },
  )

test('preserves road coverage while excluding distant segments', () => {
  const result = classify([road(256), road(2000)])
  expect(result.landFraction).toBe(1)
  expect(result.streetFraction).toBe(4 / 128)
  expect(result.isTargetable).toBe(true)
})

test('includes a road outside the child when its stroke crosses the edge', () => {
  expect(classify([road(-4)]).streetFraction).toBe(1 / 128)
  expect(classify([road(-20)]).streetFraction).toBe(0)
})

test('accepts roads concentrated along one side but rejects a fragmented lattice', () => {
  const side = Array.from({length:9}, (_,i) => road(10+i*12))
  expect(classify(side).streetFraction).toBeGreaterThan(.2)
  expect(classify(side).isTargetable).toBe(true)
  const grid = Array.from({length:7},(_,i)=>road(32+i*64))
  grid.push(...Array.from({length:7},(_,i)=>({
    type:2, properties:{kind:'major_road'},
    loadGeometry:()=>[[{x:32+i*64,y:-100},{x:32+i*64,y:4200}]],
  })))
  expect(classify(grid).isTargetable).toBe(false)
  expect(classify(grid).usableFraction).toBeLessThan(.12)
})

test('allows a coastal strip but excludes open sea and inland water', () => {
  const water = (kind, edge) => ({type:3, properties:{kind}, loadGeometry:()=>[[
    {x:edge,y:0},{x:4096,y:0},{x:4096,y:4096},{x:edge,y:4096},
  ]]})
  const check = (kind, edge) => classifyFogEligibility({layers:{
    earth:layer([earth]), water:layer([water(kind,edge)]),
  }}, {zoom:18,x:0,y:0})
  expect(check('sea',102).isTargetable).toBe(true)
  expect(check('sea',0).isTargetable).toBe(false)
  expect(check('lake',102).isTargetable).toBe(false)
})

test('rejects a layout whose largest plot falls between 12 and 25 percent', () => {
  const result = classify([road(100),road(200),road(300),road(400)])
  expect(result.usableFraction).toBeGreaterThan(.12)
  expect(result.usableFraction).toBeLessThan(.25)
  expect(result.isTargetable).toBe(false)
})

test('a coastal site needs half the tile free after road cleanup', () => {
  const roads = [road(200), road(400)]
  const inland = classify(roads)
  const sea = {
    type: 3, properties: { kind: 'sea' },
    loadGeometry: () => [[{ x: 102, y: 0 }, { x: 4096, y: 0 }, { x: 4096, y: 4096 }, { x: 102, y: 4096 }]],
  }
  const coast = classifyFogEligibility(
    { layers: { earth: layer([earth]), water: layer([sea]), roads: layer(roads) } },
    { zoom: 18, x: 0, y: 0 },
  )
  expect(inland.isTargetable).toBe(true)
  expect(coast.usableFraction).toBe(inland.usableFraction)
  expect(coast.usableFraction).toBeLessThan(.5)
  expect(coast.isTargetable).toBe(false)
})
