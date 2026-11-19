import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const targets = process.argv.slice(2).map(value => {
  const [id, sha] = value.split(':')
  assert.match(id, /^(sea-)?[0-9]+$/)
  assert.match(sha, /^[a-f0-9]{64}$/)
  return { id, sha, url: `/atlas-v2/production/${id}-${sha.slice(0, 16)}.webp` }
})
assert.ok(targets.length, 'Supply ID:SHA256 for each repaired edition')
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.reviewMap = map; installArtworkSampling(map)')
    await route.fulfill({ response, body })
  })
  for (const target of targets) {
    const catalog = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
    const sheet = catalog.sheets.find(s => s.id.startsWith('production-cell-') && s.art.some(a => a.url === target.url))
    assert.ok(sheet, 'Current repaired edition missing from catalog: ' + target.id)
    const index = sheet.art.findIndex(a => a.url === target.url)
    const art = sheet.art[index]
    const response = await page.request.get(base + target.url)
    assert.equal(response.status(), 200)
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), target.sha)
    await page.goto(base + '/generated-tiles/dream-atlas/cards/index.html')
    const figure = page.locator('a[href*="card=' + sheet.id + '&"]').locator('xpath=ancestor::figure')
    assert.equal(await figure.count(), 1)
    await figure.scrollIntoViewIfNeeded()
    await figure.getByRole('img').evaluate(async image => { await image.decode(); if (!image.naturalWidth) throw Error('Card decode failed') })
    await figure.screenshot({ path: artifacts + '/' + target.id + '-card.png' })
    await page.goto(base + '/?review&card=' + sheet.id + '&painting=' + (index + 1))
    await page.waitForFunction(({ art, id }) => {
      const source = window.reviewMap?.getSource('v2-' + art.x + '-' + art.y)
      return source?.url === art.url && source.loaded() && source.image?.width > 0 &&
        document.querySelector('.v2-review select')?.value === id &&
        document.querySelector('.v2-review output')?.textContent.endsWith(art.title)
    }, { art, id: sheet.id }, { timeout: 45000 })
    await page.screenshot({ path: artifacts + '/' + target.id + '-map.png' })
    const decisions = await (await page.request.get(base + '/api/artwork-reviews')).json()
    assert.ok(!decisions.some(d => d.url === target.url && d.status === 'rejected'), 'Target rejected during check: ' + target.id)
    console.log('Verified repaired asset hash, contact card and exact map painting: ' + target.id)
  }
} finally {
  await browser.close()
}
