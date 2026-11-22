import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const response = await page.request.get(
    `${base}/api/atlas-tiles/cached?diagnostics&collection=discovery`,
  )
  assert.ok(response.ok())
  const { tiles } = await response.json()
  const art = tiles.find(tile => tile.variant.startsWith('discovery-'))
  assert.ok(art, 'This check needs one saved regular-view render')
  const title = art.scene
    .split('-')
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  await page.addInitScript(({ x, y }) => {
    const center = [
      ((x + 0.5) / 262144) * 360 - 180,
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 262144))) * 180) / Math.PI,
    ]
    history.replaceState({ atlasModeCamera: { center, zoom: 17 } }, '')
  }, art)
  // Isolate release choices and save the review in memory for this browser only.
  await page.route('**/atlas-v2/catalog.json', route =>
    route.fulfill({ json: { release: 'v2', sheets: [] } }),
  )
  let review
  await page.route('**/api/artwork-reviews*', route => {
    if (route.request().method() === 'PUT') {
      review = route.request().postDataJSON()
      return route.fulfill({ json: review })
    }
    return route.fulfill({ json: review ? [review] : [] })
  })
  await page.context().addCookies([{ name: 'atlas_csrf', value: 'fixture', url: base }])
  await page.goto(`${base}/?diagnostics&noSplash=true`, {
    waitUntil: 'domcontentloaded',
  })
  const group = page.locator(`[aria-label$="images on tile 18/${art.x}/${art.y}"]`)
  await group
    .getByTitle(new RegExp(`${title} · considered`))
    .first()
    .click()
  await group.getByRole('button', { name: `Accept ${title} for production` }).click()
  await group.locator('[data-status="accepted"]').waitFor()
  assert.equal(review.url, art.url)
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'discovery-promotion.png'),
  })
  await page.keyboard.press('r')
  await page.locator('.atlas-fog').waitFor()
  await page.mouse.move(600, 400)
  await page.waitForFunction(
    () => document.querySelector('.maplibregl-canvas').style.cursor === 'pointer',
  )
  const revealed = page.waitForResponse(
    r => new URL(r.url()).pathname + new URL(r.url()).search === art.url && r.ok(),
  )
  await page.mouse.click(600, 400)
  await revealed
  await page.getByText(title, { exact: true }).waitFor()
} finally {
  await browser.close()
}
