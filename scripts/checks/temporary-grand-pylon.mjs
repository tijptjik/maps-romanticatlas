import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const sheet = JSON.parse(
  await readFile('releases/sources/west-kowloon-airship-mooring.json'),
)
const art = sheet.art[0]
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  await page.route('**/src/main.ts*', async route => {
    const res = await route.fetch()
    await route.fulfill({
      response: res,
      body: (await res.text()).replace(
        'installArtworkSampling(map)',
        'window.reviewMap=map; installArtworkSampling(map)',
      ),
    })
  })
  await page.goto(
    `${process.env.PLAYWRIGHT_BASE_URL}/?review&card=${sheet.id}&painting=1`,
  )
  assert.equal(art.rows, 2)
  await page.waitForFunction(({ x, y, url }) => {
    const src = window.reviewMap?.getSource(`v2-${x}-${y}`)
    return src?.url === url && src.loaded() && src.image?.height === 3072
  }, art)
  await page.evaluate(
    () =>
      new Promise(resolve => {
        window.reviewMap.once('idle', resolve)
        window.reviewMap.triggerRepaint()
      }),
  )
  await page.screenshot({
    path: `${process.env.DEV_RUNNER_ARTIFACTS}/grand-airship-mooring.png`,
  })
} finally {
  await browser.close()
}
