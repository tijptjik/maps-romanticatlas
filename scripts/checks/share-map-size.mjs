import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import media from '../../releases/assets.json' with { type: 'json' }
import { chromium } from 'playwright'
import sharp from 'sharp'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 }, hasTouch: true })
  // Check the frame selected by the real app before using a controlled canvas for pixel assertions.
  await page.goto(process.env.PLAYWRIGHT_BASE_URL, { waitUntil: 'domcontentloaded' })
  const actualFrame = page.locator('.atlas-share-frame img')
  const frameUrl = await actualFrame.evaluate(async img => {
    await img.decode()
    return img.currentSrc
  })
  const frame = await (await page.request.get(frameUrl)).body()
  const digest = createHash('sha256').update(frame).digest('hex')
  assert.equal(media['/pavilion/orchid-camera-frame.webp'], 'release-assets/' + digest + '.webp')
  const background = await page.locator('.atlas-share-result').evaluate(el => getComputedStyle(el).backgroundImage)
  assert.ok(background.includes('orchid-share-frame'), 'QR dialog lost its print frame')
  // Serve a controlled canvas on the app origin and exercise its real sharing UI and API.
  await page.route('**/share-test-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/style.css"><style>#map{position:relative;width:min(580px,100vw);height:min(835px,100dvh)} canvas{width:100%;height:100%;background:#adcac0}</style><div id="map"><canvas width="2160" height="2700"></canvas></div>',
  }))
  await page.goto(new URL('/share-test-fixture', process.env.PLAYWRIGHT_BASE_URL).href)
  await page.evaluate(async () => {
    const { installAtlasSharing } = await import('/src/atlas-sharing.ts')
    const container = document.querySelector('#map')
    const { createAtlasTitleCard } = await import('/src/atlas-title-cards.ts')
    const card = createAtlasTitleCard(container, '', 'The Rain Inheritance')
    card.classList.remove('is-awaiting-focus')
    card.style.cssText = 'top:30%;left:25%;width:110px'
    const fillText = CanvasRenderingContext2D.prototype.fillText
    window.titleLines = []
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.textAlign === 'center') window.titleLines.push(text)
      return fillText.call(this, text, ...args)
    }
    installAtlasSharing({
      getContainer: () => container,
      getCanvas: () => container.querySelector('canvas'),
      getPixelRatio: () => 4,
      triggerRepaint() {},
      on() {},
    }).setRevealCount(5)
  })
  await page.waitForFunction(() => {
    const trigger = document.querySelector('.atlas-share-button--trigger')
    return trigger && getComputedStyle(trigger).opacity === '1'
  })
  const iconWidth = await page.locator('.atlas-share-button--trigger svg').evaluate(svg => svg.getBoundingClientRect().width)
  assert.ok(iconWidth <= 20, 'Share glyph crowds the enamel plate')
  await page.getByRole('button', { name: 'Share your map' }).screenshot({ animations: 'disabled', path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'share-button.png') })
  await page.getByRole('button', { name: 'Share your map' }).click()
  for (const detailed of [false, true]) {
    if (detailed) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Retake' }).click()
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        const context = canvas.getContext('2d')
        const pixels = context.createImageData(canvas.width, canvas.height)
        let seed = 1
        for (let i = 0; i < pixels.data.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
          pixels.data[i] = seed >>> 24
          pixels.data[i + 1] = (seed >>> 16) & 255
          pixels.data[i + 2] = (seed >>> 8) & 255
          pixels.data[i + 3] = 255
        }
        context.putImageData(pixels, 0, 0)
      })
    }
    await page.locator('.atlas-share-frame img').evaluate(img => img.decode())
    const frameBox = await page.locator('.atlas-share-frame').boundingBox()
    const shutter = await page.getByRole('button', { name: 'Snap this map' }).boundingBox()
    const socketX = frameBox.x + frameBox.width / 2
    const socketY = frameBox.y + frameBox.height * 0.937
    assert.ok(Math.abs(shutter.x + shutter.width / 2 - socketX) < 1)
    assert.ok(Math.abs(shutter.y + shutter.height / 2 - socketY) < 1)
    assert.ok(shutter.height >= 44 && shutter.width >= 44)
    const swatch = [52, 147, 137]
    await page.evaluate(rgb => {
      const canvas = document.querySelector('canvas')
      const bounds = canvas.getBoundingClientRect()
      const frame = document.querySelector('.atlas-share-frame').getBoundingClientRect()
      const scale = canvas.width / bounds.width
      const x = (frame.left - bounds.left + frame.width * 0.45) * scale
      const y = (frame.top - bounds.top + frame.height * 0.45) * scale
      const context = canvas.getContext('2d')
      context.fillStyle = 'rgb(' + rgb.join(',') + ')'
      context.fillRect(x - 20, y - 20, 40, 40)
    }, swatch)
    await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'compose-' + detailed + '.png') })
    const saved = page.waitForResponse(response => response.url().endsWith('/api/share-maps'))
    await page.evaluate(() => { window.titleLines.length = 0 })
    if (detailed) await page.touchscreen.tap(socketX, socketY)
    else await page.mouse.click(socketX, socketY)
    const response = await saved
    assert.equal(response.status(), 200, await response.text())
    const lines = await page.evaluate(() => window.titleLines)
    assert.ok(lines.includes('The Rain') && lines.includes('Inheritance'), JSON.stringify(lines))
    assert.ok(lines.includes('TIJPTJIK') && !lines.includes('by TIJPTJIK'))
    const { url } = await response.json()
    const download = await page.request.get(url)
    assert.equal(download.status(), 200)
    const png = await download.body()
    const { width, height } = await sharp(png).metadata()
    assert.deepEqual([width, height], detailed ? [1080, 1350] : [2160, 2700])
    assert.ok(png.length <= 8_000_000)
    const pixel = await sharp(png)
      .extract({ left: Math.floor(width * 0.45), top: Math.floor(height * 0.45), width: 1, height: 1 })
      .removeAlpha().raw().toBuffer()
    assert.deepEqual([...pixel], swatch, 'Map RGB changed during PNG export')
    const cornerWidth = Math.ceil(width * 0.27)
    const cornerHeight = Math.ceil(height * 0.12)
    await sharp(png)
      .extract({ left: Math.floor(width * 0.67), top: Math.floor(height * 0.80), width: cornerWidth, height: cornerHeight })
      .toFile(path.join(process.env.DEV_RUNNER_ARTIFACTS, 'credit-' + width + '.png'))
    if (!detailed) {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const alpha = (x, y) => data[(Math.floor(y * height) * width + Math.floor(x * width)) * info.channels + 3]
      assert.ok(alpha(0.5, 0.934) > 240, 'Bottom rail missing from export')
      assert.equal(alpha(0.5, 0.5), 0, 'Frame aperture obscures the map')
      const credit = await sharp(png).extract({
        left: Math.floor(width * 0.78), top: Math.floor(height * 0.85),
        width: Math.floor(width * 0.13), height: Math.floor(height * 0.055),
      }).stats()
      assert.ok(credit.channels[3].max > 240, 'Credit missing inside the frame')
    }
    const outside = await sharp(png).extract({ left: Math.floor(width / 2), top: 2, width: 1, height: 1 }).ensureAlpha().raw().toBuffer()
    assert.equal(outside[3], 0, 'Outside edge must remain transparent')
    const qr = page.getByAltText('QR code for your map image')
    await qr.evaluate(img => img.decode())
    await qr.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'qr-' + width + '.png') })
    await page.getByRole('dialog').screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'result-' + width + '.png') })
    await qr.click()
    assert.equal(await page.getByRole('dialog').getByRole('button').count(), 1)
    if (!detailed) {
      await page.mouse.click(3, 3)
      await page.getByRole('button', { name: 'Share your map' }).click()
      await page.getByRole('button', { name: 'Snap this map' }).click()
      await page.getByRole('dialog').waitFor()
    }
    console.log(width, height, png.length, 'bytes')
  }
  await page.touchscreen.tap(3, 3)
  assert.ok(await page.getByRole('dialog').isHidden())
  assert.ok(await page.getByRole('button', { name: 'Share your map' }).isVisible())
} finally {
  await browser.close()
}
