import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createEnrichmentService} from '../dist/enrichment-queue.js';
import {readPaperMetadata,writePaperCandidate,applyPaperCandidate} from '../dist/paper-metadata.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const permission=Object.freeze({trusted:Symbol('temporary test approval')});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const response={summary:'Fake local summary.',bibliography:{firstAuthor:'Alice',hasMoreAuthors:false,year:'2024',originalTitle:'Study'},proposedName:'Alice-2024-Study',namingReady:true};
// Injected observer-style FIFO. Production queue only receives its callback.
function policyFence(){
 let tail=Promise.resolve(),active=0,maxActive=0,calls=0;
 const run=fn=>{calls++;const work=tail.catch(()=>{}).then(async()=>{active++;maxActive=Math.max(maxActive,active);try{return await fn();}finally{active--;}});tail=work.catch(()=>{});return work;};
 return {run,get active(){return active;},get maxActive(){return maxActive;},get calls(){return calls;}};
}
async function fixture(t,extra={}){
 const root=await mkdtemp(join(tmpdir(),'dpr-observed-epoch-')),paperId=randomUUID();
 const paper={paperId,collectionId:randomUUID(),name:'paper',locationRevision:1,status:'active',origin:'import',ingestSeq:1};
 const sourceText='Alice 2024 Study. Fake source body for local observed policy tests.',sourceSignature=hash(sourceText);
 const calls={requests:0,applies:0,renames:0,authority:[]},papers=new Map([[paperId,paper]]);let seq=0;
 const options={storageDir:root,resolvePaper:async({paperId:id})=>{assert(papers.has(id));return structuredClone(papers.get(id));},readText:async()=>({text:sourceText,sourceSignature}),readMetadata:ref=>readPaperMetadata(root,ref.paperId),writeCandidate:(ref,patch)=>writePaperCandidate(root,ref.paperId,patch),applyCandidate:async(ref,patch,authority)=>{assert(authority.authorize());calls.applies++;return applyPaperCandidate(root,ref.paperId,patch);},renamePaper:async(ref,patch)=>{assert(patch.authorize());calls.renames++;const target=papers.get(ref.paperId);target.name=patch.name;target.locationRevision++;return{entity:structuredClone(target)};},resolveEndpoint:async()=>({baseUrl:'http://fake.invalid/v1',apiKey:'fake-test-credential',model:'fake-model'}),getIngestSeq:async()=>seq,authorize:async(proof,context)=>{calls.authority.push(context);return proof===permission||context.action==='automatic';},request:async()=>{calls.requests++;return structuredClone(response);},...extra};
 const service=createEnrichmentService(options);await service.initialize();
 t.after(async()=>{await service.stop();await rm(root,{recursive:true,force:true});});
 return {root,paper,paperId,sourceText,sourceSignature,calls,options,service,setSeq:v=>seq=v,
  addPaper:()=>{const row={...paper,paperId:randomUUID(),name:'new-paper',locationRevision:1,ingestSeq:papers.size+1};papers.set(row.paperId,row);return row;},
  event:(...epoch)=>({paperId,origin:paper.origin,ingestSeq:paper.ingestSeq,sourceSignature,...(epoch.length?{observedPolicyEpoch:epoch[0]}:{})}),
  change:async(flags={autoSummary:true,autoName:false})=>service.setAutomation({...flags,expectedRevision:(await service.getAutomation()).revision,confirmCosts:true},permission),
  journal:async()=>JSON.parse(await readFile(join(root,'.dpr-enrichment-queue.json'),'utf8'))};
}
async function cycle(s){await s.change({autoSummary:false,autoName:false});return s.change();}

test('explicit null and observed default-off epoch never gain later automatic permission',async t=>{
 const s=await fixture(t);const enabled=await s.change();assert(enabled.epoch>0);
 for(const observed of [null,0]){const job=await s.service.admitNew(s.event(observed));assert.equal(job.status,'skipped');}
 assert.equal(s.calls.requests,0);assert.equal((await s.journal()).ingests.length,0);
});
test('own undefined and malformed observed epochs fail invalid without charging',async t=>{
 const s=await fixture(t);await s.change();
 for(const value of [undefined,'1',true,{},1.5,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(s.service.admitNew(s.event(value)),e=>e.code==='invalid');
 assert.equal(s.calls.requests,0);assert.equal((await s.journal()).ingests.length,0);
});
test('old observation cannot inherit a disable-reenable epoch even above the new watermark',async t=>{
 const s=await fixture(t),first=await s.change();const event=Object.freeze(s.event(first.epoch));const next=await cycle(s);assert(next.epoch>first.epoch);
 assert.equal((await s.service.admitNew(event)).status,'skipped');assert.equal(s.calls.requests,0);assert.equal((await s.journal()).ingests.length,0);
});
test('current observation is admitted once without changing UUID or source or journal format',async t=>{
 const s=await fixture(t),policy=await s.change({autoSummary:true,autoName:true}),event=Object.freeze(s.event(policy.epoch));
 const job=await s.service.admitNew(event);assert.equal(job.status,'done');assert.equal(job.paperId,s.paperId);assert.equal(s.calls.requests,1);
 assert.equal((await s.service.admitNew(event)).status,'skipped');assert.equal(s.calls.requests,1);
 assert.equal(s.paper.paperId,event.paperId);assert.equal(hash(s.sourceText),event.sourceSignature);assert.equal(s.sourceSignature,event.sourceSignature);
 const journal=await s.journal();assert.equal(JSON.stringify(journal).includes('observedPolicyEpoch'),false);const stored=journal.ingests[0];assert.equal(stored.epoch,policy.epoch);assert.equal(stored.sourceSignature,event.sourceSignature);
});
test('absent observation field preserves the existing direct queue API',async t=>{
 const s=await fixture(t);await s.change();const event=s.event();assert.equal(Object.hasOwn(event,'observedPolicyEpoch'),false);
 assert.equal((await s.service.admitNew(event)).status,'done');assert.equal(s.calls.requests,1);
});
test('policy change during pre-claim readText skips the original observed event',async t=>{
 const entered=gate(),release=gate();let s;
 s=await fixture(t,{readText:async()=>{entered.resolve();await release.promise;return{text:s.sourceText,sourceSignature:s.sourceSignature};}});
 const policy=await s.change(),work=s.service.admitNew(s.event(policy.epoch));
 try{await entered.promise;await cycle(s);}finally{release.resolve();}
 assert.equal((await work).status,'skipped');assert.equal(s.calls.requests,0);assert.equal((await s.journal()).ingests.length,0);
});
test('policy change after persistent claim while planning prevents dispatch',async t=>{
 const entered=gate(),release=gate();let s,reads=0;
 s=await fixture(t,{readMetadata:async()=>{if(++reads===1){entered.resolve();await release.promise;}return readPaperMetadata(s.root,s.paperId);}});
 const policy=await s.change(),work=s.service.admitNew(s.event(policy.epoch));
 try{await entered.promise;assert.equal((await s.journal()).ingests[0].epoch,policy.epoch);await cycle(s);}finally{release.resolve();}
 assert.equal((await work).status,'skipped');assert.equal(s.calls.requests,0);
});
test('policy change after plan while begin authorization awaits prevents dispatch',async t=>{
 const entered=gate(),release=gate();let waiting=true,s;
 s=await fixture(t,{authorize:async(proof,context)=>{if(context.action==='automatic'&&waiting){waiting=false;entered.resolve();await release.promise;}return proof===permission||context.action==='automatic';}});
 const policy=await s.change(),work=s.service.admitNew(s.event(policy.epoch));
 try{await entered.promise;const disk=await s.journal();assert.equal(disk.ingests[0].epoch,policy.epoch);assert.equal(disk.plans[0].policyEpoch,policy.epoch);await cycle(s);}finally{release.resolve();}
 assert.equal((await work).status,'skipped');assert.equal(s.calls.requests,0);
});
test('constructor rejects explicitly invalid policy fence callbacks',async t=>{
 const s=await fixture(t);for(const withPolicyFence of [null,false,0,{},'not-function'])assert.throws(()=>createEnrichmentService({...s.options,withPolicyFence}),e=>e.code==='invalid');
});
test('policy reads and watermark stay inside FIFO fence; concurrent enable failure releases it',async t=>{
 const fence=policyFence(),entered=gate(),release=gate();let seqReads=0;
 const s=await fixture(t,{withPolicyFence:fence.run,getIngestSeq:async()=>{if(++seqReads===1){entered.resolve();await release.promise;return 10;}return 20;}});
 const first=s.service.setAutomation({autoSummary:true,autoName:false,expectedRevision:null,confirmCosts:true},permission);
 // This synchronous probe gives the old implementation a deterministic assertion RED, rather than a pending gate.
 let second;
 try{assert.equal(fence.calls,1,'setAutomation must enter the injected policy fence');await entered.promise;second=s.service.setAutomation({autoSummary:false,autoName:true,expectedRevision:null,confirmCosts:true},permission);const rejected=assert.rejects(second,e=>e.code==='conflict');await new Promise(r=>setImmediate(r));assert.equal(seqReads,1,'second watermark waits for first policy publication');release.resolve();const a=await first;assert.equal(a.watermark,10);await rejected;
  const next=await s.service.setAutomation({autoSummary:true,autoName:true,expectedRevision:a.revision,confirmCosts:true},permission);assert.equal(next.watermark,20);assert.equal(next.epoch,a.epoch+1);assert.equal(fence.maxActive,1);assert.equal(fence.active,0);assert.equal(s.calls.requests,0);assert.equal((await readdir(s.root)).some(x=>x.endsWith('.lock')),false);
 }finally{release.resolve();await Promise.allSettled([first,second].filter(Boolean));}
});
test('off immediately revokes result adoption while its policy fence is occupied',async t=>{
 const fence=policyFence(),entered=gate(),responseReady=gate();let s;
 s=await fixture(t,{withPolicyFence:fence.run,request:async()=>{s.calls.requests++;entered.resolve();await responseReady.promise;return structuredClone(response);}});
 const policy=await s.change();assert.equal(fence.calls,1,'policy callback is required');
 const work=s.service.admitNew(s.event(policy.epoch));await entered.promise;
 const held=gate(),release=gate(),hold=fence.run(async()=>{held.resolve();await release.promise;});await held.promise;
 const off=s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:policy.revision,confirmCosts:false});
 try{responseReady.resolve();const job=await work;assert.equal(job.status,'needs-review');assert.equal(s.calls.applies,0);assert.equal(s.calls.renames,0);assert.equal((await s.service.getAutomation()).autoSummary,true,'persisted off waits for fence');const m=await readPaperMetadata(s.root,s.paperId);assert.equal(m.summary.text,'');assert.ok(m.candidate);
 }finally{responseReady.resolve();release.resolve();await Promise.allSettled([work,off,hold]);}
 assert.equal((await s.service.getAutomation()).autoSummary,false);assert.equal(fence.active,0);
});
test('off immediately revokes an unsent dispatch while waiting on an occupied policy fence',async t=>{
 const fence=policyFence(),entered=gate(),releaseAuthority=gate();let automaticChecks=0;
 const s=await fixture(t,{withPolicyFence:fence.run,authorize:async(proof,context)=>{if(context.action==='automatic'&&++automaticChecks===3){entered.resolve();await releaseAuthority.promise;}return proof===permission||context.action==='automatic';}});
 const policy=await s.change();assert.equal(fence.calls,1,'policy callback is required');
 const held=gate(),releaseFence=gate(),hold=fence.run(async()=>{held.resolve();await releaseFence.promise;});await held.promise;
 const work=s.service.admitNew(s.event(policy.epoch));await entered.promise;
 const off=s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:policy.revision,confirmCosts:false});
 try{releaseAuthority.resolve();const job=await work;assert.ok(['skipped','request-unknown'].includes(job.status));assert.equal(s.calls.requests,0);assert.equal((await s.service.getAutomation()).autoSummary,true);
 }finally{releaseAuthority.resolve();releaseFence.resolve();await Promise.allSettled([work,off,hold]);}
 assert.equal((await s.service.getAutomation()).autoSummary,false);assert.equal(fence.active,0);
});
test('automatic admission starting after off invocation is paused throughout its fence wait',async t=>{
 const fence=policyFence(),s=await fixture(t,{withPolicyFence:fence.run}),policy=await s.change();
 const entered=gate(),release=gate(),hold=fence.run(async()=>{entered.resolve();await release.promise;});await entered.promise;
 const off=s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:policy.revision,confirmCosts:false});
 try{const job=await s.service.admitNew(s.event(policy.epoch));assert.equal(s.calls.requests,0,'late automatic admission must not acquire the already advanced generation');assert.equal(job.status,'skipped');assert.equal((await s.journal()).ingests.length,0);
 }finally{release.resolve();await Promise.allSettled([off,hold]);}
});
test('failed pending enable releases new admission but never revives old automatic work',async t=>{
 const fence=policyFence(),requestEntered=gate(),responseReady=gate(),fenceEntered=gate(),releaseFailure=gate();let failNext=false,s;
 s=await fixture(t,{withPolicyFence:fn=>fence.run(async()=>{if(failNext){failNext=false;fenceEntered.resolve();await releaseFailure.promise;throw Error('fake observer scan failed');}return fn();}),request:async()=>{if(++s.calls.requests===1){requestEntered.resolve();await responseReady.promise;}return structuredClone(response);}});
 const policy=await s.change(),oldWork=s.service.admitNew(s.event(policy.epoch));await requestEntered.promise;
 const added=s.addPaper(),nextEvent={paperId:added.paperId,ingestSeq:added.ingestSeq,origin:'import',sourceSignature:s.sourceSignature,observedPolicyEpoch:policy.epoch};
 failNext=true;const change=s.service.setAutomation({autoSummary:true,autoName:true,expectedRevision:policy.revision,confirmCosts:true},permission),rejected=assert.rejects(change,/fake observer scan failed/);
 try{await fenceEntered.promise;assert.equal((await s.service.admitNew(nextEvent)).status,'skipped','all pending policy changes pause new automatic work');assert.equal(s.calls.requests,1);
  releaseFailure.resolve();await rejected;assert.equal((await s.service.getAutomation()).revision,policy.revision,'failed policy publication preserves the disk grant');
  responseReady.resolve();assert.equal((await oldWork).status,'needs-review','a failed policy attempt must not restore an old generation');assert.equal(s.calls.applies,0);assert.ok((await readPaperMetadata(s.root,s.paperId)).candidate);
  assert.equal((await s.service.admitNew(nextEvent)).status,'done','new admission resumes only under the persisted grant');assert.equal(s.calls.requests,2);assert.equal(s.calls.applies,1);assert.equal(fence.active,0);
 }finally{releaseFailure.resolve();responseReady.resolve();await Promise.allSettled([oldWork,change,rejected]);}
});
test('explicit manual run stays available while automatic policy publication waits',async t=>{
 const fence=policyFence(),s=await fixture(t,{withPolicyFence:fence.run}),policy=await s.change();
 const entered=gate(),release=gate(),hold=fence.run(async()=>{entered.resolve();await release.promise;});await entered.promise;
 const off=s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:policy.revision,confirmCosts:false});
 try{const plan=await s.service.plan({paperId:s.paperId,features:['summary']}),job=await s.service.run({planId:plan.planId,operationId:'manual-during-policy-fence',confirmCosts:true},permission);assert.equal(job.status,'needs-review');assert.equal(s.calls.requests,1);assert.equal(s.calls.applies,0);assert.ok((await readPaperMetadata(s.root,s.paperId)).candidate);
 }finally{release.resolve();await Promise.allSettled([off,hold]);}
});
