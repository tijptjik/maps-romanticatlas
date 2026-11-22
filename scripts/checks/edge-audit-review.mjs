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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const root = `${base}/generated-tiles/dream-atlas/edge-audit/`
  const report = await (await page.request.get(`${root}report.json`)).json()
  const catalog = await (await page.request.get(`${base}/atlas-v2/catalog.json`)).json()
  assert.equal(report.total, report.items.length)
  assert.equal(new Set(report.items.map(item => item.url)).size, report.total)
  for (const item of report.items) {
    assert.ok(item.reviewUrl, `Missing exact-painting map link: ${item.id}`)
    const params = new URL(item.reviewUrl, base).searchParams
    const sheet = catalog.sheets.find(s => s.id === params.get('card'))
    assert.equal(sheet?.art[Number(params.get('painting')) - 1]?.url, item.url)
  }
  await page.goto(root)
  assert.equal(await page.locator('article').count(), report.total)
  assert.equal(
    await page.locator('article').first().getAttribute('id'),
    report.items[0].id,
  )
  const image = page.locator('article').first().getByRole('img')
  await image.evaluate(async element => {
    await element.decode()
    if (!element.naturalWidth) throw Error('Missing diagnostic image')
  })
  await page.screenshot({ path: `${artifacts}/edge-queue.png` })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const js = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.reviewMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body: js })
  })
  const target = report.items.find(
    item =>
      item.reviewUrl &&
      Number(new URL(item.reviewUrl, base).searchParams.get('painting')) > 1,
  )
  assert.ok(target, 'Need a non-first alternative to exercise link selection')
  await page
    .locator(`[id="${target.id}"]`)
    .getByRole('link', { name: 'Open exact painting on map' })
    .click()
  try {
    await page.waitForFunction(
      item => {
        const source = window.reviewMap?.getSource(`v2-${item.tile[1]}-${item.tile[2]}`)
        return (
          source?.url === item.url &&
          source.loaded() &&
          source.image?.width > 0 &&
          document.querySelector('.v2-review output')?.textContent.endsWith(item.title)
        )
      },
      target,
      { timeout: 45000 },
    )
  } catch (error) {
    console.log(
      await page.evaluate(
        item => ({
          url: location.href,
          title: document.querySelector('.v2-review output')?.textContent,
          map: !!window.reviewMap,
          expected: item.url,
          sources: window.reviewMap?.getStyle()?.sources,
        }),
        target,
      ),
    )
    await page.screenshot({ path: `${artifacts}/navigation-failure.png` })
    throw error
  }
  await page.screenshot({ path: `${artifacts}/exact-alternative.png` })
  console.log(
    'Verified ' +
      report.total +
      ' unique review entries and exact-edition map links; diagnostic decode and non-first alternative interaction passed',
  )
} finally {
  await browser.close()
}
