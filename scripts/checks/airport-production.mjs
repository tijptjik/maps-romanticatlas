import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { drawingFootprint, tileBounds } from '../../src/tile-geometry.ts'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const request = await browser.newContext()
  const catalog = await (await request.request.get(base + '/atlas-v2/catalog.json')).json()
  const sheet = catalog.sheets.find(item => item.id === 'hong-kong-international-airport')
  assert.ok(sheet?.accepted)
  assert.equal(sheet.art.length, 6)
  await request.close()
  for (const art of sheet.art) {
    const { cells } = drawingFootprint({ ...art, tileSpan: art })
    assert.equal(cells.length, 2)
    for (const [i, cell] of cells.entries()) {
      const context = await browser.newContext({ viewport: { width: 900, height: 750 } })
      const page = await context.newPage()
      const { west, east, north, south } = tileBounds(cell)
      await page.addInitScript(center => {
        history.replaceState({ atlasModeCamera: { center, zoom: 17 } }, '')
      }, [(west + east) / 2, (north + south) / 2])
      await page.goto(base + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
      await page.locator('.atlas-fog').waitFor()
      const loaded = page.waitForResponse(r => r.url() === new URL(art.url, base).href && r.ok())
      await page.mouse.click(450, 375)
      await loaded
      await page.getByText(art.title, { exact: true }).first().waitFor({state:'visible'})
      if (i === 0) await page.screenshot({ path: process.env.DEV_RUNNER_ARTIFACTS + '/' + art.x + '-' + art.y + '.png' })
      await context.close()
    }
    console.log('Revealed from both tiles:', art.title)
  }
} finally {
  await browser.close()
}
