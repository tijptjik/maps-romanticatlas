import assert from 'node:assert/strict'
import { fromGeojsonVt } from '@maplibre/vt-pbf'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
if (!base || !process.env.DEV_RUNNER_ARTIFACTS) throw new Error('Use managed Chrome')
const road = (points, props = {}) => ({
  type: 2,
  geometry: [points],
  tags: { kind: 'major_road', ...props },
})
const polygon = (box, kind) => ({ type: 3, geometry: [box], tags: { kind } })
const tile = Buffer.from(
  fromGeojsonVt(
    {
      earth: {
        features: [
          polygon(
            [
              [0, 0],
              [4096, 0],
              [4096, 4096],
              [0, 4096],
              [0, 0],
            ],
            'earth',
          ),
        ],
      },
      buildings: {
        features: [
          polygon(
            [
              [2500, 1600],
              [3000, 1600],
              [3000, 2400],
              [2500, 2400],
              [2500, 1600],
            ],
            'building',
          ),
        ],
      },
      roads: {
        features: [
          road([
            [700, 1000],
            [2048, 1000],
            [3400, 1000],
          ]),
          road([
            [700, 3000],
            [2048, 3000],
            [3400, 3000],
          ]),
          road([
            [700, 1000],
            [700, 3000],
          ]),
          road(
            [
              [2048, 1000],
              [2048, 3000],
            ],
            { kind: 'minor_road', kind_detail: 'service' },
          ),
        ],
      },
    },
    { version: 2, extent: 4096 },
  ),
)
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  await page.route('**/map-assets/saanseoi/hongkong-latest.json', route =>
    route.fulfill({
      json: {
        tilejson: '3.0.0',
        tiles: [`${base}/fixture/{z}/{x}/{y}.pbf`],
        minzoom: 18,
        maxzoom: 18,
      },
    }),
  )
  await page.route('**/fixture/**', route =>
    route.fulfill({ body: tile, contentType: 'application/x-protobuf' }),
  )
  await page.goto(`${base}/?review`)
  const result = await page.evaluate(async () => {
    const { captureRoadMap } = await import('/scripts/checks/capture-road-map.ts')
    const { highResolution: capture, baseline } = await captureRoadMap({
      zoom: 18,
      x: 214202,
      y: 114404,
    })
    const sample = async (key, coords, images = capture) => {
      const img = new Image()
      img.src = images[key]
      await img.decode()
      const ctx = document.createElement('canvas').getContext('2d')
      return coords.map(([x, y]) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1)
        return [...ctx.getImageData(0, 0, 1, 1).data]
      })
    }
    const positions = [
      [512, 500],
      [520, 250],
      [680, 500],
      [520, 750],
      [512, 280],
      [512, 720],
      [175, 500],
    ]
    return {
      connectors: capture.reclaimedConnectors,
      projection: await sample('projectionMask', [
        [680, 250],
        [680, 750],
      ]),
      liveLine: await sample(
        'lineOverlay',
        [
          [340, 125],
          [340, 375],
        ],
        baseline,
      ),
      safe: await sample('safeMask', positions),
      patch: await sample('roadCleanup', positions),
      building: await sample('buildingMask', positions),
    }
  })
  console.log(result)
  assert.equal(result.connectors, 1)
  assert.deepEqual(
    result.safe.map(p => p[3]),
    [255, 0, 255, 0, 255, 255, 0],
  )
  assert.deepEqual(
    result.patch.map(p => p[3]),
    [255, 0, 0, 0, 255, 255, 0],
  )
  assert.equal(result.building[2][3], 255)
  assert.deepEqual(
    result.projection.map(p => p[3]),
    [255, 0],
  )
  assert.deepEqual(
    result.liveLine.map(p => p[3]),
    [0, 255],
  )
} finally {
  await browser.close()
}
