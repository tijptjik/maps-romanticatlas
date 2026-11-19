import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({
    hasTouch: true, isMobile: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 },
  })
  page.setDefaultTimeout(90_000)
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => {
    window.menuEvents = []
    window.addEventListener('contextmenu', event => {
      window.menuEvents.push({ pointer: event.pointerType, prevented: event.defaultPrevented })
    })
  })
  const session = await page.context().newCDPSession(page)
  const sun = page.getByRole('button', { name: 'Night mode' })
  await page.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  const imageBox = await sun.locator('img').boundingBox()
  await page.evaluate(() => document.addEventListener('touchstart', event => {
    window.imageTouchPrevented = event.defaultPrevented
  }, { once: true }))
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{
    x: imageBox.x + imageBox.width / 2, y: imageBox.y + imageBox.height / 2,
  }] })
  await page.waitForTimeout(1100)
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal(await page.evaluate(() => window.imageTouchPrevented), true)
  assert.equal(await sun.getAttribute('aria-pressed'), 'false')
  await sun.tap()
  assert.equal(await sun.getAttribute('aria-pressed'), 'true')
  const credit = page.locator('.pavilion-credit')
  await credit.click({ button: 'right' })
  const box = await credit.boundingBox()
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  await page.waitForTimeout(1100)
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  const pavilionEvents = await page.evaluate(() => window.menuEvents.splice(0))
  assert.ok(pavilionEvents.some(event => event.pointer === 'mouse'))
  assert.ok(pavilionEvents.every(event => event.prevented), JSON.stringify(pavilionEvents))
  assert.equal(await credit.evaluate(el => el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), false)
  await page.getByRole('button', { name: 'Enter the Fog' }).tap()
  await page.locator('.atlas-intro').waitFor({ state: 'hidden' })
  await page.evaluate(() => { window.menuEvents = [] })
  await session.send('Input.synthesizeTapGesture', {
    x: 195, y: 422, duration: 1100, gestureSourceType: 'touch',
  })
  const holdEvents = await page.evaluate(() => window.menuEvents)
  assert.ok(holdEvents.every(event => event.prevented), JSON.stringify(holdEvents))
  // Desktop Chrome may handle an emulated hold without dispatching a DOM menu event.
  // Exercise the browser event path explicitly on a map overlay as well.
  const overlay = page.locator('.artist-statement__map-trigger')
  const allowed = await overlay.evaluate(button => ['touch', 'pen', 'mouse'].map(pointerType =>
    button.dispatchEvent(new PointerEvent('contextmenu', { pointerType, bubbles: true, cancelable: true }))))
  assert.deepEqual(allowed, [false, false, true])
  await overlay.tap()
  await page.getByRole('dialog').waitFor()
  await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS, 'context-menu.json'), JSON.stringify({ pavilionEvents, holdEvents, allowed }))
} finally {
  await browser.close()
}
