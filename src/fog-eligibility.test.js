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
