import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ hasTouch: true })
  const tile = '18/214184/114420'
  await page.goto(`${base}/?tile=${tile}`, { waitUntil: 'domcontentloaded' })
  const card = page.locator('button.atlas-title-card')
  await card.waitFor({ timeout: 60000 })
  const before = page.url()
  const title = await page.locator('.atlas-title-card__title').textContent()
  // Capture the clipboard payload without depending on system clipboard permissions.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: text => {
          window.copiedTile = text
        },
      },
    })
  })
  await card.tap()
  const copied = await page.evaluate(() => window.copiedTile)
  const url = new URL(copied)
  assert.equal(url.searchParams.get('tile'), tile)
  assert.ok(url.searchParams.get('art'))
  assert.equal(page.url(), before)
  assert.equal(await card.textContent(), title)
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await mobile.goto(copied, { waitUntil: 'domcontentloaded' })
  const reopened = mobile.locator('button.atlas-title-card')
  await reopened.waitFor({ timeout: 60000 })
  assert.equal(await mobile.locator('.atlas-title-card__title').textContent(), title)
  await mobile.screenshot({
    path: `${process.env.DEV_RUNNER_ARTIFACTS}/linked-tile.png`,
  })
  console.log(title, tile)
} finally {
  await browser.close()
}
