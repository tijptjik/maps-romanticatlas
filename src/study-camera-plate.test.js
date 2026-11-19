import { expect, test } from 'bun:test'
import { hasCameraRegistration } from './study-camera-plate.ts'

test('only completed, invertible camera registrations enter the experiment picker', () => {
  const anchor = (x, y) => ({ pixel: [x, y], lngLat: [114, 22] })
  expect(hasCameraRegistration([])).toBe(false)
  expect(hasCameraRegistration([anchor(0, 0), anchor(1, 1)])).toBe(false)
  expect(hasCameraRegistration([anchor(0, 0), anchor(1, 1), anchor(2, 2)])).toBe(false)
  expect(hasCameraRegistration([anchor(0, 0), anchor(1, 0), anchor(0, 1)])).toBe(true)
})
