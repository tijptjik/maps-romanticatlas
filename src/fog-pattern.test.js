import { expect, test } from 'bun:test'
import {
  defaultCloudCoverage,
  fogShapeSeed,
  isFogPatternSelected,
} from './fog-pattern.js'
import { cloudDraw, cloudSeed } from './cloud-seed.ts'

test('fog coverage and shapes use the fixed map seed', () => {
  expect(defaultCloudCoverage).toBe(0.75)
  let selected = 0
  for (let x = 214160; x < 214200; x++)
    for (let y = 114400; y < 114440; y++) {
      const tile = { x, y }
      expect(isFogPatternSelected(tile)).toBe(cloudDraw(cloudSeed, x, y, 0xc10d) < 0.75)
      expect(fogShapeSeed(tile)).toBe(cloudDraw(cloudSeed, x, y, 3) * 65536)
      selected += Number(isFogPatternSelected(tile))
    }
  expect(selected / 1600).toBeGreaterThan(0.7)
  expect(selected / 1600).toBeLessThan(0.8)
})
