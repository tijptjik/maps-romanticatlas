import { expect, test } from 'bun:test'
import { isFogPatternSelected, fogShapeSeed } from './fog-pattern.js'

test('clouds cover about three quarters of the grid reproducibly', () => {
  let selected = 0
  for (let x = 0; x < 40; x++) {
    for (let y = 0; y < 40; y++) {
      const tile = { x, y }
      selected += Number(isFogPatternSelected(tile))
      expect(fogShapeSeed({ x, y })).toBe(fogShapeSeed(tile))
    }
  }
  expect(selected / 1600).toBeGreaterThan(.7)
  expect(selected / 1600).toBeLessThan(.8)
})
