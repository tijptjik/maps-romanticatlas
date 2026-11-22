import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('pageerror', error => console.error(error.message))
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.atlasMap = map; installArtworkSampling(map)',
    )
    await route.fulfill({ response, body })
  })
  const modes = process.argv.includes('--review')
    ? ['diagnostics', 'review']
    : ['diagnostics']
  for (const mode of modes) {
    await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&${mode}=true`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    })
    const prefix = mode === 'review' ? 'v2-' : 'discovery-'
    const layerOrder = () =>
      page.evaluate(prefix => {
        const layers = window.atlasMap.getStyle().layers
        const labels = layers.findIndex(layer => layer.id === 'places_subplace')
        const images = layers.filter(
          layer => layer.id.startsWith(prefix) && layer.type === 'raster',
        )
        return (
          images.length > 0 && images.every(layer => layers.indexOf(layer) < labels)
        )
      }, prefix)
    await page.waitForFunction(
      prefix =>
        window.atlasMap
          ?.getStyle()
          ?.layers?.some(
            layer => layer.id.startsWith(prefix) && layer.type === 'raster',
          ),
      prefix,
      { timeout: 90000 },
    )
    assert.ok(await layerOrder(), mode)
    if (mode === 'review')
      await page.getByRole('button', { name: 'Next painting' }).click()
    else await page.mouse.click(600, 400)
    assert.ok(await layerOrder(), `${mode} after selection`)
    await page.screenshot({
      path: `${process.env.DEV_RUNNER_ARTIFACTS}/${mode}-neighborhoods.png`,
    })
  }
} finally {
  await browser.close()
}
