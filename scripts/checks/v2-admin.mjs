import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage()
  const base = process.env.PLAYWRIGHT_BASE_URL
  const manifest = '/api/atlas-tiles/cached?admin=true&diagnostics=true&collection=discovery'
  const actual = await page.request.get(base + manifest)
  if (actual.ok()) assert.equal((await actual.json()).adminMode, true)
  else assert.ok([401, 403, 503].includes(actual.status()))

  let authorized = false
  await page.route('**/api/atlas-tiles/cached?**', route => {
    const params = new URL(route.request().url()).searchParams
    assert.equal(params.get('admin'), 'true')
    assert.equal(params.get('collection'), 'discovery')
    return authorized ? route.fulfill({json: {adminMode: true, tiles: []}}) :
      route.fulfill({status: 403, json: {error: 'Admin access required'}})
  })
  await page.goto(base + '/?admin&noSplash&noMusic', {waitUntil: 'domcontentloaded'})
  const retry = page.getByRole('button', {name: 'Admin artwork unavailable · Retry'})
  await retry.waitFor({timeout: 60000})
  assert.equal(await page.locator('.atlas-image-count, .atlas-v2-admin').count(), 0)
  authorized = true
  await retry.click()
  const toolbar = page.getByRole('navigation', {name: 'Atlas V2 admin'})
  await toolbar.waitFor({timeout: 60000})
  assert.match(await toolbar.locator('output').textContent(), /^[1-9]\d* paintings?$/)
  assert.equal(await toolbar.getByText('Review queue').getAttribute('href'), '/review')
  assert.equal(new URL(await toolbar.getByText('Tile cache').getAttribute('href')).searchParams.get('view'), 'cache')
  const alternatives = page.locator('.atlas-image-count:visible').filter({has: page.locator('.atlas-image-pips button:nth-child(2)')}).first()
  const next = alternatives.locator('.atlas-image-pips button[aria-pressed="false"]').first()
  const label = await next.getAttribute('aria-label')
  await next.click()
  assert.equal(await alternatives.getByRole('button', {name: label, exact: true}).getAttribute('aria-pressed'), 'true')
  await page.waitForLoadState('networkidle', {timeout: 60000})
  await page.screenshot({path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'v2-admin.png')})

  const original = {x: 214204, y: 114422, rows: 1, title: 'The Reef Goes Visiting',
    url: '/atlas-v2/production/0261-ba3496a5c0ed2058.webp'}
  const candidate = {...original, url: '/artwork-revisions/359180ed3cfc4cc6a3a49c08327e3d4b.png'}
  const cell = '18/' + original.x + '/' + original.y
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({json: {
    release: 'v2', sheets: [{art: [original]}],
  }}))
  await page.route('**/api/artwork-reviews', route => route.fulfill({json: [{...candidate, status: 'accepted'}]}))
  await page.route('**/api/artwork-revisions', route => route.fulfill({json: [
    {source: original, candidate, mode: 'spread', state: 'ready'},
  ]}))
  await page.evaluate(({x, y}) => {
    const center = [(x + 0.5) / 262144 * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 262144))) * 180 / Math.PI]
    history.replaceState({atlasModeCamera: {center, zoom: 18}}, '')
  }, original)
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === candidate.url && response.ok())
  const requested = new Set()
  page.on('request', request => requested.add(new URL(request.url()).pathname))
  await page.reload({waitUntil: 'domcontentloaded'})
  await loaded
  const group = page.getByRole('group', {name: '1 images on tile ' + cell, exact: true})
  await group.waitFor()
  assert.equal(await group.locator('.atlas-image-pips button[data-status="accepted"]').count(), 1)
  assert.equal(await toolbar.locator('output').textContent(), '1 painting')
  assert.equal(requested.has(original.url), false)
  await page.waitForLoadState('networkidle')
  await page.screenshot({path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'v2-admin-revised-reef.png')})
} finally {
  await browser.close()
}
