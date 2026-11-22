import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error.message))
  page.on('requestfailed', request =>
    console.warn(new URL(request.url()).pathname, request.failure()?.errorText),
  )
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?review&noMusic=true`)
  const card = page.getByLabel('Contact card', { exact: true })
  const diagnostics = page.locator('.atlas-image-count').first()
  for (const key of ['r', 'v', 'd', 'v', 'a', 'v']) {
    console.log('Checking shortcut', key, new URL(page.url()).search)
    if (key === 'v') {
      await page.keyboard.press('v')
      await card.waitFor()
      const origin = await page.evaluate(() => performance.timeOrigin)
      await page.keyboard.press('v')
      assert.equal(await page.evaluate(() => performance.timeOrigin), origin)
    } else {
      await card.waitFor()
      const admin =
        key === 'a' &&
        page.waitForResponse(r => r.url().includes('/api/atlas-tiles/cached?admin'))
      await page.keyboard.press(key)
      if (key === 'r') await page.locator('.atlas-fog').waitFor()
      if (key === 'd') await diagnostics.waitFor()
      if (admin) {
        const response = await admin
        if (response.ok()) {
          assert.equal((await response.json()).adminMode, true)
          await page.locator('#map.atlas-admin-mode').waitFor()
        } else {
          assert.ok([401, 403, 503].includes(response.status()))
          assert.equal(await page.locator('.atlas-admin-actions').count(), 0)
        }
      }
    }
    const params = new URL(page.url()).searchParams
    for (const [shortcut, flag] of Object.entries({
      v: 'review',
      d: 'diagnostics',
      a: 'admin',
    })) {
      if (shortcut === key)
        assert.match(new URL(page.url()).search, new RegExp(`[?&]${flag}(&|$)`))
      assert.equal(params.get(flag), shortcut === key ? '' : null)
    }
    assert.equal(params.get('noMusic'), 'true')
  }
  await page.screenshot({
    path: path.join(process.env.DEV_RUNNER_ARTIFACTS, 'review-shortcuts.png'),
  })
} finally {
  await browser.close()
}
