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
  const touch = await page.context().newCDPSession(page)
  await touch.send('Emulation.setAutoDarkModeOverride', { enabled: true })
  const shot = name =>
    page.screenshot({ path: join(process.env.DEV_RUNNER_ARTIFACTS, `${name}.png`) })
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noMusic`, {
    waitUntil: 'domcontentloaded',
  })
  const notes = page.locator('.pavilion-notes')
  await page.locator('#map:not([inert]) .atlas-intro.is-visible').waitFor()
  await page.locator('.pavilion-curtain').waitFor({ state: 'hidden' })
  assert.equal(
    await page.locator('.pavilion-title h1').evaluate(el => getComputedStyle(el).color),
    'rgb(0, 0, 0)',
  )
  assert.equal(await page.locator('.pavilion-orrery').isVisible(), false)
  assert.equal(await notes.isVisible(), false)
  const credit = await page.locator('.pavilion-credit').boundingBox()
  const room = await page.locator('.pavilion-room').boundingBox()
  assert.match(
    await page.locator('meta[name=viewport]').getAttribute('content'),
    /viewport-fit=cover/,
  )
  const safeArea = insets =>
    touch.send('Emulation.setSafeAreaInsetsOverride', { insets })
  const petalCenterX = (credit.x + credit.width / 2 - room.x) / room.width
  const roomArt = await page.locator('.pavilion-garden').boundingBox()
  const petalCenterY = (credit.y + credit.height / 2 - roomArt.y) / roomArt.height
  assert.ok(Math.abs(petalCenterX - 0.73) < 0.01)
  assert.ok(Math.abs(petalCenterY - 0.815) < 0.002)
  assert.ok(credit.y + credit.height < room.y + room.height)
  const title = page.locator('.pavilion-title')
  for (const balloon of await page.locator('.pavilion-aerostat').all()) {
    const rect = await balloon.boundingBox()
    const inset = Math.min(rect.x - room.x, room.x + room.width - rect.x - rect.width)
    assert.ok(Math.abs(inset / room.width - 0.185) < 0.01)
    assert.ok(rect.width >= 21)
    assert.ok(rect.y + rect.height < (await title.boundingBox()).y)
  }
  const atlas = await page.locator('.pavilion-book').boundingBox()
  const heading = await title.boundingBox()
  const cloud = await page
    .locator('.pavilion-sky canvas:not(.pavilion-sky__far)')
    .boundingBox()
  assert.ok(heading.y + heading.height < cloud.y)
  assert.ok(atlas.y + atlas.height < credit.y)
  assert.ok(Math.abs((atlas.y + atlas.height) / room.height - 0.81) < 0.01)
  await shot('pavilion')
  // Repeat with a shorter visible viewport, as when mobile browser bars expand.
  await page.setViewportSize({ width: 384, height: 650 })
  const visibleHeight = await page.evaluate(() => visualViewport.height)
  const shorter = await page.locator('.pavilion-room').boundingBox()
  const petal = await page.locator('.pavilion-credit img').boundingBox()
  assert.equal(shorter.height, visibleHeight)
  assert.ok(visibleHeight - petal.y - petal.height > visibleHeight * 0.06)
  await shot('pavilion-short-viewport')
  await page.setViewportSize({ width: 384, height: 722 })
  await safeArea({ top: 59, bottom: 76 })
  assert.deepEqual(await page.locator('.pavilion-room').boundingBox(), room)
  const insetCredit = await page.locator('.pavilion-credit').boundingBox()
  const insetAtlas = await page.locator('.pavilion-book').boundingBox()
  assert.ok(insetAtlas.y + insetAtlas.height + 12 < insetCredit.y)
  assert.ok(insetCredit.y + insetCredit.height + 24 < room.height - 76)

  // The first and last painted rows must contain artwork across their width, even inside the insets.
  const checkEdges = async name => {
    const png = await shot(name)
    const { data, info } = await sharp(png)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    for (const row of [1, info.height - 2]) {
      const pixels = data.subarray(row * info.width, (row + 1) * info.width)
      assert.ok(new Set(pixels).size > 16, `Flat strip in ${name} at row ${row}`)
    }
  }
  // Safari may expose the document canvas around a composited scene. Inspect that
  // canvas on its own as well as checking both edges of the assembled artwork.
  const checkBackdrop = async (night = false) => {
    const root = page.locator('html')
    const backdrop = await root.evaluate(el => getComputedStyle(el).backgroundImage)
    const painting = await page
      .locator('.pavilion-room')
      .evaluate(
        (el, night) => getComputedStyle(el, night ? '::before' : null).backgroundImage,
        night,
      )
    assert.match(painting, /glasshouse-portrait/)
    assert.equal(backdrop, painting)
    const hideScene = await page.addStyleTag({ content: 'main { visibility: hidden }' })
    try {
      await checkEdges(night ? 'document-backdrop-night' : 'document-backdrop-day')
    } finally {
      await hideScene.evaluate(el => el.remove())
    }
  }
  await checkBackdrop()
  // Model a large viewport extending below the visible one. The room must travel
  // with the document when the user scrolls past the expanded toolbar.
  const taller = await page.addStyleTag({ content: '#map { min-height: 820px }' })
  try {
    await page.evaluate(() => window.scrollTo(0, 56))
    assert.equal(await page.evaluate(() => scrollY), 56)
    assert.equal((await page.locator('.pavilion-room').boundingBox()).y, -56)
  } finally {
    await page.evaluate(() => window.scrollTo(0, 0))
    await taller.evaluate(el => el.remove())
  }
  await checkEdges('pavilion-safe-area')
  const togglePortraitNight = async () => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.locator('.pavilion-orrery').tap()
    await page.setViewportSize({ width: 384, height: 722 })
    await page.locator('.pavilion-room').evaluate(el =>
      Promise.all(
        el
          .getAnimations({ subtree: true })
          .filter(a => a.transitionProperty === 'opacity')
          .map(a => a.finished),
      ),
    )
  }
  await togglePortraitNight()
  const nightAtlas = await page.locator('.pavilion-book').boundingBox()
  assert.ok(nightAtlas.y + nightAtlas.height + 12 < insetCredit.y)
  await checkEdges('pavilion-safe-area-night')
  await checkBackdrop(true)
  await togglePortraitNight()
  await safeArea({})
  for (const [width, height] of [
    [834, 1194],
    [1024, 1366],
  ]) {
    await page.setViewportSize({ width, height })
    assert.equal(await notes.isVisible(), false)
    assert.equal(await page.locator('.pavilion-book').isVisible(), true)
    const art = await page.locator('.pavilion-credit__art img').boundingBox()
    assert.ok(Math.abs(art.width - width * 0.18) < 1)
    assert.ok(art.y + art.height < height)
    await shot(`pavilion-tablet-${width}`)
  }
  // Cross the portrait artwork breakpoint one pixel at a time.
  const positions = []
  for (const width of [649, 650]) {
    await page.setViewportSize({ width, height: 722 })
    positions.push(
      await page
        .locator('.pavilion-title, .pavilion-aerostat')
        .evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top)),
    )
  }
  positions[0].forEach((y, index) => {
    assert.ok(Math.abs(y - positions[1][index]) < 1)
  })
  await page.setViewportSize({ width: 384, height: 722 })
  const pages = page.locator('.note-pages')
  async function readBook(source) {
    await pages.evaluate(async el => {
      await Promise.all(
        el
          .closest('section')
          .getAnimations({ subtree: true })
          .map(a => a.finished),
      )
    })
    const close = pages.getByRole('button', { name: 'Close the artist statement' })
    const before = await close.boundingBox()
    await pages.evaluate(el => {
      el.scrollTop = el.scrollHeight
    })
    const rect = await pages.boundingBox()
    assert.ok(rect.y >= 15 && rect.y + rect.height <= 707, JSON.stringify(rect))
    assert.ok(await pages.evaluate(el => el.scrollTop > 0))
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    })
    for (const distance of [20, 60, 100, 140]) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - distance }],
      })
      await page.evaluate(() => new Promise(requestAnimationFrame))
    }
    assert.deepEqual(await pages.boundingBox(), rect)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    assert.equal(await page.evaluate(() => window.scrollY), 0)
    assert.equal(await pages.evaluate(el => el.closest('section').scrollTop), 0)
    assert.deepEqual(await close.boundingBox(), before)
    assert.ok(
      await close.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return (
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ) === el
        )
      }),
    )
    await shot(`${source}-book`)
    await close.tap()
    await pages.waitFor({ state: 'hidden' })
  }
  await page.setViewportSize({ width: 844, height: 390 })
  assert.equal(await notes.isVisible(), false)
  await page.setViewportSize({ width: 1280, height: 800 })
  assert.equal(await notes.isVisible(), true)
  await page.setViewportSize({ width: 384, height: 722 })
  await page.locator('.pavilion-book').tap()
  await page.locator('.atlas-intro').waitFor({ state: 'hidden' })
  assert.equal(
    await page.locator('html').evaluate(el => getComputedStyle(el).backgroundImage),
    'none',
  )
  const trigger = page.getByRole('button', { name: "Cartographer's Note", exact: true })
  await page.setViewportSize({ width: 844, height: 390 })
  await safeArea({ left: 47, right: 47, bottom: 21 })
  const audio = await page.locator('.atlas-audio-control').boundingBox()
  const attribution = await page.locator('.maplibregl-ctrl-attrib').boundingBox()
  const note = await trigger.boundingBox()
  assert.ok(audio.x >= 47 && audio.y + audio.height <= 390 - 21 + 1)
  assert.ok(attribution.x + attribution.width <= 844 - 47 + 1)
  assert.ok(attribution.y + attribution.height <= 390 - 21 + 1)
  assert.ok(note.x + note.width <= 844 - 47 + 1)
  await safeArea({})
  await page.setViewportSize({ width: 384, height: 722 })
  assert.equal(
    await trigger.locator('.artist-statement__map-trigger-label').isVisible(),
    false,
  )
  const palette = () =>
    trigger.evaluate(el => {
      const style = getComputedStyle(el)
      return [
        style.backgroundColor,
        style.backgroundImage,
        style.color,
        style.borderColor,
      ]
    })
  const mobilePalette = await palette()
  await page.setViewportSize({ width: 1280, height: 800 })
  assert.deepEqual(await palette(), mobilePalette)
  await page.setViewportSize({ width: 384, height: 722 })
  await shot('map-button')
  for (const control of [trigger, page.locator('.atlas-audio-control')]) {
    const { data } = await sharp(await control.screenshot())
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const median = data.sort()[Math.floor(data.length / 2)]
    assert.ok(
      median > 170,
      `Expected a light control under auto-darkening, got ${median}`,
    )
  }
  await trigger.tap()
  await readBook('map')
} finally {
  await browser.close()
}
