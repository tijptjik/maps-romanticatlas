import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', error => console.error(error.message))
  page.on('requestfailed', request => console.error(request.url(), request.failure()))
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()) })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const note = page.locator('.pavilion-notes')
  const sun = page.locator('.pavilion-orrery')
  await page.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  for (const mode of ['day', 'night']) {
    if (mode === 'night') await sun.click()
    await page.mouse.move(1, 1)
    await page.waitForTimeout(550)
    const capture = (target, state) => target.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, mode + '-' + state + '.png') })
    const still = await capture(note, 'book')
    await note.hover()
    await page.waitForFunction(() => {
      const motion = document.querySelector('.pavilion-notes').getAnimations({ subtree: true })
        .find(animation => animation.animationName === 'pavilion-compass-glint')
      return motion?.effect.getComputedTiming().currentIteration >= 1
    })
    await note.evaluate(el => {
      const movement = el.getAnimations({ subtree: true }).find(a => a.animationName === 'pavilion-compass-glint')
      movement.pause()
      movement.currentTime = 380
    })
    const lit = await capture(note, 'book-hover')
    const { width, height } = await sharp(still).metadata()
    const patch = (png, y) => sharp(png).extract({ left: Math.floor(width * .43), top: Math.floor(height * y),
      width: Math.floor(width * .14), height: Math.floor(height * .12) }).raw().toBuffer()
    assert.notDeepEqual(await patch(still, .23), await patch(lit, .23))
    assert.deepEqual(await patch(still, .75), await patch(lit, .75))
    await page.mouse.move(1, 1)
    const settled = await capture(note, 'book-settled')
    assert.deepEqual(await patch(still, .23), await patch(settled, .23))
    const sunLevel = async png => {
      const { width, height } = await sharp(png).metadata()
      const patch = await sharp(png).extract({ left: Math.floor(width * .50), top: Math.floor(height * .31), width: 8, height: 8 }).raw().toBuffer()
      return patch.reduce((sum, value) => sum + value, 0) / patch.length
    }
    const initial = await sunLevel(await capture(sun, 'sun'))
    await sun.hover()
    await page.waitForTimeout(250)
    assert.ok(await sunLevel(await capture(sun, 'sun-hover')) > initial + 2)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await note.hover()
  assert.equal(await note.evaluate(el => el.getAnimations({ subtree: true }).length), 0)
} finally {
  await browser.close()
}
