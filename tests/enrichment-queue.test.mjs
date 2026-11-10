import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readPaperMetadata, writePaperMetadata, writePaperCandidate, applyPaperCandidate } from '../dist/paper-metadata.js';
const { createEnrichmentService } = await import('../dist/enrichment-queue.js').catch(() => ({}));
import { EnrichmentError, requestPaperEnrichment, parseEnrichmentResponse } from '../dist/paper-enrichment.js';
const hash = v => createHash('sha256').update(v).digest('hex');
const permission = Object.freeze({ trusted: Symbol('UI confirmation') });
const result = { summary:'本地模拟摘要', bibliography:{firstAuthor:'Alice',hasMoreAuthors:false,year:'2024',originalTitle:'Study'}, namingReady:true, proposedName:'Alice-2024-Study', needsReview:false, reviewReasons:[], model:'fake-model' };
const gate = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(),'dpr-enrichment-')); t.after(() => rm(root,{recursive:true,force:true}));
  const paperId=randomUUID(), collectionId=randomUUID(); let seq=0;
  const paper={paperId,collectionId,name:'paper',locationRevision:1,status:'active',origin:'import',ingestSeq:1};
  let text='Alice 2024 Study. This is a sufficiently long local paper text for fake analysis.', sourceSignature=hash('source-A');
  let endpoint={baseUrl:'http://fake.invalid/v1',apiKey:'test-secret-key',model:'fake-model'};
  const calls={requests:0,renames:0,candidates:0,applies:0,authorizations:[]};
  const options={storageDir:root,resolvePaper:async({paperId:id})=>{assert.equal(id,paperId);return structuredClone(paper);},readText:async()=>({text,sourceSignature}),readMetadata:()=>readPaperMetadata(root,paperId),
    writeCandidate:async(ref,patch)=>{calls.candidates++;return writePaperCandidate(root,paperId,patch);},
    applyCandidate:async(ref,patch,authority)=>{assert.equal(authority.authorize(),true);calls.applies++;return applyPaperCandidate(root,paperId,patch);},
    renamePaper:async(ref,patch)=>{assert.equal(patch.authorize(),true);calls.renames++;paper.name=patch.name;paper.locationRevision++;return {entity:structuredClone(paper)};},
    resolveEndpoint:async()=>structuredClone(endpoint),request:async()=>{calls.requests++;return structuredClone(result);},getIngestSeq:async()=>seq,
    authorize:async(proof,context)=>{calls.authorizations.push(context.action);return proof===permission || context.action==='automatic';},...extra};
  const make=()=>createEnrichmentService(options); const service=make(); await service.initialize(); t.after(()=>service.stop());
  return {root,paperId,paper,calls,options,service,make,setSeq:v=>seq=v,setSource:v=>sourceSignature=hash(v),setEndpoint:v=>endpoint=v,
    manual:async summaryText=>{const old=await readPaperMetadata(root,paperId);return writePaperMetadata(root,paperId,{revision:old.revision,summaryText},'manual');},
    event:()=>({paperId,ingestSeq:paper.ingestSeq,origin:paper.origin,sourceSignature}),
    enable:async(flags={autoSummary:true,autoName:false})=>{const old=await service.getAutomation();return service.setAutomation({...flags,expectedRevision:old.revision,confirmCosts:true},permission);}};
}
test('automatic combined response adopts its valid summary while missing or malformed naming data stays review without rename',async t=>{
 for(const bibliography of [undefined,{firstAuthor:'Alice',hasMoreAuthors:false,year:2024,originalTitle:'Study'}]){
  let requests=0;const s=await fixture(t,{request:async args=>{requests++;return parseEnrichmentResponse(JSON.stringify({summary:'已保留的有效摘要',...(bibliography===undefined?{}:{bibliography})}),{text:args.text,features:args.features});}});
  await s.enable({autoSummary:true,autoName:true});const originalName=s.paper.name,job=await s.service.admitNew(s.event());
  assert.equal(requests,1);assert.equal(job.status,'needs-review');assert.match(job.reason,/bibliography-(?:missing|shape)/);assert.equal(s.calls.applies,1);assert.equal(s.calls.renames,0);assert.equal(s.paper.name,originalName);
  const saved=await readPaperMetadata(s.root,s.paperId);assert.equal(saved.summary.text,'已保留的有效摘要');assert.equal(saved.summary.source,'api');assert.deepEqual(saved.bibliography,{});assert.equal(saved.candidate,null);
  await s.service.admitNew(s.event());assert.equal(requests,1);assert.equal(s.calls.renames,0);
 }
});
test('invalid response diagnostics persist only a fixed detail in existing reason and keep the original data',async t=>{
 const s=await fixture(t,{request:async()=>parseEnrichmentResponse(JSON.stringify({summary:'FAKE-PRIVATE',bad:'https://private.invalid'}),{text:'local text',features:['summary']})});
 const p=await s.service.plan({paperId:s.paperId,features:['summary']}),args={planId:p.planId,operationId:'response-detail',confirmCosts:true};
 const before=await readPaperMetadata(s.root,s.paperId),job=await s.service.run(args,permission);assert.equal(job.status,'failed');assert.match(job.reason,/^\[response-invalid\].*content-schema/);
 assert.deepEqual(await readPaperMetadata(s.root,s.paperId),before);const stored=await readFile(join(s.root,'.dpr-enrichment-queue.json'),'utf8');assert.ok(!stored.includes('FAKE-PRIVATE'));assert.ok(!stored.includes('private.invalid'));assert.equal(Object.hasOwn(job,'responseDetail'),false);
 assert.equal((await s.service.run(args,permission)).jobId,job.jobId);
});

test('proven adapter preflight rejection is failed without erasing durable intent or issuing a fetch',async t=>{
 let fetches=0;const s=await fixture(t,{resolveEndpoint:async()=>({baseUrl:'ftp://fake.invalid',apiKey:'FAKE-LOCAL',model:'local'}),request:args=>requestPaperEnrichment({...args,fetchImpl:async()=>{fetches++;throw Error('must not fetch');}})});
 const p=await s.service.plan({paperId:s.paperId,features:['summary']});const job=await s.service.run({planId:p.planId,operationId:'known-local-preflight',confirmCosts:true},permission);
 assert.equal(fetches,0);assert.equal(job.status,'failed');assert.equal(job.sent,true);assert.match(job.reason,/^\[configuration\]/);
});

test('failed dispatch preserves an allowlisted reason in the existing schema and never replays a sent unknown',async t=>{
 let calls=0;const raw=new TypeError('FAKE-PRIVATE https://private.invalid/body');raw.cause={code:'ENOTFOUND',message:'FAKE-PRIVATE'};
 const s=await fixture(t,{request:async()=>{calls++;throw raw;}}),p=await s.service.plan({paperId:s.paperId,features:['summary']});
 const args={planId:p.planId,operationId:'safe-network-category',confirmCosts:true},job=await s.service.run(args,permission);
 assert.equal(job.status,'request-unknown');assert.equal(job.sent,true);assert.match(job.reason,/^\[dns\]/);assert.equal(calls,1);
 assert.equal((await s.service.run(args,permission)).jobId,job.jobId);assert.equal(calls,1);
 const stored=await readFile(join(s.root,'.dpr-enrichment-queue.json'),'utf8');assert.ok(!stored.includes('FAKE-PRIVATE'));assert.ok(!stored.includes('private.invalid'));assert.equal(Object.hasOwn(job,'failureCategory'),false);
});
test('HTTP failures expose only status and category in reason, not a provider response body',async t=>{
 const s=await fixture(t,{request:async()=>{throw new EnrichmentError('http-error',401);}}),p=await s.service.plan({paperId:s.paperId,features:['summary']});
 const job=await s.service.run({planId:p.planId,operationId:'safe-http-category',confirmCosts:true},permission);assert.equal(job.status,'failed');assert.match(job.reason,/^\[http:401\]/);
});
test('authorization lost after durable sent intent is distinguishable without claiming an actual dispatch',async t=>{
 let checks=0,calls=0;const s=await fixture(t,{authorize:async(proof)=>proof===permission&&++checks!==3,request:async()=>{calls++;return result;}}),p=await s.service.plan({paperId:s.paperId,features:['summary']});
 const job=await s.service.run({planId:p.planId,operationId:'authorization-at-dispatch',confirmCosts:true},permission);
 assert.equal(job.sent,true);assert.equal(job.status,'request-unknown');assert.equal(calls,0);assert.match(job.reason,/^\[authorization\]/);
});

test('explicit manual-summary regenerates existing manual text, adopts by CAS and replays without another request',async t=>{
 const contexts=[];const s=await fixture(t,{authorize:async(proof,context)=>{contexts.push(context);return proof===permission || context.action==='automatic';}});
 const before=await s.manual('此前手工摘要');
 const p=await s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision});
 assert.deepEqual(p.features,['summary']);assert.equal(p.intent,'manual-summary');assert.equal(p.metadataRevision,before.revision);assert.equal(s.calls.requests,0);
 const input={planId:p.planId,operationId:'manual-one-click',confirmCosts:true,intent:'manual-summary',expectedRevision:before.revision};
 await assert.rejects(s.service.run(input,{confirmCosts:true,intent:'manual-summary'}),{code:'forbidden'});
 const job=await s.service.run(input,permission);assert.equal(job.status,'done');assert.equal(job.intent,'manual-summary');assert.equal(s.calls.requests,1);assert.equal(s.calls.applies,1);
 const saved=await readPaperMetadata(s.root,s.paperId);assert.equal(saved.summary.text,result.summary);assert.equal(saved.summary.source,'api');assert.equal(saved.candidate,null);
 assert.ok(contexts.some(c=>c.action==='run'&&c.intent==='manual-summary'&&c.expectedRevision===before.revision));
 assert.equal((await s.service.run(input,permission)).jobId,job.jobId);assert.equal(s.calls.requests,1);
 await assert.rejects(s.service.run({...input,expectedRevision:saved.revision},permission),e=>e.status===409);
});
test('manual-summary explicitly replaces a model-origin summary only at its exact approved baseline',async t=>{
 const s=await fixture(t),empty=await readPaperMetadata(s.root,s.paperId);
 const before=await writePaperMetadata(s.root,s.paperId,{revision:empty.revision,summaryText:'既有模型摘要'},'model');
 const p=await s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision});
 const job=await s.service.run({planId:p.planId,operationId:'manual-model-baseline',confirmCosts:true,intent:'manual-summary',expectedRevision:before.revision},permission);
 assert.equal(job.status,'done');assert.equal(s.calls.requests,1);const saved=await readPaperMetadata(s.root,s.paperId);assert.equal(saved.summary.source,'api');assert.equal(saved.summary.text,result.summary);
});
test('manual-summary is strict summary-only and does not alter legacy skip or automatic manual-source protection',async t=>{
 const s=await fixture(t),before=await s.manual('保留原摘要');
 for(const input of [
  {paperId:s.paperId,features:['summary'],intent:'manual-summary'},
  {paperId:s.paperId,features:['summary','name'],intent:'manual-summary',expectedRevision:before.revision},
  {paperId:s.paperId,features:['summary'],intent:'automatic-override',expectedRevision:before.revision},
  {paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:'not-a-revision'},
  {paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision,force:true},
 ])await assert.rejects(s.service.plan(input),{code:'invalid'});
 await assert.rejects(s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:null}),{code:'conflict'});
 const legacy=await s.service.plan({paperId:s.paperId,features:['summary']});assert.deepEqual(legacy.features,[]);
 await s.service.run({planId:legacy.planId,operationId:'legacy-skip',confirmCosts:true},permission);
 assert.equal(s.calls.requests,0);assert.equal((await readPaperMetadata(s.root,s.paperId)).summary.text,'保留原摘要');
});
test('manual-summary late edits while the request is pending remain authoritative with a retained candidate',async t=>{
 const entered=gate(),release=gate();let requests=0;
 const s=await fixture(t,{request:async()=>{requests++;entered.resolve();await release.promise;return structuredClone(result);}}),before=await s.manual('原文');
 const p=await s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision});
 assert.deepEqual(p.features,['summary']);
 const input={planId:p.planId,operationId:'manual-late',confirmCosts:true,intent:'manual-summary',expectedRevision:before.revision};
 const running=s.service.run(input,permission);
 try{await Promise.race([entered.promise,running.then(()=>assert.fail('request did not start'))]);await s.manual('请求期间的新摘要');}finally{release.resolve();}
 const job=await running,saved=await readPaperMetadata(s.root,s.paperId);
 assert.equal(requests,1);assert.equal(job.status,'needs-review');assert.equal(saved.summary.text,'请求期间的新摘要');assert.equal(saved.candidate.summaryText,result.summary);assert.equal(s.calls.applies,0);
});
test('manual-summary also protects a write arriving after candidate publication but before adoption',async t=>{
 let state;const s=await fixture(t,{writeCandidate:async(ref,patch)=>{const candidate=await writePaperCandidate(state.root,state.paperId,patch);await state.manual('候选之后的新编辑');return candidate;}});state=s;
 const before=await s.manual('原摘要'),p=await s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision});
 const job=await s.service.run({planId:p.planId,operationId:'manual-candidate-race',confirmCosts:true,intent:'manual-summary',expectedRevision:before.revision},permission);
 assert.equal(job.status,'needs-review');assert.equal((await readPaperMetadata(s.root,s.paperId)).summary.text,'候选之后的新编辑');assert.equal(s.calls.applies,0);
});
test('manual-summary unknown results only resend through an explicitly authorized retry with a fresh baseline',async t=>{
 let requests=0;const s=await fixture(t,{request:async()=>{if(++requests===1)throw Error('unknown network outcome');return structuredClone(result);}}),before=await s.manual('旧摘要');
 const p=await s.service.plan({paperId:s.paperId,features:['summary'],intent:'manual-summary',expectedRevision:before.revision});
 const input={planId:p.planId,operationId:'manual-unknown',confirmCosts:true,intent:'manual-summary',expectedRevision:before.revision};
 const old=await s.service.run(input,permission);assert.equal(old.status,'request-unknown');assert.equal(requests,1);
 assert.equal((await s.service.run(input,permission)).jobId,old.jobId);assert.equal(requests,1);
 const edited=await s.manual('明确重试前的新摘要'),retry={jobId:old.jobId,operationId:'manual-explicit-retry',confirmCosts:true,intent:'manual-summary',expectedRevision:edited.revision};
 await assert.rejects(s.service.retry(retry,{confirmCosts:true}),{code:'forbidden'});
 const done=await s.service.retry(retry,permission);assert.equal(done.status,'done');assert.equal(done.retryOf,old.jobId);assert.equal(done.intent,'manual-summary');assert.equal(requests,2);
 assert.equal((await readPaperMetadata(s.root,s.paperId)).summary.text,result.summary);
 assert.equal((await s.service.retry(retry,permission)).jobId,done.jobId);assert.equal(requests,2);
 await assert.rejects(s.service.retry({...retry,expectedRevision:null},permission),e=>e.status===409);
});

test('exports frozen service factory',()=>assert.equal(typeof createEnrichmentService,'function'));
test('local plans are free; trusted authorization required; operation replay is idempotent and mismatched plan conflicts',async t=>{
 const s=await fixture(t);assert.equal((await s.service.getAutomation()).autoSummary,false);const p=await s.service.plan({paperId:s.paperId,features:['summary','name']});assert.equal(s.calls.requests,0);assert.equal(p.inputChars>20,true);assert.ok(p.sourceSignature);await assert.rejects(s.service.run({planId:p.planId,operationId:'denied',confirmCosts:true},{confirmCosts:true}),e=>e.status===403);
 const job=await s.service.run({planId:p.planId,operationId:'op-one',confirmCosts:true},permission);assert.equal(s.calls.requests,1);assert.equal(job.status,'needs-review');assert.equal(s.calls.renames,0);const replay=await s.service.run({planId:p.planId,operationId:'op-one',confirmCosts:true},permission);assert.equal(replay.jobId,job.jobId);assert.equal(s.calls.requests,1);const p2=await s.service.plan({paperId:s.paperId,features:['name']});await assert.rejects(s.service.run({planId:p2.planId,operationId:'op-one',confirmCosts:true},permission),e=>e.status===409);
 const disk=(await readdir(s.root)).filter(x=>x.includes('enrichment')&&x.endsWith('.json'));assert.equal(disk.length,1);const stored=await readFile(join(s.root,disk[0]),'utf8');assert.ok(!stored.includes('test-secret-key'));assert.ok(!stored.includes('sufficiently long local paper'));
});
test('manual/model metadata and late manual writes keep candidates protected',async t=>{
 const entered=gate(),release=gate();const s=await fixture(t,{request:async()=>{entered.resolve();await release.promise;return structuredClone(result);}});await s.manual('手写摘要');const p=await s.service.plan({paperId:s.paperId,features:['summary']});assert.deepEqual(p.features,[]);assert.equal(s.calls.requests,0);
 const name=await s.service.plan({paperId:s.paperId,features:['name']});const running=s.service.run({planId:name.planId,operationId:'late',confirmCosts:true},permission);await entered.promise;await s.manual('新手写摘要');release.resolve();const job=await running;assert.equal(job.status,'needs-review');const meta=await readPaperMetadata(s.root,s.paperId);assert.equal(meta.summary.text,'新手写摘要');assert.ok(meta.candidate);assert.equal(s.calls.applies,0);
});
test('automatic epoch and ingest watermark apply only to genuine new imports across future collections',async t=>{
 const s=await fixture(t);s.setSeq(10);s.paper.ingestSeq=9;await s.enable({autoSummary:true,autoName:true});assert.equal((await s.service.admitNew(s.event())).status,'skipped');s.paper.origin='baseline';s.paper.ingestSeq=11;assert.equal((await s.service.admitNew(s.event())).status,'skipped');s.paper.origin='import';s.paper.ingestSeq=12;s.paper.collectionId=randomUUID();const job=await s.service.admitNew(s.event());assert.equal(job.status,'done');assert.equal(s.calls.requests,1);assert.equal(s.calls.applies,1);assert.equal(s.calls.renames,1);await s.service.admitNew(s.event());assert.equal(s.calls.requests,1);
});
test('forged ingest, source, endpoint, metadata and policy drift prevent requests',async t=>{
 const s=await fixture(t);await s.enable();assert.equal((await s.service.admitNew({...s.event(),ingestSeq:999})).status,'skipped');const p=await s.service.plan({paperId:s.paperId,features:['summary']});s.setSource('B');await assert.rejects(s.service.run({planId:p.planId,operationId:'source-drift',confirmCosts:true},permission),e=>e.status===409);assert.equal(s.calls.requests,0);
 const p2=await s.service.plan({paperId:s.paperId,features:['summary']});s.setEndpoint({baseUrl:'http://fake.invalid/v1',apiKey:'changed-key',model:'fake-model'});await assert.rejects(s.service.run({planId:p2.planId,operationId:'endpoint-drift',confirmCosts:true},permission),e=>e.status===409);const p3=await s.service.plan({paperId:s.paperId,features:['summary']});await s.manual('local');await assert.rejects(s.service.run({planId:p3.planId,operationId:'metadata-drift',confirmCosts:true},permission),e=>e.status===409);assert.equal(s.calls.requests,0);
});
test('disable while preflight awaits revokes unsent automatic work',async t=>{
 const s=await fixture(t);await s.enable();const entered=gate(),release=gate();const original=s.options.readText;s.options.readText=async ref=>{entered.resolve();await release.promise;return original(ref);};const second=s.make();await second.initialize();const work=second.admitNew(s.event());await entered.promise;const a=await s.service.getAutomation();await s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:a.revision,confirmCosts:false});release.resolve();const job=await work;assert.ok(['skipped','needs-review'].includes(job.status));assert.equal(s.calls.requests,0);await second.stop();
});
test('sent intent is durable before request; unknown never restarts or replays automatically; retry needs new op and authority',async t=>{
 let s; s=await fixture(t,{request:async()=>{s.calls.requests++;const files=(await readdir(s.root)).filter(x=>x.includes('enrichment')&&x.endsWith('.json'));const disk=JSON.parse(await readFile(join(s.root,files[0]),'utf8'));assert.equal(disk.jobs.at(-1).sent,true);throw Error('provider test-secret-key private text');}});const p=await s.service.plan({paperId:s.paperId,features:['summary']});const job=await s.service.run({planId:p.planId,operationId:'unknown-op',confirmCosts:true},permission);assert.equal(job.status,'request-unknown');assert.ok(!JSON.stringify(job).includes('test-secret-key'));await s.service.stop();const restored=s.make();await restored.initialize();await restored.run({planId:p.planId,operationId:'unknown-op',confirmCosts:true},permission);assert.equal(s.calls.requests,1);await assert.rejects(restored.retry({jobId:job.jobId,operationId:'unknown-op',confirmCosts:true},permission),e=>e.status===409);await assert.rejects(restored.retry({jobId:job.jobId,operationId:'retry-op',confirmCosts:true},{}),e=>e.status===403);await restored.retry({jobId:job.jobId,operationId:'retry-op',confirmCosts:true},permission);assert.equal(s.calls.requests,2);await restored.stop();
});
test('concurrent services claim one operation once',async t=>{
 const s=await fixture(t);const b=s.make();await b.initialize();const p=await s.service.plan({paperId:s.paperId,features:['summary']});const results=await Promise.all([s.service.run({planId:p.planId,operationId:'concurrent',confirmCosts:true},permission),b.run({planId:p.planId,operationId:'concurrent',confirmCosts:true},permission)]);assert.equal(s.calls.requests,1);assert.equal(results[0].jobId,results[1].jobId);await b.stop();
});
test('complete local bibliography can propose name without API and preserves manual rename confirmation',async t=>{
 const s=await fixture(t);await writePaperMetadata(s.root,s.paperId,{revision:null,bibliography:result.bibliography},'manual');const p=await s.service.plan({paperId:s.paperId,features:['name']});const job=await s.service.run({planId:p.planId,operationId:'local-name',confirmCosts:false},permission);assert.equal(s.calls.requests,0);assert.equal(job.proposedName,'Alice-2024-Study');assert.equal(job.status,'needs-review');assert.equal(s.calls.renames,0);
});

import { execFile } from 'node:child_process';
function childRun(s,p,operationId,{crash=false,crashQueued=false}={}) {
 const moduleUrl=new URL('../dist/enrichment-queue.js',import.meta.url).href;
 const metadataUrl=new URL('../dist/paper-metadata.js',import.meta.url).href;
 const script=`import {createEnrichmentService} from ${JSON.stringify(moduleUrl)};import {readPaperMetadata,writePaperCandidate,applyPaperCandidate} from ${JSON.stringify(metadataUrl)};import {appendFile} from 'node:fs/promises';import {join} from 'node:path';const root=${JSON.stringify(s.root)},paper=${JSON.stringify(s.paper)},sourceSignature=${JSON.stringify(s.event().sourceSignature)};let authorizationCalls=0;const service=createEnrichmentService({storageDir:root,resolvePaper:async()=>paper,readText:async()=>({text:'Alice 2024 Study. This is a sufficiently long local paper text for fake analysis.',sourceSignature}),readMetadata:()=>readPaperMetadata(root,paper.paperId),writeCandidate:(ref,patch)=>writePaperCandidate(root,paper.paperId,patch),applyCandidate:(ref,patch)=>applyPaperCandidate(root,paper.paperId,patch),renamePaper:async()=>({}),resolveEndpoint:async()=>({baseUrl:'http://fake.invalid/v1',apiKey:'test-secret-key',model:'fake-model'}),getIngestSeq:async()=>0,authorize:async()=>{if(${crashQueued?'++authorizationCalls===2':'false'})process.exit(0);return true;},request:async()=>{await appendFile(join(root,'fake-request-count.log'),'sent\\n');${crash?'process.exit(0);':'await new Promise(r=>setTimeout(r,40));return '+JSON.stringify(result)+';'}}});await service.initialize();const job=await service.run({planId:${JSON.stringify(p.planId)},operationId:${JSON.stringify(operationId)},confirmCosts:true},{});await service.stop();console.log(JSON.stringify(job));`;
 return new Promise((resolve,reject)=>execFile(process.execPath,['--input-type=module','-e',script],{timeout:15000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout.trim()?JSON.parse(stdout.trim()):null)));
}
test('two actual Node processes reserve a single paid operation',async t=>{const s=await fixture(t);const p=await s.service.plan({paperId:s.paperId,features:['summary']});const jobs=await Promise.all([childRun(s,p,'process-once'),childRun(s,p,'process-once')]);assert.equal(jobs[0].jobId,jobs[1].jobId);assert.equal((await readFile(join(s.root,'fake-request-count.log'),'utf8')).trim().split('\n').length,1);});
test('process exit after sent intent recovers dead lock as unknown without automatic resend',async t=>{const s=await fixture(t);const p=await s.service.plan({paperId:s.paperId,features:['summary']});await childRun(s,p,'crashed',{crash:true});const b=s.make();await b.initialize();const list=await b.jobs();assert.equal(list[0].status,'request-unknown');await b.run({planId:p.planId,operationId:'crashed',confirmCosts:true},permission);assert.equal((await readFile(join(s.root,'fake-request-count.log'),'utf8')).trim().split('\n').length,1);await b.stop();});
test('stop aborts an in-flight fake request and journals unknown for same-process restart',async t=>{const entered=gate();const s=await fixture(t,{request:({signal})=>new Promise((resolve,reject)=>{entered.resolve();signal.addEventListener('abort',()=>reject(Error('aborted fake request')),{once:true});})});const p=await s.service.plan({paperId:s.paperId,features:['summary']});const work=s.service.run({planId:p.planId,operationId:'stop',confirmCosts:true},permission);await entered.promise;await s.service.stop();await work;const b=s.make();await b.initialize();assert.equal((await b.jobs())[0].status,'request-unknown');await b.stop();});
test('disabling inside awaited authorization revokes send boundary before fake request',async t=>{let s,shouldDisable=false;const original=(proof,context)=>proof===permission||context.action==='automatic';s=await fixture(t,{authorize:async(proof,context)=>{if(shouldDisable&&context.action==='automatic'){shouldDisable=false;const a=await s.service.getAutomation();void s.service.setAutomation({autoSummary:false,autoName:false,expectedRevision:a.revision,confirmCosts:false});await new Promise(r=>setTimeout(r,10));}return original(proof,context);}});await s.enable();shouldDisable=true;await s.service.admitNew(s.event());assert.equal(s.calls.requests,0);});
test('late automatic result preserves a concurrent manual edit as candidate',async t=>{const entered=gate(),release=gate();const s=await fixture(t,{request:async()=>{entered.resolve();await release.promise;return structuredClone(result);}});await s.enable();const work=s.service.admitNew(s.event());await entered.promise;await s.manual('request期间手写');release.resolve();const job=await work;assert.equal(job.status,'needs-review');const meta=await readPaperMetadata(s.root,s.paperId);assert.equal(meta.summary.text,'request期间手写');assert.ok(meta.candidate);assert.equal(s.calls.applies,0);assert.equal(s.calls.renames,0);});
test('corrupt journal is preserved and rejects all admission',async t=>{const s=await fixture(t);await s.service.stop();const file=join(s.root,'.dpr-enrichment-queue.json');await writeFile(file,'{broken');const b=s.make();await assert.rejects(b.initialize());assert.equal(await readFile(file,'utf8'),'{broken');});
test('source changed during candidate persistence blocks automatic apply and rename',async t=>{let s;s=await fixture(t,{writeCandidate:async(ref,patch)=>{const saved=await writePaperCandidate(s.root,s.paperId,patch);s.setSource('candidate-write-changed-source');return saved;}});await s.enable({autoSummary:true,autoName:true});const job=await s.service.admitNew(s.event());assert.equal(job.status,'needs-review');assert.equal(s.calls.applies,0);assert.equal(s.calls.renames,0);assert.ok((await readPaperMetadata(s.root,s.paperId)).candidate);});
test('unexpected persisted fields fail closed instead of entering safe job responses',async t=>{const s=await fixture(t);const p=await s.service.plan({paperId:s.paperId,features:['summary']});await s.service.run({planId:p.planId,operationId:'schema',confirmCosts:true},permission);await s.service.stop();const file=join(s.root,'.dpr-enrichment-queue.json');const raw=JSON.parse(await readFile(file,'utf8'));raw.jobs[0].unexpectedSensitiveField='untrusted';await writeFile(file,JSON.stringify(raw));const b=s.make();await assert.rejects(b.initialize());});
test('retry proof stays bound to original jobId and new operation across all derived plan gates',async t=>{let originalJob;const boundProof=Object.freeze({trusted:Symbol('retry A')});const observed=[];const s=await fixture(t,{request:async()=>{throw Error('fake unknown');},authorize:async(proof,context)=>{if(context.action==='retry'){observed.push(context);return proof===boundProof && context.jobId===originalJob?.jobId && context.operationId==='retry-A';}return proof===permission;}});const p=await s.service.plan({paperId:s.paperId,features:['summary']});originalJob=await s.service.run({planId:p.planId,operationId:'unknown-A',confirmCosts:true},permission);const other=await s.service.run({planId:p.planId,operationId:'unknown-B',confirmCosts:true},permission);await assert.rejects(s.service.retry({jobId:other.jobId,operationId:'retry-A',confirmCosts:true},boundProof),e=>e.status===403);observed.length=0;const retried=await s.service.retry({jobId:originalJob.jobId,operationId:'retry-A',confirmCosts:true},boundProof);assert.equal(retried.status,'request-unknown');assert.equal(observed.length,4);assert.ok(observed.every(context=>context.jobId===originalJob.jobId && context.operationId==='retry-A'));});
test('dead unsent queued owner becomes failed and supports explicit newly authorized retry',async t=>{const s=await fixture(t);const p=await s.service.plan({paperId:s.paperId,features:['summary']});await childRun(s,p,'crashed-queued',{crashQueued:true});const b=s.make();await b.initialize();const job=(await b.jobs())[0];assert.equal(job.status,'failed');assert.equal(job.sent,false);assert.equal((await b.run({planId:p.planId,operationId:'crashed-queued',confirmCosts:true},permission)).status,'failed');assert.equal(s.calls.requests,0);await b.retry({jobId:job.jobId,operationId:'recover-queued',confirmCosts:true},permission);assert.equal(s.calls.requests,1);await b.stop();});
test('another service preserves a live unsent queued owner',async t=>{const entered=gate(),release=gate();let checks=0;const s=await fixture(t,{authorize:async(proof)=>{if(++checks===2){entered.resolve();await release.promise;}return proof===permission;}});const p=await s.service.plan({paperId:s.paperId,features:['summary']});const work=s.service.run({planId:p.planId,operationId:'live-queued',confirmCosts:true},permission);await entered.promise;const b=s.make();await b.initialize();assert.equal((await b.jobs())[0].status,'queued');assert.equal(s.calls.requests,0);release.resolve();await work;assert.equal(s.calls.requests,1);await b.stop();});
for(const matches of [true,false])test(`prefilled local bibliography ${matches?'matching':'absent from'} source evidence ${matches?'permits automatic rename':'stays review with original name'} and makes zero requests`,async t=>{
 const s=await fixture(t);const bibliography=matches?result.bibliography:{firstAuthor:'Unrelated Author',hasMoreAuthors:false,year:'2023',originalTitle:'Another Title'};
 await writePaperMetadata(s.root,s.paperId,{revision:null,bibliography},'manual');await s.enable({autoSummary:false,autoName:true});const original=s.paper.name;const job=await s.service.admitNew(s.event());assert.equal(s.calls.requests,0);assert.equal(job.status,matches?'done':'needs-review');assert.equal(s.calls.renames,matches?1:0);assert.equal(s.paper.name,matches?'Alice-2024-Study':original);
});
test('manual local name preview keeps unverified proposal for explicit review without API or rename',async t=>{const s=await fixture(t);await writePaperMetadata(s.root,s.paperId,{revision:null,bibliography:{firstAuthor:'Unrelated Author',hasMoreAuthors:false,year:'2023',originalTitle:'Another Title'}},'manual');const p=await s.service.plan({paperId:s.paperId,features:['name']});const job=await s.service.run({planId:p.planId,operationId:'manual-unverified-preview',confirmCosts:false},permission);assert.equal(job.status,'needs-review');assert.equal(job.proposedName,'Unrelated Author-2023-Another Title');assert.equal(s.calls.requests,0);assert.equal(s.calls.renames,0);});
test('prefilled summary filtered to empty features stays skipped without name parsing or API',async t=>{const s=await fixture(t);await s.manual('摘要已填写');const p=await s.service.plan({paperId:s.paperId,features:['summary']});assert.deepEqual(p.features,[]);const job=await s.service.run({planId:p.planId,operationId:'empty-features',confirmCosts:false},permission);assert.equal(job.status,'skipped');assert.equal(s.calls.requests,0);assert.equal(s.calls.renames,0);assert.equal(s.calls.candidates,0);});
