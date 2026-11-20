import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { isFogPatternSelected } from '../../src/fog-pattern.js'

const base = process.env.PLAYWRIGHT_BASE_URL
const browser = await chromium.launch({channel: 'chrome', headless: false,
  args: ['--ozone-platform=x11', '--class=' + process.env.DEV_RUNNER_CHROME_CLASS]})
try {
  const page = await browser.newPage({viewport: {width: 1000, height: 800}})
  const tile = {x: 214180, y: 114420, zoom: 18, isTargetable: true, regionalLandAvailable: true}
  while (!isFogPatternSelected(tile)) tile.x++
  const records = []
  const session = await page.request.get(base + '/api/atlas-tiles/cached?admin=true')
  if (session.ok()) assert.equal((await session.json()).adminMode, true)
  else assert.ok([401,403,503].includes(session.status()))
  await page.addInitScript(({x,y}) => {
    sessionStorage.setItem('atlas-admin-token', 'test-admin')
    history.replaceState({atlasModeCamera: {center: [(x+.5)/262144*360-180,
      Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/262144)))*180/Math.PI], zoom: 18}}, '')
  }, tile)
  await page.context().addCookies([{name:'atlas_csrf', value:'fixture', url:base}])
  await page.route('**/api/atlas-tiles/cached?**', route => {
    assert.equal(route.request().headers().authorization, 'Bearer test-admin')
    return route.fulfill({json:{adminMode:true, tiles:[]}})
  })
  await page.route('**/api/fog-index/**', route => {
    const parent = '/' + Math.floor(tile.x/8) + '/' + Math.floor(tile.y/8)
    return route.fulfill({json: {eligibility: route.request().url().endsWith(parent) ? [tile] : [], cached:[]}})
  })
  await page.route('**/api/artwork-reviews', route => route.fulfill({json:[]}))
  await page.route('**/api/artwork-revisions', route => route.fulfill({json:records}))
  await page.route('**/atlas-v2/catalog.json', route => route.fulfill({json:{release:'v2',sheets:[]}}))
  await page.route('**/api/artwork-generation?**', route => {
    const body = route.request().postDataJSON()
    assert.equal(route.request().headers()['x-atlas-csrf-token'], 'fixture')
    assert.equal(body.x, tile.x)
    assert.ok(body.mapImage.startsWith('data:image/png;base64,'))
    if (!records.length) assert.equal(body.scene, 'The Procession of Feet')
    else assert.equal(body.random, true)
    const job = {id: String(records.length), mode:'generate', state:'pending',
      source:{...tile, rows:1, scene:body.family ?? 'automata', title:body.scene ?? 'Random scene', url:'/fixture/' + records.length}}
    records.push(job)
    return route.fulfill({status:202,json:job})
  })
  await page.goto(base + '/?admin&noSplash&noMusic')
  const choose = page.getByRole('button', {name:'Choose scene',exact:true})
  await choose.waitFor({timeout:60000})
  // Click the highlighted map surface beside the marker.
  const box = await choose.boundingBox()
  await page.mouse.click(box.x-20, box.y+12)
  const dialog = page.getByRole('dialog', {name:'Choose a scene'})
  await dialog.getByLabel('Scene family').selectOption('circus')
  await dialog.getByLabel('Scene', {exact:true}).selectOption('The Procession of Feet')
  await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/scene-picker.png'})
  await dialog.getByRole('button',{name:'Queue scene'}).click()
  await page.getByText('Queued The Procession of Feet', {exact:false}).waitFor({timeout:75000})
  await choose.click()
  assert.equal(await dialog.locator('option[value="circus"]').count(),0)
  await dialog.getByRole('button',{name:'Cancel'}).click()
  await page.getByRole('button',{name:/Queue a random scene on tile/}).click()
  await page.getByText('Queued Random scene', {exact:false}).waitFor({timeout:75000})
  assert.equal(records.length,2)
  await page.screenshot({path:process.env.DEV_RUNNER_ARTIFACTS+'/eligible-target.png'})
} finally { await browser.close() }
