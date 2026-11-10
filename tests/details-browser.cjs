'use strict';
// Disposable loopback only: no installed plugin, user library or configured model endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require('playwright');
const PAPER='11111111-1111-4111-8111-111111111111',COLLECTION='22222222-2222-4222-8222-222222222222',CAP='33333333-3333-4333-8333-333333333333';
const htmlPath=path.resolve(__dirname,'../reader/paper-details.html');
const attack='<script>window.__executed=true</script><img src=x onerror="window.__executed=true">';
const clone=value=>JSON.parse(JSON.stringify(value));
function defaults(kind='paper') {
 return {kind,entity:kind==='paper'?{paperId:PAPER,collectionId:COLLECTION,name:'Current Paper',segments:['文献库','认知研究'],locationRevision:3}:{collectionId:COLLECTION,name:'认知研究',segments:['认知研究'],revision:7},
  metadata:kind==='paper'?{revision:'m1',summary:{text:'从一个清晰的问题开始。\n这是此前保留的摘要。',source:'manual'},bibliography:{firstAuthor:'Ada Researcher',hasMoreAuthors:true,year:'2025',originalTitle:'Reading and Reasoning'},candidate:null}:{revision:'c1',note:'记录这座子库的范围与线索。'},
  endpoint:{model:'fixture-model',hasApiKey:true},automation:{revision:'a1',autoSummary:false,autoName:false,epoch:0},jobs:[]};
}
async function createFixture() {
 let data=defaults(),conflict=false,failRun=false,noAdmission=false,lateEdit=false,injectCsrf=false,planGate=null;
 const requests=[],errors=[],artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-details-fixture-'));
 const server=http.createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try {
   const url=new URL(req.url,'http://127.0.0.1');let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):undefined;requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body,csrf:req.headers['x-dpr-ui-csrf']});
   if(url.pathname==='/parent'){res.setHeader('content-type','text/html');res.end('<html><body style="margin:0"><iframe id="details" style="border:0;width:100vw;height:100vh" src="/paper-reader/paper-details.html?'+(url.searchParams.has('collection')?'collectionId='+COLLECTION:'paperId='+PAPER)+'"></iframe><script>window.received=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.source===document.querySelector("iframe").contentWindow)received.push(e.data)})</script></body></html>');return;}
   if(url.pathname==='/paper-reader/paper-details.html'){res.setHeader('content-type','text/html');let html=fs.readFileSync(htmlPath,'utf8');if(injectCsrf)html=html.replace('__DPR_UI_CSRF__',CAP);res.end(html);return;}
   if(url.pathname==='/paper-reader/api/library/details'&&req.method==='GET')return json(clone(data));
   if(url.pathname==='/paper-reader/api/library/details'&&req.method==='POST'){
    assert.equal(data.kind,'collection','paper has no local manual-write action');if(conflict)return json({error:'备注版本已变化'},409);
    assert.equal(body.revision,data.metadata.revision);data.metadata={revision:'saved-'+requests.length,note:body.note};return json({metadata:clone(data.metadata)});
   }
   if(url.pathname==='/paper-reader/api/enrichment/plan'){
    assert.deepEqual(body.features,['summary']);assert.equal(body.intent,'manual-summary');assert.equal(body.expectedRevision,data.metadata.revision);if(planGate)await planGate;
    return json({plan:{planId:'plan-1',paperId:PAPER,intent:'manual-summary',metadataRevision:body.expectedRevision}});
   }
   if(['/paper-reader/api/enrichment/run','/paper-reader/api/enrichment/retry'].includes(url.pathname)){
    assert.equal(body.confirmCosts,true);assert.equal(body.intent,'manual-summary');assert.equal(body.expectedRevision,data.metadata.revision);assert.ok(body.operationId);
    const retry=url.pathname.endsWith('/retry');if(retry)assert.ok(data.jobs.some(j=>j.jobId===body.jobId));else assert.equal(body.planId,'plan-1');
    const job={jobId:retry?'job-retry':'job-first',paperId:PAPER,operationId:body.operationId,intent:'manual-summary',features:['summary'],automatic:false,sent:true,status:failRun&&!retry?'request-unknown':lateEdit?'needs-review':'done',updatedAt:'2026-11-10T06:00:00Z',...(retry?{retryOf:body.jobId}:{})};
    if(!noAdmission||retry)data.jobs.push(job);
    if(failRun&&!retry)return json({error:'请求结果待核对'},503);
    if(lateEdit)data.metadata={...data.metadata,revision:'new-manual',summary:{text:'请求期间的新摘要',source:'manual'},candidate:{operationId:body.operationId,summaryText:'本次 API 候选'}};
    else data.metadata={...data.metadata,revision:'generated',summary:{text:'已生成并保存的摘要。',source:'api'},candidate:null};
    return json({job});
   }
   if(url.pathname==='/paper-reader/api/enrichment/jobs')return json({jobs:clone(data.jobs)});
   if(url.pathname==='/paper-reader/api/enrichment/automation'){
    if(req.method==='POST'){assert.equal(body.revision,data.automation.revision);data.automation={...data.automation,revision:'auto-'+requests.length,autoSummary:body.autoSummary,autoName:body.autoName};}
    return json({automation:clone(data.automation)});
   }
   if(url.pathname==='/paper-reader/api/library/changes/plan')return json({plan:{planId:'rename-1',entityId:data.kind==='paper'?PAPER:COLLECTION,newName:body.name,affectedFiles:[data.entity.name+'.pdf',data.entity.name+'.orig.ink.json'],conflicts:[],sessionEffects:['稳定会话关联保留']}});
   if(url.pathname==='/paper-reader/api/library/changes/apply'){data.entity.name='Renamed Paper';if(data.kind==='paper')data.entity.locationRevision++;else data.entity.revision++;return json({entity:clone(data.entity)});}
   json({error:'Unknown fixture route'},404);
  }catch(error){errors.push('fixture: '+error.message);if(!res.headersSent)json({error:'fixture assertion failed'},500);else res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
 let browser,context,page;
 try{browser=await chromium.launch({headless:true,executablePath});context=await browser.newContext({viewport:{width:1000,height:900},acceptDownloads:true});
  await context.route('**/*',route=>{const url=route.request().url();return url.startsWith(origin+'/')||url.startsWith('blob:')?route.continue():route.abort();});
  page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 }catch(e){await browser?.close();await new Promise(r=>server.close(r));throw e;}
 return {origin,page,requests,errors,artifacts,data:()=>data,conflict:v=>{conflict=v;},failRun:(v,missing=false)=>{failRun=v;noAdmission=missing;},lateEdit:v=>{lateEdit=v;},
  pausePlan(){let release;planGate=new Promise(r=>release=r);return()=>{planGate=null;release();};},
  async open(kind='paper',changes={},options={}){await page.goto('about:blank');await page.waitForLoadState('networkidle');data={...defaults(kind),...changes};conflict=failRun=noAdmission=lateEdit=false;injectCsrf=!!options.csrf;planGate=null;requests.length=0;errors.length=0;
   await page.goto(origin+'/parent'+(kind==='collection'?'?collection=1':''));await page.waitForLoadState('networkidle');const ui=page.frameLocator('#details');await ui.locator(kind==='paper'?'#generate-summary':'#save-local').waitFor({state:'visible'});return ui;},
  async close(){await browser.close();await new Promise(r=>server.close(r));},
 };
}
async function run(onCase=async(name,fn)=>{await fn();console.log('PASS '+name);}) {
 const f=await createFixture();let timeout;
 try{
  await Promise.race([(async()=>{
   await onCase('compact initial paper view is read-only, defaults off and hides former workflow and details behind More',async()=>{
    const ui=await f.open();assert.equal(await ui.locator('#summary-content').textContent(),f.data().metadata.summary.text);assert.equal(await ui.locator('#editor').isVisible(),false);assert.equal(await ui.locator('#save-local').isVisible(),false);
    assert.equal(await ui.locator('#auto-summary').isChecked(),false);assert.equal(await ui.locator('#auto-name').isChecked(),false);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
    for(const id of ['generation-confirm','candidate-section','automation-confirm','endpoint','provenance','identity'])assert.equal(await ui.locator('#'+id).count(),0);
    assert.equal(await ui.locator('#more-panel').evaluate(el=>el.open),false);assert.equal(await ui.locator('#new-name').isVisible(),false);
    await f.page.screenshot({path:path.join(f.artifacts,'compact-paper-1000.png'),fullPage:true});
   });
   await onCase('read-only summary renders model-shaped HTML as literal text without executing it',async()=>{
    const metadata=defaults().metadata;metadata.summary={text:attack,source:'api'};const ui=await f.open('paper',{metadata});
    assert.equal(await ui.locator('#summary-content').textContent(),attack);assert.equal(await f.page.frames()[1].evaluate(()=>window.__executed),undefined);assert.equal(f.requests.some(r=>r.path==='/x'),false);
   });
   await onCase('one trusted click regenerates the existing summary, saves and displays it with exact frozen intent',async()=>{
    const ui=await f.open();await ui.locator('#generate-summary').click();await ui.locator('#summary-content').filter({hasText:'已生成并保存'}).waitFor();
    const plan=f.requests.find(r=>r.path.endsWith('/enrichment/plan')),request=f.requests.find(r=>r.path.endsWith('/enrichment/run'));
    assert.deepEqual(plan.body,{paperId:PAPER,features:['summary'],intent:'manual-summary',expectedRevision:'m1'});assert.equal(request.body.expectedRevision,'m1');assert.equal(request.body.confirmCosts,true);assert.equal(request.body.intent,'manual-summary');assert.ok(request.body.operationId);
    assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/run')).length,1);assert.equal(f.requests.some(r=>r.path.endsWith('/apply-candidate')||r.path.endsWith('/library/details')&&r.method==='POST'),false);
    assert.equal(await ui.locator('#generate-summary').textContent(),'重新生成');
   });
   await onCase('busy double-click and synthetic clicks cannot produce an extra request',async()=>{
    const ui=await f.open();await ui.locator('#generate-summary').evaluate(el=>el.click());assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
    const release=f.pausePlan();try{await ui.locator('#generate-summary').dblclick();await f.page.waitForTimeout(50);assert.equal(await ui.locator('#generate-summary').isDisabled(),true);assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/plan')).length,1);}finally{release();}
    await ui.locator('#summary-content').filter({hasText:'已生成并保存'}).waitFor();assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/run')).length,1);
   });
   await onCase('unknown sent operation is queried without resending and a new click explicitly retries the old job',async()=>{
    const ui=await f.open();f.failRun(true);await ui.locator('#generate-summary').click();await ui.locator('#generate-summary').filter({hasText:'重试生成'}).waitFor();await f.page.waitForTimeout(2200);
    assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/run')).length,1);assert.ok(f.requests.some(r=>r.path.endsWith('/enrichment/jobs')));
    const old=f.requests.find(r=>r.path.endsWith('/enrichment/run'));await ui.locator('#generate-summary').click();await ui.locator('#summary-content').filter({hasText:'已生成并保存'}).waitFor();
    const retry=f.requests.find(r=>r.path.endsWith('/enrichment/retry'));assert.equal(retry.body.jobId,'job-first');assert.notEqual(retry.body.operationId,old.body.operationId);assert.equal(retry.body.expectedRevision,'m1');assert.equal(retry.body.confirmCosts,true);
    assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/plan')).length,1);
   });
   await onCase('missing admission receipt keeps the same uncertain operation and only exposes read-only status checking',async()=>{
    const ui=await f.open();f.failRun(true,true);await ui.locator('#generate-summary').click();await ui.locator('#generate-summary').filter({hasText:'查询状态'}).waitFor();await ui.locator('#generate-summary').click();
    assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/run')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/retry')).length,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/enrichment/plan')).length,1);
   });
   await onCase('late metadata changes remain visible while the generated result stays protected',async()=>{
    const ui=await f.open();f.lateEdit(true);await ui.locator('#generate-summary').click();await ui.locator('#summary-content').filter({hasText:'请求期间的新摘要'}).waitFor();
    assert.equal(f.data().metadata.summary.source,'manual');assert.equal(f.data().metadata.candidate.summaryText,'本次 API 候选');assert.equal(await ui.locator('#candidate-section').count(),0);
   });
   await onCase('automation checkboxes persist immediately, preserve the other flag, and require no second dialog',async()=>{
    const ui=await f.open();await ui.locator('#auto-summary').check();await ui.locator('#auto-name').check();await ui.locator('#auto-summary').uncheck();
    await ui.locator('#auto-summary:not(:disabled)').waitFor();const writes=f.requests.filter(r=>r.path.endsWith('/automation')&&r.method==='POST');assert.equal(writes.length,3);
    assert.equal(writes[0].body.confirmCosts,true);assert.equal(writes[1].body.confirmCosts,true);assert.equal(writes[2].body.confirmCosts,false);assert.equal(writes[2].body.autoName,true);
    assert.equal(await ui.locator('#auto-summary').isChecked(),false);assert.equal(await ui.locator('#auto-name').isChecked(),true);
   });
   await onCase('collection note keeps CAS editing, conflict draft preservation and export without any model request',async()=>{
    const ui=await f.open('collection');await ui.locator('#editor').fill('子库备注 <script>literal</script>');await ui.locator('#save-local').click();await ui.locator('#status').filter({hasText:'已保存'}).waitFor();
    assert.deepEqual(f.requests.find(r=>r.path.endsWith('/library/details')&&r.method==='POST').body,{collectionId:COLLECTION,revision:'c1',note:'子库备注 <script>literal</script>'});
    f.conflict(true);await ui.locator('#editor').fill('冲突后仍保留的库备注');await ui.locator('#save-local').click();await ui.locator('#conflict').waitFor({state:'visible'});assert.equal(await ui.locator('#editor').inputValue(),'冲突后仍保留的库备注');
    const download=f.page.waitForEvent('download');await ui.locator('#export-draft').click();assert.ok((await download).suggestedFilename().endsWith('.txt'));assert.equal(f.requests.some(r=>r.path.endsWith('/enrichment/run')),false);
   });
   await onCase('physical rename remains in More with explicit file list and location CAS',async()=>{
    const ui=await f.open();await ui.locator('#more-panel > summary').click();await ui.locator('#new-name').fill('Renamed Paper');await ui.locator('#preview-name').click();await ui.locator('#rename-confirm').waitFor({state:'visible'});
    assert.equal(f.requests.filter(r=>r.path.endsWith('/changes/apply')).length,0);assert.match(await ui.locator('#rename-files').textContent(),/\.pdf/);
    await ui.locator('#confirm-rename').click();await ui.locator('#entity-name').filter({hasText:'Renamed Paper'}).waitFor();assert.deepEqual(f.requests.find(r=>r.path.endsWith('/changes/plan')).body,{paperId:PAPER,name:'Renamed Paper',expectedLocationRevision:3});
   });
   await onCase('collection dirty close preserves the note until an explicit discard and scopes the parent message',async()=>{
    const ui=await f.open('collection');await ui.locator('#editor').fill('未保存的备注');await ui.locator('#close-panel').click();await ui.locator('#close-confirm').waitFor({state:'visible'});assert.equal((await f.page.evaluate(()=>window.received)).length,0);
    await ui.locator('#cancel-close').click();assert.equal(await ui.locator('#editor').inputValue(),'未保存的备注');await ui.locator('#close-panel').click();await ui.locator('#confirm-close').click();
    await f.page.waitForFunction(()=>window.received.some(m=>m.type==='dpr:paper-details-close'&&m.collectionId==='22222222-2222-4222-8222-222222222222'));
   });
   await onCase('320/600/1000px paper views keep heading action and toggles compact with no horizontal overflow',async()=>{
    for(const width of [320,600,1000]){await f.page.setViewportSize({width,height:900});const ui=await f.open();assert.equal(await f.page.frames()[1].evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
     const header=await ui.locator('#summary-heading').boundingBox(),button=await ui.locator('#generate-summary').boundingBox();assert.ok(Math.abs((header.y+header.height/2)-(button.y+button.height/2))<4);
     const auto=await ui.locator('.automation-grid').boundingBox();assert.ok(auto.y+auto.height<500);assert.equal(await ui.locator('#new-name').isVisible(),false);assert.equal(await ui.locator('#more-panel').evaluate(el=>el.open),false);
     await f.page.screenshot({path:path.join(f.artifacts,'compact-paper-'+width+'.png'),fullPage:true});}
   });
   await onCase('only an injected UUID capability appears in POST headers, never GETs, URL or body',async()=>{
    const ui=await f.open('paper',{}, {csrf:true});await ui.locator('#generate-summary').click();await ui.locator('#summary-content').filter({hasText:'已生成并保存'}).waitFor();
    for(const request of f.requests){if(request.method==='POST')assert.equal(request.csrf,CAP);else assert.equal(request.csrf,undefined);assert.equal(JSON.stringify(request.body||{}).includes(CAP),false);assert.equal(JSON.stringify(request.query).includes(CAP),false);}
    const plain=await f.open();await plain.locator('#generate-summary').click();await plain.locator('#summary-content').filter({hasText:'已生成并保存'}).waitFor();assert.ok(f.requests.every(r=>!r.csrf));
   });
   await onCase('incomplete bibliography leaves manual rename available and invalid identity makes zero API fetches',async()=>{
    const metadata=defaults().metadata;metadata.bibliography={};const ui=await f.open('paper',{metadata});await ui.locator('#more-panel > summary').click();assert.equal(await ui.locator('#use-suggestion').isDisabled(),true);
    await ui.locator('#new-name').fill('Manual name');assert.equal(await ui.locator('#preview-name').isDisabled(),false);await ui.locator('#new-name').fill('../escape');assert.equal(await ui.locator('#preview-name').isDisabled(),true);
    await f.page.goto('about:blank');f.requests.length=0;await f.page.goto(f.origin+'/paper-reader/paper-details.html?paperId=../../private');await f.page.waitForLoadState('networkidle');assert.equal(f.requests.some(r=>r.path.startsWith('/paper-reader/api/')),false);
   });
   assert.deepEqual(f.errors,[]);
  })(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Five-minute fixture deadline')),290000);})]);
  console.log(JSON.stringify({screenshots:f.artifacts,requestCount:f.requests.length}));return {screenshots:f.artifacts};
 }finally{clearTimeout(timeout);await f.close();}
}
module.exports={run,createFixture};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
