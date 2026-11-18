import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base=process.env.PLAYWRIGHT_BASE_URL,out=process.env.DEV_RUNNER_ARTIFACTS
if(!base||!out)throw Error('Use managed Chrome')
const browser=await chromium.launch({channel:'chrome',headless:false,args:['--ozone-platform=x11','--class='+process.env.DEV_RUNNER_CHROME_CLASS]})
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await page.route('**/src/main.ts*',async route=>{
   const response=await route.fetch()
   await route.fulfill({response,body:(await response.text()).replace('installArtworkSampling(map)','window.testAtlasMap=map; installArtworkSampling(map)')})
 })
 await page.goto(base+'/?noSplash=true&noMusic=true')
 await page.waitForSelector('.atlas-fog')
 await page.evaluate(()=>window.testAtlasMap.jumpTo({center:[114.1378,22.283],zoom:17}))
 await page.waitForFunction(()=>window.testAtlasMap.loaded())
 await page.waitForTimeout(2500)
 const cells=await page.evaluate(async()=>{
   const {viewportFogTiles}=await import('/src/atlas-tiles.ts')
   const {tileBounds}=await import('/src/tile-geometry.ts')
   const {isFogPatternSelected}=await import('/src/fog-pattern.js')
   return viewportFogTiles(window.testAtlasMap).map(t=>{
     const b=tileBounds(t),p=window.testAtlasMap.project([(b.west+b.east)/2,(b.north+b.south)/2])
     return {...t,selected:isFogPatternSelected(t),px:p.x,py:p.y}
   }).filter(t=>t.px>200&&t.px<1240&&t.py>200&&t.py<800)
 })
 let selected=0,unselected=0
 for(const t of cells){
   await page.mouse.move(t.px,t.py)
   await page.waitForTimeout(50)
   const cursor=await page.locator('.maplibregl-canvas').evaluate(el=>el.style.cursor)
   if(t.selected){if(cursor==='pointer')selected++}
   else {assert.notEqual(cursor,'pointer');unselected++}
 }
 assert.ok(selected>0&&unselected>0)
 console.log({selected,unselected})
 await page.screenshot({path:out+'/main-clouds.png'})
 await page.mouse.wheel(0,300)
 await page.waitForTimeout(1200)
 await page.screenshot({path:out+'/main-clouds-zoom-out.png'})
}finally{await browser.close()}
