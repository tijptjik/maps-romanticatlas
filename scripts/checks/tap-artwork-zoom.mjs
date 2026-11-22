import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  for (const [width, height, dpr] of [
    [960, 640, 1],
    [390, 844, 3],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      hasTouch: true,
    })
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
    await page.touchscreen.tap(width / 2, height / 2)
    await page.locator('.atlas-title-card:not(.is-awaiting-focus)').waitFor()
    await page.waitForFunction(() => !window.testAtlasMap.isMoving())
    const measure = () =>
      page.evaluate(async () => {
        const map = window.testAtlasMap
        const source = map.getSource('atlas-tile-214184-114420')
        const image = new Image()
        image.src = source.url
        await image.decode()
        const a = map.project(source.coordinates[0]),
          b = map.project(source.coordinates[2])
        const canvas = map.getCanvas()
        const limits = [
          canvas.clientWidth / (b.x - a.x),
          canvas.clientHeight / (b.y - a.y),
          image.naturalWidth / (b.x - a.x),
          image.naturalHeight / (b.y - a.y),
        ]
        return {
          scale: Math.min(...limits),
          limits,
          center: [(a.x + b.x) / 2, (a.y + b.y) / 2],
        }
      })
    const expectedScale = width <= 700 ? 1 / 1.75 : 1
    const result = await measure()
    assert.ok(Math.abs(result.scale - expectedScale) < 0.005, JSON.stringify(result))
    assert.ok(
      Math.abs(result.center[0] - width / 2) < 1 &&
        Math.abs(result.center[1] - height / 2) < 1,
    )
    await page.evaluate(() => window.testAtlasMap.jumpTo({ zoom: 16 }))
    const tap = await page.evaluate(() => {
      const map = window.testAtlasMap
      const source = map.getSource('atlas-tile-214184-114420')
      const nw = map.project(source.coordinates[0]),
        se = map.project(source.coordinates[2])
      for (const y of [0.25, 0.75]) {
        for (const x of [0.25, 0.75]) {
          const point = { x: nw.x + x * (se.x - nw.x), y: nw.y + y * (se.y - nw.y) }
          if (document.elementFromPoint(point.x, point.y) === map.getCanvas())
            return point
        }
      }
      throw Error('No exposed canvas inside the revealed artwork')
    })
    await page.touchscreen.tap(tap.x, tap.y)
    await page.waitForFunction(
      () => window.testAtlasMap.getZoom() > 16 && !window.testAtlasMap.isMoving(),
    )
    const refocused = await measure()
    assert.ok(
      Math.abs(refocused.scale - expectedScale) < 0.005,
      JSON.stringify(refocused),
    )
    await page.screenshot({
      path: path.join(process.env.DEV_RUNNER_ARTIFACTS, `tap-${width}.png`),
    })
    console.log(width, height, dpr, result)
    await page.close()
  }
} finally {
  await browser.close()
}
