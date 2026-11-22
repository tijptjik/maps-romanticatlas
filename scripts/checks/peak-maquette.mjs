import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const site = JSON.parse(await readFile('releases/sources/peak-maquette/site.json'))
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const base = process.env.PLAYWRIGHT_BASE_URL
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.testMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body })
  })
  const catalog = await (await page.request.get(`${base}/atlas-v2/catalog.json`)).json()
  const overlapping = catalog.sheets
    .flatMap(s => s.art)
    .filter(art =>
      site.cells.some(
        cell =>
          cell.x >= art.x &&
          cell.x < art.x + (art.columns ?? 1) &&
          cell.y <= art.y &&
          cell.y > art.y - art.rows,
      ),
    )
  assert.deepEqual([...new Set(overlapping.map(art => art.url))], [site.image])
  const sheet = catalog.sheets.find(s => s.id === 'peak-maquette')
  assert.equal(sheet.art.length, 1)
  assert.equal(sheet.art[0].columns, 3)
  const reviews = await (await page.request.get(`${base}/api/artwork-reviews`)).json()
  assert.ok(
    reviews.some(
      r => r.url === site.image && r.status === 'accepted' && r.columns === 3,
    ),
  )
  await page.goto(`${base}/?review&card=peak-maquette`)
  await page.waitForFunction(site => {
    const source = window.testMap?.getSource(`v2-${site.x}-${site.y}`)
    return (
      source?.url === site.image &&
      source.loaded() &&
      source.image?.width === 2172 &&
      source.image.height === 724 &&
      !window.testMap.isMoving()
    )
  }, site)
  const margins = await page.evaluate(site => {
    const image = window.testMap.getSource(`v2-${site.x}-${site.y}`).image
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, image.width, image.height).data
    let left = image.width,
      top = image.height,
      right = 0,
      bottom = 0
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        if (!data[(y * image.width + x) * 4 + 3]) continue
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    return [left, top, image.width - 1 - right, image.height - 1 - bottom]
  }, site)
  assert.ok(
    margins[0] >= 100 && margins[1] >= 50 && margins[2] >= 100 && margins[3] >= 30,
    JSON.stringify(margins),
  )
  console.log('Transparent clearance around complete maquette', margins)
  const bounds = await page.evaluate(
    site => window.testMap.getSource(`v2-${site.x}-${site.y}`).coordinates,
    site,
  )
  const { west, east, north, south } = site.bounds
  const expected = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ]
  assert.ok(
    bounds.every((point, i) =>
      point.every((value, j) => Math.abs(value - expected[i][j]) < 1e-10),
    ),
  )
  await page.screenshot({
    path: `${process.env.DEV_RUNNER_ARTIFACTS}/peak-maquette-review.png`,
  })
  await page.goto(`${base}/?diagnostics&noSplash=true&noMusic=true`)
  await page.waitForFunction(() => window.testMap?.isStyleLoaded())
  await page.evaluate(({ west, east, north, south }) => {
    window.testMap.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 100, duration: 0 },
    )
  }, site.bounds)
  const title = page.locator(
    `.atlas-discovery-title[data-tile="18/${site.x}/${site.y}"]`,
  )
  await title.waitFor()
  assert.equal(await title.textContent(), site.title)
  await title.click()
  await page
    .getByRole('status')
    .filter({ hasText: `Copied reference for ${site.title}` })
    .waitFor()
  const reference = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  )
  assert.deepEqual(
    reference.tiles,
    site.cells.map(c => `18/${c.x}/${c.y}`),
  )
  assert.equal(reference.image, new URL(site.image, base).href)
  assert.equal(
    await page
      .getByRole('button', {
        name: `Accept ${site.title} for production`,
        exact: true,
      })
      .count(),
    3,
  )
  await page.screenshot({
    path: `${process.env.DEV_RUNNER_ARTIFACTS}/peak-maquette-diagnostics.png`,
  })
  console.log(
    'Three adjoining summit cells rendered at correct bounds; accepted review and copied three-tile reference verified.',
  )
} finally {
  await browser.close()
}
