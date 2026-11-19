import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
const base = process.env.PLAYWRIGHT_BASE_URL
const results = []
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    const requests = []
    page.on('request', request => requests.push(request.url()))
    let releaseArt, releaseMap
    const art = new Promise(resolve => { releaseArt = resolve })
    const map = new Promise(resolve => { releaseMap = resolve })
    await page.route('**/pavilion/clear-harbour-atlas.webp', async route => {
      await art
      await route.continue()
    })
    await page.route('**/src/main.ts*', async route => {
      await map
      await route.continue()
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('#map').inert)
    assert.deepEqual(requests.filter(url => /maplibre|\/src\/main\.ts|hongkong-latest|romantic-paper-texture/.test(url)), [])
    const mapRequested = page.waitForRequest('**/src/main.ts*')
    releaseArt()
    await mapRequested
    const book = page.getByRole('button', { name: 'Enter the Fog' })
    assert.equal(await book.evaluate(el => !!el.closest('[inert], [hidden], .atlas-boot')), false)
    await book.click()
    assert.equal(await book.isVisible(), true)
    releaseMap()
    await page.locator('.maplibregl-canvas').waitFor()
    await page.locator('.atlas-intro').waitFor({ state: 'hidden' })
    await page.goBack()
    await book.waitFor()
    results.push({ viewport, mapRequests: requests.filter(url => /maplibre/.test(url)).length })
    await page.close()
  }
  const page = await browser.newPage()
  const art = []
  page.on('request', req => { if (req.url().includes('/pavilion/glasshouse')) art.push(req.url()) })
  await page.goto(new URL('?noSplash=true', base).href, { waitUntil: 'domcontentloaded' })
  await page.locator('.maplibregl-canvas').waitFor()
  assert.deepEqual(art, [])
  await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS, 'loading-order.json'), JSON.stringify(results, null, 2))
} finally {
  await browser.close()
}
