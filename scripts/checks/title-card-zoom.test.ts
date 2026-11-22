import { expect, test } from 'bun:test'
import { tileBounds } from '../../src/tile-geometry'
import { positionAtlasTitleCard } from '../../src/atlas-title-cards'

test('title cards keep their layout and shrink proportionally below the size cap', () => {
  const tile = { x: 0, y: 0 }
  const bounds = tileBounds(tile)
  const card = {
    offsetWidth: 166,
    offsetHeight: 50,
    style: {} as Record<string, string>,
  }
  for (const [tileWidth, expectedScale] of [
    [512, 1],
    [256, 1],
    [128, (128 * 0.8) / 166],
  ]) {
    const map = {
      project: ([lng, lat]) => ({
        x: ((lng - bounds.west) / (bounds.east - bounds.west)) * tileWidth,
        y: ((bounds.north - lat) / (bounds.north - bounds.south)) * tileWidth,
      }),
      getCanvas: () => ({ clientWidth: 960, clientHeight: 720 }),
    }
    positionAtlasTitleCard(map, card, tile, undefined)
    expect(Number(card.style.scale)).toBeCloseTo(expectedScale)
    expect(card.style.width).toBeUndefined()
    expect(parseFloat(card.style.left) + card.offsetWidth / 2).toBeCloseTo(
      tileWidth / 2,
    )
  }
})
