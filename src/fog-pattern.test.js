import { expect, test } from 'bun:test'
import { defaultCloudCoverage, fogShapeSeed, isFogPatternSelected } from './fog-pattern.js'
import { cloudDraw, studyCloudSeed } from './study-cloud-seed.ts'

test('main map uses the same seeded 75% distribution and shapes as the experiment', () => {
  expect(defaultCloudCoverage).toBe(.75)
  let selected=0
  for(let x=214160;x<214200;x++)for(let y=114400;y<114440;y++){
    const tile={x,y},seed=studyCloudSeed(null)
    expect(isFogPatternSelected(tile)).toBe(cloudDraw(seed,x,y,0xc10d)<.75)
    expect(fogShapeSeed(tile)).toBe(cloudDraw(seed,x,y,3)*65536)
    selected+=Number(isFogPatternSelected(tile))
  }
  expect(selected/1600).toBeGreaterThan(.7)
  expect(selected/1600).toBeLessThan(.8)
})
