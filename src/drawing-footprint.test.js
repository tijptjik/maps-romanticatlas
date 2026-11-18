import { test, expect } from 'bun:test'
import { drawingFootprint, tileBounds } from './tile-geometry.ts'

test('a six-tile drawing uses every cell and the full image bounds', () => {
  const { cells, bounds } = drawingFootprint({ x: 40, y: 80, tileSpan: { columns: 3, rows: 2 } })
  expect(cells).toEqual([
    { x: 40, y: 80 }, { x: 41, y: 80 }, { x: 42, y: 80 },
    { x: 40, y: 79 }, { x: 41, y: 79 }, { x: 42, y: 79 },
  ])
  expect(bounds).toEqual({
    ...tileBounds(cells[0]), north: tileBounds(cells[5]).north, east: tileBounds(cells[5]).east,
  })
})
