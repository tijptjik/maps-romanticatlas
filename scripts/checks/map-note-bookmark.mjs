import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { observePavilionAudio } from './observe-pavilion-audio.mjs'

const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const base = process.env.PLAYWRIGHT_BASE_URL
if (!artifacts || !base) throw new Error('Run with managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
    })
    await page.addInitScript(observePavilionAudio)
    await page.goto(
      base + (width === 390 ? '/?noSplash=true&noMusic=true' : '/?noMusic=true'),
      { waitUntil: 'domcontentloaded' },
    )
    if (width !== 390) {
      await page.getByRole('button', { name: 'Enter the Fog' }).click()
      await page.locator('.atlas-intro').waitFor({ state: 'hidden' })
    }
    const tag = page.getByRole('button', { name: "Cartographer's Note", exact: true })
    const appearance = () =>
      tag.evaluate(button => {
        const style = getComputedStyle(button)
        const compass = getComputedStyle(
          button.querySelector('.artist-statement__map-trigger-compass'),
        )
        return [
          style.background,
          style.color,
          style.outline,
          style.boxShadow,
          style.borderColor,
          style.transform,
          compass.transform,
          compass.borderColor,
        ]
      })
    await page.mouse.move(0, 0)
    const idle = await appearance()
    await tag.hover()
    await tag.evaluate(el =>
      Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)),
    )
    assert.deepEqual(
      await appearance(),
      idle,
      'Hover preserves the bookmark and compass appearance',
    )
    const reader = page.getByRole('dialog')
    await page.evaluate(() => {
      window.pavilionPlayback.started.length = 0
    })
    await tag.click()
    await page.waitForFunction(() =>
      window.pavilionPlayback.ended.includes('book-shelf-pull.ogg'),
    )
    assert.equal(
      await page.evaluate(() => window.pavilionPlayback.started.length),
      1,
      'One shelf pull with music off',
    )
    await reader.waitFor()
    const seek = time =>
      reader.evaluate((el, t) => {
        for (const animation of el
          .closest('section')
          .getAnimations({ subtree: true })) {
          animation.pause()
          animation.currentTime = t
        }
      }, time)
    const cord = reader.locator('.note-bookmark-cord')
    const movingTag = reader.locator('.note-bookmark-knot button')
    await seek(0)
    const start = await movingTag.boundingBox()
    await seek(410)
    const pulled = await movingTag.boundingBox()
    assert.ok(pulled.x < start.x - 65)
    const string = await cord.boundingBox()
    assert.ok(string.width >= 36)
    assert.ok(Math.abs(pulled.x + pulled.width - string.x) < 4)
    await page.screenshot({
      path: path.join(artifacts, `bookmark-pull-${width}.png`),
    })
    await seek(850)
    await reader.locator('.note-board img').evaluate(el => el.decode())
    await page.screenshot({
      path: path.join(artifacts, `bookmark-opening-${width}.png`),
    })
    // Reverse during pickup, then complete a second opening and close from the spread.
    await page.keyboard.press('Escape')
    await reader.waitFor({ state: 'hidden' })
    assert.ok(await tag.evaluate(el => el === document.activeElement))
    await tag.press('Enter')
    await reader.waitFor()
    await reader.evaluate(el =>
      Promise.all(
        el
          .closest('section')
          .getAnimations({ subtree: true })
          .map(a => a.finished),
      ),
    )
    assert.equal(
      await reader
        .locator(':scope > .note-pages')
        .evaluate(el => getComputedStyle(el).opacity),
      '1',
    )
    await reader.getByRole('button', { name: 'Close the artist statement' }).click()
    await reader.waitFor({ state: 'hidden' })
    await page.locator('.atlas-audio-control').click()
    assert.equal(
      await page.locator('.atlas-audio-control').getAttribute('data-audio-mode'),
      'all-off',
    )
    await page.evaluate(() => {
      window.pavilionPlayback.started.length = 0
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await tag.click()
    assert.equal(
      await page.evaluate(() => window.pavilionPlayback.started.length),
      0,
      'All-off silences the shelf pull',
    )
    assert.equal(await reader.locator('.note-bookmark-plane,.note-face').count(), 0)
    await page.keyboard.press('Escape')
    await reader.waitFor({ state: 'hidden' })
    await page.close()
  }
} finally {
  await browser.close()
}
