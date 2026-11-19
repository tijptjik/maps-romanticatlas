import assert from 'node:assert/strict'
import path from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright'

const artifacts = process.env.DEV_RUNNER_ARTIFACTS
const base = process.env.PLAYWRIGHT_BASE_URL
if (!artifacts || !base) throw new Error('Run with managed Chrome')
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS],
})
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: mobile, reducedMotion: mobile ? 'reduce' : 'no-preference',
    })
    let themeRequests = 0
    page.on('request', request => {
      if (request.url().endsWith('/atlas-audio/harbour-light-legato.ogg')) themeRequests++
    })
    let releaseAtlas
    const heldAtlas = new Promise(resolve => { releaseAtlas = resolve })
    await page.route('**/pavilion/clear-harbour-atlas.webp', async route => {
      await heldAtlas
      await route.continue()
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const intro = page.locator('.atlas-intro')
    const book = intro.getByRole('button', { name: 'Enter the Fog', exact: true })
    const note = intro.getByRole('button', { name: 'Cartographer' })
    await page.waitForFunction(() => document.querySelector('#map')?.inert)
    assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)')
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).opacity), '0')
    const deskItems = intro.locator('.pavilion-book,.pavilion-orrery,.pavilion-notes,.pavilion-credit')
    const positions = () => deskItems.evaluateAll(items => items.map(item => {
      const { x, y, width, height } = item.getBoundingClientRect()
      return [x, y, width, height]
    }))
    releaseAtlas()
    await page.waitForFunction(() => !document.documentElement.classList.contains('atlas-boot') && !document.querySelector('#map').inert)
    assert.equal(await intro.evaluate(el => el.classList.contains('is-visible')), true)
    await book.waitFor()
    const [instrument, atlas, booklet, petal] = await positions()
    assert.ok(booklet[0] < atlas[0] + atlas[2] / 2)
    assert.ok(instrument[0] > atlas[0] + atlas[2] / 2 && petal[0] > atlas[0] + atlas[2] / 2)
    assert.ok(petal[1] + petal[3] / 2 > instrument[1] + instrument[3] / 2)
    await intro.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    const room = await intro.locator('.pavilion-room').boundingBox()
    const viewport = page.viewportSize()
    assert.equal(room.width, viewport.width)
    assert.equal(room.height, viewport.height)
    const orrery = intro.locator('.pavilion-orrery img')
    assert.ok((await orrery.getAttribute('src')).endsWith('/orrery.webp'))
    const mist = intro.locator('.pavilion-orb canvas')
    const water = intro.locator('.pavilion-water')
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.pavilion-water')
      return canvas.width > 300 && canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((v,i) => i%4===3 && v>0)
    })
    await intro.locator('.pavilion-page-mist.has-flow').waitFor()
    const credit = intro.getByRole('link', {name:'By TIJPTJIK — type.hk'})
    assert.equal(await credit.getAttribute('href'), 'https://type.hk/')
    assert.ok(await credit.isVisible())
    assert.equal(await intro.locator('.pavilion-orb').evaluate(el => getComputedStyle(el,'::after').borderBottomStyle),'none')
    assert.equal(await intro.locator('.pavilion-sky canvas').count(), 2)
    const initialWater = await water.evaluate(el => el.toDataURL())
    assert.equal(await note.evaluate(el => getComputedStyle(el).transform), 'none')
    const motionSamples = await page.evaluate(async () => {
      const layers = [...document.querySelectorAll('.pavilion-sky canvas,.pavilion-aerostat canvas,.pavilion-orb canvas')]
      const samples = layers.map(layer => {
        const probe = document.createElement('canvas')
        probe.width = Math.min(layer.width, 480)
        probe.height = Math.min(layer.height, 90)
        const ctx = probe.getContext('2d', {willReadFrequently:true})
        let previous
        return () => {
          ctx.clearRect(0, 0, probe.width, probe.height)
          ctx.drawImage(layer, 0, 0, probe.width, probe.height)
          const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data
          const changed = previous && pixels.some((value,i) => i % 4 === 3 && previous[i] !== value)
          previous = pixels
          return changed
        }
      })
      const changes = layers.map(() => 0)
      const gaps = []
      let last
      for (let i = 0; i < 31; i++) {
        const now = await new Promise(requestAnimationFrame)
        if (i) gaps.push(now-last)
        last = now
        samples.forEach((sample,index) => { if (sample()) changes[index]++ })
      }
      return {changes, medianGap: gaps.sort((a,b) => a-b)[15]}
    })
    console.log('Painted cloud, balloon and orb frames', { mobile, ...motionSamples, orbChanges: motionSamples.changes.at(-1) })
    assert.ok(motionSamples.changes.every(count => mobile ? count === 0 : count >= 24))
    const initialMist = await mist.evaluate(el => el.toDataURL())
    await page.waitForTimeout(350)
    assert.equal(await mist.evaluate(el => el.toDataURL()) === initialMist, mobile)
    assert.equal(await water.evaluate(el => el.toDataURL()) === initialWater, mobile)
    const pages = book.locator('.pavilion-spread')
    const spread = await pages.boundingBox()
    const cloud = await mist.boundingBox()
    assert.ok(cloud.y + cloud.height/2 > spread.y, 'Orb centre is backed by the printed map')
    assert.equal(await intro.getByText('Enter the Fog', { exact:true }).count(),0)
    await page.screenshot({ path: path.join(artifacts, mobile ? 'pavilion-mobile.png' : 'pavilion-desktop.png') })
    if (!mobile) {
      // Compare scenery independently of passing petals and twinkling reflections.
      const foreground = await page.addStyleTag({content: '.pavilion-air,.pavilion-lamps,.pavilion-sun{visibility:hidden}'})
      const samples = [
        ['iron crown',700,88,40,22,true], ['front pier',58,235,18,115,true],
        ['swaying leaves',220,25,60,55,false], ['moving page ink',590,518,75,40,false],
        ['fixed binding',710,729,24,9,true], ['mountains',1054,480,13,8,true],
        ['water surface',1055,590,20,10,false],
      ]
      const before = await page.screenshot({path:path.join(artifacts,'harbour-frame-a.png')})
      const balloon = intro.locator('.pavilion-aerostat--west')
      async function balloonPigment() {
        return balloon.locator('canvas').evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
          const sum = [0,0,0]
          let coverage = 0
          for (let i = 0; i < pixels.length; i += 4) {
            const alpha = pixels[i+3] / 255
            coverage += alpha
            sum.forEach((_,ch) => { sum[ch] += pixels[i+ch] * alpha })
          }
          return sum.map(value => value / coverage)
        })
      }
      const colour = await balloonPigment()
      await page.waitForTimeout(900)
      const after = await page.screenshot({path:path.join(artifacts,'harbour-frame-b.png')})
      for (const [name,left,top,width,height,stationary] of samples) {
        const crop = async png => sharp(png).extract({left,top,width,height}).raw().toBuffer()
        assert.equal((await crop(before)).equals(await crop(after)),stationary,name)
      }
      await foreground.evaluate(el => el.remove())
      const later = await balloonPigment()
      assert.ok(later.every((value,i) => Math.abs(value-colour[i]) < 24), 'Balloon body retains its pigment')
    }
    assert.equal(await book.or(note).count(), 2)
    const paintedCover = await note.locator('.pavilion-notes__cover').elementHandle()
    const deskCover = await paintedCover.boundingBox()
    if (mobile) await note.tap()
    else await note.click()
    const reader = page.getByRole('dialog')
    await reader.waitFor()
    assert.equal(await reader.locator(':scope > .note-pages .note-leaf').count(), 2)
    if (!mobile) {
      assert.ok(await paintedCover.evaluate(el => el.parentElement.classList.contains('note-board')))
      const seek = time => reader.evaluate((el, time) => {
        el.getAnimations({subtree:true}).forEach(animation => {
          animation.pause()
          animation.currentTime = time
        })
      }, time)
      await seek(0)
      const liftedCover = await paintedCover.boundingBox()
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(liftedCover[key] - deskCover[key]) < 1, key)
      }
      await seek(420)
      const lift = await reader.evaluate(el => {
        const m = new DOMMatrix(getComputedStyle(el).transform)
        return [Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)]
      })
      assert.ok(Math.abs(lift[0] - lift[1]) < .001)
      await page.screenshot({path: path.join(artifacts, 'lifting-the-book.png')})
      await seek(580)
      const hinge = await reader.evaluate(el => {
        const board = el.querySelector('.note-board')
        const rect = el.getBoundingClientRect()
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, cover: board.getBoundingClientRect().left}
      })
      assert.ok(hinge.x - hinge.cover > 10, 'Leather extends beyond the page hinge')
      const frame = await page.screenshot({path: path.join(artifacts, 'book-spine.png')})
      // Removing the paper must leave the painted spine pixels identical.
      const hidePaper = await page.addStyleTag({content: '.note-face { filter: opacity(0) }'})
      const leather = await page.screenshot()
      await hidePaper.evaluate(el => el.remove())
      const spineStrip = {left: Math.floor(hinge.x), top: Math.floor(hinge.y) - 40, width: 5, height: 80}
      const pixels = png => sharp(png).extract(spineStrip).raw().toBuffer()
      assert.deepEqual(await pixels(frame), await pixels(leather))
      await seek(1100)
      assert.ok(await reader.locator('.note-face--left').isVisible())
      for (const time of [1100, 1220, 1340]) {
        await seek(time)
        const [topEdge, bottomEdge] = await reader.locator('.note-face--right').evaluate(face =>
          [0, 100].map(top => {
            const marker = document.createElement('i')
            marker.style.cssText = `position:absolute;right:0;top:${top}%;width:0;height:0`
            face.append(marker)
            const {x, y} = marker.getBoundingClientRect()
            marker.remove()
            return {x, y}
          }))
        const opened = await page.screenshot({path: path.join(artifacts, `opening-the-book-${time}.png`)})
        const {data, info} = await sharp(opened).removeAlpha().raw().toBuffer({resolveWithObject:true})
        // Follow the slant of the outer edge, inspecting the 120px of paper
        // inside it. The reported binding line sits about 50px into that band.
        const firstRow = Math.ceil(topEdge.y + (bottomEdge.y - topEdge.y) * .12)
        const lastRow = Math.floor(topEdge.y + (bottomEdge.y - topEdge.y) * .88)
        let rowsWithBinding = 0
        for (let y = firstRow; y <= lastRow; y++) {
          const t = (y - topEdge.y) / (bottomEdge.y - topEdge.y)
          const edgeX = Math.floor(topEdge.x + (bottomEdge.x - topEdge.x) * t)
          for (let x = edgeX - 120; x < edgeX - 3; x++) {
            const i = (y * info.width + x) * info.channels
            if (data[i+1] > data[i] + 5 && data[i+1] < 140 && data[i+1] > data[i+2]) {
              rowsWithBinding++
              break
            }
          }
        }
        assert.ok(rowsWithBinding < (lastRow - firstRow) * .05, `Binding visible inside right page at ${time}ms`)
      }
      await reader.evaluate(el => el.getAnimations({subtree:true}).forEach(animation => animation.play()))
    }
    await reader.evaluate(el => Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished)))
    await page.screenshot({path: path.join(artifacts, mobile ? 'reading-mobile.png' : 'reading-desktop.png')})
    await page.keyboard.press('Escape')
    await reader.waitFor({state:'hidden'})
    assert.ok(await paintedCover.evaluate(el => el.parentElement.classList.contains('pavilion-notes')))
    assert.equal(await note.evaluate(el => el === document.activeElement), true)
    assert.equal(themeRequests, 0, 'Reading the booklet keeps the pavilion silent')
    const themeStarted = page.waitForRequest('**/atlas-audio/harbour-light-legato.ogg')
    const orb = book.locator('.pavilion-orb')
    if (mobile) await orb.tap()
    else {
      await book.hover()
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.pavilion-orb canvas')
        const light = document.querySelector('.pavilion-page-light')
        return Number(getComputedStyle(canvas).scale) >= 1.139 &&
          getComputedStyle(canvas).translate.includes('-7%') && Number(getComputedStyle(light).opacity) >= .99
      })
      await page.screenshot({path: path.join(artifacts, 'atlas-hover.png')})
      await orb.hover()
      assert.deepEqual(await pages.boundingBox(),spread)
      assert.equal(await pages.evaluate(el => getComputedStyle(el).filter),'none')
      assert.equal(await book.locator('.pavilion-sparks i').first().evaluate(el => el.getAnimations().length), 1)
      await orb.click()
      assert.equal(await intro.evaluate(el => el.classList.contains('is-exiting')), true)
      assert.equal(await orb.evaluate(el => el.getAnimations()[0]?.animationName), 'pavilion-launch')
      await page.waitForTimeout(570)
      await page.screenshot({ path: path.join(artifacts, 'entering-the-harbour.png') })
    }
    await intro.waitFor({ state: 'hidden' })
    await themeStarted
    await page.locator('.maplibregl-canvas').waitFor()
    const mapHistoryLength = await page.evaluate(() => history.length)
    await page.goBack()
    await book.waitFor()
    assert.equal(await intro.evaluate(el => el.classList.contains('is-visible')), true)
    await page.goForward()
    await intro.waitFor({state:'hidden'})
    assert.equal(await page.evaluate(() => history.length), mapHistoryLength)
    await page.keyboard.press('Control+m')
    await intro.waitFor()
    if (mobile) await book.tap()
    else await book.press('Enter')
    await intro.waitFor({ state: 'hidden' })
    await page.close()
  }
} finally {
  await browser.close()
}
