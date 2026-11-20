import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { isFakeRenderTile } from '../../src/fake-render-state.ts'

const tile = { x: 214210, y: 114419 }
const art = {
  ...tile, rows: 1, columns: 1, title: 'The Borrowed Horizon',
  url: '/hku-skyscrapers-in-place/mirror-garden/the-borrowed-horizon.webp',
}
const center = [(tile.x + 0.5) / 262144 * 360 - 180,
  Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 0.5) / 262144))) * 180 / Math.PI]
let visit = 0
while (isFakeRenderTile(tile, visit)) visit++

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript(({ center, visit }) => {
    history.replaceState({ atlasModeCamera: { center, zoom: 18 } }, '')
    const random = crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues = array => array instanceof Uint32Array && array.length === 1
      ? array.fill(Number(sessionStorage.getItem('test-cloud-visit') ?? visit)) : random(array)
  }, { center, visit })
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({
    json: { release: 'v2', sheets: [{ accepted: true, art: [art] }] },
  }))
  await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [] }))
  await page.route('**/api/fog-index/**', route => route.fulfill({ json: {
    eligibility: [{ ...tile, isTargetable: true, regionalLandAvailable: true, landFraction: 1 }],
  } }))
  const requests = []
  await page.route('**/api/fake-render/**', route => {
    requests.push(route.request().method())
    return route.fulfill({ status: 403, headers: { 'cf-ray': 'recovery-test' },
      json: { error: 'Application POST required.' } })
  })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/?noSplash&noMusic', { waitUntil: 'domcontentloaded' })
  await page.locator('.atlas-fog-cached-mist.is-visible').waitFor()
  const diagnostic = page.waitForEvent('console', {
    predicate: message => message.text().includes('[atlas] Released artwork lookup failed'),
  })
  await page.mouse.click(600, 400)
  const details = (await diagnostic).args()[1]
  assert.deepEqual(await details.evaluate(({ tile, status, ray, error }) => [tile, status, ray, error.message]),
    ['18/214210/114419', 403, 'recovery-test', 'Application POST required.'])
  const title = page.locator('.atlas-title-card:not(.is-awaiting-focus)')
  await title.waitFor({ state: 'visible', timeout: 150000 })
  assert.match(await title.innerText(), /The Borrowed Horizon/i)
  assert.deepEqual(requests, ['GET'])
  await page.screenshot({ path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'recovered-artwork.png') })
  console.log('Verified catalog reveal and request diagnostics after HTTP 403')

  while (!isFakeRenderTile(tile, visit)) visit++
  await page.evaluate(visit => sessionStorage.setItem('test-cloud-visit', String(visit)), visit)
  let claims = 0
  await page.route('**/api/fake-render/**', route => {
    if (route.request().method() === 'POST') {
      claims++
      return route.fulfill({ status: 400, json: { error: 'Not a rotating cloud.' } })
    }
    return route.fulfill({ json: { ready: true, released: [] } })
  })
  const ready = page.waitForResponse(response => response.url().includes('availability=1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready
  await page.mouse.click(600, 400)
  await title.waitFor({ state: 'visible', timeout: 150000 })
  assert.match(await title.innerText(), /The Borrowed Horizon/i)
  assert.equal(claims, 1)
  console.log('Verified cached artwork reveal after a declined rotation claim')
} finally {
  await browser.close()
}
