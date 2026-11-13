import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const output = process.env.DEV_RUNNER_ARTIFACTS
if (!output || !process.env.PLAYWRIGHT_BASE_URL)
  throw new Error('Run with dev-remote --port PORT chrome bun run test:performance')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  const requests = []
  const pendingFog = new Set()
  page.context().on('request', request => {
    if (request.url().includes('/api/fog-index/')) pendingFog.add(request)
  })
  page.context().on('requestfailed', request => pendingFog.delete(request))
  page.on('pageerror', error => errors.push(error.message))
  page.context().on('requestfinished', request => {
    pendingFog.delete(request)
    if (/mvt|fog-index/.test(request.url()))
      requests.push({ url: request.url(), timing: request.timing() })
  })
  await page.addInitScript(() => {
    window.fogMetrics = { blurAssignments: 0, frames: [], previous: 0, record: false }
    const descriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      'filter',
    )
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'filter', {
      ...descriptor,
      set(value) {
        if (value.includes('blur(')) window.fogMetrics.blurAssignments++
        descriptor.set.call(this, value)
      },
    })
    const tick = time => {
      const metrics = window.fogMetrics
      if (metrics.record && metrics.previous)
        metrics.frames.push(time - metrics.previous)
      metrics.previous = time
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL}/?noSplash=true&noMusic`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('.maplibregl-canvas')
      const gl = canvas?.getContext('webgl2')
      if (!gl) return false
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
      const colours = new Set()
      for (let i = 0; i < pixels.length; i += 400) {
        if (pixels[i + 3]) colours.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
        if (colours.size > 20) return true
      }
      return false
    },
    {},
    { timeout: 120000, polling: 500 },
  )
  const basemapReadyMs = await page.evaluate(() => performance.now())
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('.atlas-fog')
      const gl = canvas?.getContext('webgl')
      if (!gl) return false
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 30) return true
      return false
    },
    {},
    { timeout: 120000, polling: 500 },
  )
  const cloudReadyMs = await page.evaluate(() => performance.now())
  // A first cloud can appear while most eligibility requests are still pending.
  // Measure panning only after the starting viewport has finished loading.
  const settleDeadline = Date.now() + 120000
  let quietSamples = 0
  while (quietSamples < 2 && Date.now() < settleDeadline) {
    await page.waitForTimeout(500)
    quietSamples = pendingFog.size === 0 ? quietSamples + 1 : 0
  }
  assert.equal(pendingFog.size, 0, 'Fog requests did not settle before panning')
  const fogSettledMs = await page.evaluate(() => performance.now())
  await page.screenshot({ path: `${output}/loaded.png` })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    window.fogMetrics.blurAssignments = 0
    window.fogMetrics.record = true
  })
  await page.mouse.move(500, 500)
  await page.mouse.down()
  for (let i = 0; i < 180; i++) {
    await page.mouse.move(500 + i * 2, 500 + Math.sin(i / 30) * 80)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  const pan = await page.evaluate(() => {
    window.fogMetrics.record = false
    const frames = window.fogMetrics.frames.sort((a, b) => a - b)
    return {
      frames: frames.length,
      p50Ms: frames[Math.floor(frames.length * 0.5)],
      p95Ms: frames[Math.floor(frames.length * 0.95)],
      blurAssignments: window.fogMetrics.blurAssignments,
      quality: document.querySelector('.atlas-fog').dataset.quality,
    }
  })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${output}/pan.png` })
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${output}/zoom.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${output}/mobile.png` })
  const report = { basemapReadyMs, cloudReadyMs, fogSettledMs, pan, requests, errors }
  await writeFile(`${output}/performance.json`, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({ basemapReadyMs, cloudReadyMs, fogSettledMs, pan, errors }),
  )
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
