import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const base = process.env.PLAYWRIGHT_BASE_URL
  await page.goto(`${base}/?noLinkOut&noMusic`, { waitUntil: 'domcontentloaded' })
  const credit = page.locator('.pavilion-credit')
  await credit.waitFor()
  assert.match(await credit.getAttribute('aria-label'), /TIJPTJIK/)
  assert.equal(await credit.getAttribute('href'), null)
  await page.waitForFunction(
    () =>
      document.querySelector('.atlas-intro.is-visible') &&
      !document.querySelector('#map').inert,
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const petal = credit.locator('.pavilion-credit__petal')
  const restingWidth = await petal.evaluate(el => el.offsetWidth)
  await credit.hover()
  await petal.evaluate(async el => {
    const flight = el
      .getAnimations()
      .find(animation => animation.animationName === 'pavilion-petal-flight')
    if (!flight)
      throw new Error('Hover should lift the credit with external links disabled')
    await flight.finished
  })
  assert.ok((await petal.evaluate(el => el.offsetWidth)) > restingWidth * 1.75)
  await credit.click()
  assert.equal(page.context().pages().length, 1)
  assert.equal(new URL(page.url()).origin, new URL(base).origin)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Enter the Fog' }).click({ timeout: 90000 })
  const attribution = page.locator('.maplibregl-ctrl-attrib')
  await attribution.locator('summary').click()
  await attribution.getByText('Sounds', { exact: true }).waitFor()
  assert.equal(await attribution.getByRole('link').count(), 0)
  assert.equal(await page.evaluate(() => history.state.atlasView), 'map')
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'no-link-out-map.png'),
  })

  await page.goto(`${base}/?no-link-out&noMusic`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('link', { name: /By TIJPTJIK/ }).waitFor()
  assert.equal(await credit.getAttribute('href'), 'https://type.hk/')
} finally {
  await browser.close()
}
