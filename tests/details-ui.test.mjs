import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const file = new URL('../reader/paper-details.html', import.meta.url);
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
test('shared panel exists, is standalone, and never injects model text as HTML', () => {
  assert.ok(source.includes('id="editor"'), 'details editor must be implemented');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(source, /<script[^>]+src\s*=|<link[^>]+href\s*=/i);
  assert.doesNotMatch(source, /\.apiKey\b|\[.apiKey.\]|\/chat\/completions|\/translate\/config/);
});
test('panel script parses and uses explicit consent, metadata CAS, and scoped parent messages', () => {
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script, 'standalone script must exist'); new vm.Script(script);
  for (const key of ['revision', 'expectedLocationRevision', 'confirmCosts', 'operationId', 'manual-summary', 'expectedRevision']) assert.ok(script.includes(key), key);
  assert.match(script, /postMessage\([^]*location\.origin/);
  assert.match(source, /aria-live="polite"/); assert.match(source, /for="editor"/);
});
const pid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function compactFixture(options={}) {
 const elements=new Map([...source.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{id:m[1],value:'',textContent:'',hidden:false,disabled:false,checked:false,dataset:{},children:[],isConnected:true,
  addEventListener(name,fn){this[name]=fn;},append(...nodes){this.children.push(...nodes);},appendChild(node){this.children.push(node);},replaceChildren(...nodes){this.children=nodes;},focus(){},select(){},click(){return this.onclick?.({isTrusted:false});}}]));
 const element=()=>({textContent:'',children:[],dataset:{},append(...v){this.children.push(...v);},appendChild(v){this.children.push(v);},replaceChildren(...v){this.children=v;},addEventListener(){},setAttribute(){},focus(){}});
 const requests=[],jobs=[],automation={revision:'a1',autoSummary:false,autoName:false};let policy=1;
 const paper=options.collection!==true;
 const details={kind:paper?'paper':'collection',entity:paper?{paperId:pid,name:'示例论文',segments:['专题'],locationRevision:1}:{collectionId:cid,name:'专题',segments:['专题'],revision:1},
  metadata:paper?{revision:'r1',summary:{text:'已有摘要',source:'manual'},bibliography:{},candidate:null}:{revision:'c1',note:'原库备注'},endpoint:{model:'fake',hasApiKey:true},automation,jobs};
 const response=(value,status=200)=>({ok:status<400,status,json:async()=>structuredClone(value)});
 const fetch=async(url,init={})=>{
  const pathname=new URL(url,'http://127.0.0.1').pathname,body=init.body?JSON.parse(init.body):undefined;requests.push({path:pathname,body,headers:init.headers,method:init.method});
  if(pathname.endsWith('/library/details')) {
   if(body){assert.equal(paper,false,'paper mode must not write through the manual details endpoint');details.metadata={revision:'c2',note:body.note};}
   return response(body?{metadata:details.metadata}:details);
  }
  if(pathname.endsWith('/enrichment/automation')) {if(body){Object.assign(automation,{revision:'a'+(++policy),autoSummary:body.autoSummary,autoName:body.autoName});}return response({automation});}
  if(pathname.endsWith('/enrichment/plan')) {await options.planGate;return response({plan:{planId:'plan-1',paperId:pid,intent:'manual-summary',metadataRevision:body.expectedRevision}});}
  if(pathname.endsWith('/enrichment/jobs'))return response({jobs});
  if(pathname.endsWith('/enrichment/run') || pathname.endsWith('/enrichment/retry')){
   const retry=pathname.endsWith('/retry');
   if(!retry&&options.rejectRun){const status=options.rejectRun;options.rejectRun=null;return response({error:'需要当前桌面授权'},status);}
   const job={jobId:retry?'job-retry':'job-first',paperId:pid,operationId:body.operationId,intent:'manual-summary',features:['summary'],automatic:false,status:options.unknown&&!retry?'request-unknown':'done',...(retry?{retryOf:body.jobId}:{})};
   if(!options.noAdmission || retry)jobs.push(job);
   if(options.abortRun&&!retry){const error=new Error('fake timeout');error.name='AbortError';throw error;}
   if(options.unknown&&!retry)throw new TypeError('fake response lost');
   details.metadata={...details.metadata,revision:'r2',summary:{text:'新生成并保存的摘要',source:'api'}};return response({job});
  }
  throw Error('unexpected fake path '+pathname);
 };
 const listeners=new Map(),messages=[],parent={postMessage:(data,origin)=>messages.push({data,origin})};
 const timers=new Map();let timer=0;const document={activeElement:null,getElementById:id=>elements.get(id)||null,createElement:element,
  querySelector:selector=>selector==='meta[name="dpr-ui-csrf"]'?{content:options.csrf||'__DPR_UI_CSRF__'}:null};
 const context=vm.createContext({document,location:{origin:'http://127.0.0.1',search:paper?'?paperId='+pid:'?collectionId='+cid},fetch,URL,URLSearchParams,AbortController,Blob,crypto:{randomUUID},navigator:{clipboard:{writeText:async()=>{}}},
  setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(callback);},console});
 context.window=context;context.parent=options.embedded?parent:context;
 const boot=vm.runInContext(source.match(/<script>([\s\S]*?)<\/script>/)[1],context);await boot;
 return {elements,requests,details,jobs,automation,context,timers,parent,messages,emit:(type,event)=>{for(const fn of listeners.get(type)||[])fn(event);},click:()=>elements.get('generate-summary')?.onclick?.({isTrusted:true})};
}
test('compact paper markup has a read-only summary and one heading action without former workflow panels',()=>{
 assert.match(source,/id="summary-content"/);assert.match(source,/id="generate-summary"/);assert.match(source,/id="collection-editor"/);
 assert.match(source,/<meta name="dpr-ui-csrf" content="__DPR_UI_CSRF__">/);
 for(const id of ['generation-section','generation-confirm','candidate-section','candidate-confirm','automation-confirm','provenance','endpoint','identity'])assert.doesNotMatch(source,new RegExp('id="'+id+'"'));
 assert.match(source,/id="more-panel"/);
 assert.match(source,/<p id="auto-scope-hint"[^>]*>仅处理开启后新增的文献<\/p>/);
});
test('compact one-click generation uses a frozen revision and saves the displayed summary without manual editing',async()=>{
 const f=await compactFixture();assert.ok(f.elements.get('generate-summary'));assert.equal(f.elements.get('summary-content').textContent,'已有摘要');assert.equal(f.elements.get('collection-editor').hidden,true);
 await f.click();const plan=f.requests.find(r=>r.path.endsWith('/plan')),run=f.requests.find(r=>r.path.endsWith('/run'));
 assert.equal(plan.body.intent,'manual-summary');assert.equal(plan.body.expectedRevision,'r1');assert.deepEqual(plan.body.features,['summary']);
 assert.equal(run.body.intent,'manual-summary');assert.equal(run.body.expectedRevision,'r1');assert.equal(run.body.confirmCosts,true);assert.ok(run.body.operationId);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);assert.equal(f.elements.get('summary-content').textContent,'新生成并保存的摘要');
});
test('compact busy admission suppresses a second click and programmatic events do not authorize fees',async()=>{
 let release;const f=await compactFixture({planGate:new Promise(r=>release=r)});assert.ok(f.elements.get('generate-summary'));
 await f.elements.get('generate-summary').onclick({isTrusted:false});assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 const first=f.click();await f.click();release();await first;assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
});
test('compact unknown response queries jobs and explicitly retries the old job without a new plan or hidden send',async()=>{
 const f=await compactFixture({unknown:true});assert.ok(f.elements.get('generate-summary'));await f.click();
 assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);assert.ok(f.requests.some(r=>r.path.endsWith('/jobs')));
 const first=f.requests.find(r=>r.path.endsWith('/run'));assert.match(f.elements.get('generate-summary').textContent,/重试/);await f.click();
 const retry=f.requests.find(r=>r.path.endsWith('/retry'));assert.equal(retry.body.jobId,'job-first');assert.notEqual(retry.body.operationId,first.body.operationId);assert.equal(retry.body.confirmCosts,true);assert.equal(retry.body.expectedRevision,'r1');
 assert.equal(f.requests.filter(r=>r.path.endsWith('/plan')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
});
test('compact unresolved admission only checks status and retains the original operation',async()=>{
 const f=await compactFixture({unknown:true,noAdmission:true});assert.ok(f.elements.get('generate-summary'));await f.click();await f.click();
 assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/retry')).length,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/plan')).length,1);
 assert.ok(f.requests.filter(r=>r.path.endsWith('/jobs')).length>=2);
});
test('compact definite admission rejection preserves its error and permits a new explicit click without a stuck unknown attempt',async()=>{
 for(const status of [400,401,403,404,409,422]){
  const f=await compactFixture({rejectRun:status});await f.click();assert.equal(f.jobs.length,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
  assert.equal(f.elements.get('generate-summary').textContent,'重新生成');if(status===403)assert.match(f.elements.get('status').textContent,/需要当前桌面授权/);
  const first=f.requests.find(r=>r.path.endsWith('/run')).body.operationId;await f.click();
  const sent=f.requests.filter(r=>r.path.endsWith('/run'));assert.equal(sent.length,2);assert.notEqual(sent[1].body.operationId,first);assert.equal(f.elements.get('summary-content').textContent,'新生成并保存的摘要');
 }
});
test('compact timeout with no admission receipt retains its operation and never silently sends another request',async()=>{
 const f=await compactFixture({unknown:true,noAdmission:true,abortRun:true});await f.click();await f.click();
 assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/retry')).length,0);assert.equal(f.elements.get('generate-summary').textContent,'查询状态');
});

test('compact non-JSON HTTP403 preserves definite admission status and permits the next explicit click',async()=>{
 for(const body of ['non-json',null]){
  const f=await compactFixture(),original=f.context.fetch;let rejected=false;
  f.context.fetch=async(url,init)=>{if(!rejected&&new URL(url,'http://127.0.0.1').pathname.endsWith('/enrichment/run')){rejected=true;f.requests.push({path:'/paper-reader/api/enrichment/run',method:init.method,body:JSON.parse(init.body)});return {ok:false,status:403,json:async()=>{if(body===null)return null;throw new SyntaxError('non-JSON denial');}};}return original(url,init);};
  await f.click();assert.equal(f.elements.get('generate-summary').textContent,'重新生成');assert.match(f.elements.get('status').textContent,/403|授权|拒绝/);
  const first=f.requests.find(r=>r.path.endsWith('/run')).body.operationId;await f.click();const sent=f.requests.filter(r=>r.path.endsWith('/run'));assert.equal(sent.length,2);assert.notEqual(sent[1].body.operationId,first);
 }
});
test('compact malformed HTTP200 still retains uncertain admission and never silently resends',async()=>{
 const f=await compactFixture(),original=f.context.fetch;let sent=false;
 f.context.fetch=async(url,init)=>{if(!sent&&new URL(url,'http://127.0.0.1').pathname.endsWith('/enrichment/run')){sent=true;f.requests.push({path:'/paper-reader/api/enrichment/run',method:init.method,body:JSON.parse(init.body)});return {ok:true,status:200,json:async()=>{throw new SyntaxError('unknown successful response');}};}return original(url,init);};
 await f.click();await f.click();assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);assert.equal(f.elements.get('generate-summary').textContent,'查询状态');
});
test('compact completed job with a failed metadata refresh shows its result and only queries until refresh recovers',async()=>{
 const f=await compactFixture(),original=f.context.fetch;let completed=false,refreshUnavailable=true;
 f.context.fetch=async(url,init)=>{const path=new URL(url,'http://127.0.0.1').pathname;if(completed&&refreshUnavailable&&path.endsWith('/library/details')){f.requests.push({path,method:init.method});return {ok:false,status:503,json:async()=>({error:'metadata refresh unavailable'})};}const result=await original(url,init);if(path.endsWith('/enrichment/run'))completed=true;return result;};
 await f.click();assert.match(f.elements.get('status').textContent,/已生成.*刷新|保存.*刷新/);assert.equal(f.elements.get('generate-summary').textContent,'查询状态');assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
 const operation=f.requests.find(r=>r.path.endsWith('/run')).body.operationId;await f.click();assert.equal(vm.runInContext('attempt.operationId',f.context),operation);assert.equal(f.elements.get('generate-summary').textContent,'查询状态');assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
 refreshUnavailable=false;await f.click();assert.equal(f.elements.get('summary-content').textContent,'新生成并保存的摘要');assert.equal(f.elements.get('generate-summary').textContent,'重新生成');assert.equal(f.requests.filter(r=>r.path.endsWith('/run')).length,1);
});

test('compact checkboxes commit immediately and a partial disable preserves the other flag without new cost consent',async()=>{
 const f=await compactFixture();const a=f.elements.get('auto-summary'),b=f.elements.get('auto-name');assert.equal(a.checked,false);assert.equal(b.checked,false);
 a.checked=true;await a.change({isTrusted:true});b.checked=true;await b.change({isTrusted:true});a.checked=false;await a.change({isTrusted:true});
 const writes=f.requests.filter(r=>r.path.endsWith('/automation')&&r.body);assert.equal(writes.length,3);
 assert.equal(writes[0].body.confirmCosts,true);assert.equal(writes[1].body.confirmCosts,true);assert.equal(writes[2].body.confirmCosts,false);assert.equal(writes[2].body.autoName,true);
});
test('compact CSRF capability is only a validated POST header and collection notes retain local CAS editing',async()=>{
 const cap='cccccccc-cccc-4ccc-8ccc-cccccccccccc',f=await compactFixture({collection:true,csrf:cap});
 assert.equal(f.elements.get('collection-editor').hidden,false);f.elements.get('editor').value='新的库备注';await f.elements.get('save-local').onclick();
 const save=f.requests.find(r=>r.path.endsWith('/library/details')&&r.body);assert.equal(save.body.note,'新的库备注');assert.equal(save.body.revision,'c1');assert.equal(save.headers['x-dpr-ui-csrf'],cap);
 assert.ok(f.requests.filter(r=>r.method==='GET').every(r=>!r.headers?.['x-dpr-ui-csrf']));assert.ok(f.requests.every(r=>!JSON.stringify(r.body||{}).includes(cap)));
 const plain=await compactFixture();await plain.click();assert.ok(plain.requests.every(r=>!r.headers?.['x-dpr-ui-csrf']));
});

test('guarded parent close requests validate origin, window and exact entity before touching dirty notes',async()=>{
 const f=await compactFixture({collection:true,embedded:true});f.elements.get('editor').value='未保存备注';f.elements.get('editor').input();f.elements.get('close-confirm').hidden=true;
 const message={type:'dpr:paper-details-request-close',collectionId:cid};
 for(const event of [{origin:'https://other.invalid',source:f.parent,data:message},{origin:'http://127.0.0.1',source:{},data:message},{origin:'http://127.0.0.1',source:f.parent,data:{...message,collectionId:pid}},{origin:'http://127.0.0.1',source:f.parent,data:{...message,paperId:pid}}]){f.emit('message',event);assert.equal(f.elements.get('close-confirm').hidden,true);}
 f.emit('message',{origin:'http://127.0.0.1',source:f.parent,data:message});assert.equal(f.elements.get('close-confirm').hidden,false);assert.equal(f.messages.length,0);assert.equal(f.elements.get('editor').value,'未保存备注');
 f.elements.get('cancel-close').onclick();assert.equal(f.elements.get('close-confirm').hidden,true);f.elements.get('close-panel').onclick();assert.equal(f.elements.get('close-confirm').hidden,false);
 f.elements.get('confirm-close').onclick();assert.equal(f.messages.length,1);assert.equal(f.messages[0].data.type,'dpr:paper-details-close');assert.equal(f.messages[0].data.collectionId,cid);assert.equal(f.messages[0].origin,'http://127.0.0.1');assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});
test('Escape inside details uses the same note guard; a clean paper closes with its own identity',async()=>{
 const dirty=await compactFixture({collection:true,embedded:true});dirty.elements.get('editor').value='dirty';let prevented=false;dirty.emit('keydown',{key:'Escape',preventDefault(){prevented=true;},stopPropagation(){}});assert.equal(prevented,true);assert.equal(dirty.elements.get('close-confirm').hidden,false);assert.equal(dirty.messages.length,0);
 const clean=await compactFixture({embedded:true});clean.emit('message',{origin:'http://127.0.0.1',source:clean.parent,data:{type:'dpr:paper-details-request-close',paperId:pid}});assert.equal(clean.messages.length,1);assert.equal(clean.messages[0].data.paperId,pid);
});
test('loopback fake API browser contract', { timeout: 295000 }, async t => {
  const require = createRequire(import.meta.url); const { run } = require('./details-browser.cjs');
  await run((name, fn) => t.test(name, fn));
});
