import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { isFakeRenderTile } from '../../src/fake-render-state.ts'
const origin = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  })
  const errors = []
  page.on('pageerror', e => {
    if (e.message === 'WebSocket closed without opened.')
      console.log('Vite HMR connection unavailable through the managed tunnel')
    else errors.push(e.message)
  })
  const tile = {
    x: 214210,
    y: 114419,
    rows: 1,
    title: 'The Borrowed Horizon',
    url: '/hku-skyscrapers-in-place/mirror-garden/the-borrowed-horizon.webp',
  }
  const png = tile.url
  let visit = 0
  while (!isFakeRenderTile(tile, visit)) visit++
  await page.route('**/atlas-v2/catalog.json', route =>
    route.fulfill({
      json: { release: 'v2', sheets: [{ accepted: true, art: [tile] }] },
    }),
  )
  await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [] }))
  await page.route('**/api/fog-index/**', route =>
    route.fulfill({
      json: {
        eligibility: [
          { ...tile, isTargetable: true, regionalLandAvailable: true, landFraction: 1 },
        ],
      },
    }),
  )
  const center = [
    ((tile.x + 0.5) / 262144) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / 262144))) * 180) /
      Math.PI,
  ]
  await page.addInitScript(
    center => history.replaceState({ atlasModeCamera: { center, zoom: 18 } }, ''),
    center,
  )
  await page.addInitScript(visit => {
    window.poemDraws = 0
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (
        this.canvas.classList.contains('atlas-fog-loading') &&
        this.globalAlpha > 0.2 &&
        Math.abs(args[1] - innerWidth / 2) < 100 &&
        Math.abs(args[2] - innerHeight / 2) < 240
      ) {
        window.poemDraws++
        if (args[0].startsWith('— ')) window.poemCredit = args[0]
      }
      return fillText.apply(this, args)
    }
    const original = crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues = array =>
      array instanceof Uint32Array && array.length === 1
        ? array.fill(visit)
        : original(array)
  }, visit)
  // Start with all three visitor generation slots occupied so the click exercises the limit.
  await page.route('**/src/atlas-tiles.ts*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const initialState = /const tileState = (?:\/\*[^*]*\*\/ )?new Map\(\)/
    assert.match(source, initialState)
    await route.fulfill({
      response,
      body: source.replace(
        initialState,
        "const tileState = new Map(Array.from({length: 3}, (_, i) => ['18/1/' + i, 'generating']))",
      ),
    })
  })
  let busy = false
  let lostClaim = false
  let claims = 0
  await page.route('**/api/fake-render/**', async route => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          ready: !busy,
          released: [{ url: png, scene: 'maze-garden', title: 'Test garden' }],
        },
      })
    const body = route.request().postDataJSON()
    assert.match(body.sourceImage, /^data:image\/png;base64,/)
    assert.match(body.requestId, /^[a-f0-9-]{36}$/)
    claims++
    if (lostClaim) return route.fulfill({ status: 202, json: { ready: false } })
    await route.fulfill({
      json: {
        url: png,
        scene: 'maze-garden',
        title: 'Test garden',
        contentBounds: null,
      },
    })
  })
  await page.goto(`${origin}/?noSplash=true&noMusic=true`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.atlas-fog').waitFor()
  await page.waitForTimeout(5000)
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'fake-before.png'),
  })
  for (const lost of [false, true]) {
    lostClaim = lost
    if (lost) {
      const ready = page.waitForResponse(response =>
        response.url().includes('availability=1'),
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await ready
    }
    const expectedClaims = lost ? 2 : 1
    const suffix = lost ? '-fallback' : ''
    const start = Date.now()
    const claimed = page.waitForResponse(
      response =>
        response.url().includes('/api/fake-render/') &&
        response.request().method() === 'POST',
    )
    await page.mouse.click(720, 500)
    await claimed
    await page.waitForFunction(() => window.poemDraws > 0)
    assert.equal(claims, expectedClaims)
    assert.equal(
      await page.locator('.atlas-title-card').count(),
      0,
      'Artwork waits for the poem',
    )
    await page.screenshot({
      path: path.join(process.env.DEV_RUNNER_ARTIFACTS, `fake-poem${suffix}.png`),
    })
    await page.waitForFunction(() => window.poemCredit, undefined, { timeout: 150000 })
    await page
      .locator('.atlas-title-card:not(.is-awaiting-focus)')
      .first()
      .waitFor({ state: 'visible' })
    assert.ok(Date.now() - start > 15000, 'The poem is actually read')
    assert.equal(claims, expectedClaims)
    await page.screenshot({
      path: path.join(process.env.DEV_RUNNER_ARTIFACTS, `fake-after${suffix}.png`),
    })
    console.log(
      'One poem then reveal in',
      Date.now() - start,
      'ms; cell',
      tile.x,
      tile.y,
    )
  }
  busy = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.atlas-fog').waitFor()
  await page.waitForTimeout(5000)
  await page.mouse.click(720, 500)
  await page
    .locator('.atlas-title-card:not(.is-awaiting-focus)')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(
    await page.evaluate(() => window.poemDraws),
    0,
    'Rainbow never draws a poem',
  )
  assert.equal(
    claims,
    2,
    'Rainbow reveals released art while the replacement is pending',
  )
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'rainbow-after.png'),
  })
  await page.goto(`${origin}/?noSplash=true&noMusic=true&noFakeRender=true`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.atlas-fog').waitFor()
  await page.waitForTimeout(3000)
  await page.mouse.click(720, 500)
  await page
    .locator('.atlas-title-card:not(.is-awaiting-focus)')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(claims, 2, 'Override makes no rotating claim')
  await page.route('**/atlas-v2/catalog.json', route =>
    route.fulfill({ json: { release: 'v2', sheets: [] } }),
  )
  await page.route('**/api/atlas-tiles/cache-status*', route =>
    route.fulfill({
      json: {
        statuses: route
          .request()
          .postDataJSON()
          .tiles.map(() => ({ cached: false, scenes: [] })),
      },
    }),
  )
  let generationRequests = 0
  await page.route('**/api/atlas-tiles/18/**', route => {
    if (route.request().method() === 'POST') generationRequests++
    return route.fulfill({ status: 503, json: {} })
  })
  const eligibilityLoaded = page.waitForResponse(response =>
    response.url().includes('/api/fog-index/'),
  )
  await page.goto(`${origin}/?noSplash=true&noMusic=true`, {
    waitUntil: 'domcontentloaded',
  })
  await eligibilityLoaded
  await page.locator('.atlas-fog').waitFor()
  const canvas = page.locator('.maplibregl-canvas')
  for (let attempt = 0; attempt < 50; attempt++) {
    await page.mouse.move(720 + (attempt % 2), 500)
    if (await canvas.evaluate(el => el.style.cursor === 'pointer')) break
    await page.waitForTimeout(100)
  }
  await page.mouse.click(720, 500)
  const notice = page.locator('.atlas-clearance-notice.is-visible')
  await notice.waitFor()
  assert.equal(await notice.locator('strong').textContent(), 'Hold up')
  assert.equal(
    await notice.locator('span').textContent(),
    'Discovery is not for speedrunners',
  )
  assert.equal(
    generationRequests,
    0,
    'Fourth discovery is stopped before requesting a render',
  )
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'fourth-discovery.png'),
  })
  assert.deepEqual(errors, [])
  console.log('Override preserves immediate cached reveal')
} finally {
  await browser.close()
}
