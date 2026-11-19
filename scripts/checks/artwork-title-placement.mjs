import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  for (const [title, width, height] of [
    ['The Herbarium Unpressed', 960, 720],
    ['The Theatre That Grows Back', 960, 720],
    ['The Office of Unwanted Gifts', 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } })
    page.on('pageerror', error => console.error(error.message))
    page.on('console', message => {
      if (message.type() === 'error') console.error(message.text())
    })
    console.log('Revealing', title)
    const catalog = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
    const art = catalog.sheets.flatMap(sheet => sheet.art).find(art => art.title === title)
    await page.route('**/atlas-v2/catalog.json', route => route.fulfill({
      json: { release: 'v2', sheets: [{accepted: true, art: [art]}] },
    }))
    await page.route('**/api/artwork-reviews', route => route.fulfill({json: []}))
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('installArtworkSampling(map)', 'window.testAtlasMap = map; installArtworkSampling(map)')
      await route.fulfill({ response, body })
    })
    await page.addInitScript(({x, y}) => {
      const lng = (x + 0.5) / 262144 * 360 - 180
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 262144))) * 180 / Math.PI
      history.replaceState({atlasModeCamera: {center: [lng, lat], zoom: 18}}, '')
    }, art)
    await page.goto(base + '/?noSplash=true&noMusic', {waitUntil: 'domcontentloaded'})
    await page.locator('.atlas-fog').waitFor({timeout: 60000})
    await page.mouse.click(width / 2, height / 2)
    const card = page.locator('.atlas-title-card:not(.is-awaiting-focus)')
    await card.waitFor()
    assert.equal(await card.innerText(), title)
    if (title === 'The Herbarium Unpressed') {
      await page.evaluate(() => document.fonts.ready)
      const sizes = []
      for (const zoom of [18, 17, 16]) {
        await page.evaluate(zoom => window.testAtlasMap.jumpTo({zoom}), zoom)
        await page.waitForTimeout(750)
        sizes.push(await card.evaluate(el => {
          const {width, height} = el.getBoundingClientRect()
          return {width, height, lines: el.firstChild.offsetHeight / parseFloat(getComputedStyle(el.firstChild).lineHeight)}
        }))
      }
      console.log(title, sizes)
      assert.ok(sizes.every(size => Math.round(size.lines) === 2))
      assert.ok(sizes[0].height >= 48 && sizes[0].height <= 55)
      assert.ok(Math.abs(sizes[0].width - sizes[1].width) < 1)
      assert.ok(sizes[2].width < sizes[1].width && sizes[2].height < sizes[1].height)
      await page.evaluate(() => window.testAtlasMap.jumpTo({zoom: 18}))
    }
    for (const zoomOut of [false, true]) {
      if (zoomOut) await page.evaluate(() => window.testAtlasMap.zoomOut({duration: 0}))
      await page.waitForFunction(() => !window.testAtlasMap.isMoving())
      const coveredColumns = await card.evaluate(async (card, art) => {
        const map = window.testAtlasMap
        const source = map.getSource('atlas-tile-' + art.x + '-' + art.y)
        const a = map.project(source.coordinates[0])
        const b = map.project(source.coordinates[2])
        const image = new Image()
        image.src = art.url
        await image.decode()
        const canvas = document.createElement('canvas')
        const scale = Number(getComputedStyle(card).scale)
        canvas.width = Math.round(card.offsetWidth * scale)
        canvas.height = 6
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, a.x - card.offsetLeft - card.offsetWidth * (1 - scale) / 2, a.y - card.offsetTop - card.offsetHeight * (1 - scale) / 2, b.x - a.x, b.y - a.y)
        const pixels = ctx.getImageData(0, 0, canvas.width, 1).data
        return pixels.filter((alpha, i) => i % 4 === 3 && alpha > 96).length / canvas.width
      }, art)
      assert.ok(coveredColumns > 0.07, title + ' painted fraction ' + coveredColumns)
    }
    await page.screenshot({path: path.join(process.env.DEV_RUNNER_ARTIFACTS, art.x + '-title-' + width + '.png')})
    await page.close()
  }
} finally {
  await browser.close()
}
