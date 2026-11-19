import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1090, height: 772 }, hasTouch: true })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/?noMusic', { waitUntil: 'domcontentloaded' })
  await page.locator('.pavilion-notes').tap()
  const pages = page.locator('.note-pages')
  await pages.evaluate(async el => {
    await Promise.all(el.closest('section').getAnimations({ subtree: true }).map(a => a.finished))
    await document.fonts.ready
  })
  const geometry = () => pages.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el.querySelector('.artist-statement__copy p'))
    return {
      border: getComputedStyle(el).borderLeftWidth,
      lines: [...range.getClientRects()].map(r => [r.x, r.y, r.width, r.height]),
    }
  })
  const before = await geometry()
  const paragraph = pages.locator('.artist-statement__copy p').first()
  await paragraph.hover()
  await page.mouse.down()
  assert.deepEqual(await geometry(), before, 'Pressing the text preserves the paper border and line layout')
  await page.mouse.up()
  await paragraph.tap()
  assert.deepEqual(await geometry(), before, 'Tapping the text preserves the layout')
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'note-after-tap.png') })
  await pages.getByRole('button', { name: 'Close the artist statement' }).tap()
  await pages.waitFor({ state: 'hidden' })
} finally {
  await browser.close()
}
