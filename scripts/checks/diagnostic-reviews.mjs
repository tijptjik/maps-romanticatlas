import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 800}})
  page.on('pageerror', error => console.error(error.message))
  // Exercise review persistence through the UI without modifying the release under review.
  const reviews = new Map()
  await page.route('**/api/artwork-reviews*', async route => {
    if (route.request().method() === 'PUT') {
      const record = route.request().postDataJSON()
      reviews.set(record.url, record)
      return route.fulfill({ json: record })
    }
    return route.fulfill({ json: [...reviews.values()] })
  })
  await page.context().addCookies([{name: 'atlas_csrf', value: 'test', url: process.env.PLAYWRIGHT_BASE_URL}])
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: process.env.PLAYWRIGHT_BASE_URL})
  await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/?noSplash=true&diagnostics', {waitUntil:'domcontentloaded'})
  const fog = page.locator('.atlas-fog')
  const counter = page.locator('[aria-label$="images on tile 18/214183/114420"]')
  await page.waitForFunction(() => Number(document.querySelector('[aria-label$="images on tile 18/214183/114420"] output')?.textContent) >= 4)
  assert.equal(await counter.isVisible(), true)
  assert.equal(await fog.count(),0)
  const pips = counter.locator('.atlas-image-pips button')
  const selected = counter.locator('.atlas-image-pips [aria-pressed="true"]')
  const title = page.locator('.atlas-discovery-title[data-tile="18/214183/114420"]')
  async function checkTitle() {
    const name = await title.textContent()
    assert.ok(name)
    assert.equal(await counter.locator('[data-action="accepted"]').getAttribute('aria-label'), 'Accept ' + name + ' for production')
    const top = await title.boundingBox()
    const bottom = await counter.boundingBox()
    assert.ok(top && bottom && top.y + top.height < bottom.y)
  }
  const catalog = await (await page.request.get(new URL('/atlas-v2/catalog.json', page.url()).href)).json()
  async function checkCopy(keyboard = false) {
    const name = await title.textContent()
    const art = catalog.sheets.flatMap(sheet => sheet.art).find(art =>
      art.title === name && art.x === 214183 && art.y >= 114420 && art.y - art.rows < 114420)
    assert.ok(art)
    if (keyboard) await title.press('Enter')
    else await title.click()
    await page.getByRole('status').filter({hasText: 'Copied reference for ' + name}).waitFor()
    const reference = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
    assert.deepEqual(reference, {
      title: name,
      image: new URL(art.url, page.url()).href,
      southwestTile: '18/' + art.x + '/' + art.y,
      tiles: Array.from({length: art.rows}, (_, i) => '18/' + art.x + '/' + (art.y - i)),
    })
    assert.equal(await title.textContent(), name)
    return reference.image
  }
  await checkTitle()
  const firstImage = await checkCopy()
  const pending = counter.locator('.atlas-image-pips [data-status="considered"]')
  const total = await pips.count()
  assert.ok(await pending.count() >= 4)
  await pending.nth(1).click()
  await checkTitle()
  assert.notEqual(await checkCopy(true), firstImage)
  const nextTitle = await pending.nth(2).getAttribute('title')
  await counter.locator('[data-action="accepted"]').click()
  await selected.and(page.getByTitle(nextTitle, {exact:true})).waitFor()

  // Reject the last candidate and check that selection wraps to the first pending image.
  const firstTitle = await pending.first().getAttribute('title')
  await pending.last().click()
  const rejectedTitle = (await selected.getAttribute('title')).replace(/^\d+\. /, '').split(' · ')[0]
  await counter.locator('[data-action="rejected"]').click()
  await selected.and(page.getByTitle(firstTitle, {exact:true})).waitFor()
  await checkTitle()
  assert.equal(await pips.count(), total - 1)
  assert.equal(await counter.locator('output').textContent(), String(total - 1))
  await page.reload()
  await counter.waitFor({timeout: 90000})
  await checkTitle()
  assert.equal(await pips.count(), total - 1)
  assert.equal(await counter.getByTitle(rejectedTitle, {exact:false}).count(), 0)
  assert.equal(await page.locator('.atlas-image-pips [data-status="rejected"]').count(), 0)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'diagnostic-images.png')})
  await page.keyboard.press('r')
  await fog.waitFor()
  assert.equal(new URL(page.url()).searchParams.has('diagnostics'),false)
  assert.equal(await title.count(), 0)
} finally {
  await browser.close()
}
