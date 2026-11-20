import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { isFogPatternSelected } from '../../src/fog-pattern.js'

const origin=process.env.ATLAS_LIVE_TEST_ORIGIN ?? process.env.PLAYWRIGHT_BASE_URL ?? 'https://romanticatlas.hype.hk'
const browser=await chromium.launch({channel:'chrome',headless:false,args:['--ozone-platform=x11','--class='+process.env.DEV_RUNNER_CHROME_CLASS]})
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'})
 page.setDefaultTimeout(90_000)
 const catalog=await (await page.request.get(origin+'/atlas-v2/catalog.json')).json()
 const reviews=await (await page.request.get(origin+'/api/artwork-reviews')).json()
 const occupied=new Set()
 for(const art of [...catalog.sheets.flatMap(s=>s.art),...reviews.filter(r=>r.status==='accepted')]){
  for(let x=art.x;x<art.x+(art.columns??1);x++)for(let y=art.y-art.rows+1;y<=art.y;y++)occupied.add(x+'/'+y)
 }
 const {eligibility}=await (await page.request.get(origin+'/api/fog-index/15/26773/14302?eligibilityOnly=true')).json()
 const candidates=eligibility.filter(t=>t.isTargetable && isFogPatternSelected(t) && !occupied.has(t.x+'/'+t.y))
 const {statuses}=await (await page.request.post(origin+'/api/atlas-tiles/cache-status',{
  data:{tiles:candidates.map(({x,y})=>({zoom:18,x,y}))},
 })).json()
 const tile=candidates.find((_,index)=>statuses[index]?.cached===false)
 assert.ok(tile,'An eligible white cloud is required')
 console.log('Target',tile.x,tile.y)
 await page.addInitScript(({x,y})=>{
  const center=[(x+.5)/262144*360-180,Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/262144)))*180/Math.PI]
  history.replaceState({atlasModeCamera:{center,zoom:18}},'')
 },tile)
 await page.goto(origin+'/?noSplash=true&noMusic=true',{waitUntil:'domcontentloaded'})
 await page.locator('.atlas-fog').waitFor()
 await page.waitForTimeout(5000)
 await page.mouse.move(720,500)
 await page.waitForTimeout(1000)
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'si-before.png')})
 const submitted=page.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/api/atlas-tiles/18/'),{timeout:90_000})
 await page.mouse.click(720,500)
 const response=await submitted
 const body=await response.json()
 console.log('Submission',response.status(),body)
 assert.equal(response.status(),202,JSON.stringify(body))
 await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS,'si-job.json'),JSON.stringify({tile,statusUrl:body.statusUrl,request:response.url()},null,2))
 const completed=await page.waitForResponse(r=>r.url()===origin+body.statusUrl && r.status()!==202,{timeout:18*60_000})
 const result=await completed.json()
 console.log('Completion',completed.status(),result)
 assert.equal(completed.status(),200,JSON.stringify(result))
 const image=await page.request.get(origin+result.url)
 assert.equal(image.status(),200)
 assert.match(image.headers()['content-type'],/image\/png/)
 await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS,'si-image.png'),await image.body())
 await writeFile(path.join(process.env.DEV_RUNNER_ARTIFACTS,'si-result.json'),JSON.stringify(result,null,2))
 await page.locator('.atlas-title-card').first().waitFor({timeout:30_000})
 await page.waitForTimeout(5000)
 assert.ok(await page.locator('.atlas-intro').isHidden(),'The map must remain visible throughout generation')
 await page.screenshot({path:path.join(process.env.DEV_RUNNER_ARTIFACTS,'si-after.png')})
 console.log('Live artwork rendered in the map')
} finally {await browser.close()}
