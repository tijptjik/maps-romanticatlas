import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createFakeRenderStore } from '../../server/fake-render-store'
import { isFakeRenderTile } from '../../src/fake-render-state'

test('claims survive restart, retry idempotently, and wait for a unique replacement', () => {
 const root=mkdtempSync(tmpdir()+'/atlas-rotation-')
 try {
  const first={url:'/first.png',scene:'maze-garden'}
  const second={url:'/second.png',scene:'maze-garden'}
  let store=createFakeRenderStore(root)
  expect(store.claim('1/2',first,'visitor-a','source')).toEqual(first)
  expect(store.claim('1/2',first,'visitor-b','source')).toBeNull()
  store=createFakeRenderStore(root)
  expect(store.claim('1/2',first,'visitor-a','source')).toEqual(first)
  const state=store.read('1/2')!;state.ready=second;state.job=null;store.save('1/2',state)
  expect(store.snapshot('1/2')).toEqual({ready:true,released:[first]})
  expect(store.claim('1/2',first,'visitor-b','source')).toEqual(second)
  expect(store.snapshot('1/2')).toEqual({ready:false,released:[first,second]})
  expect(store.claim('1/2',first,'visitor-c','source')).toBeNull()
  expect(store.read('1/2')!.job).toBeTruthy()
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('cloud assignment is stable and approximately half the city',()=>{
 let fake=0
 for(let x=214100;x<214200;x++)for(let y=114400;y<114500;y++)if(isFakeRenderTile({x,y}))fake++
 expect(fake).toBeGreaterThan(4700);expect(fake).toBeLessThan(5300)
})

test('a cached tile can receive either assignment on a fresh page load', () => {
  const tile = { x: 214210, y: 114419 }
  const roles = new Set(Array.from({ length: 64 }, (_, visit) => isFakeRenderTile(tile, visit)))
  expect(roles.size).toBe(2)
})

test('released artwork seeds from its family, including opaque asset URLs', async () => {
  const { fakeRenderSeed, seedForPainting, restoreSeedScene } = await import('../../src/fake-render-seed')
  const seed = fakeRenderSeed({ x: 214205, y: 114420 })!
  expect(seed.scene).toBe('mermaid-station')
  expect(seed.url).toContain('/release-assets/')
  expect(restoreSeedScene({ ...seed, scene: 'maze-garden' })).toEqual(seed)
  const art = { title: 'Untyped edition', rows: 1, x: 4, y: 5, url: '/study/abc.webp' }
  expect(seedForPainting(art)).toBeNull()
  expect(seedForPainting({ ...art, scene: 'circus', columns: 2 })).toBeNull()
  expect(seedForPainting({ ...art, url: '/generated-tiles/18/4/5/ironworks?version=6' })?.scene).toBe('ironworks')
})

test('old rotations recover the original family while returning the painting actually rendered', async () => {
  const { fakeRenderSeed } = await import('../../src/fake-render-seed')
  const seed = fakeRenderSeed({ x: 214205, y: 114420 })!
  const garden = { url: '/generated-tiles/18/214205/114420/maze-garden?variant=old', scene: 'maze-garden' }
  const root = mkdtempSync(tmpdir() + '/atlas-old-rotation-')
  try {
    const store = createFakeRenderStore(root)
    store.save('old', {
      scene: 'maze-garden', claims: { first: { ...seed, scene: 'maze-garden' } },
      ready: garden, sourceImage: '', job: null, attempts: 0,
    })
    expect(store.claim('old', seed, 'next', 'source')).toEqual(garden)
    expect(store.read('old')?.scene).toBe(seed.scene)
    expect(store.snapshot('old').released).toEqual([seed, garden])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
