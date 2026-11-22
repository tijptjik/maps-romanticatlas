import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const sheet = JSON.parse(await readFile('public/atlas-v2/coasters/sheet.json'))
const sites = JSON.parse(
  await readFile('releases/sources/coasters/sites.geojson'),
).features
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = await response.text()
    assert.ok(body.includes('installArtworkSampling(map)'))
    await route.fulfill({
      response,
      body: body.replace(
        'installArtworkSampling(map)',
        'window.reviewMap = map; installArtworkSampling(map)',
      ),
    })
  })
  const base = process.env.PLAYWRIGHT_BASE_URL
  await page.goto(`${base}/?review&card=coasters`)
  for (const { id, geometry, properties } of sites) {
    const [sw, se, ne, nw] = geometry.coordinates[0]
    const expected = [nw, ne, se, sw]
    const { x, y, name, tileSpan } = properties
    const { url } = sheet.art.find(art => art.x === x && art.y === y)
    await page.waitForFunction(
      ({ x, y, name, expected, tileSpan, url }) => {
        const map = window.reviewMap
        const layer = `v2-${x}-${y}`
        const source = map?.getSource(layer)
        return (
          document.querySelector('.v2-review output')?.textContent.endsWith(name) &&
          map.getLayer(layer) &&
          source?.url === url &&
          source.loaded() &&
          source.image?.width === tileSpan.columns * 887 &&
          source.image.height === tileSpan.rows * 887 &&
          source.coordinates.every((point, i) =>
            point.every((v, j) => Math.abs(v - expected[i][j]) < 1e-8),
          )
        )
      },
      { x, y, name, expected, tileSpan, url },
    )
    await page.waitForFunction(
      () => {
        const map = window.reviewMap
        const { width, height } = map.getContainer().getBoundingClientRect()
        return (
          map.isSourceLoaded('hongkong-latest') &&
          map
            .queryRenderedFeatures([
              [width * 0.25, height * 0.25],
              [width * 0.75, height * 0.75],
            ])
            .some(
              feature =>
                feature.source === 'hongkong-latest' && feature.sourceLayer !== 'water',
            )
        )
      },
      undefined,
      { timeout: 90000 },
    )
    await page.evaluate(
      () =>
        new Promise(resolve => {
          window.reviewMap.once('render', resolve)
          window.reviewMap.triggerRepaint()
        }),
    )
    if (id === 'counterweight-ballet') {
      const alpha = await page.evaluate(
        ({ x, y }) => {
          const image = window.reviewMap.getSource(`v2-${x}-${y}`).image
          const canvas = document.createElement('canvas')
          canvas.width = image.width
          canvas.height = image.height
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0)
          return [
            [0.5, 0.6],
            [0.5, 0.85],
            [0.5, 1],
            [0.1, 0.1],
          ].map(
            ([u, v]) =>
              context.getImageData(
                Math.floor(u * (image.width - 1)),
                Math.floor(v * (image.height - 1)),
                1,
                1,
              ).data[3],
          )
        },
        { x, y },
      )
      assert.equal(alpha[0], 255)
      assert.ok(alpha[1] > 0 && alpha[1] < 255)
      assert.equal(alpha[2], 0)
      assert.equal(alpha[3], 0)
    }
    await page.screenshot({
      path: `${process.env.DEV_RUNNER_ARTIFACTS}/${id}.png`,
    })
    assert.deepEqual(
      await (await page.request.get(base + url, { maxRetries: 3 })).body(),
      await readFile(`public${url}`),
    )
    console.log('Verified painting bytes and map bounds for', name)
    await page.getByRole('button', { name: 'Next painting' }).click()
  }
  await page.waitForFunction(() =>
    document.querySelector('.v2-review output')?.textContent.startsWith('1/6'),
  )
} finally {
  await browser.close()
}
