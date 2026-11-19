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
  expect(store.claim('1/2',first,'visitor-b','source')).toEqual(second)
  expect(store.claim('1/2',first,'visitor-c','source')).toBeNull()
  expect(store.read('1/2')!.job).toBeTruthy()
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('cloud assignment is stable and approximately half the city',()=>{
 let fake=0
 for(let x=214100;x<214200;x++)for(let y=114400;y<114500;y++)if(isFakeRenderTile({x,y}))fake++
 expect(fake).toBeGreaterThan(4700);expect(fake).toBeLessThan(5300)
})
