import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !output) throw new Error('Run through managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  for (const density of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: density })
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('installArtworkSampling(map)', 'window.testAtlasMap = map; installArtworkSampling(map)')
      await route.fulfill({ response, body })
    })
    const catalog = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
    for (const card of ['harbour-curiosities-v2-01', 'coasters']) {
      const art = catalog.sheets.find(sheet => sheet.id === card).art[0]
      const layer = 'v2-' + art.x + '-' + art.y
      await page.goto(base + '/?experiment=true&card=' + card, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(id => window.testAtlasMap?.getSource(id)?.image?.width, layer)
      const expected = await page.evaluate(async url => {
        const image = new Image()
        image.src = url
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, art.animation?.plate ?? art.url)
      await page.mouse.move(550, 425)
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -1200)
        await page.waitForTimeout(300)
      }
      const size = await page.evaluate(id => {
        const map = window.testAtlasMap
        const corners = map.getSource(id).coordinates.map(point => map.project(point))
        return { width: corners[2].x - corners[0].x, height: corners[2].y - corners[0].y }
      }, layer)
      const scale = Math.max(size.width / expected.width, size.height / expected.height)
      assert.ok(Math.abs(scale - 1) < 0.001, JSON.stringify({ card, density, size, expected }))
      console.log(card, density, size)
      await page.screenshot({ path: path.join(output, card + '-' + density + 'x.png') })
    }
    await page.close()
  }
} finally {
  await browser.close()
}
