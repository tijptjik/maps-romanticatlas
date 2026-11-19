import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage()
  const token = 'fixture-admin'
  await page.context().addCookies([{name: 'atlas_csrf', value: 'expired', url: base}])
  const submittedTokens = []
  let saved
  await page.route('**/api/atlas-tiles/cached?*', async route => {
    const query = new URL(route.request().url()).searchParams
    if (!query.has('admin')) return route.continue()
    assert.equal(query.get('admin'), 'true')
    if (route.request().headers().authorization !== 'Bearer ' + token)
      return route.fulfill({ status: 401 })
    return route.fulfill({ json: { tiles: [] }, headers: {
      'set-cookie': 'atlas_csrf=fixture-session; Path=/; SameSite=Strict',
    } })
  })
  await page.route('**/api/artwork-reviews*', async route => {
    const request = route.request()
    if (request.method() !== 'PUT') return route.fulfill({ json: [] })
    assert.equal(new URL(request.url()).searchParams.get('admin'), 'true')
    if (request.headers().authorization !== 'Bearer ' + token)
      return route.fulfill({ status: 401 })
    submittedTokens.push(request.headers()['x-atlas-csrf-token'])
    if (submittedTokens.at(-1) === 'expired') return route.fulfill({ status: 403 })
    assert.equal(request.headers()['x-atlas-csrf-token'], 'fixture-session')
    assert.match(await request.headerValue('cookie'), /atlas_csrf=fixture-session/)
    saved = request.postDataJSON()
    return route.fulfill({ json: saved })
  })
  page.on('dialog', async dialog => {
    assert.equal(dialog.type(), 'prompt', dialog.message())
    await dialog.accept(token)
  })
  await page.goto(base + '/?noLinkOut=&diagnostics=true&noSplash=true', { waitUntil: 'domcontentloaded' })
  const hit = await page.waitForFunction(() => {
    for (const button of document.querySelectorAll('[data-action="accepted"]:enabled')) {
      const {x, y, width, height} = button.getBoundingClientRect()
      if (document.elementFromPoint(x + width / 2, y + height / 2) === button)
        return button.parentElement.getAttribute('aria-label')
    }
  }, undefined, { timeout: 90000 })
  const group = page.getByRole('group', {name: await hit.jsonValue(), exact: true})
  const button = group.locator('[data-action="accepted"]')
  const name = (await button.getAttribute('aria-label')).slice('Accept '.length, -' for production'.length)
  await button.click()
  await group.locator('[data-status="accepted"]').and(page.getByTitle(name + ' · accepted', {exact: false})).waitFor()
  assert.deepEqual(submittedTokens, ['expired', 'fixture-session'])
  assert.equal(saved.status, 'accepted')
  await page.screenshot({path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'diagnostic-review.png')})
} finally {
  await browser.close()
}
