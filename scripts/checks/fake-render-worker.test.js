import { test, expect, mock } from 'bun:test'
mock.module('cloudflare:workers',()=>({DurableObject:class {ctx;env;constructor(ctx,env){this.ctx=ctx;this.env=env}}}))
let ready=false
let dispatches=[]
mock.module('../../src/si-generation',()=>({
 startSiGeneration:async(...args)=>{dispatches.push(args);return Response.json({}, {status:202})},
 siGenerationStatus:async()=>Response.json(ready?{url:'/new.png',scene:'maze-garden'}:{pending:true},{status:ready?200:202}),
}))
const {FakeRenderCloud}=await import('../../src/fake-render-cloud')

test('durable claims serialize visitors and alarms replenish after the browser leaves',async()=>{
 const values=new Map();let alarm=null;let serial=Promise.resolve()
 const storage={
  get:async key=>structuredClone(values.get(key)),
  put:async(key,value)=>{if(typeof key==='string')values.set(key,structuredClone(value));else for(const [k,v]of Object.entries(key))values.set(k,structuredClone(v))},
  getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value},deleteAlarm:async()=>{alarm=null},
  transaction(fn){const result=serial.then(()=>fn(storage));serial=result.catch(()=>{});return result},
 }
 const objects=new Map()
 const env={ATLAS_BUCKET:{put:async(k,v)=>{objects.set(k,v)},get:async k=>objects.has(k)?{text:async()=>objects.get(k)}:null,delete:async k=>{objects.delete(k)}}}
 let cloud=new FakeRenderCloud({storage},env)
 const tile={zoom:18,x:1,y:2},seed={url:'/old.png',scene:'maze-garden'}
 const results=await Promise.all(['a','b'].map(id=>cloud.claim(tile,seed,id,'large source image')))
 expect(results.filter(Boolean)).toHaveLength(1)
 expect(alarm).not.toBeNull()
 expect(JSON.stringify(values.get('state'))).not.toContain('large source image')
 cloud=new FakeRenderCloud({storage},env)
 await cloud.alarm()
 expect(await cloud.claim(tile,seed,'c','source')).toBeNull()
 ready=true;await cloud.alarm()
 expect(alarm).toBeNull()
 expect(await cloud.claim(tile,seed,'c','source')).toEqual({url:'/new.png',scene:'maze-garden'})
 expect(await cloud.claim(tile,seed,'a','source')).toEqual(seed)
 expect(alarm).not.toBeNull()
 expect(dispatches[0][4]).toBe(dispatches[1][4])
})
