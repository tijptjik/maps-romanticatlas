import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  })
  page.on('pageerror', error => console.error(error.message))
  page.on('requestfailed', request => console.error(request.url(), request.failure()))
  page.on('response', response => {
    if (response.status() >= 400) console.error(response.status(), response.url())
  })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const sun = page.getByRole('button', { name: 'Night mode' })
  await sun.waitFor({ timeout: 90000 })
  await page.waitForFunction(() => !document.querySelector('#map').inert)
  assert.ok(await page.locator('.pavilion-room img').evaluateAll(images =>
    images.length > 0 && images.every(image => !image.draggable && getComputedStyle(image).pointerEvents === 'none')))
  await page.evaluate(() => {
    window.imageGestures = []
    for (const type of ['dragstart', 'contextmenu']) {
      document.addEventListener(type, event => window.imageGestures.push([type, event.target.tagName]))
    }
  })
  const { x, y, width, height } = await sun.boundingBox()
  const point = { x: x + width / 2, y: y + height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(900)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + 30 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.ok(await page.evaluate(() => window.imageGestures.every(([type, tag]) => type !== 'dragstart' && tag !== 'IMG')))
  const before = await sun.getAttribute('aria-pressed')
  await sun.tap()
  assert.notEqual(await sun.getAttribute('aria-pressed'), before)
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'pavilion-touch.png') })
} finally {
  await browser.close()
}
