import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 900}})
  const base = process.env.PLAYWRIGHT_BASE_URL
  const catalog = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
  const reviews = await (await page.request.get(base + '/api/artwork-reviews')).json()
  const sheetId = process.argv[2] ?? 'coasters'
  const sheet = catalog.sheets.find(sheet => sheet.id === sheetId)
  assert.ok(sheet)
  const paintings = sheetId === 'coasters' ? sheet.art.slice(3) : sheet.art
  assert.ok(paintings.length > 0)
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.testMap = map; installArtworkSampling(map)')
    await route.fulfill({response, body})
  })
  await page.goto(base + '/?noSplash=true&noMusic=true')
  await page.locator('.atlas-fog').waitFor()
  for (const art of paintings) {
    assert.ok(reviews.some(review => review.url === art.url && review.status === 'accepted'))
    const point = await page.evaluate(({x,y}) => {
      const n = 2 ** 18
      const center = [(x + .5) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / n))) * 180 / Math.PI]
      window.testMap.jumpTo({center, zoom: 18})
      return {x: 600, y: 450}
    }, art)
    await page.waitForFunction(() => !window.testMap.isMoving())
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(art => {
      const map = window.testMap
      const id = 'atlas-tile-' + art.x + '-' + art.y
      const source = map.getSource(id)
      return source?.url === art.url && source.loaded() && map.getPaintProperty(id, 'raster-opacity') === 1 &&
        !map.isMoving() && [...document.querySelectorAll('.atlas-title-card:not(.is-awaiting-focus)')].some(card => card.textContent.includes(art.title))
    }, art, {timeout: 60000})
    const result = await page.evaluate(art => {
      const source = window.testMap.getSource('atlas-tile-' + art.x + '-' + art.y)
      const [nw,ne,se] = source.coordinates
      return {columns: (ne[0] - nw[0]) * 2 ** 18 / 360, width: source.image.width, height: source.image.height, south:se[1]}
    }, art)
    assert.ok(Math.abs(result.columns - art.columns) < 1e-7)
    assert.equal(result.width / result.height, art.columns / art.rows)
    await page.screenshot({path: process.env.DEV_RUNNER_ARTIFACTS + '/' + art.x + '-' + art.y + '.png'})
    console.log('Revealed accepted painting in regular discovery:', art.title)
  }
} finally {
  await browser.close()
}
