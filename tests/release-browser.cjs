'use strict';
// Finite public release demonstration. Only owned synthetic data; no model, credential or production profile access.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{start,inputs,digest}=require('./demo-fixture.cjs');
const root=path.resolve(__dirname,'..'),images=path.join(root,'docs/images');
async function run(){
 const report={pass:false,startedAt:new Date().toISOString(),inputs:inputs(),inputsStable:false,resourcesClosed:false,cases:[],screenshots:[],externalNetwork:[],pageErrors:[],realPaidCalls:0};let fixture,browser,page;
 const deadline=setTimeout(()=>{report.deadlineExceeded=true;void browser?.close();},150000);
 const shot=async(name,target=page)=>{const file=path.join(images,name);await target.screenshot({path:file,animations:'disabled'});report.screenshots.push('docs/images/'+name);};
 const check=async(name,fn)=>{const at=Date.now();try{const result=await fn();report.cases.push({name,pass:true,ms:Date.now()-at,...result});}catch(e){report.cases.push({name,pass:false,ms:Date.now()-at,error:String(e.message).replace(/https?:\/\/\S+/g,'[demo-origin]').slice(0,600)});}};
 try{
  await fsp.mkdir(images,{recursive:true});fixture=await start();report.scope=fixture.scope;
  const exe=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
  browser=await chromium.launch({headless:true,...(exe?{executablePath:exe}:{})});const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(![fixture.origin].includes(u.origin)&&!['blob:','data:'].includes(u.protocol)){report.externalNetwork.push(u.origin);return route.abort();}return route.continue();});
  await context.routeWebSocket('**/*',socket=>{report.externalNetwork.push('websocket');socket.close();});
  page=await context.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(20000);page.on('pageerror',e=>report.pageErrors.push(String(e.message).slice(0,200)));
  await check('self-authored-three-page-PDF-and-production-reader',async()=>{
   await page.goto(fixture.origin+'/demo');const reader=page.frameLocator('#demo-reader');await reader.locator('#page-total').filter({hasText:'/ 3'}).waitFor();await reader.locator('#pdf-pages .page canvas').first().waitFor();await page.locator('[data-dpr-library-kind="paper"]').filter({hasText:'阅读工作流'}).waitFor();
   assert.equal(await reader.locator('.dpr-ink-status').innerText(),'未启用','no private license is loaded or bypassed');assert.equal(await reader.locator('#pdf-pages .page').count(),3);await shot('workbench.png');return {pdfPages:3,productionTree:true,inkUnlicensed:true};
  });
  await check('production-tree-creates-subcollection-and-note-survives-reload',async()=>{
   const parent=page.locator('[data-dpr-library-kind="topic"]').filter({hasText:'研究资料'}).first();await parent.click({button:'right'});await page.getByRole('menuitem',{name:'新建子库',exact:true}).click();await page.getByRole('textbox').fill('阅读计划');await page.getByRole('button',{name:'确定',exact:true}).click();
   const child=page.locator('[data-dpr-library-kind="topic"]').filter({hasText:'阅读计划'}).first();await child.waitFor();const entity=fixture.runtime.catalog.listCollections().find(c=>c.name==='阅读计划');assert(entity);assert.equal(entity.parentId,fixture.rootCollectionId);
   await child.click({button:'right'});await page.getByRole('menuitem',{name:'库备注',exact:true}).click();const frameEl=await page.locator('#dpr-paper-details-dialog iframe').elementHandle(),frame=await frameEl.contentFrame();
   const note='阅读目标：比较研究假设与证据质量。\n\n本周计划\n1. 精读原文，记录方法与局限。\n2. 保留来源文件，整理对照资料。\n3. 将下一步问题写入库备注。';
   await frame.locator('#editor').fill(note);await frame.locator('#save-local').click();await frame.locator('#status').filter({hasText:'已保存'}).waitFor();await frame.goto(frame.url());await frame.locator('#editor').waitFor();assert.equal(await frame.locator('#editor').inputValue(),note);assert.equal((await fixture.runtime.service.getDetails({collectionId:entity.collectionId})).metadata.note,note);
   await shot('library-management.png');await frame.locator('#close-panel').click();await page.locator('#dpr-paper-details-dialog').waitFor({state:'detached'});return {parentIdPreserved:true,noteSavedAndReloaded:true,contextMenu:true};
  });
  await check('real-service-import-never-overwrites-and-preserves-source',async()=>{
   const source=fixture.generated[2],sourceHash=digest(source),before=fixture.runtime.catalog.listPapers().length;
   const result=await fixture.runtime.service.importPdfs({collectionId:fixture.collectionId,sources:[{path:source,name:'方法比较'}],operationId:'public-demo-import'});assert(result.results.some(r=>r.created));
   const duplicate=await fixture.runtime.service.importPdfs({collectionId:fixture.collectionId,sources:[{path:source,name:'方法比较'}],operationId:'public-demo-import-again'});assert.equal(duplicate.results.some(r=>r.created),false);assert.equal(fixture.runtime.catalog.listPapers().length,before+1);assert.equal(digest(source),sourceHash);assert.equal(fixture.sourcePreserved(),true);
   const saved=fixture.runtime.catalog.listPapers().find(p=>p.name==='方法比较');assert.equal(digest(fixture.runtime.catalog.resolvePaper({paperId:saved.paperId}).pdfPath),sourceHash);await page.evaluate(()=>window.dispatchEvent(new Event('dpr:library-updated')));return {newPaperCount:1,duplicateCreated:0,sourceBytesPreserved:true};
  });
  await check('production-paper-details-render-safe-local-summary-and-default-off',async()=>{
   const details=await context.newPage();try{await details.goto(fixture.origin+'/paper-reader/paper-details.html?paperId='+fixture.paperId);await details.locator('#summary-content').filter({hasText:'公开演示'}).waitFor();assert.equal(await details.locator('#auto-summary').isChecked(),false);assert.equal(await details.locator('#auto-name').isChecked(),false);assert.equal(await details.locator('#collection-editor').isVisible(),false);await shot('paper-details.png',details);
    const current=await fixture.runtime.service.getDetails({paperId:fixture.paperId});const literal='字面安全测试 <img src=x onerror=window.demoInjected=1> & 保留文本';await fixture.runtime.service.updateDetails({paperId:fixture.paperId,revision:current.metadata.revision,summaryText:literal},'manual');await details.reload();await details.locator('#summary-content').filter({hasText:literal}).waitFor();assert.equal(await details.locator('#summary-content img').count(),0);assert.equal(await details.evaluate(()=>window.demoInjected),undefined);return {summarySource:'manual fictional text',literalHtmlSafe:true,automaticFlagsDefaultOff:true};
   }finally{await details.close();}
  });
  await check('production-batch-filter-selection-and-zero-paid-queue',async()=>{
   const batch=await context.newPage();try{await batch.goto(fixture.origin+'/paper-reader/batch');await batch.locator('#papers .paper input').first().waitFor();assert.equal(await batch.locator('#global-automation').isChecked(),false);assert.equal(await batch.locator('#automation-topics input:checked').count(),0);
    await batch.locator('#search').fill('方法比较');await batch.locator('#papers .paper').filter({hasText:'方法比较'}).waitFor();await batch.locator('#select-visible').click();assert.match(await batch.locator('#enqueue').textContent(),/1/);await batch.locator('#search').fill('证据');assert.match(await batch.locator('#enqueue').textContent(),/0/);await batch.locator('#search').fill('');await batch.locator('#translation-filter').selectOption('translated');assert.equal(await batch.locator('#papers input[data-paper]').count(),0);await batch.locator('#translation-filter').selectOption('all');await batch.locator('#papers .paper input').first().waitFor();assert.equal(fixture.paid.length,0);assert.equal(fixture.blocked.length,0);await shot('batch-translation.png',batch);return {searchClearsSelection:true,globalDefaultOff:true,collectionFlagsDefaultOff:true,queuePaidRequests:0};
   }finally{await batch.close();}
  });
  report.sourceBytesPreserved=fixture.sourcePreserved();report.realPaidCalls=fixture.paid.length;report.forbiddenRoutes=fixture.blocked.length;report.promptCalls=fixture.promptCalls.length;report.pass=report.cases.every(c=>c.pass)&&report.externalNetwork.length===0&&report.realPaidCalls===0&&report.promptCalls===0&&report.forbiddenRoutes===0;
 }catch(e){report.fatal=String(e.message).replace(/https?:\/\/\S+/g,'[demo-origin]').slice(0,500);}
 finally{
  let browserClosed=!browser;try{if(page&&!page.isClosed())await page.evaluate(()=>window.demoDispose?.()).catch(()=>{});await browser?.close();browserClosed=true;}catch{}
  report.cleanup=fixture?await fixture.close():{setupFailed:true};report.resourcesClosed=browserClosed&&Object.values(report.cleanup).every(Boolean);report.inputsStable=JSON.stringify(report.inputs)===JSON.stringify(inputs());report.pass=report.pass&&report.resourcesClosed&&report.inputsStable;report.finishedAt=new Date().toISOString();clearTimeout(deadline);
 }
 console.log(JSON.stringify(report));if(!report.pass)process.exitCode=1;return report;
}
module.exports={run};if(require.main===module)run().catch(e=>{console.error(JSON.stringify({fatal:'Public demo failed',errorClass:e.name}));process.exitCode=1;});
