import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.testAtlasMap = map; installArtworkSampling(map)')
    await route.fulfill({ response, body })
  })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
  await page.locator('.atlas-fog').waitFor({ timeout: 90000 })
  const cdp = await page.context().newCDPSession(page)
  const gesture = async (from, to) => {
    for (let step = 0; step <= 10; step++) {
      const t = step / 10
      const radius = from + (to - from) * t
      const angle = t * Math.PI / 6
      const touchPoints = [-1, 1].map((sign, id) => ({
        id, x: 195 + sign * radius * Math.cos(angle), y: 422 + sign * radius * Math.sin(angle),
      }))
      await cdp.send('Input.dispatchTouchEvent', { type: step ? 'touchMove' : 'touchStart', touchPoints })
      await page.evaluate(() => new Promise(requestAnimationFrame))
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForFunction(() => !window.testAtlasMap.isMoving())
  }
  const camera = () => page.evaluate(() => ({
    zoom: window.testAtlasMap.getZoom(), bearing: window.testAtlasMap.getBearing(),
    pitch: window.testAtlasMap.getPitch(), pageScale: visualViewport.scale,
  }))
  const initial = await camera()
  await gesture(100, 45)
  const inward = await camera()
  await gesture(45, 100)
  const outward = await camera()
  console.log({ initial, inward, outward })
  assert.ok(inward.zoom < initial.zoom - 0.1)
  assert.ok(outward.zoom > inward.zoom + 0.1)
  for (const state of [inward, outward]) {
    assert.equal(state.bearing, initial.bearing)
    assert.equal(state.pitch, initial.pitch)
    assert.equal(state.pageScale, initial.pageScale)
  }
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'pinch-map.png') })
} finally {
  await browser.close()
}
