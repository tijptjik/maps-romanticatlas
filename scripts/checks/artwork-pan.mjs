import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !output) throw Error('Managed Chrome required')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
const errors = []
const visits = []
const mobile = process.argv.includes('--mobile')
const prefix = mobile ? 'mobile-' : ''
try {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 },
  })
  page.on('pageerror', error => errors.push(error.stack))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      'installArtworkSampling(map)',
      'window.testMap = map; map.on("error", e => console.error(e.error)); installArtworkSampling(map)',
    )
    await route.fulfill({ response, body })
  })
  await page.goto(`${base}/?noSplash=true&noMusic=true`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () =>
      window.testMap?.getSource('hongkong-latest') &&
      window.testMap.isSourceLoaded('hongkong-latest'),
    null,
    { timeout: 60000 },
  )
  // A newly revealed high-resolution painting raises the native zoom ceiling.
  // The already-warm basemap must keep its z15 geometry throughout that change.
  await page.evaluate(async () => {
    const map = window.testMap
    const { tileForPosition, tileBounds } = await import('/src/tile-geometry.ts')
    const { addGeneratedTile } = await import('/src/atlas-tiles.ts')
    const tile = tileForPosition(map.getCenter())
    window.testPainting = tile
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 2048
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#c99075'
    ctx.fillRect(0, 0, 2048, 2048)
    await addGeneratedTile(
      map,
      tile,
      canvas.toDataURL(),
      undefined,
      undefined,
      tileBounds(tile),
      1,
    )
  })
  await page.waitForFunction(() => window.testMap.getMaxZoom() > 19)
  for (const action of ['reveal', 'focus', 'pan', 'zoom-out']) {
    await page.evaluate(async action => {
      const map = window.testMap
      if (action === 'focus') {
        const { focusAtlasTile } = await import('/src/atlas-tiles.ts')
        focusAtlasTile(map, window.testPainting)
      }
      if (action === 'pan') map.panBy([180, 80], { duration: 300 })
      if (action === 'zoom-out') map.easeTo({ zoom: 17, duration: 300 })
    }, action)
    await page.waitForFunction(
      () =>
        !window.testMap.isMoving() && window.testMap.isSourceLoaded('hongkong-latest'),
      null,
      { timeout: 60000 },
    )
    visits.push(
      await page.evaluate(action => {
        const map = window.testMap
        const manager = map.style.tileManagers['hongkong-latest']
        return {
          action,
          zoom: map.getZoom(),
          maxZoom: map.getMaxZoom(),
          lost: map.painter.context.gl.isContextLost(),
          tiles: manager
            .getRenderableIds()
            .map(id => manager.getTileByID(id).tileID.canonical.z),
        }
      }, action),
    )
    await page.screenshot({
      path: `${output}/${prefix}artwork-${action}.png`,
    })
  }
  assert.deepEqual(errors, [])
  assert.ok(
    visits.every(
      visit => !visit.lost && visit.tiles.length && visit.tiles.every(z => z === 15),
    ),
    'Artwork must not replace warm z15 basemap tiles with synthetic higher-zoom tiles: ' +
      JSON.stringify(visits),
  )
} finally {
  await writeFile(
    `${output}/${prefix}artwork-pan.json`,
    JSON.stringify({ errors, visits }, null, 2),
  )
  await browser.close()
}
