import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { isFakeRenderTile } from '../../src/fake-render-state.ts'

const tile = {
  x: 214210,
  y: 114419,
  rows: 1,
  title: 'Test artwork',
  url: '/test-catalog.png',
}
const center = [
  ((tile.x + 0.5) / 262144) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / 262144))) * 180) / Math.PI,
]
let visit = 0
while (!isFakeRenderTile(tile, visit)) visit++
const image = await sharp({
  create: { width: 1024, height: 1024, channels: 3, background: '#72896b' },
})
  .png()
  .toBuffer()
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: true })
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace(
        'installArtworkSampling(map)',
        'window.testAtlasMap = map; installArtworkSampling(map)',
      )
      await route.fulfill({ response, body })
    })
    await page.addInitScript(
      ({ center, visit }) => {
        history.replaceState({ atlasModeCamera: { center, zoom: 18 } }, '')
        const original = crypto.getRandomValues.bind(crypto)
        crypto.getRandomValues = array =>
          array instanceof Uint32Array && array.length === 1
            ? array.fill(visit)
            : original(array)
        // Choose the released generated image after the catalog alternative.
        Math.random = () => 0.999
      },
      { center, visit },
    )
    await page.route('**/atlas-v2/catalog.json', route =>
      route.fulfill({
        json: { release: 'v2', sheets: [{ accepted: true, art: [tile] }] },
      }),
    )
    await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [] }))
    await page.route('**/api/fog-index/**', route =>
      route.fulfill({
        json: {
          eligibility: [
            {
              ...tile,
              isTargetable: true,
              regionalLandAvailable: true,
              landFraction: 1,
            },
          ],
        },
      }),
    )
    await page.route('**/test-*.png', route =>
      route.fulfill({ contentType: 'image/png', body: image }),
    )
    let claims = 0
    await page.route('**/api/fake-render/**', route => {
      if (route.request().method() === 'POST') claims++
      return route.fulfill({
        json: {
          ready: false,
          released: [
            {
              url: '/test-generated.png',
              scene: 'maze-garden',
              title: 'Generated artwork',
            },
          ],
        },
      })
    })
    const ready = page.waitForResponse(response =>
      response.url().includes('availability=1'),
    )
    await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&noMusic`, {
      waitUntil: 'domcontentloaded',
    })
    await ready
    await page.locator('.atlas-fog').waitFor()
    await page.waitForTimeout(500)
    await page.touchscreen.tap(viewport.width / 2, viewport.height / 2)
    await page.locator('.atlas-title-card:not(.is-awaiting-focus)').waitFor()
    await page.waitForFunction(() => !window.testAtlasMap.isMoving())
    const firstReveal = await page.evaluate(() => {
      const map = window.testAtlasMap
      const camera = { center: map.getCenter().toArray(), zoom: map.getZoom() }
      const source = map.getSource('atlas-tile-214210-114419')
      assertGeneratedSource(source)
      function assertGeneratedSource(source) {
        if (!source.url.includes('test-generated.png'))
          throw Error('Expected generated artwork')
      }
      map.jumpTo({ center: [camera.center[0] + 0.0002, camera.center[1]], zoom: 16 })
      return camera
    })
    const tap = await page.evaluate(center => {
      const point = window.testAtlasMap.project(center)
      return { x: point.x, y: point.y - 15 }
    }, center)
    await page.touchscreen.tap(tap.x, tap.y)
    await page.waitForFunction(
      () => window.testAtlasMap.getZoom() > 16 && !window.testAtlasMap.isMoving(),
    )
    const refocused = await page.evaluate(() => ({
      center: window.testAtlasMap.getCenter().toArray(),
      zoom: window.testAtlasMap.getZoom(),
    }))
    assert.ok(
      Math.abs(firstReveal.zoom - refocused.zoom) < 0.00001,
      JSON.stringify({ firstReveal, refocused }),
    )
    assert.ok(
      refocused.center.every(
        (value, i) => Math.abs(value - firstReveal.center[i]) < 0.000001,
      ),
    )
    assert.equal(claims, 0, 'Retapping does not start generation')
    await page.screenshot({
      path: path.join(
        process.env.DEV_RUNNER_ARTIFACTS,
        `revealed-tap-${viewport.width}.png`,
      ),
    })
    console.log('Repeat tap matches first reveal:', viewport, refocused)
    await page.close()
  }
} finally {
  await browser.close()
}
