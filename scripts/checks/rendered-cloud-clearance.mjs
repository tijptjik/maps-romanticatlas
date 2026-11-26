import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.PLAYWRIGHT_BASE_URL
const out = process.env.DEV_RUNNER_ARTIFACTS
if (!base || !out) throw Error('Run with managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ozone-platform=x11', `--class=${process.env.DEV_RUNNER_CHROME_CLASS}`],
})
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    hasTouch: true,
  })
  const x = 214168,
    y = 114420
  const center = [
    ((x + 1) / 262144) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 262144))) * 180) / Math.PI,
  ]
  const art = [y, y + 1].map((row, index) => ({
    x,
    y: row,
    columns: 2,
    rows: 1,
    title: ['Painting', 'Neighbour'][index],
    url: `/hku-skyscrapers-in-place/mirror-garden/the-borrowed-horizon.webp?row=${row}`,
  }))
  await page.addInitScript(
    center => history.replaceState({ atlasModeCamera: { center, zoom: 17 } }, ''),
    center,
  )
  // Hold the timeline at each sampled fraction so GPU readback can't skip
  // a stage. Both the artwork and fog still render through the normal path.
  await page.route('**/src/atlas-tiles.ts*', async route => {
    const response = await route.fetch()
    const body = await response.text()
    const timeline =
      /clampUnit\(\(\s*(?:now - ready|time - startedAt)\) \/ generatedRevealDuration\)/g
    const initial = /clampUnit\(\(now - tapped\) \/ initialCloudFadeDuration\)/
    assert.match(body, initial)
    assert.equal(body.match(timeline)?.length, 2)
    await route.fulfill({
      response,
      body: body
        .replace(timeline, '(window.sampleProgress ?? $&)')
        .replace(initial, '(window.initialFadeProgress ?? $&)'),
    })
  })
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        'installArtworkSampling(map)',
        'window.testMap = map; installArtworkSampling(map)',
      ),
    })
  })
  await page.route('**/atlas-v2/catalog.json', route =>
    route.fulfill({ json: { release: 'v2', sheets: [{ accepted: true, art }] } }),
  )
  await page.route('**/api/artwork-reviews', route => route.fulfill({ json: [] }))
  await page.route('**/api/fog-index/**', route =>
    route.fulfill({ json: { eligibility: [] } }),
  )
  await page.goto(`${base}/?noSplash&noMusic&noFakeRender`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.atlas-fog-cached-mist.is-visible').waitFor()
  await page.evaluate(
    ({ x, y }) => {
      const layer = `atlas-tile-${x}-${y}`
      const stages = [0, 0.22, 0.45, 0.68, 0.9]
      const strip = document.createElement('canvas')
      strip.width = 320 * stages.length
      strip.height = 190
      const stripContext = strip.getContext('2d')
      const fog = document.querySelector('.atlas-fog')
      const mist = document.querySelector('.atlas-fog-cached-mist')
      const copy = document.createElement('canvas')
      copy.width = 320
      copy.height = 190
      const ctx = copy.getContext('2d', { willReadFrequently: true })
      const samples = []
      const draw = (context, canvas) => {
        const rect = canvas.getBoundingClientRect()
        const sx = canvas.width / rect.width,
          sy = canvas.height / rect.height
        context.drawImage(
          canvas,
          (280 - rect.x) * sx,
          (210 - rect.y) * sy,
          640 * sx,
          380 * sy,
          0,
          0,
          320,
          190,
        )
      }
      window.sampleProgress = 0
      window.revealFrames = new Promise(resolve => {
        const sample = () => {
          const progress = window.testMap.getLayer(layer)
            ? window.testMap.getPaintProperty(layer, 'raster-opacity')
            : 0
          if (progress >= stages[samples.length]) {
            ctx.clearRect(0, 0, 320, 190)
            draw(ctx, fog)
            const alpha = [58, 160, 262].map(x => ctx.getImageData(x, 95, 1, 1).data[3])
            stripContext.save()
            stripContext.translate(samples.length * 320, 0)
            draw(stripContext, window.testMap.getCanvas())
            draw(stripContext, fog)
            draw(stripContext, mist)
            stripContext.restore()
            samples.push({ progress, alpha })
            window.sampleProgress = stages[samples.length] ?? 1
          }
          if (samples.length < stages.length)
            setTimeout(() => requestAnimationFrame(sample), 250)
          else resolve({ samples, image: strip.toDataURL() })
        }
        sample()
      })
    },
    { x, y },
  )
  // Hold the image off the network until a real tap has visibly thinned its cloud.
  let releaseImage
  const held = new Promise(resolve => {
    releaseImage = resolve
  })
  await page.route('**/*?row=114420', async route => {
    await held
    await route.continue()
  })
  await page.evaluate(() => {
    window.initialFadeProgress = 0
  })
  const rainbowAlpha = () =>
    page.locator('.atlas-fog-cached-mist').evaluate(mist => {
      const rect = mist.getBoundingClientRect()
      const x = Math.floor(((470 - rect.left) * mist.width) / rect.width)
      const y = Math.floor(((400 - rect.top) * mist.height) / rect.height)
      return mist.getContext('2d').getImageData(x, y, 1, 1).data[3]
    })
  const beforeTap = await rainbowAlpha()
  assert.ok(beforeTap > 0)
  await page.touchscreen.tap(470, 400)
  const rainbow = []
  try {
    for (const progress of [0, 0.25, 0.65, 1]) {
      await page.evaluate(value => {
        window.initialFadeProgress = value
      }, progress)
      await page.waitForTimeout(200)
      rainbow.push(await rainbowAlpha())
    }
    assert.ok(
      Math.abs(rainbow[0] - beforeTap) < beforeTap * 0.08,
      'No opacity jump on tap',
    )
    assert.ok(
      rainbow.every((alpha, i) => alpha > 0 && (!i || alpha < rainbow[i - 1])),
      'Rainbow fades progressively and remains visible while the image is held',
    )
    console.log(
      'Rainbow alpha before tap and through the initial fade',
      beforeTap,
      rainbow,
    )
  } finally {
    releaseImage()
    await page.evaluate(() => {
      delete window.initialFadeProgress
    })
  }
  await page.locator('.atlas-title-card:visible').first().waitFor()
  await page.waitForFunction(
    ({ x, y }) => {
      const layer = `atlas-tile-${x}-${y}`
      return (
        window.testMap.getLayer(layer) &&
        window.testMap.getPaintProperty(layer, 'raster-opacity') === 1
      )
    },
    { x, y },
  )
  const sequence = await page.evaluate(() => window.revealFrames)
  await writeFile(
    `${out}/cloud-dissipation.png`,
    Buffer.from(sequence.image.split(',')[1], 'base64'),
  )
  console.log(sequence.samples)
  const [before, , midway] = sequence.samples
  assert.ok(midway.progress < 0.68, 'Captured the middle of the reveal')
  midway.alpha.forEach((alpha, i) => {
    assert.ok(
      alpha > 0 && alpha < before.alpha[i] - 5,
      'Both edges and the centre thin together',
    )
  })
  for (const zoom of [17, 16.5]) {
    await page.evaluate(
      ({ center, zoom }) => window.testMap.stop().jumpTo({ center, zoom }),
      { center, zoom },
    )
    await page.waitForTimeout(700)
    for (const selector of ['.atlas-fog', '.atlas-fog-cached-mist']) {
      const sample = await page.locator(selector).evaluate((canvas, zoom) => {
        const rect = canvas.getBoundingClientRect()
        const copy = document.createElement('canvas')
        copy.width = canvas.width
        copy.height = canvas.height
        const ctx = copy.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const size = 512 * 2 ** (zoom - 18)
        const px = x => ((x - rect.left) * copy.width) / rect.width
        const py = y => ((y - rect.top) * copy.height) / rect.height
        const maxAlpha = (left, top, right, bottom) => {
          const x = Math.ceil(px(left)),
            y = Math.ceil(py(top))
          const data = ctx.getImageData(
            x,
            y,
            Math.floor(px(right)) - x,
            Math.floor(py(bottom)) - y,
          ).data
          let max = 0
          for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i])
          return max
        }
        // Read outward from the artwork into the middle of a cloudy cell.
        const profile = Array.from({ length: 61 }, (_, step) => {
          const x = px(600 - size / 2),
            y = py(400 + size * (0.1 + step / 50))
          return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3]
        })
        const peak = Math.max(...profile)
        const crossing = fraction =>
          profile.findIndex(alpha => alpha >= peak * fraction) / 50
        return {
          taperInCells: crossing(0.9) - crossing(0.1),
          peak,
          boundary: profile[20],
          interior: maxAlpha(
            600 - size / 2,
            400 - size * 0.1,
            600 + size / 2,
            400 + size * 0.1,
          ),
          neighbour: maxAlpha(
            600 - size,
            400 + size * 0.8,
            600 + size,
            400 + size * 1.2,
          ),
        }
      }, zoom)
      console.log({ zoom, selector, ...sample })
      assert.ok(sample.interior <= 2)
      const boundaryFraction = sample.boundary / sample.peak
      assert.ok(
        boundaryFraction >= 0.38 && boundaryFraction <= 0.62,
        'Tile boundary bisects the visible taper',
      )
      assert.ok(sample.neighbour > 0 && sample.peak > 0)
      assert.ok(sample.taperInCells >= 0.22, 'The fade spans the shared edge')
    }
    await page.screenshot({ path: `${out}/cloud-clearance-${zoom}.png` })
  }
  const target = { x: 214165, y }
  const ring = [
    [-1, -1, 3],
    [-1, 1, 3],
    [-2, 0, 2],
    [1, 0, 2],
    [0, 0, 1],
  ]
  art.splice(
    0,
    art.length,
    ...ring.map(([dx, dy, columns], index) => ({
      x: target.x + dx,
      y: y + dy,
      columns,
      rows: 1,
      title: `Ring ${index}`,
      url:
        '/hku-skyscrapers-in-place/mirror-garden/the-borrowed-horizon.webp?ring=' +
        index,
    })),
  )
  await page.route('**/api/fog-index/**', route =>
    route.fulfill({
      json: {
        eligibility: [
          {
            ...target,
            regionalLandAvailable: true,
            landFraction: 1,
            isTargetable: true,
          },
        ],
      },
    }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.atlas-fog-cached-mist.is-visible').waitFor()
  const resetCamera = async () => {
    await page.evaluate(async target => {
      const { tileBounds } = await import('/src/tile-geometry.ts')
      const b = tileBounds(target)
      window.testMap
        .stop()
        .jumpTo({ center: [(b.west + b.east) / 2, (b.north + b.south) / 2], zoom: 17 })
    }, target)
    await page.waitForTimeout(400)
  }
  const clickPainting = async (dx, dy, art) => {
    await page.mouse.click(600 + dx * 256, 400 + dy * 256)
    await page.waitForFunction(({ x, y }) => {
      const layer = `atlas-tile-${x}-${y}`
      return (
        window.testMap.getLayer(layer) &&
        window.testMap.getPaintProperty(layer, 'raster-opacity') === 1
      )
    }, art)
  }
  for (const [index, [dx, dy]] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ].entries()) {
    await resetCamera()
    await clickPainting(dx, dy, art[index])
  }
  await resetCamera()
  for (const selector of ['.atlas-fog', '.atlas-fog-cached-mist']) {
    const alpha = await page.locator(selector).evaluate(canvas => {
      const rect = canvas.getBoundingClientRect()
      const pixel = document.createElement('canvas').getContext('2d')
      pixel.drawImage(
        canvas,
        ((600 - rect.x) * canvas.width) / rect.width,
        ((400 - rect.y) * canvas.height) / rect.height,
        1,
        1,
        0,
        0,
        1,
        1,
      )
      return pixel.getImageData(0, 0, 1, 1).data[3]
    })
    console.log({ surrounded: selector, alpha })
    assert.ok(
      alpha > (selector === '.atlas-fog' ? 150 : 45),
      'Surrounded target keeps its cloud core',
    )
  }
  await page.screenshot({ path: `${out}/surrounded-target.png` })
  await clickPainting(0, 0, art[4])
} finally {
  await browser.close()
}
