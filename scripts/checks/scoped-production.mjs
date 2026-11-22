import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const jobs = process.argv.slice(2)
assert.ok(jobs.length, 'Pass the scoped production job IDs to verify')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const source = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.reviewMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body: source })
  })
  for (const job of jobs) {
    const catalogResponse = await page.request.get(`${base}/atlas-v2/catalog.json`)
    assert.ok(catalogResponse.ok())
    const catalog = await catalogResponse.json()
    const reviewsResponse = await page.request.get(`${base}/api/artwork-reviews`)
    assert.ok(reviewsResponse.ok())
    const reviews = await reviewsResponse.json()
    const rejected = new Set(
      reviews.filter(review => review.status === 'rejected').map(review => review.url),
    )
    const sheet = catalog.sheets.find(
      sheet =>
        sheet.id.startsWith('production-cell-') &&
        sheet.art.some(art => art.url.startsWith(`/atlas-v2/production/${job}-`)),
    )
    assert.ok(sheet, `Missing production contact card for ${job}`)
    const index = sheet.art.findIndex(art =>
      art.url.startsWith(`/atlas-v2/production/${job}-`),
    )
    const art = sheet.art[index]
    assert.ok(
      !rejected.has(art.url),
      `Scoped candidate was rejected before verification ${job}`,
    )
    const media = await page.request.get(base + art.url)
    assert.ok(media.ok())
    const hash = createHash('sha256')
      .update(await media.body())
      .digest('hex')
    assert.ok(art.url.endsWith(`-${hash.slice(0, 16)}.webp`))
    await page.goto(`${base}/?review&noSplash&card=${sheet.id}&painting=${index + 1}`)
    await page.waitForFunction(
      ({ sheet, art, index }) => {
        const map = window.reviewMap
        const source = map?.getSource(`v2-${art.x}-${art.y}`)
        return (
          document.querySelector('.v2-review select')?.value === sheet.id &&
          document
            .querySelector('.v2-review output')
            ?.textContent.endsWith(art.title) &&
          new URLSearchParams(location.search).get('painting') === String(index + 1) &&
          source?.url === art.url &&
          source.loaded() &&
          source.image?.width > 0 &&
          map.areTilesLoaded()
        )
      },
      { sheet, art, index },
      { timeout: 60000 },
    )
    await page.screenshot({ path: `${artifacts}/scoped-${job}.png` })
    if (sheet.art.length > 1) {
      await page.getByRole('button', { name: 'Next painting' }).click()
      await page.waitForFunction(
        expected =>
          new URLSearchParams(location.search).get('painting') === String(expected),
        ((index + 1) % sheet.art.length) + 1,
      )
      await page.getByRole('button', { name: 'Previous painting' }).click()
      await page.waitForFunction(
        expected =>
          new URLSearchParams(location.search).get('painting') === String(expected),
        index + 1,
      )
    }
    console.log(`Verified scoped painting ${job} on its contact-card map`)
  }
} finally {
  await browser.close()
}
