import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.atlasMap = map; installArtworkSampling(map)')
    await route.fulfill({ response, body })
  })
  const art = (title, dx, dy, rows = 1) => ({
    x: 214184 + dx, y: 114420 + dy, title, rows, url: '/fixture/' + title + '.png',
  })
  const first = art('A', 0, 0), alternate = art('B', 0, 0), east = art('East', 1, 0, 2)
  const north = art('North', 0, -1, 2), northeast = art('Northeast', 1, -1)
  const accepted = art('Accepted', -1, 0), rejected = art('Rejected', -1, 0)
  const records = new Map([[rejected.url, { ...rejected, status: 'rejected' }]])
  const requested = new Set()
  const png = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#e62359' } }).png().toBuffer()
  const blue = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#2244dd' } }).png().toBuffer()
  await page.route('**/fixture/*', route => {
    requested.add(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: 'image/png', body: route.request().url().endsWith(first.url) ? png : blue })
  })
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({ json: { release: 'v2', sheets: [
    { art: [north, east, northeast, first, rejected, first] }, { accepted: true, art: [accepted] },
  ] } }))
  await page.route('**/api/atlas-tiles/cached?*', route => route.fulfill({ json: { tiles: [
    { ...alternate, variant: 'discovery-test', scene: 'circus', title: 'Midnight Circus' },
  ] } }))
  await page.addInitScript(() => sessionStorage.setItem('atlas-admin-token', 'review-test'))
  await page.context().addCookies([{ name: 'atlas_csrf', value: 'fixture-session', url: base }])
  let revisionJobs = []
  await page.route('**/api/artwork-revisions*', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: revisionJobs })
    assert.equal(request.headers().authorization, 'Bearer review-test')
    assert.equal(request.headers()['x-atlas-csrf-token'], 'fixture-session')
    const { source, mode, mapImage, previousImage } = request.postDataJSON()
    assert.notEqual(mapImage, previousImage)
    for (const data of [mapImage, previousImage]) {
      const dimensions = await sharp(Buffer.from(data.split(',')[1], 'base64')).metadata()
      assert.equal(dimensions.width, 1024)
      assert.equal(dimensions.height, 1024)
    }
    const job = { source, mode, state: 'pending' }
    revisionJobs.push(job)
    return route.fulfill({ status: 202, json: job })
  })
  await page.route('**/api/artwork-reviews*', route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: [...records.values()] })
    assert.equal(new URL(request.url()).searchParams.get('admin'), 'true')
    assert.equal(request.headers().authorization, 'Bearer review-test')
    assert.equal(request.headers()['x-atlas-csrf-token'], 'fixture-session')
    assert.match(request.headers().cookie, /atlas_csrf=fixture-session/)
    const record = request.postDataJSON()
    if (request.method() === 'DELETE') records.delete(record.url)
    else records.set(record.url, record)
    return route.fulfill({ json: record })
  })
  await page.goto(base + '/review', { waitUntil: 'domcontentloaded' })
  const panel = page.locator('.atlas-review-queue')
  const complete = page.locator('.atlas-review-queue[data-complete="true"]')
  async function ready(title) {
    await panel.locator('.atlas-title-card__title').filter({ hasText: title }).waitFor()
    await page.locator('.atlas-review-queue[aria-busy="false"]').waitFor()
  }
  async function checkOverlap(visible, hidden) {
    const urls = await page.evaluate(() => Object.values(window.atlasMap.getStyle().sources)
      .filter(source => source.type === 'image').map(source => source.url))
    assert.ok(urls.includes(visible.url), visible.title + ' should be displayed')
    assert.ok(!urls.includes(hidden.url), hidden.title + ' should be fully hidden')
  }
  await ready('A')
  await panel.getByText('1 / 5').waitFor()
  assert.equal(await panel.locator('button:visible').count(), 2)
  const credit = page.locator('.maplibregl-ctrl-attrib')
  assert.equal(await credit.evaluate(el => el.open), false)
  await credit.locator('summary').click()
  assert.equal(await credit.evaluate(el => el.open), true)
  await credit.locator('summary').click()
  assert.ok(requested.has(east.url) && requested.has(accepted.url))
  assert.ok(!requested.has(rejected.url))
  const shot = path.join(process.env.DEV_RUNNER_ARTIFACTS, 'review-queue.png')
  await page.screenshot({ path: shot })
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  function isFocusedArtwork(data, info, x, y) {
    const offset = (y * info.width + x) * info.channels
    const [r, g, b] = data.subarray(offset, offset + 3)
    return r > 200 && g < 60 && b > 65 && b < 105
  }
  // Height limits this square on desktop. Check both sides of the 40px margins.
  for (const y of [36, 763]) assert.ok(!isFocusedArtwork(data, info, 410, y))
  for (const y of [44, 755]) assert.ok(isFocusedArtwork(data, info, 410, y))
  for (const x of [100, 1100]) {
    const offset = (400 * info.width + x) * info.channels
    assert.ok(data[offset + 2] > data[offset] + 100, 'Neighboring artwork should be visible')
  }
  // Width limits the same artwork after rotating to a portrait viewport.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const portrait = await sharp(await page.screenshot()).raw().toBuffer({ resolveWithObject: true })
  for (const x of [15, 375]) assert.ok(!isFocusedArtwork(portrait.data, portrait.info, x, 422))
  for (const x of [24, 366]) assert.ok(isFocusedArtwork(portrait.data, portrait.info, x, 422))
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.keyboard.press('=')
  await ready('Midnight Circus')
  await panel.getByText('2 / 5').waitFor()
  assert.equal(records.get(first.url).status, 'accepted')
  await page.keyboard.press('-')
  await ready('East')
  await checkOverlap(east, northeast)
  await panel.getByText('3 / 5').waitFor()
  assert.equal(records.get(alternate.url).status, 'rejected')
  await page.keyboard.press('Control+z')
  await ready('Midnight Circus')
  await panel.getByText('2 / 5').waitFor()
  assert.equal(records.has(alternate.url), false)
  await page.keyboard.press('-')
  await ready('East')
  await page.keyboard.press('=')
  await ready('Northeast')
  await checkOverlap(northeast, east)
  await page.keyboard.press('Control+z')
  await ready('East')
  await checkOverlap(east, northeast)
  await page.keyboard.press('=')
  await ready('Northeast')
  await page.keyboard.press('-')
  await ready('North')
  await page.keyboard.press('=')
  await complete.getByText('5 / 5').waitFor()
  await page.keyboard.press('Control+z')
  await ready('North')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready('North')
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'review-queue-mobile.png') })
  await panel.getByRole('button', { name: '[S]pread' }).click()
  await panel.getByText('0 / 1 · 1 rendering').waitFor()
  assert.equal(revisionJobs[0].mode, 'spread')
  assert.equal(revisionJobs[0].source.url, north.url)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await complete.getByText('0 / 1 · 1 rendering').waitFor()
  const candidate = { ...north, url: '/fixture/North-revision.png' }
  Object.assign(revisionJobs[0], { state: 'ready', candidate })
  await ready('North')
  await page.keyboard.press('a')
  await panel.getByText('0 / 1 · 1 rendering').waitFor()
  assert.equal(revisionJobs[1].mode, 'adjust')
  assert.equal(revisionJobs[1].source.url, candidate.url)
  assert.equal(new URL(page.url()).pathname, '/review')
  Object.assign(revisionJobs[1], { state: 'failed' })
  const retryFailed = panel.getByRole('button', { name: 'Retry failed adjust · North' })
  await retryFailed.waitFor()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await retryFailed.click()
  await complete.getByText('0 / 1 · 1 rendering').waitFor()
  assert.equal(revisionJobs[2].source.url, candidate.url)
  Object.assign(revisionJobs[2], { state: 'ready', candidate: { ...north, url: '/fixture/final.png' } })
  await ready('North')
  await page.keyboard.press('-')
  await complete.getByText('1 / 1', { exact: true }).waitFor()
} finally {
  await browser.close()
}
