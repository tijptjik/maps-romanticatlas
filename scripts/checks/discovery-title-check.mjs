import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  for (const [variant, title] of [
    ['0e6ad9abe2a4', 'The Static Menagerie'],
    ['cf7d545332b8', 'The Parachute Loft'],
  ]) {
    const page = await browser.newPage()
    await page.route('**/api/atlas-tiles/cached?*', async route => {
      const res = await route.fetch()
      const { tiles } = await res.json()
      const matches = tiles.filter(tile => tile.variant.endsWith(variant))
      assert.equal(matches.length, 1)
      await route.fulfill({ json: { tiles: matches } })
    })
    await page.route('**/atlas-v2/catalog.json', route => route.fulfill({ json: { release: 'v2', sheets: [] } }))
    await page.route('**/api/artwork-re*', route => route.fulfill({ json: [] }))
    await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/review', { waitUntil: 'domcontentloaded' })
    const card = page.locator('.atlas-review-queue[aria-busy="false"]')
    await card.getByText(title, { exact: true }).waitFor({ timeout: 60000 })
    await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, variant + '.png') })
    console.log(title)
    await page.close()
  }
} finally {
  await browser.close()
}
