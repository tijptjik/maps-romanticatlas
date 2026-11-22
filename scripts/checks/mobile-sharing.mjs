import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium, devices } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !output) throw Error('Managed Chrome required')
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
const results = []
try {
  for (const scenario of ['download', 'share', 'cancel', 'desktop']) {
    const context = await browser.newContext(scenario === 'desktop'
      ? { viewport: { width: 1200, height: 800 } }
      : { ...devices['iPhone 13'] })
    const page = await context.newPage()
    let uploads = 0
    await page.addInitScript(scenario => {
      Object.defineProperty(navigator, 'userAgentData', { value: { mobile: scenario !== 'desktop' } })
      Object.defineProperty(navigator, 'canShare', { value: () => scenario !== 'download' })
      Object.defineProperty(navigator, 'share', { value: async data => {
        window.sharedFile = { name: data.files[0].name, size: data.files[0].size, type: data.files[0].type }
        if (scenario === 'cancel') throw new DOMException('Cancelled', 'AbortError')
      } })
    }, scenario)
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('const sharing = installAtlasSharing(map, audio)',
        'const sharing = installAtlasSharing(map, audio); window.testSharing = sharing; window.testMap = map')
      await route.fulfill({ response, body })
    })
    await page.route('**/api/share-maps', async route => {
      uploads++
      await route.fulfill({ json: { url: 'https://example.com/map.png' } })
    })
    await page.goto(base + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.testSharing && window.testMap?.loaded(), null, { timeout: 60000 })
    await page.evaluate(() => window.testSharing.setRevealCount(5))
    await page.getByRole('button', { name: 'Share your map', exact: true }).click()
    const downloaded = scenario === 'download' ? page.waitForEvent('download') : null
    await page.getByRole('button', { name: 'Snap this map', exact: true }).click()
    await page.locator('.atlas-share-result[open]').waitFor()
    if (downloaded) {
      const download = await downloaded
      assert.equal(download.suggestedFilename(), 'romantic-atlas-map.png')
      await download.saveAs(output + '/downloaded-map.png')
    }
    const state = await page.evaluate(() => ({
      text: document.querySelector('.atlas-share-result').innerText,
      qrVisible: getComputedStyle(document.querySelector('.atlas-share-qr')).display !== 'none',
      qr: document.querySelector('.atlas-share-qr').src,
      file: window.sharedFile,
    }))
    await page.screenshot({ path: output + '/sharing-' + scenario + '.png' })
    results.push({ scenario, uploads, ...state })
    assert.equal(state.qrVisible, scenario === 'desktop', JSON.stringify(results.at(-1)))
    assert.equal(uploads, scenario === 'desktop' ? 1 : 0)
    if (scenario !== 'desktop') assert.equal(await page.getByText('Open image', { exact: true }).isVisible(), false)
    if (scenario === 'desktop') assert.ok(state.qr.startsWith('data:image/png'))
    if (scenario === 'download') assert.match(state.text, /Downloads folder/)
    if (scenario === 'share' || scenario === 'cancel') {
      assert.equal(state.file.type, 'image/png')
      assert.ok(state.file.size > 0)
    }
    if (scenario === 'cancel') assert.match(state.text, /ready to share/)
    await page.getByRole('button', { name: 'Retake', exact: true }).click()
    assert.ok(await page.getByRole('button', { name: 'Snap this map', exact: true }).isVisible())
    await context.close()
  }
} finally {
  await writeFile(output + '/sharing-results.json', JSON.stringify(results, null, 2))
  await browser.close()
}
