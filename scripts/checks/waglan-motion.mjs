import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { join } from 'node:path'

const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS] })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.reviewMap = map; installArtworkSampling(map)')
    await route.fulfill({ response, body })
  })
  const base = process.env.PLAYWRIGHT_BASE_URL
  const { sheets } = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
  const sheet = sheets.find(s => s.id === 'waglan-pneumatic-works')
  const [art] = sheet.art
  const id = 'v2-' + art.x + '-' + art.y
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(base + '/?review&card=' + sheet.id)
  await page.waitForFunction(id => window.reviewMap?.getSource(id)?.image?.width, id)
  await page.evaluate(id => { window.still = window.reviewMap.getSource(id).image }, id)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(id => {
    const image = window.reviewMap.getSource(id).image
    if (image === window.still) return false
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 80
    const ctx = canvas.getContext('2d')
    if (image instanceof ImageData) return false
    ctx.drawImage(image, 0, 0, 160, 80)
    const key = canvas.toDataURL()
    window.framesSeen ??= new Set()
    window.framesSeen.add(key)
    return window.framesSeen.size >= 6
  }, id)
  await page.screenshot({ path: join(process.env.DEV_RUNNER_ARTIFACTS, 'waglan-motion.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(id => window.reviewMap.getSource(id).image === window.still, id)
  assert.equal(await page.locator('.v2-review output').innerText(), `1/${sheet.art.length} · ` + art.title)
} finally {
  await browser.close()
}
