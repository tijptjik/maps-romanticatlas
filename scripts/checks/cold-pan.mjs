import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !output) throw Error('Managed Chrome required')

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
let releaseTile
const tileGate = new Promise(resolve => { releaseTile = resolve })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    assert.ok(source.includes('installArtworkSampling(map)'))
    await route.fulfill({ response, body: source.replace('installArtworkSampling(map)',
      'window.testAtlasMap = map; installArtworkSampling(map)') })
  })
  await page.goto(base + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.atlas-fog')
  await page.waitForFunction(() => window.testAtlasMap.areTilesLoaded())

  const center = [114.177, 22.276]
  const parentX = Math.floor((center[0] + 180) / 360 * 32768)
  const parentY = Math.floor((1 - Math.asinh(Math.tan(center[1] * Math.PI / 180)) / Math.PI) * 16384)
  const parent = '/15/' + parentX + '/' + parentY
  let held = false
  await page.route('**' + parent + '.mvt*', async route => {
    held = true
    await tileGate
    await route.continue()
  })
  const indexReady = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/fog-index' + parent && response.ok())
  const started = Date.now()
  await page.evaluate(center => window.testAtlasMap.jumpTo({ center, zoom: 17 }), center)
  await indexReady
  const indexMs = Date.now() - started
  assert.ok(held, 'The destination vector tile must still be in flight')
  await page.waitForFunction(() => {
    const map = window.testAtlasMap
    if (map.isSourceLoaded('hongkong-latest')) return false
    const canvas = document.querySelector('.atlas-fog')
    const gl = canvas.getContext('webgl')
    const pixels = new Uint8Array(64 * 64 * 4)
    gl.readPixels((canvas.width - 64) >> 1, (canvas.height - 64) >> 1,
      64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels.some((value, i) => i % 4 === 3 && value > 32)
  }, null, { timeout: 30000 })
  const fogMs = Date.now() - started
  releaseTile()
  await page.waitForFunction(() => window.testAtlasMap.isSourceLoaded('hongkong-latest'))
  const basemapMs = Date.now() - started
  await page.screenshot({ path: output + '/cold-pan.png' })
  const report = { center, parent, indexMs, fogMs, basemapMs }
  await writeFile(output + '/cold-pan.json', JSON.stringify(report, null, 2))
  console.log(report)
} finally {
  releaseTile()
  await browser.close()
}
