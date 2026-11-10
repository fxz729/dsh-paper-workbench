import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const ctx = { window: { __ModuleLoader__: { load() {} } }, URL };
vm.runInNewContext(source + '\nthis.api = { model: typeof dprLibraryModel === "function" ? dprLibraryModel : null, same: typeof dprSamePaper === "function" ? dprSamePaper : null, reload: typeof dprReaderNeedsNavigation === "function" ? dprReaderNeedsNavigation : null, src:dprReaderSource, sync:typeof dprSyncReaderIdentity === "function" ? dprSyncReaderIdentity : null };', ctx);
const a = { paperId:'paper-a', collectionId:'child', topic:'父库/子库',name:'A' };
test('flat server tree retains stable IDs, child membership and note as data', () => {
 assert.equal(typeof ctx.api.model,'function');
 const model = ctx.api.model({ collections:[{collectionId:'root',parentId:null,name:'父库',segments:['父库'],papers:[]},{collectionId:'child',parentId:'root',name:'子库',segments:['父库','子库'],note:'<img src=x onerror=alert(1)>',papers:[{paperId:'paper-a',name:'A',locationRevision:3}]}] }, {topics:['obsolete'],papers:[]});
 assert.equal(model.collections[1].parentId,'root'); assert.equal(model.collections[1].note,'<img src=x onerror=alert(1)>');
 assert.equal(model.papers[0].paperId,'paper-a'); assert.equal(model.papers[0].collectionId,'child'); assert.equal(model.papers[0].topic,'父库/子库');
 assert.deepEqual(Array.from(model.topics),['父库','父库/子库']);
});
test('catalog tree retains translation health from the matching legacy ID only', () => {
 assert.equal(typeof ctx.api.model,'function');
 const model=ctx.api.model({collections:[{collectionId:'c',name:'库',segments:['库'],papers:[{paperId:'a',name:'新名字'}]}]}, {papers:[{paperId:'a',topic:'旧库',name:'旧名字',translation:{state:'translated',zh:true}},{paperId:'b',name:'新名字',translation:{state:'missing'}}]});
 assert.equal(model.papers[0].translation?.zh,true); assert.equal(model.papers[0].name,'新名字'); assert.equal(model.papers[0].topic,'库');
});
test('v2 session identity keeps the UUID and sequence separately', () => {
 const context={window:{__ModuleLoader__:{load(){}}}};
 vm.runInNewContext(source+'\nthis.parse=typeof dprSessionPaper === "function"?dprSessionPaper:null;',context);
 assert.equal(typeof context.parse,'function');
 const sid='dpr-v2-11111111-1111-4111-8111-111111111111-7';
 assert.equal(context.parse(sid).paperId,'11111111-1111-4111-8111-111111111111'); assert.equal(context.parse(sid).n,7);
 assert.equal(context.parse('dpr-not-a-v2-session'),null);
});
test('legacy library remains usable when tree endpoint is unavailable', () => {
 assert.equal(typeof ctx.api.model,'function');
 const model = ctx.api.model(null,{topics:['旧库'],papers:[{topic:'旧库',name:'旧文献'}],capabilities:{safeImport:true}});
 assert.equal(model.collections[0].name,'旧库'); assert.equal(model.papers[0].name,'旧文献'); assert.equal(model.capabilities.safeImport,true);
});
test('reader src carries ID on real navigation; upgrade and same-ID rename retain document', () => {
 assert.match(ctx.api.src(a),/paperId=paper-a/);
 assert.equal(typeof ctx.api.reload,'function');
 assert.equal(ctx.api.reload({...a,paperId:undefined},a),false);
 assert.equal(ctx.api.reload(a,{...a,topic:'新父/新子',name:'新名字'}),false);
 assert.equal(ctx.api.reload(a,{...a,paperId:'other'}),true);
 assert.equal(ctx.api.reload(a,{...a,page:7}),true);
 assert.equal(ctx.api.reload(a,null),true);
});
test('identity hydration uses history and validated-message seam without assigning frame src', () => {
 assert.equal(typeof ctx.api.sync,'function');
 let replaced, message; const frame = {contentWindow:{location:{href:'http://client.test/paper-reader/?topic=old&name=A&page=4'},history:{replaceState:(state,unused,url)=>replaced=url},postMessage:(data,origin)=>message={data,origin}}};
 ctx.api.sync(frame,a,'http://client.test');
 assert.equal(new URL(replaced).searchParams.get('paperId'),'paper-a'); assert.equal(new URL(replaced).searchParams.get('page'),'4');
 assert.equal(message.data.type,'dpr:reader-identity'); assert.equal(message.data.ref.paperId,'paper-a'); assert.equal(message.origin,'http://client.test'); assert.equal('src' in frame,false);
});

