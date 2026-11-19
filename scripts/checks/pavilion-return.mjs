import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.clock.install()
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const ready = page.locator('.atlas-intro.is-visible:not([inert]):not(.is-returning)')
  const sun = page.getByRole('button', { name: 'Night mode' })
  await page.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  await page.clock.fastForward(300_000)
  assert.equal(await sun.getAttribute('aria-pressed'), 'true')
  await page.clock.fastForward(300_000)
  assert.equal(await sun.getAttribute('aria-pressed'), 'false')
  await sun.click()
  await page.getByRole('button', { name: 'Enter the Fog' }).click()
  await page.locator('.atlas-intro[hidden]').waitFor({ state: 'attached' })
  await page.clock.fastForward(110_000)
  await page.keyboard.press('Shift')
  await page.clock.fastForward(110_000)
  assert.equal(await page.locator('.atlas-intro').isHidden(), true)
  await page.clock.fastForward(10_000)
  const returning = page.locator('.atlas-intro.is-returning')
  await returning.waitFor({ state: 'attached' })
  assert.equal(await returning.evaluate(el => getComputedStyle(el).animationDirection), 'reverse')
  await ready.waitFor()
  assert.equal(await sun.getAttribute('aria-pressed'), 'true')
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'pavilion-return.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goForward()
  await page.locator('.atlas-intro[hidden]').waitFor({ state: 'attached' })
  await page.keyboard.press('Control+m')
  await ready.waitFor()
  assert.equal(await ready.evaluate(el => document.activeElement === el), true)
} finally {
  await browser.close()
}
