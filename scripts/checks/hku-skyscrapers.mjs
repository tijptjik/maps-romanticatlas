import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const choices = JSON.parse(await readFile('releases/sources/hku-selection.json'))
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS] })
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 950 } })
  page.on('pageerror', e => console.error(e.message))
  const posts = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/atlas-tiles/')) posts.push(r.url()) })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const original = await response.text()
    const body = original.replace('const atlas = installAtlasTileInteractions(', 'window.hkuMap = map; const atlas = installAtlasTileInteractions(')
    assert.notEqual(body, original)
    await route.fulfill({response, body})
  })
  // Exercise every selection while keeping the map's real click and image paths.
  let selectedIndex = 0
  await page.route('**/src/atlas-tiles.ts*', async route => {
    const response = await route.fetch()
    const original = await response.text()
    const body = original.replace(/Math\.random\(\)\s*\*\s*hkuTowers\.length/, String(selectedIndex + .5))
    assert.notEqual(body, original)
    await route.fulfill({response, body})
  })
  for (const [index, choice] of choices.entries()) {
    selectedIndex = index
    const firstY = 114419 + index % 2
    await page.goto(process.env.PLAYWRIGHT_BASE_URL + '/?noSplash=true&noMusic=true')
    await page.waitForFunction(() => window.hkuMap)
    await page.evaluate(() => window.hkuMap.jumpTo({
      center: [214184.5 / 262144 * 360 - 180,
        Math.atan(Math.sinh(Math.PI*(1-2*114420/262144)))*180/Math.PI], zoom: 17,
    }))
    async function clickTile(y) {
      const pt = await page.evaluate(y => {
        const pos = [214184.5 / 262144 * 360 - 180, Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/262144)))*180/Math.PI]
        const point = window.hkuMap.project(pos)
        return [point.x, point.y]
      }, y)
      await page.mouse.click(...pt)
    }
    await clickTile(firstY)
    const title = page.locator('.atlas-title-card:not(.is-awaiting-focus) strong')
    await title.waitFor()
    const name = await title.textContent()
    assert.equal(name, choice.title)
    await clickTile(firstY === 114419 ? 114420 : 114419)
    assert.equal(await title.count(), 1)
    assert.equal(await title.textContent(), name)
    const layer = await page.evaluate(() => window.hkuMap.getSource('atlas-tile-214184-114420').serialize())
    assert.ok(layer.url.endsWith('/' + choices.find(c => c.title === name).slug + '.webp'))
    await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS + '/' + choice.slug + '.png'})
    console.log(firstY, name)
  }
  assert.equal(posts.length, 0)
} finally { await browser.close() }
