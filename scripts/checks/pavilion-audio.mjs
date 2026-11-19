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
    hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce',
  })
  await page.addInitScript(() => {
    window.cues = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      this.addEventListener('ended', () => window.cues.push(this.src.split('/').pop()), { once: true })
      return play.call(this)
    }
    const start = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...args) {
      window.cues.push('tone')
      return start.apply(this, args)
    }
  })
  await page.context().route('https://type.hk/**', route => route.fulfill({ body: '' }))
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  const leaf = page.locator('.pavilion-credit')
  const pose = () => leaf.locator('.pavilion-credit__petal').evaluate(el => getComputedStyle(el).transform)
  assert.equal(await pose(), 'matrix(1, 0, 0, 1, 0, -6)')
  await leaf.hover()
  assert.equal(await pose(), 'matrix(1, 0, 0, 1, 0, -6)')
  await leaf.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'upright-petal.png') })
  const popup = page.waitForEvent('popup')
  await leaf.tap()
  const linkPage = await popup
  await page.waitForFunction(() => window.cues.includes('petal-touch.ogg'))
  await linkPage.close()
  await page.locator('.pavilion-orrery').tap()
  await page.waitForFunction(() => window.cues.includes('gear-click.ogg'))
  await page.locator('.pavilion-orrery').tap()
  await page.waitForFunction(() => window.cues.includes('gear-release.ogg'))
  await page.locator('.pavilion-notes').tap()
  await page.waitForFunction(() => window.cues.includes('book-open.ogg'))
  await page.getByRole('button', { name: 'Close the artist statement' }).tap()
  await page.waitForFunction(() => window.cues.includes('book-close.ogg'))
  await page.locator('.pavilion-book').tap()
  const cues = await page.evaluate(() => window.cues)
  assert.deepEqual(cues, ['petal-touch.ogg', 'gear-click.ogg', 'gear-release.ogg', 'book-open.ogg', 'book-close.ogg', 'tone'])
  await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS, 'pavilion-audio.json'), JSON.stringify(cues, null, 2))
  const desktop = await browser.newPage({ reducedMotion: 'reduce' })
  await desktop.addInitScript(() => {
    window.tones = []
    const pitches = new WeakMap()
    const ramps = new WeakMap()
    for (const [method, values] of [['setValueAtTime', pitches], ['exponentialRampToValueAtTime', ramps]]) {
      const schedule = AudioParam.prototype[method]
      AudioParam.prototype[method] = function (value, at) {
        values.set(this, value)
        return schedule.call(this, value, at)
      }
    }
    const stop = OscillatorNode.prototype.stop
    OscillatorNode.prototype.stop = function (at) {
      window.tones.push({ frequency: pitches.get(this.frequency), end: ramps.get(this.frequency), duration: at - this.context.currentTime })
      return stop.call(this, at)
    }
  })
  await desktop.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const credit = desktop.locator('.pavilion-credit')
  await desktop.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  await desktop.emulateMedia({ reducedMotion: 'no-preference' })
  const petal = credit.locator('.pavilion-credit__petal')
  for (const lighting of ['day', 'night']) {
    if (lighting === 'night') await desktop.locator('.pavilion-orrery').click()
    const resting = await petal.boundingBox()
    const filter = await credit.locator('img').evaluate(el => getComputedStyle(el).filter)
    await petal.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'petal-rest-' + lighting + '.png') })
    await petal.hover()
    await petal.evaluate(async el => {
      const flight = el.getAnimations().find(animation => animation.animationName === 'pavilion-petal-flight')
      if (!flight) throw new Error('The petal did not lift')
      await flight.finished
    })
    const raised = await petal.boundingBox()
    assert.ok(raised.width > resting.width * 1.75)
    assert.equal(await petal.evaluate(el => getComputedStyle(el).transform), 'none')
    const layoutWidth = await credit.locator('img').evaluate(el => el.offsetWidth)
    assert.ok(Math.abs(layoutWidth - raised.width) < 1)
    assert.equal(await credit.locator('img').evaluate(el => getComputedStyle(el).filter), filter)
    await petal.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'petal-hover-' + lighting + '.png') })
    await desktop.mouse.move(1, 1)
    await petal.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
  }
  await desktop.emulateMedia({ reducedMotion: 'reduce' })
  const orb = desktop.locator('.pavilion-book')
  await orb.hover()
  await credit.hover()
  await orb.hover()
  await orb.click()
  const control = desktop.locator('.atlas-audio-control')
  await control.click()
  await control.click()
  await control.click()
  const tones = await desktop.evaluate(() => window.tones)
  assert.deepEqual(tones.map(t => Math.round(t.frequency)), [330, 392, 330, 330, 392, 392, 330])
  assert.deepEqual(tones.map(t => Math.round(t.end)), [392, 330, 392, 494, 330, 330, 392])
  assert.ok(tones[3].duration > .4 && tones[0].duration < .3)
  await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS, 'orb-tones.json'), JSON.stringify(tones))
} finally {
  await browser.close()
}
