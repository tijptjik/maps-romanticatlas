import { expect, test } from 'bun:test'
import { availableFamilies, familyIndex, generationJob, scenesForFamily } from './generation-targets'
import { isFogPatternSelected } from './fog-pattern.js'

const tile = { zoom: 18, x: 214180, y: 114420, regionalLandAvailable: true, isTargetable: true,
  coastal: false, landFraction: 1, streetFraction: 0.1 }
while (!isFogPatternSelected(tile)) tile.x++

test('family spacing includes the target, diagonals, and every occupied footprint cell', () => {
  const index = familyIndex([
    { ...tile, title: scenesForFamily('circus')[1].name },
    { x: tile.x - 5, y: tile.y + 5, rows: 2, columns: 2, scene: 'automata' },
    { x: tile.x + 5, y: tile.y, scene: 'observatory' },
  ])
  const families = availableFamilies(tile, index)
  expect(families).not.toContain('circus')
  expect(families).not.toContain('automata')
  expect(families).toContain('observatory')
  expect(families).not.toContain('lighthouse')
  const chosen = scenesForFamily('observatory')[2]
  const job = generationJob({family: 'observatory', scene: chosen.name}, tile, [])
  expect(job?.source.title).toBe(chosen.name)
  expect(job?.prompt).toBe(chosen.prompt)
})

test('both selection paths fail closed on unavailable land and exhausted families', () => {
  const coast = {...tile, coastal: true}
  const occupied = availableFamilies(coast, familyIndex([])).map(scene => ({...tile, scene}))
  for (const choice of [{random: true}, {family: 'lighthouse', scene: 'Lighthouse'}]) {
    expect(generationJob(choice, coast, occupied)).toBeNull()
    expect(generationJob(choice, {...coast, isTargetable: false}, [])).toBeNull()
  }
  const only = occupied.filter(art => art.scene !== 'lighthouse')
  expect(generationJob({random: true}, coast, only)?.source.scene).toBe('lighthouse')
})
