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
  await page.route('**' + image + '?*', async route => route.fulfill({ response: await route.fetch({ url: base + image }) }))
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

  // Revealed artwork can sit outside the cloud grid. Empty cells still obey it.
  const alternative = { ...wide, title: 'Another wide painting', url: image + '?alternative' }
  const rejected = { ...wide, title: 'Rejected painting', url: image + '?rejected' }
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({
    json: { release: 'v2', sheets: [{ art: [wide, alternative, rejected] }] },
  }))
  await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [{ ...rejected, status: 'rejected' }] }))
  await page.route('**/api/atlas-tiles/cached?*', route => route.fulfill({ json: { tiles: [] } }))
  await page.goto(base + '/?revealed&noMusic', { waitUntil: 'domcontentloaded' })
  const title = page.locator('.atlas-title-card:visible')
  await title.waitFor()
  const chosen = await title.innerText()
  assert.ok([wide.title, alternative.title].includes(chosen))
  assert.equal(await page.locator('.atlas-image-count,.atlas-title-card.is-awaiting-focus').count(), 0)
  const fogDeadline = Date.now() + 30000
  while (!await alpha(214165) && Date.now() < fogDeadline) await page.waitForTimeout(100)
  for (const [x, cloud] of [[214165,true],[214166,false],[214167,false],[214168,false],[214169,false]]) {
    assert.equal((await alpha(x)) > 0, cloud, 'Revealed-mode cloud at ' + x)
  }
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'revealed-cloud-grid.png') })
  const drag = async (from, to) => {
    await page.mouse.move(from, 400)
    await page.mouse.down()
    await page.mouse.move(to, 400, { steps: 16 })
    await page.waitForTimeout(180)
    await page.mouse.up()
  }
  await drag(120, 1320)
  await title.waitFor({ state: 'hidden' })
  await drag(1320, 120)
  await title.waitFor()
  assert.equal(await title.innerText(), chosen)
  await page.keyboard.press('r')
  await page.waitForURL(url => !url.searchParams.has('revealed'))
  await page.locator('.atlas-fog').waitFor()
  assert.equal(await title.count(), 0)

  const live = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await live.goto(base + '/?revealed&noMusic', { waitUntil: 'domcontentloaded' })
  await live.locator('.atlas-title-card:visible').first().waitFor()
  await live.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'revealed-map.png') })
} finally {
  await browser.close()
}
