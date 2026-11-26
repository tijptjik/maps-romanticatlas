import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({
    viewport: { width: 384, height: 722 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  })
  const shot = name =>
    page.screenshot({ path: join(process.env.DEV_RUNNER_ARTIFACTS, `${name}.png`) })
  page.on('pageerror', error => console.error(error.message))
  await page.clock.install()
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noMusic`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('#map:not([inert]) .atlas-intro.is-visible').waitFor()
  await page.locator('.pavilion-curtain').waitFor({ state: 'hidden' })
  await page.locator('.pavilion-spread').evaluate(img => img.decode())

  // Simulate a mobile theme rewriting the foreground after author styles load.
  await page.addStyleTag({ content: '.pavilion-title * { color: ivory !important }' })
  const title = await shot('pavilion-day-ink')
  for (const selector of ['p span', 'h1', 'small']) {
    const region = await page.locator(`.pavilion-title ${selector}`).evaluate(el => {
      const range = document.createRange()
      range.selectNodeContents(el.firstChild)
      const rect = range.getBoundingClientRect()
      return {
        left: Math.floor(rect.x),
        top: Math.floor(rect.y),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      }
    })
    const ink = await sharp(title).extract(region).greyscale().raw().toBuffer()
    assert.ok(
      ink.filter(value => value < 55).length > 10,
      `Dark lettering in ${selector}`,
    )
  }

  // Hold the real opening transition at its brightest frame for paired samples.
  await page.locator('.maplibregl-canvas').waitFor({ state: 'attached' })
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)))
  // Keep the shapes and blur radii but force the roof lights to paint with black ink.
  await page.addStyleTag({
    content:
      '.pavilion-lamps i { background: black !important; box-shadow: 0 0 4px 2px black, 0 0 14px 3px black !important }',
  })
  const lamp = page.locator('.pavilion-lamps i').first()
  const glimmer = await lamp.evaluateHandle(el => el.getAnimations()[0])
  await page.locator('.pavilion-book').tap()
  const bloom = page.locator('.atlas-intro.is-exiting .pavilion-bloom')
  await bloom.waitFor()
  assert.ok(
    await lamp.evaluate(
      (el, before) =>
        before && el.getAnimations()[0] === before && before.playState === 'paused',
      glimmer,
    ),
  )
  await bloom.evaluate(el => {
    const intro = el.closest('.atlas-intro')
    for (const animation of intro.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = 550
    }
  })
  assert.ok(await bloom.evaluate(el => Number(getComputedStyle(el).opacity) > 0.9))
  const lit = await shot('pavilion-orb-launch')
  const lamps = page.locator('.pavilion-lamps')
  const centers = await lamps.locator('i').evaluateAll(elements =>
    elements
      .map(el => {
        const box = el.getBoundingClientRect()
        return [Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2)]
      })
      .filter(([x, y]) => x >= 0 && x < innerWidth && y >= 0 && y < innerHeight),
  )
  assert.ok(centers.length > 0, 'Roof lamps are visible during launch')
  await lamps.evaluate(el => {
    el.style.visibility = 'hidden'
  })
  const grey = png => sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  const withLamps = await grey(lit)
  const withoutLamps = await grey(await page.screenshot())
  const gains = centers.map(([x, y]) => {
    const index = y * withLamps.info.width + x
    return withLamps.data[index] - withoutLamps.data[index]
  })
  assert.ok(
    gains.every(gain => gain >= -2) && Math.max(...gains) > 5,
    `Roof lights should brighten the rafters, measured differences ${gains}`,
  )
  await lamps.evaluate(el => {
    el.style.visibility = ''
  })
  const book = await page.locator('.pavilion-book').boundingBox()
  const sample = {
    left: Math.round(book.x + book.width / 2) - 8,
    top: Math.round(book.y + book.height / 2) - 8,
    width: 16,
    height: 16,
  }
  await bloom.evaluate(el => {
    el.style.visibility = 'hidden'
  })
  const unlit = await page.screenshot()
  const mean = async png => {
    const pixels = await sharp(png).extract(sample).greyscale().raw().toBuffer()
    return pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length
  }
  const gain = (await mean(lit)) - (await mean(unlit))
  assert.ok(gain > 25, `Orb launch should brighten the book, measured gain ${gain}`)
  console.log(`Orb launch increased mean brightness by ${gain.toFixed(1)} / 255`)
} finally {
  await browser.close()
}
