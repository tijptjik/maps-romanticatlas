import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const js = await response.text()
    const body = js.replace(
      'installArtworkSampling(map)',
      'window.reviewMap = map; installArtworkSampling(map)',
    )
    assert.notEqual(body, js)
    await route.fulfill({ response, body })
  })
  const base = process.env.PLAYWRIGHT_BASE_URL
  await page.goto(`${base}/?review&card=harbour-airworks&painting=1`)
  const select = page.getByLabel('Contact card', { exact: true })
  const catalog = await (await page.request.get(`${base}/atlas-v2/catalog.json`)).json()
  const studies = catalog.sheets.filter(s => s.title.startsWith('Skyscrapers · '))
  assert.equal(studies.length, 6)
  for (const sheet of studies) {
    const study = JSON.parse(await readFile(`releases/sources/${sheet.id}.json`))
    assert.equal(sheet.art.length, study.tiles.length)
    await select.selectOption(sheet.id)
    for (const [index, art] of sheet.art.entries()) {
      const { title, x, y } = study.tiles[index]
      assert.deepEqual([art.title, art.x, art.y, art.rows], [title, x, y, 2])
      await page.waitForFunction(
        ({ x, y, title, url }) => {
          const map = window.reviewMap
          const layer = `v2-${x}-${y}`
          const source = map?.getSource(layer)
          return (
            document.querySelector('.v2-review output')?.textContent.endsWith(title) &&
            map.getLayer(layer) &&
            source?.url === url &&
            source.loaded() &&
            source.image?.height === 2 * source.image?.width &&
            source.image.width > 0
          )
        },
        { ...art, url: art.animation?.plate ?? art.url },
      )
      const tile = study.tiles[index]
      const effect = tile.motion
        ? `.${tile.motion.sprite}`
        : tile.glitterOrigin
          ? '.fountain-glitter i'
          : tile.auditoriumOriginPixels
            ? '.eclipse-spotlights canvas'
            : null
      if (effect) {
        const element = page.locator(effect).first()
        await element.waitFor({ state: 'visible' })
        if (tile.motion) {
          await element.locator('img').evaluate(image => image.decode())
          assert.equal(
            new URL(art.animation.plate, base).pathname,
            `/${sheet.id}/${x}-${y}.webp`,
          )
        }
        const frame = () =>
          element.evaluate(el =>
            el instanceof HTMLCanvasElement
              ? el.toDataURL()
              : getComputedStyle(el).transform,
          )
        const first = await frame()
        await page.waitForFunction(
          ({ effect, first }) => {
            const el = document.querySelector(effect)
            return (
              (el instanceof HTMLCanvasElement
                ? el.toDataURL()
                : getComputedStyle(el).transform) !== first
            )
          },
          { effect, first },
        )
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.evaluate(
          () =>
            new Promise(resolve =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        )
        const still = await frame()
        await page.waitForTimeout(150)
        assert.equal(await frame(), still)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
      }
      if (sheet.id !== 'harbour-airworks' || !effect) {
        assert.equal(
          await page
            .locator(
              '.airworks-figure:visible,.eclipse-spotlights:visible,.fountain-glitter:not([hidden])',
            )
            .count(),
          0,
        )
      }
      if (index === 0) {
        await page.screenshot({
          path: `${process.env.DEV_RUNNER_ARTIFACTS}/${sheet.id}.png`,
        })
      }
      if (index + 1 < sheet.art.length) await page.getByLabel('Next painting').click()
    }
    console.log('Reviewed', sheet.title, sheet.art.length)
  }
} finally {
  await browser.close()
}
