import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  page.setDefaultTimeout(90_000)
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'commit' })
  const intro = page.locator('.atlas-intro')
  const book = page.getByRole('button', { name: 'Enter the Fog' })
  await book.click()
  await intro.waitFor({ state: 'hidden' })
  await page.locator('.artist-statement__map-trigger').click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.ok(await intro.isHidden())
  await page.keyboard.press('Escape')
  await book.waitFor()
  assert.equal(await page.evaluate(() => history.state.atlasView), 'pavilion')
  assert.ok(await intro.evaluate(el => el === document.activeElement))
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'map-escape.png') })
  await book.press('Enter')
  await intro.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => history.state.atlasView), 'map')
} finally {
  await browser.close()
}
