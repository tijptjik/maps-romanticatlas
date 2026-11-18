import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const base = process.env.PLAYWRIGHT_BASE_URL
const out = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !out) throw new Error('Use managed Chrome')
const [x, y] = process.argv.slice(2, 4).map(Number)
const stalled = process.argv[4] === '--stalled'
const artwork = process.argv[4] === '--artwork'
const codex = process.argv[4] === '--codex'
const singleRender = codex || process.argv[4] === '--render'
const deadline = codex ? 16 * 60_000 : 60_000
if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Supply eligible z18 x y')
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS] })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.addInitScript(({ x, y }) => {
    const lng = (x + .5) / 262144 * 360 - 180
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / 262144))) * 180 / Math.PI
    history.replaceState({ ...history.state, atlasModeCamera: { center: [lng, lat], zoom: 17 } }, '')
  }, { x, y })
  await page.addInitScript(() => {
    window.waitingWords = new Set()
    const draw = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas.classList?.contains('atlas-fog-loading')) window.waitingWords.add(text)
      return draw.call(this, text, ...args)
    }
  })
  const results = []
  if (stalled) await page.route('**/api/atlas-tiles/18/**', () => {})
  for (const mode of artwork ? ['artwork'] : stalled ? ['stalled'] : singleRender ? ['cold'] : ['cold', 'cached']) {
    await page.goto(base + '/?noMusic=true', { waitUntil: 'domcontentloaded' })
    if (await page.evaluate(() => history.state?.atlasView !== 'map')) {
      await page.getByRole('button', {name: 'Enter the Fog', exact: true}).click()
    }
    await page.locator('.atlas-intro').waitFor({state: 'hidden'})
    const readyBy = Date.now() + 45000
    while (Date.now() < readyBy) {
      await page.mouse.move(549, 450)
      await page.mouse.move(550, 450)
      if (await page.locator('.maplibregl-canvas').evaluate(el => el.style.cursor === 'pointer')) break
      await page.waitForTimeout(200)
    }
    const cached = await (await page.request.get(base + '/api/atlas-tiles/cache-status/18/' + x + '/' + y)).json()
    if (!codex && (mode === 'cold' || mode === 'stalled') && cached.cached) throw new Error('Choose a fresh cell for cold timing')
    const calls = []
    const responses = []
    const onRequest = r => { if (r.method() === 'POST' && r.url().includes('/api/atlas-tiles/18/')) calls.push(r.url()) }
    const onResponse = async r => {
      if (calls.includes(r.url())) responses.push({ status: r.status(), body: await r.json().catch(() => null) })
    }
    page.on('request', onRequest)
    page.on('response', onResponse)
    await page.evaluate(() => {
      window.addEventListener('click', () => window.studyClickAt = performance.now(), { once: true, capture: true })
    })
    await page.mouse.click(550, 450)
    const result = await page.waitForFunction(() => {
      const error = document.querySelector('.atlas-fog-error-announcement')?.textContent
      const card = document.querySelector('.atlas-title-card:not(.is-awaiting-focus)')
      return window.studyClickAt && (error || card) && { elapsedMs: Math.round(performance.now() - window.studyClickAt), error: error || null, title: card?.textContent }
    }, null, { timeout: deadline + 1000 })
    if (codex && !await result.evaluate(value => value.error)) {
      if (!responses.some(r => r.status === 202 && r.body?.statusUrl?.startsWith('/api/discovery-jobs/')))
        throw new Error('Expected a new local Codex job')
      await page.screenshot({path: path.join(out, 'codex-reveal.png')})
    }
    const words = await page.evaluate(() => [...window.waitingWords])
    const sample = { mode, ...await result.jsonValue(), calls, responses, words }
    results.push(sample)
    console.log(JSON.stringify(sample))
    await writeFile(path.join(out, 'click-timings.json'), JSON.stringify(results, null, 2))
    page.off('request', onRequest)
    page.off('response', onResponse)
    if (mode === 'stalled') {
      if (!sample.error || sample.elapsedMs > deadline || !calls.length) throw new Error('Deadline check failed')
    } else if (((mode === 'cached' || mode === 'artwork') && calls.length) || (mode === 'cold' && !words.length) || sample.error || sample.elapsedMs > deadline || (mode === 'cold' && calls.length !== 1)) {
      throw new Error(sample.error || 'Reveal exceeded the budget or did not generate')
    }
  }
} finally { await browser.close() }
