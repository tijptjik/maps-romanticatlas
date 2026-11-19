import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const catalog = await (await page.request.get(base + '/atlas-v2/catalog.json')).json()
  const reviews = await (await page.request.get(base + '/api/artwork-reviews')).json()
  const decisions = new Map(reviews.map(review => [review.url, review.status]))
  const art = catalog.sheets.flatMap(sheet => sheet.art.filter(painting => painting.animation &&
    (decisions.get(painting.url) ?? (sheet.accepted && 'accepted')) === 'accepted'))
  assert.ok(art.length, 'Expected an accepted animated skyscraper')
  for (const painting of art) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const view = await context.newPage()
    await view.addInitScript(({ x, y }) => {
      const center = [(x + .5) / 262144 * 360 - 180,
        Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / 262144))) * 180 / Math.PI]
      history.replaceState({ atlasModeCamera: { center, zoom: 17 } }, '')
    }, painting)
    await view.goto(base + '/?noSplash=true&noMusic=true', { waitUntil: 'domcontentloaded' })
    await view.locator('.atlas-fog').waitFor()
    const animation = painting.animation
    const selector = animation.motion ? '.' + animation.motion.sprite :
      animation.glitterOrigin ? '.fountain-glitter i' : '.eclipse-spotlights canvas'
    const effect = view.locator(selector).first()
    assert.equal(await effect.isVisible(), false)
    const plate = view.waitForResponse(response =>
      response.url() === new URL(animation.plate ?? painting.url, base).href && response.ok())
    await view.mouse.click(550, 450)
    await plate
    await view.getByText(painting.title, { exact: true }).first().waitFor()
    await effect.waitFor({ state: 'visible' })
    if (animation.motion) await effect.locator('img').evaluate(image => image.decode())
    const frame = () => effect.evaluate(el => el instanceof HTMLCanvasElement ?
      el.toDataURL() : getComputedStyle(el).transform)
    const initial = await frame()
    await view.waitForFunction(({ selector, initial }) => {
      const el = document.querySelector(selector)
      return (el instanceof HTMLCanvasElement ? el.toDataURL() : getComputedStyle(el).transform) !== initial
    }, { selector, initial })
    await view.emulateMedia({ reducedMotion: 'reduce' })
    await view.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const still = await frame()
    await view.waitForTimeout(150)
    assert.equal(await frame(), still)
    await view.screenshot({ path: process.env.DEV_RUNNER_ARTIFACTS + '/' + painting.x + '-' + painting.y + '.png' })
    console.log(painting.title)
    await context.close()
  }
} finally {
  await browser.close()
}
