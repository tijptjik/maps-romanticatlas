import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { isFakeRenderTile } from '../../src/fake-render-state.ts'
import { isFogPatternSelected } from '../../src/fog-pattern.js'
const origin=process.env.PLAYWRIGHT_BASE_URL
const browser=await chromium.launch({channel:'chrome',headless:false,args:['--ozone-platform=x11','--class='+process.env.DEV_RUNNER_CHROME_CLASS]})
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'})
 const errors=[];page.on('pageerror',e=>{ if(e.message==='WebSocket closed without opened.') console.log('Vite HMR connection unavailable through the managed tunnel'); else errors.push(e.message) })
 const catalog=await (await page.request.get(origin+'/atlas-v2/catalog.json')).json()
 const candidates=catalog.sheets.flatMap(s=>s.art).filter(a=>a.rows===1&&(a.columns??1)===1&&isFakeRenderTile(a)&&isFogPatternSelected(a))
 assert.ok(candidates.length,'A rotating catalog cell exists')
 const tile=candidates[0]
 const png=tile.imageUrl??tile.url
 const center=[(tile.x+.5)/262144*360-180,Math.atan(Math.sinh(Math.PI*(1-2*(tile.y+.5)/262144)))*180/Math.PI]
 await page.addInitScript(center=>history.replaceState({atlasModeCamera:{center,zoom:18}},''),center)
 await page.addInitScript(() => {
  const original = crypto.getRandomValues.bind(crypto)
  crypto.getRandomValues = array => array instanceof Uint32Array && array.length === 1 ? array.fill(0) : original(array)
 })
 let busy=false
 let claims=0
 await page.route('**/api/fake-render/**',async route=>{
  if(route.request().method()==='GET') return route.fulfill({json:{ready:!busy,released:[{url:png,scene:'maze-garden'}]}})
  const body=route.request().postDataJSON();assert.match(body.sourceImage,/^data:image\/png;base64,/);assert.match(body.requestId,/^[a-f0-9-]{36}$/)
  claims++
  await route.fulfill({json:{url:png,scene:'maze-garden',contentBounds:null}})
 })
 await page.goto(origin+'/?noSplash=true&noMusic=true',{waitUntil:'domcontentloaded'})
 await page.locator('.atlas-fog').waitFor();await page.waitForTimeout(5000)
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'fake-before.png')})
 const start=Date.now()
 await page.mouse.click(720,500)
 await page.waitForFunction(()=>document.querySelector('.atlas-fog-loading'),{timeout:10000})
 await page.waitForTimeout(6000)
 assert.equal(claims,1)
 assert.equal(await page.locator('.atlas-title-card:not(.is-awaiting-focus)').count(),0,'No artwork reveal before the poem finishes')
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'fake-poem.png')})
 await page.locator('.atlas-title-card:not(.is-awaiting-focus)').first().waitFor({state:'visible',timeout:150000})
 assert.ok(Date.now()-start>15000,'The poem is actually read')
 await page.waitForTimeout(3000)
 assert.equal(claims,1)
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'fake-after.png')})
 console.log('One poem then reveal in',Date.now()-start,'ms; cell',tile.x,tile.y)
 busy=true
 await page.reload({waitUntil:'domcontentloaded'})
 await page.locator('.atlas-fog').waitFor();await page.waitForTimeout(5000)
 await page.mouse.click(720,500)
 await page.waitForTimeout(6000)
 assert.equal(await page.locator('.atlas-title-card:not(.is-awaiting-focus)').count(),0,'Rainbow waits for a poem')
 await page.locator('.atlas-title-card:not(.is-awaiting-focus)').first().waitFor({state:'visible',timeout:150000})
 assert.equal(claims,1,'Rainbow reveals released art while the replacement is pending')
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'rainbow-after.png')})
 await page.goto(origin+'/?noSplash=true&noMusic=true&noFakeRender=true',{waitUntil:'domcontentloaded'})
 await page.locator('.atlas-fog').waitFor();await page.waitForTimeout(3000)
 await page.mouse.click(720,500)
 await page.locator('.atlas-title-card:not(.is-awaiting-focus)').first().waitFor({state:'visible',timeout:15000})
 assert.equal(claims,1,'Override makes no rotating claim')
 assert.deepEqual(errors,[])
 console.log('Override preserves immediate cached reveal')
}finally{await browser.close()}
