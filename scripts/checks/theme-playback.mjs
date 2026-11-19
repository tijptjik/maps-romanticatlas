import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    window.themeStarts = []
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      const result = start.apply(this, args)
      if (this.loop && this.buffer) {
        const observation = { duration: this.buffer.duration, ended: false, state: this.context.state }
        window.themeStarts.push(observation)
        this.addEventListener('ended', () => { observation.ended = true })
      }
      return result
    }
  })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const response = page.waitForResponse('**/atlas-audio/harbour-light-legato.ogg')
  await page.getByRole('button', { name: 'Enter the Fog', exact: true }).click()
  assert.equal((await response).status(), 200)
  await page.waitForFunction(() => window.themeStarts.length === 1)
  const control = page.locator('.atlas-audio-control')
  await control.click()
  assert.equal(await control.getAttribute('data-audio-mode'), 'music-off')
  await page.waitForFunction(() => window.themeStarts[0].ended)
  await control.click()
  assert.equal(await control.getAttribute('data-audio-mode'), 'all-off')
  await control.click()
  await page.waitForFunction(() => window.themeStarts.length === 2)
  const starts = await page.evaluate(() => window.themeStarts)
  assert.ok(starts.every(s => Math.abs(s.duration - 100.786) < .02 && s.state === 'running'))
  assert.equal(starts[1].ended, false)
  await writeFile(join(process.env.DEV_RUNNER_ARTIFACTS, 'theme-playback.json'), JSON.stringify(starts))
} finally {
  await browser.close()
}
