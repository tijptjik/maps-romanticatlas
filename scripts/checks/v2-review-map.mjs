import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({channel:'chrome',headless:false,
  args:['--ozone-platform=x11','--class='+process.env.DEV_RUNNER_CHROME_CLASS]})
try {
  const page = await browser.newPage({viewport:{width:1100,height:900}})
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('installArtworkSampling(map)', 'window.reviewMap = map; installArtworkSampling(map)')
    await route.fulfill({response, body})
  })
  const forbidden = []
  const fetched = new Set()
  page.on('request', req => {
    const path = new URL(req.url()).pathname
    if (/^\/(api\/(atlas-tiles|fog-index)|generated-tiles|circus-study|parcel-diversity)/.test(path)) forbidden.push(path)
  })
  page.on('response', res => { if (res.ok()) fetched.add(new URL(res.url()).pathname) })
  const base = process.env.PLAYWRIGHT_BASE_URL
  const data = await (await page.request.get(base+'/atlas-v2/catalog.json')).json()
  for (const query of ['?review']) {
    await page.goto(base+'/'+query)
    const select = page.getByLabel('Contact card',{exact:true})
    await select.waitFor()
    const sheet = data.sheets.find(s => !s.isolated && s.art.length > 1)
    await select.selectOption(sheet.id)
    await page.getByRole('button',{name:'Next painting'}).click()
    const art = sheet.art[1]
    await page.waitForFunction(title => document.querySelector('.v2-review output')?.textContent.includes(title),art.title)
    await page.waitForFunction(() => location.search.includes('painting=2'))
    await page.waitForResponse(r => new URL(r.url()).pathname === art.url.split('?')[0] && r.ok(), {timeout:10000}).catch(() => assert.ok(fetched.has(art.url.split('?')[0])))
    const link = page.url()
    await page.reload()
    await page.waitForFunction(title => document.querySelector('.v2-review output')?.textContent.includes(title),art.title)
    assert.equal(page.url(),link)
    await page.waitForFunction(({x,y,url}) => {
      const map = window.reviewMap
      const source = map?.getSource('v2-'+x+'-'+y)
      return source?.url === url && source.image?.width > 0 && source.loaded() && map.areTilesLoaded()
    },art)
    await page.evaluate(() => new Promise(resolve => {window.reviewMap.once('idle', resolve);window.reviewMap.triggerRepaint()}))
    await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/'+(query.includes('review')?'review':'map')+'.png'})
  }
  const pilot = data.sheets.find(s => s.id === 'hku-cell-pilot')
  if (pilot) {
    await page.getByLabel('Contact card',{exact:true}).selectOption(pilot.id)
    for (const art of pilot.art) {
      await page.waitForFunction(({x,y,url}) => {
        const map = window.reviewMap
        const src = map.getSource('v2-'+x+'-'+y)
        return map.getLayersOrder().filter(id => id.startsWith('v2-')).length === 1 &&
          src?.url === url && src.loaded() && src.image?.width && map.areTilesLoaded()
      }, art)
      await page.getByRole('button',{name:'Next painting'}).click()
    }
    await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/pilot.png'})
  }
  assert.deepEqual(forbidden,[])
  const hku = data.sheets.find(s => s.id === 'hku-skyscrapers-current')
  assert.ok(hku?.accepted && hku.art.length)
  const acceptedUrls = hku.art.map(art => art.animation?.plate ?? art.url)
  await page.addInitScript(({x,y}) => {
    const center = [(x+.5)/262144*360-180,
      Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/262144)))*180/Math.PI]
    history.replaceState({atlasModeCamera:{center,zoom:17}},'')
  },hku.art[0])
  await page.goto(base+'/?noSplash=true&noMusic=true')
  await page.locator('.atlas-fog').waitFor({timeout:60000})
  assert.equal(await page.locator('.v2-review').count(),0)
  await page.mouse.click(550,450)
  await page.locator('.atlas-title-card').waitFor()
  console.log('Normal reveal',await page.locator('.atlas-title-card').allTextContents(),
    await page.evaluate(() => Object.entries(window.reviewMap.getStyle().sources)
      .filter(([,source]) => source.type === 'image').map(([id,source]) => ({id,
        serializedUrl:source.url,url:window.reviewMap.getSource(id)?.url,
        loaded:window.reviewMap.getSource(id)?.loaded(),width:window.reviewMap.getSource(id)?.image?.width}))))
  await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/normal-reveal-diagnostic.png'})
  await page.waitForFunction(urls => {
    const map=window.reviewMap
    return Object.entries(map.getStyle().sources).some(([id,source]) =>
      source.type === 'image' && urls.includes(map.getSource(id)?.url) &&
      map.getSource(id)?.loaded() && map.getSource(id)?.image?.width > 0)
  },acceptedUrls)
  await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/map.png'})
  assert.ok(forbidden.every(url => url.startsWith('/api/fog-index/')),
    'Normal map must not request legacy artwork while revealing the V2 centre')
  console.log('Verified review card selection, alternatives and deep link; normal-map V2 reveal and legacy artwork exclusion')
} finally {await browser.close()}
