import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const base = process.env.PLAYWRIGHT_BASE_URL
  await page.goto(base + '/?noLinkOut&noMusic', { waitUntil: 'domcontentloaded' })
  const credit = page.locator('.pavilion-credit')
  await credit.waitFor()
  assert.match(await credit.innerText(), /TIJPTJIK/)
  assert.equal(await credit.getAttribute('href'), null)
  await page.getByRole('button', { name: 'Enter the Fog' }).click({ timeout: 90000 })
  const attribution = page.locator('.maplibregl-ctrl-attrib')
  await attribution.locator('summary').click()
  await attribution.getByText('Sounds', { exact: true }).waitFor()
  assert.equal(await attribution.getByRole('link').count(), 0)
  assert.equal(await page.evaluate(() => history.state.atlasView), 'map')
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'no-link-out-map.png') })

  await page.goto(base + '/?no-link-out&noMusic', { waitUntil: 'domcontentloaded' })
  await page.getByRole('link', { name: /By TIJPTJIK/ }).waitFor()
  assert.equal(await credit.getAttribute('href'), 'https://type.hk/')
} finally {
  await browser.close()
}
