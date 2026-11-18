import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const base = process.env.PLAYWRIGHT_BASE_URL
if (!artifacts || !base) throw new Error('Run with managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})

try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: mobile, reducedMotion: mobile ? 'reduce' : 'no-preference',
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const toggle = page.getByRole('button', { name: 'Night mode' })
    await toggle.waitFor()
    await page.waitForFunction(() => !document.documentElement.classList.contains('atlas-boot') && !document.querySelector('#map').inert)
    const title = page.locator('.pavilion-title')
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    const note = page.getByRole('button', { name: 'Cartographer’s Note', exact: true })
    const coverFrame = mode => note.screenshot({path: path.join(artifacts, `spine-${mode}-${mobile ? 'mobile' : 'desktop'}.png`)})
    await coverFrame('day')
    const dayColor = await title.evaluate(el => getComputedStyle(el).color)
    if (mobile) await toggle.tap()
    else await toggle.click()
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    assert.equal(await title.evaluate(el => getComputedStyle(el).color), 'rgb(162, 215, 254)')
    const room = page.locator('.pavilion-room')
    await room.evaluate(async el => {
      const url = getComputedStyle(el, '::before').backgroundImage
      const image = new Image()
      image.src = url.slice(5, -2)
      await image.decode()
      await Promise.all(el.getAnimations({subtree: true})
        .filter(animation => animation instanceof CSSTransition).map(animation => animation.finished))
    })
    const water = page.locator('.pavilion-water[data-light="night"]')
    await water.waitFor()
    assert.equal(await page.locator('.pavilion-aerostat:visible').count(), 0)
    const paintedWater = () => water.evaluate(el => el.toDataURL())
    const firstFrame = await paintedWater()
    if (mobile) {
      await page.waitForTimeout(350)
      assert.equal(await paintedWater(), firstFrame, 'Reduced motion keeps the night water still')
      await page.emulateMedia({reducedMotion: 'no-preference'})
      await page.waitForTimeout(800)
      assert.notEqual(await paintedWater(), firstFrame, 'Mobile water moves with motion enabled')
      await page.emulateMedia({reducedMotion: 'reduce'})
    } else {
      const clip = { x: 1000, y: 574, width: 82, height: 42 }
      const reflection = await page.screenshot({clip, path: path.join(artifacts, 'reflection-a.png')})
      await page.waitForTimeout(420)
      assert.notEqual(await paintedWater(), firstFrame)
      const next = await page.screenshot({clip, path: path.join(artifacts, 'reflection-b.png')})
      assert.ok(!reflection.equals(next), 'The harbour reflections move in the rendered scene')
      const frames = path.join(artifacts, 'harbour-loop')
      await mkdir(frames, {recursive: true})
      const times = []
      const start = performance.now()
      while (performance.now() - start < 5600) {
        const frame = await page.screenshot({clip: {x: 1054, y: 536, width: 176, height: 98}})
        times.push(Math.round(performance.now() - start))
        await writeFile(path.join(frames, times.length + '.png'), frame)
        await page.waitForTimeout(45)
      }
      await writeFile(path.join(frames, 'times.json'), JSON.stringify(times))
    }
    await page.screenshot({path: path.join(artifacts, mobile ? 'night-mobile.png' : 'night-desktop.png')})

    await coverFrame('night')
    await note.click()
    const reader = page.getByRole('dialog')
    await reader.waitFor()
    assert.ok(await reader.evaluate(el => !!el.closest('.artist-statement.is-night')))
    await reader.evaluate(el => Promise.all(el.getAnimations({subtree: true}).map(animation => animation.finished)))
    await page.screenshot({path: path.join(artifacts, mobile ? 'note-mobile.png' : 'note-desktop.png')})
    await page.keyboard.press('Escape')
    await reader.waitFor({state: 'hidden'})
    assert.ok(await note.evaluate(el => el === document.activeElement))
    if (mobile) await toggle.tap()
    else await toggle.press('Space')
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    await page.locator('.pavilion-water[data-light="day"]').waitFor()
    assert.equal(await page.locator('.pavilion-aerostat:visible').count(), 2)
    assert.equal(await title.evaluate(el => getComputedStyle(el).color), dayColor)
    await toggle.press('Enter')
    await page.getByRole('button', { name: 'Enter the Fog' }).click()
    await page.locator('.atlas-intro').waitFor({state: 'hidden'})
    await page.close()
  }
} finally {
  await browser.close()
}
