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
try {
  const page = await browser.newPage()
  await page.route('**/decode-test.html', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<canvas id="sample" width="4" height="4"></canvas>',
    }),
  )
  await page.goto(`${base}/decode-test.html`)
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 4, 4)
      return canvas.toDataURL().split(',')[1]
    }),
    'base64',
  )
  const requests = {}
  await page.route('**/decode-test/*.png', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop()
    const attempt = (requests[name] ?? 0) + 1
    requests[name] = attempt
    if (name === 'missing.png' || (name === 'later.png' && attempt <= 2))
      return route.fulfill({
        status: 404,
        json: { error: 'This atlas tile has not been generated yet.' },
      })
    if (name === 'transient.png' && attempt === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary service failure' },
      })
    if (name === 'corrupt.png' && attempt === 1)
      return route.fulfill({ contentType: 'image/png', body: 'truncated PNG' })
    if (name === 'html.png' && attempt === 1)
      return route.fulfill({
        contentType: 'text/html',
        body: '<html>Error page</html>',
      })
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  const results = await page.evaluate(async () => {
    const { decodeArtworkImage } = await import('/src/artwork-image.ts')
    const native = new Image()
    native.src = '/decode-test/missing.png'
    const originalError = await native.decode().then(
      () => null,
      error => error.message,
    )
    const recovered = []
    for (const name of ['transient', 'corrupt', 'html']) {
      const url = `/decode-test/${name}.png`
      const [image, same] = await Promise.all([
        decodeArtworkImage(url),
        decodeArtworkImage(url),
      ])
      const ctx = document.querySelector('canvas').getContext('2d')
      ctx.clearRect(0, 0, 4, 4)
      ctx.drawImage(image, 0, 0)
      recovered.push({
        name,
        same: same === image,
        width: image.naturalWidth,
        pixel: [...ctx.getImageData(0, 0, 1, 1).data],
      })
    }
    const failure = await decodeArtworkImage('/decode-test/later.png').then(
      () => null,
      error => error.message,
    )
    const retry = await decodeArtworkImage('/decode-test/later.png')
    return { originalError, recovered, failure, retryWidth: retry.naturalWidth }
  })
  assert.match(results.originalError, /cannot be decoded/)
  assert.equal(
    results.failure,
    'The artwork could not load. Click the cloud to try again.',
  )
  assert.equal(results.retryWidth, 4)
  for (const image of results.recovered) {
    assert.equal(image.same, true)
    assert.equal(image.width, 4)
    assert.deepEqual(image.pixel, [255, 0, 0, 255])
    assert.equal(requests[`${image.name}.png`], 2)
  }
  assert.equal(requests['later.png'], 3)
  assert.equal(
    await page.evaluate(async () => {
      const { decodeArtworkImage, forgetArtworkImage } = await import(
        '/src/artwork-image.ts'
      )
      const url = '/decode-test/transient.png'
      const previous = await decodeArtworkImage(url)
      forgetArtworkImage(url)
      return previous !== (await decodeArtworkImage(url))
    }),
    true,
  )
  assert.equal(requests['transient.png'], 3)
  await writeFile(
    `${output}/artwork-image.json`,
    JSON.stringify({ results, requests }, null, 2),
  )
  console.log(
    'Verified the original 404 decode error, bounded recovery, shared decoding, and retry after failure',
  )
} finally {
  await browser.close()
}
