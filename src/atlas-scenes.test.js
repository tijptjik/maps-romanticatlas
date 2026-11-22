import { expect, test } from 'bun:test'
import { atlasSeaScenes, atlasScenes, pickAtlasScene } from './atlas-scenes.ts'
import { atlasPrompt } from './atlas-prompt.ts'

test('coastal scenes stay water-connected even after all choices are exhausted', () => {
  expect(atlasSeaScenes.size).toBe(16)
  for (let i = 0; i < 30; i++) {
    expect(atlasSeaScenes.has(pickAtlasScene(true))).toBe(true)
    expect(atlasSeaScenes.has(pickAtlasScene(true, Object.keys(atlasScenes)))).toBe(
      true,
    )
    expect(atlasSeaScenes.has(pickAtlasScene(false))).toBe(false)
  }
  expect(atlasPrompt('pleasure-pier', true)).toContain(
    'out over the blue nearshore water zone',
  )
})
