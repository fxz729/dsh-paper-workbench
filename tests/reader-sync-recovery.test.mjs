import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createReaderGate } from '../dist/reader-gate.js';
const source=fs.readFileSync(new URL('../reader/reader-sync.js',import.meta.url),'utf8');
function setup(t){
 const scope={};vm.runInNewContext(source,scope);
 let now=0,dropHeartbeat=false,failSave=false,notices=0,saves=0;
 const paperId=randomUUID(),collectionId=randomUUID(),gate=createReaderGate({now:()=>now,ttlMs:60000});
 const sync=scope.DprReaderSync.createReaderSync({paperId,setTimer:()=>0,clearTimer(){},onError:()=>notices++,
  applyCanonical(){},getInk:()=>({suspendSync(){},resumeSync(){},async rejoinSync(){saves++;if(failSave)throw Object.assign(Error('CAS conflict'),{status:409});}}),
  request:async(route,body)=>{
   if(route==='/readers/heartbeat'&&dropHeartbeat){dropHeartbeat=false;throw Object.assign(Error('temporary timeout'),{name:'AbortError'});}
   if(route.startsWith('/readers/'))return gate[route.split('/').at(-1)](JSON.parse(JSON.stringify(body)));
   if(route.startsWith('/paper?'))return {paperId,collectionId,topic:'Library',name:'Paper',locationRevision:1};
   throw Error('unexpected fixture route');
  }});
 t.after(async()=>{await sync.stop();gate.close();});
 return {sync,gate,setClock:n=>now=n,timeout:()=>dropHeartbeat=true,conflict:value=>failSave=value,notices:()=>notices,saves:()=>saves};
}
test('ordinary hidden-tab TTL expiry reconciles and saves without a false failure toast',async t=>{
 const f=setup(t);await f.sync.start();f.setClock(61000);await f.sync.tick();
 assert.equal(f.sync.blocked,false);assert.equal(f.saves(),1);assert.equal(f.gate.snapshot().clients.length,1);
 assert.equal(f.notices(),0,'a successfully recovered expiry is not an unresolved save error');
});
test('a single heartbeat timeout that fully rejoins does not interrupt reading with a failure toast',async t=>{
 const f=setup(t);await f.sync.start();f.timeout();await f.sync.tick();
 assert.equal(f.sync.blocked,false);assert.equal(f.saves(),1);assert.equal(f.notices(),0);
});
test('closing a stale reader does not create an error toast on another active page',async t=>{
 const f=setup(t);await f.sync.start();f.setClock(61000);await f.sync.stop();assert.equal(f.notices(),0);
});
test('real rejoin save conflict remains blocked and is reported once across retries',async t=>{
 const f=setup(t);await f.sync.start();f.conflict(true);f.setClock(61000);
 await f.sync.tick();await f.sync.tick();assert.equal(f.sync.blocked,true);assert.equal(f.notices(),1);
 f.conflict(false);await f.sync.tick();assert.equal(f.sync.blocked,false);assert.equal(f.notices(),1);
});
