import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const catalog = await (await page.request.get(`${base}/atlas-v2/catalog.json`)).json()
  const decisions = await (await page.request.get(`${base}/api/artwork-reviews`)).json()
  const rejected = new Set(
    decisions.filter(d => d.status === 'rejected').map(d => d.url),
  )
  const sheetId = process.argv[2]
  const sheet = sheetId
    ? catalog.sheets.find(s => s.id === sheetId)
    : catalog.sheets.find(s => s.id.startsWith('production-cell-') && s.art.length >= 2)
  assert.ok(sheet && !sheet.accepted)
  if (sheet.id.startsWith('production-retained-')) {
    assert.ok(
      sheet.art.every(a =>
        decisions.some(d => d.url === a.url && d.status === 'accepted'),
      ),
    )
  }
  assert.equal(new Set(catalog.sheets.map(s => s.id)).size, catalog.sheets.length)
  assert.ok(catalog.sheets.every(s => s.art.some(a => !rejected.has(a.url))))

  await page.goto(`${base}/generated-tiles/dream-atlas/cards/index.html`)
  const link = page.locator(`a[href*="card=${sheet.id}&"]`)
  assert.equal(await link.count(), 1)
  const card = link.locator('xpath=ancestor::figure').getByRole('img')
  await card.scrollIntoViewIfNeeded()
  await card.evaluate(async element => {
    await element.decode()
    if (!element.naturalWidth) throw Error('Contact card failed to decode')
  })
  await link
    .locator('xpath=ancestor::figure')
    .screenshot({ path: `${artifacts}/contact-card.png` })

  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const js = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.reviewMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body: js })
  })
  await link.click()
  for (let index = 0; index < sheet.art.length; index++) {
    const art = sheet.art[index]
    assert.ok(!rejected.has(art.url))
    await page.waitForFunction(
      ({ id, art, index }) => {
        const map = window.reviewMap
        const src = map?.getSource(`v2-${art.x}-${art.y}`)
        return (
          document.querySelector('.v2-review select')?.value === id &&
          document
            .querySelector('.v2-review output')
            ?.textContent.endsWith(art.title) &&
          new URLSearchParams(location.search).get('painting') === String(index + 1) &&
          src?.url === art.url &&
          src.loaded() &&
          src.image?.width > 0 &&
          map.areTilesLoaded()
        )
      },
      { id: sheet.id, art, index },
      { timeout: 45000 },
    )
    await page.screenshot({ path: `${artifacts}/painting-${index + 1}.png` })
    if (index < sheet.art.length - 1)
      await page.getByRole('button', { name: 'Next painting' }).click()
  }
  console.log(
    'Verified unique card IDs, exact review statuses, gallery image decode, map link and all ' +
      sheet.art.length +
      ' rendered alternatives for ' +
      sheet.id,
  )
} finally {
  await browser.close()
}
