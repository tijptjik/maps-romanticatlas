import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1270, height: 756 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        'installArtworkSampling(map)',
        'window.testMap = map; installArtworkSampling(map)',
      ),
    })
  })
  await page.addInitScript(() =>
    history.replaceState(
      {
        atlasModeCamera: { center: [114.1404, 22.27545], zoom: 17.2 },
      },
      '',
    ),
  )
  await page.goto(
    `${process.env.PLAYWRIGHT_BASE_URL}/?revealed&noSplash=true&noMusic=true`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => {
    const map = window.testMap
    return (
      map?.getLayer('buildings') &&
      map.querySourceFeatures('hongkong-latest', {
        sourceLayer: 'roads',
        filter: ['==', ['id'], 35185148845215],
      }).length > 0
    )
  })
  const layersAt = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const position = [
          ((26773 + x / 4096) / 32768) * 360 - 180,
          (Math.atan(Math.sinh(Math.PI * (1 - (2 * (14303 + y / 4096)) / 32768))) *
            180) /
            Math.PI,
        ]
        return window.testMap
          .queryRenderedFeatures(window.testMap.project(position))
          .map(f => f.layer.id)
      },
      [x, y],
    )
  for (const point of [
    [1045, 1708],
    [692, 1820],
  ]) {
    const layers = await layersAt(...point)
    assert.ok(layers.includes('landuse_park'), JSON.stringify(layers))
    assert.ok(!layers.includes('buildings') && !layers.includes('water'))
  }
  assert.ok((await layersAt(1811, 1574)).some(id => id.startsWith('roads_')))
  await page
    .getByText('Fragrant Harbour in the Clouds', { exact: true })
    .first()
    .waitFor()
  await page.waitForFunction(() => {
    const map = window.testMap
    return Object.keys(map.getStyle().sources).some(id => {
      const source = map.getSource(id)
      return (
        source.type === 'image' &&
        source.url?.includes('fragrant-harbour') &&
        source.loaded() &&
        source.image?.width
      )
    })
  })
  await page.evaluate(
    () =>
      new Promise(resolve => {
        window.testMap.once('idle', resolve)
        window.testMap.triggerRepaint()
      }),
  )
  await page.screenshot({
    path: `${process.env.DEV_RUNNER_ARTIFACTS}/peak-woodland.png`,
  })
} finally {
  await browser.close()
}
