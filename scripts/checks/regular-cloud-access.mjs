import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const y = 114420
const image = '/hku-skyscrapers-in-place/mirror-garden/the-borrowed-horizon.webp'
const single = x => ({ title: 'Single ' + x, x, y, rows: 1, url: image + '?single=' + x })
const wide = { title: 'Two-tile painting', x: 214168, y, columns: 2, rows: 1, url: image + '?wide' }
const art = [single(214165), single(214166), single(214167), single(214168), wide]
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(({ x, y }) => {
    const center = [(x + 0.5) / 262144 * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 262144))) * 180 / Math.PI]
    history.replaceState({ atlasModeCamera: { center, zoom: 17 } }, '')
  }, { x: 214167, y })
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({
    json: { release: 'v2', sheets: [{ accepted: true, art }] },
  }))
  await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [] }))
  await page.route('**/api/fog-index/**', route => route.fulfill({ json: {
    eligibility: [214165, 214166, 214167].map(x => ({
      x, y, regionalLandAvailable: true, isTargetable: x !== 214166, landFraction: x === 214166 ? 0 : 1,
    })),
  } }))
  await page.route('**' + image + '?*', route => route.fulfill({ path: 'public/romantic-paper-texture.png' }))
  const requested = []
  page.on('request', request => {
    if (request.url().includes(image)) requested.push(new URL(request.url()).search)
  })
  await page.goto(base + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
  const fog = page.locator('.atlas-fog')
  await fog.waitFor()
  const centerX = x => 720 + (x - 214167) * 256
  const alpha = x => fog.evaluate((canvas, px) => {
    const rect = canvas.getBoundingClientRect()
    const copy = document.createElement('canvas')
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext('2d')
    context.drawImage(canvas, 0, 0)
    return context.getImageData((px - rect.x) * canvas.width / rect.width,
      (450 - rect.y) * canvas.height / rect.height, 1, 1).data[3]
  }, centerX(x))
  const deadline = Date.now() + 30000
  while ((!await alpha(214165) || !await alpha(214168)) && Date.now() < deadline) await page.waitForTimeout(100)
  for (const [x, cloud] of [[214165,true],[214166,false],[214167,false],[214168,true],[214169,true]]) {
    assert.equal((await alpha(x)) > 0, cloud, 'Cloud at ' + x)
    await page.mouse.move(centerX(x), 450)
    await page.waitForTimeout(80)
    assert.equal(await page.locator('.maplibregl-canvas').evaluate(el => el.style.cursor === 'pointer'), cloud, 'Cursor at ' + x)
    if (!cloud) await page.mouse.click(centerX(x), 450)
  }
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'regular-cloud-access.png') })
  await page.mouse.click(centerX(214168), 450)
  await page.locator('.atlas-title-card').waitFor()
  assert.deepEqual([...new Set(requested)], ['?wide'])
} finally {
  await browser.close()
}
