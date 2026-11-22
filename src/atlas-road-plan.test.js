import { expect, test } from 'bun:test'
import { planAtlasRoads } from './atlas-road-plan.ts'

const bounds = { west: 0, east: 10, north: 10, south: 0 }
const road = (coordinates, properties = {}) => ({
  properties: { kind: 'major_road', ...properties },
  geometry: { type: 'LineString', coordinates },
})
const cross = [
  [5, 3],
  [5, 5],
  [5, 7],
]
const local = { kind: 'minor_road', kind_detail: 'service' }
const streets = [
  road([
    [2, 3],
    [5, 3],
    [8, 3],
  ]),
  road([
    [2, 7],
    [5, 7],
    [8, 7],
  ]),
  road([
    [2, 3],
    [2, 7],
  ]),
  road(cross, local),
]
test('reclaims the turn between two junctions and keeps both through lines intact', () => {
  const plan = planAtlasRoads(streets, bounds)
  expect(plan.removedPaths).toEqual([cross])
  expect(plan.retained.map(f => f.geometry)).toEqual(
    streets.slice(0, 3).map(f => f.geometry),
  )
})
test('protects links with no surface alternative, one-way routes and tile edges', () => {
  const check = features =>
    expect(planAtlasRoads(features, bounds).removedPaths).toEqual([])
  check(streets.filter((_, i) => i !== 2))
  for (const props of [{ is_bridge: true }, { oneway: 'yes' }, { is_tunnel: true }])
    check([
      ...streets.slice(0, 2),
      road(
        [
          [2, 3],
          [2, 7],
        ],
        props,
      ),
      streets[3],
    ])
  check([...streets.slice(0, 3), road(cross, { ...local, is_bridge: true })])
  expect(planAtlasRoads(streets, { ...bounds, north: 7 }).removedPaths).toEqual([])
})

test('reclaims a dead end to its junction while preserving the through road', () => {
  const main = road([
    [1, 5],
    [5, 5],
    [9, 5],
  ])
  const branch = road(
    [
      [5, 5],
      [5, 7],
      [6, 8],
    ],
    local,
  )
  const plan = planAtlasRoads([main, branch], bounds)
  expect(plan.removedPaths).toEqual([
    [
      [6, 8],
      [5, 7],
      [5, 5],
    ],
  ])
  expect(plan.retained.map(f => f.geometry)).toEqual([main.geometry])
  expect(
    planAtlasRoads(
      [
        main,
        road(
          [
            [5, 5],
            [5, 10],
          ],
          local,
        ),
      ],
      bounds,
    ).removedPaths,
  ).toEqual([])
})
