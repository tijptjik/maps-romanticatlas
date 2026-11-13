import { expect, test } from 'bun:test'
import { neighboringTiles } from './basemap-preload.ts'

test('warms the surrounding ring without visible tiles or duplicates', () => {
  const visible = [
    { z: 15, x: 26772, y: 14302 },
    { z: 15, x: 26773, y: 14302 },
  ]
  const ring = neighboringTiles(visible)
  expect(ring).toHaveLength(10)
  expect(new Set(ring.map(tile => JSON.stringify(tile))).size).toBe(10)
  for (const tile of visible) expect(ring).not.toContainEqual(tile)
})

test('does not request tiles outside the world', () => {
  expect(neighboringTiles([{ z: 1, x: 0, y: 0 }])).toHaveLength(3)
  expect(neighboringTiles([{ z: 0, x: 0, y: 0 }])).toEqual([])
})
