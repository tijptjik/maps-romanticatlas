import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type()))
      console.log(message.type(), message.text().slice(0, 400))
  })
  page.on('requestfailed', request =>
    console.log(
      'Request failed',
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  )
  page.on('pageerror', error => console.error(error.message))
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true`, {
    waitUntil: 'domcontentloaded',
  })
  const fog = page.locator('.atlas-fog')
  try {
    await fog.waitFor({ timeout: 60000 })
  } catch (error) {
    await page.screenshot({
      path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'missing-fog.png'),
    })
    console.log(await page.locator('body').textContent())
    throw error
  }
  assert.equal(
    await page.locator('.v2-review,.atlas-image-count,.atlas-title-card').count(),
    0,
  )
  const catalog = await (
    await page.request.get(`${process.env.PLAYWRIGHT_BASE_URL}/atlas-v2/catalog.json`)
  ).json()
  const hku = catalog.sheets.find(sheet => sheet.id === 'hku-skyscrapers-current')
  assert.equal(hku.accepted, true)
  const urls = new Set(hku.art.map(art => new URL(art.url, page.url()).href))
  const artwork = page.waitForResponse(r => urls.has(r.url()) && r.ok())
  await page.mouse.click(600, 400)
  await artwork
  await page.locator('.atlas-title-card').waitFor()
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'accepted-reveal.png'),
  })
  const requests = await page
    .evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))
    .then(names => names.map(name => new URL(name)))
  assert.ok(
    requests.some(url => url.pathname.startsWith('/api/fog-index/')),
    'Public map loads regional cloud coverage',
  )
  assert.ok(
    requests
      .filter(url => url.pathname.startsWith('/generated-tiles/'))
      .every(url => url.searchParams.get('variant')?.startsWith('discovery-')),
    'Unreviewed legacy tiles must not preload',
  )
  await page.keyboard.press('d')
  await page.waitForURL('**/*diagnostics*')
  const counter = page.locator('[aria-label$="images on tile 18/214184/114420"]')
  await counter.waitFor()
  assert.equal(Number(await counter.locator('output').textContent()), hku.art.length)
  assert.equal(await counter.isVisible(), true)
  assert.equal(await fog.count(), 0)
  await page.mouse.click(600, 400)
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'diagnostic-images.png'),
  })
  await page.keyboard.press('d')
  assert.equal(new URL(page.url()).searchParams.get('diagnostics'), '')
  const admin = page.waitForResponse(r =>
    r.url().includes('/api/atlas-tiles/cached?admin'),
  )
  await page.keyboard.press('a')
  const response = await admin
  assert.equal(new URL(page.url()).searchParams.has('diagnostics'), false)
  if (response.ok()) {
    assert.equal((await response.json()).adminMode, true)
    await page.locator('#map.atlas-admin-mode').waitFor()
  } else {
    assert.ok([401, 403, 503].includes(response.status()))
    assert.equal(await page.locator('.atlas-admin-actions').count(), 0)
  }
  console.log('Admin manifest status', response.status())
  await page.keyboard.press('r')
  await fog.waitFor()
  assert.equal(new URL(page.url()).searchParams.has('admin'), false)
  // This cell fell in the old seed's 25% gap. Only this cell is eligible in the fixture.
  const x = 214167,
    y = 114420
  await page.addInitScript(
    ({ x, y }) => {
      const lng = ((x + 0.5) / 262144) * 360 - 180
      const lat =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 262144))) * 180) / Math.PI
      history.replaceState({ atlasModeCamera: { center: [lng, lat], zoom: 17 } }, '')
    },
    { x, y },
  )
  const legacyUrl = `/generated-tiles/18/${x}/${y}/legacy`
  let legacyLoads = 0,
    generations = 0
  await page.route('**/api/fog-index/**', route =>
    route.fulfill({
      json: {
        eligibility: [
          { x, y, regionalLandAvailable: true, isTargetable: true, landFraction: 1 },
        ],
        cached: [{ x, y, url: legacyUrl }],
      },
    }),
  )
  await page.route('**/api/atlas-tiles/cache-status*', route =>
    route.fulfill({
      json: {
        statuses: route
          .request()
          .postDataJSON()
          .tiles.map(() => ({ cached: true, url: legacyUrl })),
      },
    }),
  )
  await page.route(`**${legacyUrl}`, route => {
    legacyLoads++
    return route.abort()
  })
  await page.route('**/api/atlas-tiles/18/**', route => {
    const url = new URL(route.request().url())
    assert.ok(url.pathname.startsWith(`/api/atlas-tiles/18/${x}/${y}/`))
    const scene = url.pathname.split('/').pop()
    const visit = url.searchParams.get('discovery')
    assert.ok(visit)
    generations++
    const image = new URL(hku.art[0].url, url)
    image.searchParams.set('variant', `discovery-${visit}-fixture`)
    return route.fulfill({ json: { scene, url: image.href } })
  })
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&noMusic=true`, {
    waitUntil: 'domcontentloaded',
  })
  await fog.waitFor()
  await page.mouse.click(344, 400)
  const readyBy = Date.now() + 30000
  do {
    await page.mouse.move(599, 400)
    await page.mouse.move(600, 400)
    if (
      await page
        .locator('.maplibregl-canvas')
        .evaluate(canvas => canvas.style.cursor === 'pointer')
    )
      break
    await page.waitForTimeout(100)
  } while (Date.now() < readyBy)
  assert.equal(
    await page.locator('.maplibregl-canvas').evaluate(canvas => canvas.style.cursor),
    'pointer',
  )
  await page.mouse.click(600, 400)
  await page
    .locator('.atlas-title-card:not(.is-awaiting-focus)')
    .waitFor({ timeout: 60000 })
  assert.equal(generations, 1)
  assert.equal(legacyLoads, 0)
} finally {
  await browser.close()
}
