import assert from 'node:assert/strict'
import {chromium} from 'playwright'
const browser = await chromium.launch({channel:'chrome',headless:false,args:['--ozone-platform=x11','--class='+process.env.DEV_RUNNER_CHROME_CLASS]})
try {
  const page = await browser.newPage({viewport:{width:900,height:1000}})
  await page.route('**/src/main.ts*', async route => {
    const res=await route.fetch()
    await route.fulfill({response:res,body:(await res.text()).replace('installArtworkSampling(map)','window.reviewMap = map; installArtworkSampling(map)')})
  })
  await page.goto(process.env.PLAYWRIGHT_BASE_URL+'/?review&card=space-elevator&painting=1')
  await page.waitForFunction(()=>window.reviewMap?.getSource('v2-214198-114418')?.image?.width>0)
  assert.equal(await page.getByLabel('Contact card',{exact:true}).inputValue(),'space-elevator')
  await page.evaluate(()=>new Promise(resolve=>{window.reviewMap.once('idle', resolve);window.reviewMap.triggerRepaint()}))
  await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/space-elevator.png'})
} finally { await browser.close() }
