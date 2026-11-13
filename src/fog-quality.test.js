import { expect, test } from 'bun:test'
import { FogQuality } from './fog-quality.ts'

test('requires sustained pressure, bounds quality and recovers slowly', () => {
  const quality = new FogQuality()
  for (let i = 0; i < 20; i++) quality.sample(33, true)
  expect(quality.level).toBe(0)
  for (let i = 0; i < 180; i++) quality.sample(33, true)
  expect(quality.level).toBe(2)
  for (let i = 0; i < 400; i++) quality.sample(16, true)
  expect(quality.level).toBe(2)
  for (let i = 0; i < 100; i++) quality.sample(16, true)
  expect(quality.level).toBe(1)
  for (let i = 0; i < 500; i++) quality.sample(16, true)
  expect(quality.level).toBe(0)
})

test('ignores background time and isolated long loading stalls', () => {
  const quality = new FogQuality()
  for (let i = 0; i < 100; i++) quality.sample(100, false)
  quality.sample(3000, true)
  expect(quality.level).toBe(0)
})
