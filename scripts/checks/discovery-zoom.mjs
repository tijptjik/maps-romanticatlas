import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.testAtlasMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body })
  })
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&noMusic`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.atlas-fog').waitFor()
  assert.equal(await page.evaluate(() => window.testAtlasMap.getMinZoom()), 16)
  await page.mouse.move(480, 360)
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1400)
    await page.waitForTimeout(450)
  }
  await page.waitForFunction(
    () => Math.abs(window.testAtlasMap.getZoom() - 16) < 0.00001,
  )
  await page.waitForFunction(
    () => {
      const fog = document.querySelector('.atlas-fog')
      const sample = document.createElement('canvas')
      sample.width = sample.height = 80
      const ctx = sample.getContext('2d')
      ctx.drawImage(fog, 0, 0, 80, 80)
      return ctx.getImageData(0, 0, 80, 80).data.some((v, i) => i % 4 === 3 && v > 64)
    },
    null,
    { timeout: 60000 },
  )
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'discovery-zoom-limit.png'),
  })
  for (const [mode, minimum] of [
    ['diagnostics', 15],
    ['admin', -2],
  ]) {
    await page.goto(
      `${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&noMusic&${mode}=true`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.testAtlasMap?.isStyleLoaded())
    assert.equal(await page.evaluate(() => window.testAtlasMap.getMinZoom()), minimum)
    const actual = await page.evaluate(() => {
      const map = window.testAtlasMap
      map.jumpTo({ zoom: -10 })
      return {
        zoom: map.getZoom(),
        floor: map.getMinZoom(true),
        bounded: Boolean(map.getMaxBounds()),
      }
    })
    if (mode === 'admin') {
      assert.equal(actual.bounded, false)
      assert.ok(actual.zoom < 2)
    }
    assert.ok(Math.abs(actual.zoom - actual.floor) < 0.00001)
  }
} finally {
  await browser.close()
}
