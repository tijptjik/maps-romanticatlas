import assert from 'node:assert/strict'
import path from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !output) throw new Error('Run through managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  await page.route('**/sampling-test.html', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="map" style="position:fixed;inset:0"></div>',
    }),
  )
  await page.goto(`${base}/sampling-test.html`)
  await page.evaluate(async () => {
    const lib = await import('/node_modules/maplibre-gl/dist/maplibre-gl.mjs')
    lib.setWorkerUrl('/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs')
    const { installArtworkSampling } = await import('/src/artwork-sampling.ts')
    const map = new lib.Map({
      container: 'map',
      style: { version: 8, sources: {}, layers: [] },
      center: [0, 0],
      zoom: 20,
      attributionControl: false,
    })
    window.gridMap = map
    installArtworkSampling(map)
    await map.once('load')
    const patch = document.createElement('canvas')
    patch.width = patch.height = 1024
    const ctx = patch.getContext('2d')
    ctx.fillStyle = 'rgb(225, 96, 33)'
    ctx.fillRect(0, 0, 512, 1024)
    ctx.fillStyle = 'rgb(37, 104, 198)'
    ctx.fillRect(512, 0, 512, 1024)
    const half = 180 / 2 ** 18
    map.addSource('patch', {
      type: 'image',
      url: patch.toDataURL(),
      coordinates: [
        [-half, half],
        [half, half],
        [half, -half],
        [-half, -half],
      ],
    })
    map.addLayer({
      id: 'patch',
      type: 'raster',
      source: 'patch',
      paint: { 'raster-fade-duration': 0 },
    })
    await map.once('idle')
    window.fullArtwork = map.getSource('patch').image
  })
  for (const zoom of [17, 15, 20]) {
    await page.evaluate(async zoom => {
      const map = window.gridMap
      const idle = map.once('idle')
      map.jumpTo({ zoom })
      await idle
    }, zoom)
    const span = 512 * 2 ** (zoom - 18)
    const width = await page.evaluate(
      () => window.gridMap.getSource('patch').image.width,
    )
    assert.ok(width >= Math.min(span, 1024) && width <= Math.min(span * 2, 1024))
    const buffer = await page.screenshot({
      path: path.join(output, `sampling-${zoom}.png`),
    })
    for (const [direction, expected] of [
      [-1, [225, 96, 33]],
      [1, [37, 104, 198]],
    ]) {
      const left = 550 + direction * Math.min(200, span / 4)
      const pixel = await sharp(buffer)
        .extract({ left, top: 425, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer()
      assert.ok(
        expected.every((value, i) => Math.abs(pixel[i] - value) <= 3),
        `zoom ${zoom}: expected ${expected}, got ${[...pixel]}`,
      )
    }
  }
  assert.ok(
    await page.evaluate(
      () => window.gridMap.getSource('patch').image === window.fullArtwork,
    ),
  )
} finally {
  await browser.close()
}
