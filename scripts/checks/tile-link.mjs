import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage()
  const tile = '18/214184/114420'
  await page.goto(base + '/?tile=' + tile, { waitUntil: 'domcontentloaded' })
  const link = page.getByRole('link', { name: 'Copy tile link' })
  await link.waitFor({ timeout: 60000 })
  const url = new URL(await link.getAttribute('href'), base)
  assert.equal(url.searchParams.get('tile'), tile)
  assert.ok(url.searchParams.get('art'))
  const title = await page.locator('.atlas-title-card__title').innerText()
  // Capture the clipboard payload without depending on system clipboard permissions.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: text => { window.copiedTile = text } } })
  })
  await link.click()
  const copied = await page.evaluate(() => window.copiedTile)
  assert.equal(copied, url.href)
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await mobile.goto(copied, { waitUntil: 'domcontentloaded' })
  const reopened = mobile.getByRole('link', { name: 'Copy tile link' })
  await reopened.waitFor({ timeout: 60000 })
  assert.equal(new URL(await reopened.getAttribute('href'), base).href, copied)
  assert.equal(await mobile.locator('.atlas-title-card__title').innerText(), title)
  await mobile.screenshot({ path: process.env.DEV_RUNNER_ARTIFACTS + '/linked-tile.png' })
  console.log(title, tile)
} finally {
  await browser.close()
}
