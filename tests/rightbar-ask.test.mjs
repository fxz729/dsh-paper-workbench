import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const {registerRoutes}=await import('../dist/host.js');
const {createPaperRuntime}=await import('../dist/library-runtime.js');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'dpr-rightbar-ask-'));await mkdir(join(root,'Library'));await writeFile(join(root,'Library','Paper.pdf'),'%PDF-1.4\n'+'local fixture '.repeat(30));
 const runtime=createPaperRuntime(root,{}, {createEnrichmentService:()=>({initialize:async()=>{},stop:async()=>{},admitNew:async()=>{},getAutomation:async()=>({epoch:0,autoSummary:false,autoName:false}),jobs:async()=>[]})});await runtime.ready;
 const paper=runtime.catalog.listPapers()[0],rows=[{sessionId:'ordinary-chat',running:false},{sessionId:'other-chat',running:false},{sessionId:'dpr-v2-'+paper.paperId+'-1',running:false}],prompts=[],creates=[];
 let handler,dispose;
 registerRoutes({webServer:{register:r=>{handler=r.handler;return()=>{};}},connection:{requestRejection:()=>undefined},sessionController:{list:async()=>({items:rows}),create:async s=>{creates.push(s);return s;},prompt:async input=>{prompts.push(input);}},workspaceController:{create:async()=>({workspace:{workspaceId:'fixture'}})},workspaceRegistry:{archivedSessionIds:[],archiveSession:async()=>{}},effect:fn=>{dispose=fn();}},{dataDir:root,translate:{}},{runtime});
 const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await dispose();await runtime.stop();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 const request=async(path,body,headers={})=>{const r=await fetch(origin+'/paper-reader'+path,{method:body?'POST':'GET',headers:{origin,...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,headers:r.headers,value:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()};};
 const capability=async()=>{const r=await request('/?dock=1&paperId='+paper.paperId+'&workspaceSessionId=ordinary-chat');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const token=r.value.match(/<meta name="dpr-ui-csrf" content="([0-9a-f-]{36})">/)?.[1];assert.ok(token,'dock reader must receive its private page capability');return token;};
 return{runtime,paper,rows,prompts,creates,request,capability};
}
test('dock reader has no-store private capability and explicit ask targets existing central chat without companion creation',async t=>{
 const f=await fixture(t),token=await f.capability();
 const r=await f.request('/api/ask',{paperId:f.paper.paperId,workspaceSessionId:'ordinary-chat',question:'Explain the method',selectedText:'Local source quote',page:2},{origin:'','x-dpr-ui-csrf':token});
 assert.equal(r.status,200);assert.equal(r.value.sessionId,'ordinary-chat');assert.equal(r.value.target,'workspace');assert.equal(f.prompts.length,1);assert.equal(f.prompts[0].sessionId,'ordinary-chat');assert.match(f.prompts[0].content[0].text,/Local source quote/);assert.doesNotMatch(f.prompts[0].content[0].text,/同目录下/);assert.match(f.prompts[0].content[0].text,new RegExp(f.paper.paperId));assert.equal(f.creates.length,0);
});
test('workspace asks reject missing/wrong capability and cross-site requests before prompt',async t=>{
 const f=await fixture(t),token=await f.capability(),args={paperId:f.paper.paperId,workspaceSessionId:'ordinary-chat',question:'Explain'};
 for(const headers of [{origin:''},{origin:'','x-dpr-ui-csrf':'wrong'},{origin:'https://foreign.invalid','x-dpr-ui-csrf':token},{origin:'null','sec-fetch-site':'cross-site','x-dpr-ui-csrf':token}])assert.equal((await f.request('/api/ask',args,headers)).status,403);
 assert.equal(f.prompts.length,0);assert.equal(f.creates.length,0);
});
test('unknown or companion target and mixed navigation parameters never redirect a workspace ask',async t=>{
 const f=await fixture(t),token=await f.capability(),headers={'x-dpr-ui-csrf':token},base={paperId:f.paper.paperId,question:'Explain'};
 for(const args of [{workspaceSessionId:'unknown'},{workspaceSessionId:'dpr-v2-'+f.paper.paperId+'-1'},{workspaceSessionId:'ordinary-chat',fresh:true},{workspaceSessionId:'ordinary-chat',n:2},{workspaceSessionId:'ordinary-chat',sessionId:'other-chat'},{workspaceSessionId:12}])assert.ok([400,403,404,409].includes((await f.request('/api/ask',{...base,...args},headers)).status));
 assert.equal(f.prompts.length,0);assert.equal(f.creates.length,0);
});
test('a dock page whose target was archived or removed never falls back to another conversation',async t=>{
 const f=await fixture(t),token=await f.capability(),args={paperId:f.paper.paperId,workspaceSessionId:'ordinary-chat',question:'Explain'},headers={'x-dpr-ui-csrf':token};
 f.rows.find(row=>row.sessionId==='ordinary-chat').archived=true;
 assert.equal((await f.request('/api/ask',args,headers)).status,404);
 f.rows.splice(f.rows.findIndex(row=>row.sessionId==='ordinary-chat'),1);
 assert.equal((await f.request('/api/ask',args,headers)).status,404);
 assert.equal(f.prompts.length,0);assert.equal(f.creates.length,0);
});
test('ordinary reader HTML does not carry the workspace prompt capability',async t=>{
 const f=await fixture(t),r=await f.request('/?paperId='+f.paper.paperId);assert.equal(r.status,200);assert.doesNotMatch(r.value,/<meta name="dpr-ui-csrf" content="[0-9a-f-]{36}">/);
});
