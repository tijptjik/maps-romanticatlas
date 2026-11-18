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
  await page.waitForFunction(() => window.cues.includes('petal-touch.wav'))
  await linkPage.close()
  await page.locator('.pavilion-orrery').tap()
  await page.waitForFunction(() => window.cues.includes('gear-click.wav'))
  await page.locator('.pavilion-orrery').tap()
  await page.waitForFunction(() => window.cues.includes('gear-release.wav'))
  await page.locator('.pavilion-notes').tap()
  await page.waitForFunction(() => window.cues.includes('book-open.wav'))
  await page.getByRole('button', { name: 'Close the artist statement' }).tap()
  await page.waitForFunction(() => window.cues.includes('book-close.wav'))
  await page.locator('.pavilion-book').tap()
  const cues = await page.evaluate(() => window.cues)
  assert.deepEqual(cues, ['petal-touch.wav', 'gear-click.wav', 'gear-release.wav', 'book-open.wav', 'book-close.wav', 'tone'])
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
  const letters = credit.locator('.pavilion-credit__petal > span')
  await desktop.waitForFunction(() => document.querySelector('.atlas-intro.is-visible') && !document.querySelector('#map').inert)
  await desktop.emulateMedia({ reducedMotion: 'no-preference' })
  const waitForTint = value => desktop.waitForFunction(expected =>
    getComputedStyle(document.querySelector('.pavilion-credit__petal'), '::before').opacity === expected, value)
  for (const lighting of ['day', 'night']) {
    if (lighting === 'night') await desktop.locator('.pavilion-orrery').click()
    await waitForTint('0')
    assert.equal(await letters.evaluate(el => getComputedStyle(el).textDecorationLine), 'none')
    await credit.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'petal-rest-' + lighting + '.png') })
    await credit.hover()
    await waitForTint('0.52')
    assert.equal(await letters.evaluate(el => getComputedStyle(el).textDecorationLine), 'none')
    assert.equal(await letters.evaluate(el => getComputedStyle(el).color), 'rgb(255, 241, 237)')
    await credit.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'petal-hover-' + lighting + '.png') })
    await desktop.mouse.move(1, 1)
    await waitForTint('0')
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
