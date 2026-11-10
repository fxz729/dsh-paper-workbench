// Pure local discovery/qualification. No timers, network requests, file moves, or paid-job ledger.
import {constants,lstatSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {lstat,readdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalRoot,claimKey,collectionClaimKey,foldName,validateSegment,validateLegacySegment,validateLegacySegments,resolveCollectionPath,resolvePdfPath} from './collection-paths.js';
const MAX_BYTES=8*1024*1024,MAX_ROWS=20000,NOFOLLOW=constants.O_NOFOLLOW||0;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v,allowed)=>plain(v)&&Object.keys(v).every(k=>allowed.includes(k));
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const hash=x=>createHash('sha256').update(x).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
const emptyEligibility=()=>({observedPolicyEpoch:null,observedTranslation:null});
const active=c=>(c.status??'active')==='active';
export class ObserverError extends Error{
 constructor(code){super({invalid:'本地观察记录无效，原文件已保留',conflict:'本地观察正在变化，请稍后重试',io:'本地观察未完成，请检查文献库','too-large':'文件超过本地登记上限，请人工确认',stopped:'本地观察已停止'}[code]||'本地观察未完成');this.name='ObserverError';this.code=code;this.status={invalid:400,conflict:409,io:500,'too-large':413,stopped:409}[code]||500;}
}
const fail=code=>{throw new ObserverError(code);};
const safeError=e=>e instanceof ObserverError?e:new ObserverError('io');
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(plain(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
function detach(value){
 let nodes=0;
 const visit=(v,depth=0)=>{
  if(++nodes>200000||depth>20)fail('invalid');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'&&Number.isSafeInteger(v))return v;
  if(typeof v==='string'&&v.length<=65536&&v.isWellFormed())return v;
  if(Array.isArray(v)){if(v.length>MAX_ROWS)fail('invalid');return v.map(x=>visit(x,depth+1));}
  if(!plain(v)||Object.getOwnPropertySymbols(v).length)fail('invalid');const out={};
  for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k)||k.length>4096)fail('invalid');out[k]=visit(d.value,depth+1);}return out;
 };return visit(value);
}
function eligibility(value){
 if(!keys(value,['observedPolicyEpoch','observedTranslation']))fail('invalid');
 const epoch=value.observedPolicyEpoch,translation=value.observedTranslation;
 if(epoch!==null&&(!Number.isSafeInteger(epoch)||epoch<=0))fail('invalid');
 if(translation!==null&&(!keys(translation,['collectionId','epoch'])||!UUID.test(translation.collectionId)||!Number.isSafeInteger(translation.epoch)||translation.epoch<=0))fail('invalid');
 return detach(value);
}
function statInfo(st,type){const size=Number(st.size);if(!Number.isSafeInteger(size)||size<0)fail('invalid');return {dev:String(st.dev),ino:String(st.ino),size,mtimeNs:String(st.mtimeNs),ctimeNs:String(st.ctimeNs),type};}
function validStat(v){return keys(v,['dev','ino','size','mtimeNs','ctimeNs','type'])&&['file','directory'].includes(v.type)&&['dev','ino'].every(k=>typeof v[k]==='string'&&/^\d{1,32}$/.test(v[k]))&&['mtimeNs','ctimeNs'].every(k=>typeof v[k]==='string'&&/^-?\d{1,32}$/.test(v[k]))&&Number.isSafeInteger(v.size)&&v.size>=0;}
function validateArgs(args){
 if(!keys(args,['observationId','segments','name','expectedStat','sourceSignature'])||!UUID.test(args.observationId)||!validStat(args.expectedStat))fail('invalid');validateLegacySegments(args.segments);
 if(Object.hasOwn(args,'name')){validateSegment(args.name);if(args.expectedStat.type!=='file'||!HASH.test(args.sourceSignature)||/-(?:en|zh|dual)$/i.test(args.name))fail('invalid');}
 else if(args.expectedStat.type!=='directory'||Object.hasOwn(args,'sourceSignature'))fail('invalid');
 return args;
}
function initial(){return {format:'dpr-library-observer',version:1,revision:0,generation:0,baselineComplete:false,observations:[],captures:[],imports:[]};}
function validateState(s){
 if(!keys(s,['format','version','revision','generation','baselineComplete','observations','captures','imports'])||s.format!=='dpr-library-observer'||s.version!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!Number.isSafeInteger(s.generation)||s.generation<0||typeof s.baselineComplete!=='boolean')fail('invalid');
 for(const k of ['observations','captures','imports'])if(!Array.isArray(s[k])||s[k].length>MAX_ROWS)fail('invalid');
 if(!s.baselineComplete&&(s.observations.length||s.captures.length||s.imports.length))fail('invalid');
 const ids=new Set(),locations=new Set(),ops=new Set(),imports=new Set();
 for(const r of s.observations){
  if(!keys(r,['observationId','key','segments','name','expectedStat','classification','observedPolicyEpoch','observedTranslation','observedGlobalTranslationEpoch','firstGeneration','since','samples','state','reason','registration','paperId','collectionId','sourceSignature','eligibility'])||!UUID.test(r.observationId)||ids.has(r.observationId)||locations.has(r.key)||!validStat(r.expectedStat)||!['baseline','live'].includes(r.classification)||!['pending','registered','needs-review'].includes(r.state)||!Number.isSafeInteger(r.firstGeneration)||!Number.isSafeInteger(r.since)||!Number.isSafeInteger(r.samples)||r.samples<1)fail('invalid');
  validateLegacySegments(r.segments);if(Object.hasOwn(r,'name'))validateLegacySegment(r.name);
  if(r.key!==locationKey(r))fail('invalid');eligibility({observedPolicyEpoch:r.observedPolicyEpoch,observedTranslation:r.observedTranslation});
  const globalEpoch=r.observedGlobalTranslationEpoch??null;if(globalEpoch!==null&&(!Number.isSafeInteger(globalEpoch)||globalEpoch<=0||r.classification!=='live'))fail('invalid');
  if(r.registration){validateArgs(r.registration);if(r.registration.observationId!==r.observationId||locationKey(r.registration)!==r.key)fail('invalid');}
  if(r.paperId!==undefined&&!UUID.test(r.paperId)||r.collectionId!==undefined&&!UUID.test(r.collectionId)||r.sourceSignature!==undefined&&!HASH.test(r.sourceSignature))fail('invalid');
  if(r.eligibility!==undefined&&r.eligibility!==null)eligibility(r.eligibility);ids.add(r.observationId);locations.add(r.key);
 }
 for(const r of s.captures){if(!keys(r,['operationId','requestHash','collectionId','eligibility'])||typeof r.operationId!=='string'||!r.operationId||r.operationId.length>128||ops.has(r.operationId)||!HASH.test(r.requestHash)||!UUID.test(r.collectionId))fail('invalid');eligibility(r.eligibility);ops.add(r.operationId);}
 for(const r of s.imports){const key=JSON.stringify([r.paperId,r.sourceSignature]);if(!keys(r,['paperId','sourceSignature','eligibility'])||!UUID.test(r.paperId)||!HASH.test(r.sourceSignature)||imports.has(key))fail('invalid');eligibility(r.eligibility);imports.add(key);}
 return s;
}
function locationKey(ref){return Object.hasOwn(ref,'name')?'p:'+claimKey(ref.segments,ref.name):'c:'+collectionClaimKey(ref.segments);}
// Retain only monotonic evidence already seen by this initialized instance. Fresh starts
// still build a complete baseline; mutable sampling/status/display fields stay mutable.
function preserveKnownEvidence(before,next){
 if(next.revision<before.revision||next.generation<before.generation)fail('invalid');
 const observations=new Map(next.observations.map(r=>[r.observationId,r]));
 const first=['key','classification','observedPolicyEpoch','observedTranslation','firstGeneration'];
 for(const old of before.observations){const row=observations.get(old.observationId);if(!row||first.some(k=>!equal(old[k],row[k]))||!equal(old.observedGlobalTranslationEpoch??null,row.observedGlobalTranslationEpoch??null)||(old.registration&&!equal(old.registration,row.registration)))fail('invalid');}
 const captures=new Map(next.captures.map(r=>[r.operationId,r]));for(const old of before.captures)if(!equal(old,captures.get(old.operationId)))fail('invalid');
 const imports=new Map(next.imports.map(r=>[JSON.stringify([r.paperId,r.sourceSignature]),r]));for(const old of before.imports)if(!equal(old,imports.get(JSON.stringify([old.paperId,old.sourceSignature]))))fail('invalid');
}
export function createLibraryObserver({dataDir,catalog,registerExisting,getPolicy,getTranslationRules,getGlobalTranslationRule=()=>({enabled:false,epoch:0}),stableMs=10000,now=Date.now}={}){
 if(!catalog||typeof catalog.snapshot!=='function'||![registerExisting,getPolicy,getTranslationRules,getGlobalTranslationRule,now].every(x=>typeof x==='function')||!Number.isSafeInteger(stableMs)||stableMs<0)fail('invalid');
 const root=canonicalRoot(dataDir),file=join(root,'.dpr-library-observer.json'),lockFile=file+'.lock';
 let initialized=false,stopped=false,broken=false,lastError=null,cached=initial(),tail=Promise.resolve(),scanWork=null;
 const caps=new Map(),work=new Set();
 const clock=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)fail('invalid');return value;};
 function ready(){if(stopped)fail('stopped');if(broken||!initialized)fail('invalid');}
 function regularSync(path,optional=false){try{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('invalid');return st;}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}}
 function load(){
  const before=regularSync(file,true);if(!before){if(initialized)fail('invalid');return {state:initial(),token:null};}if(before.size>MAX_BYTES)fail('invalid');let fd;
  try{fd=openSync(file,constants.O_RDONLY|NOFOLLOW);const st=fstatSync(fd);if(!same(st,before)||st.nlink!==1||st.size>MAX_BYTES)fail('conflict');const bytes=Buffer.alloc(st.size+1);let n=0;while(n<bytes.length){const count=readSync(fd,bytes,n,bytes.length-n,n);if(!count)break;n+=count;}const after=fstatSync(fd);if(n!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail('conflict');const raw=bytes.subarray(0,n);let state;try{state=validateState(detach(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))));}catch{fail('invalid');}if(initialized){if(!state.baselineComplete)fail('invalid');preserveKnownEvidence(cached,state);cached=detach(state);}return {state,token:hash(raw)};}finally{if(fd!==undefined)closeSync(fd);}
 }
 async function removeOwned(path,st){if(!path||!st)return;try{const current=await lstat(path);if(!current.isSymbolicLink()&&same(st,current))await unlink(path);}catch{}}
 async function acquire(){
  for(let i=0;i<200;i++){
   try{const handle=await open(lockFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);const st=await handle.stat();try{await handle.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()}));await handle.sync();}catch(e){await handle.close();await removeOwned(lockFile,st);throw e;}return {handle,st};}
   catch(e){if(e.code!=='EEXIST')throw e;const st=regularSync(lockFile,true);if(st&&st.size>0&&st.size<4096){let owner;try{const h=await open(lockFile,constants.O_RDONLY|NOFOLLOW);try{owner=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}catch{}if(owner&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&UUID.test(owner.token)){let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}if(!alive){await removeOwned(lockFile,st);continue;}}}if(i===199)fail('conflict');await new Promise(r=>setTimeout(r,5));}
  }
 }
 async function publish(s,expectedToken){
  s.revision++;validateState(s);if(initialized)preserveKnownEvidence(cached,s);const bytes=JSON.stringify(s);if(Buffer.byteLength(bytes)>MAX_BYTES)fail('invalid');let tmp,st;
  try{tmp=file+'.tmp-'+randomUUID();const h=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);try{st=await h.stat();await h.writeFile(bytes);await h.sync();}finally{await h.close();}if(load().token!==expectedToken)fail('conflict');await rename(tmp,file);tmp=null;cached=detach(s);return hash(bytes);}finally{await removeOwned(tmp,st);}
 }
 function fence(fn){
  const task=tail.catch(()=>{}).then(async()=>{
   let lock;
   try{canonicalRoot(root);lock=await acquire();const loaded=load();cached=detach(loaded.state);let token=loaded.token;const save=async()=>{token=await publish(loaded.state,token);};return await fn(loaded.state,save);}
   catch(e){lastError='本地观察未完成，请检查文献库';if(e.code==='invalid'){broken=true;caps.clear();}throw safeError(e);}
   finally{if(lock){await lock.handle.close().catch(()=>{});await removeOwned(lockFile,lock.st);}}
  });tail=task.catch(()=>{});return task;
 }
 async function qualification(collectionId,classification){
  if(classification==='baseline')return {...emptyEligibility(),observedGlobalTranslationEpoch:null};const p=detach(await getPolicy()),rules=detach(await getTranslationRules()),global=detach(await getGlobalTranslationRule());
  if(!keys(global,['enabled','epoch'])||typeof global.enabled!=='boolean'||!Number.isSafeInteger(global.epoch)||global.epoch<0||(global.enabled&&global.epoch===0))fail('invalid');
  if(!plain(p)||!Number.isSafeInteger(p.epoch)||p.epoch<0||typeof p.autoSummary!=='boolean'||typeof p.autoName!=='boolean'||!Array.isArray(rules))fail('invalid');
  let observedTranslation=null;
  for(const r of rules){if(!keys(r,['collectionId','enabled','epoch'])||!UUID.test(r.collectionId)||typeof r.enabled!=='boolean'||!Number.isSafeInteger(r.epoch)||r.epoch<0)fail('invalid');if(r.collectionId===collectionId&&r.enabled&&r.epoch>0)observedTranslation={collectionId,epoch:r.epoch};}
  if(global.enabled)observedTranslation=UUID.test(collectionId)?{collectionId,epoch:global.epoch}:null;
  return {observedPolicyEpoch:(p.autoSummary||p.autoName)&&p.epoch>0?p.epoch:null,observedTranslation,observedGlobalTranslationEpoch:global.enabled?global.epoch:null};
 }
 function catalogView(){const s=catalog.snapshot();if(!plain(s.collections)||!plain(s.papers)||!plain(s.claims)||!plain(s.collectionClaims))fail('invalid');return s;}
 function currentCollection(s,segments){return Object.values(s.collections).find(c=>active(c)&&collectionClaimKey(c.segments)===collectionClaimKey(segments));}
 function currentPaper(s,segments,name){return Object.values(s.papers).find(p=>p.status==='active'&&claimKey(p.segments,p.name)===claimKey(segments,name));}
 async function inventory(snap){
  const entries=[];let count=0;
  async function walk(segments){
   const dir=segments.length?resolveCollectionPath(root,segments):root;const list=await readdir(dir,{withFileTypes:true}),names=new Set();
   for(const entry of list){if(++count>MAX_ROWS)fail('invalid');if(entry.name.startsWith('.')&&entry.isDirectory())continue;if(!entry.isDirectory()&&!entry.isSymbolicLink()&&!/\.pdf$/i.test(entry.name))continue;const folded=foldName(entry.name);if(names.has(folded))fail('invalid');names.add(folded);
    const path=join(dir,entry.name),st=await lstat(path,{bigint:true});const directory=st.isDirectory()||entry.isDirectory();
    if(!directory&&!st.isSymbolicLink()&&!/\.pdf$/i.test(entry.name))continue;
    let item=directory?{segments:[...segments,entry.name]}:{segments,name:entry.name.replace(/\.pdf$/i,'')};
    // Root PDFs have no collection identity and remain outside the library convention.
    if(!directory&&!segments.length)continue;
    if(Object.hasOwn(item,'name')&&/-(?:en|zh|dual)$/i.test(item.name))continue;
    try{validateLegacySegments(item.segments);if(item.name!==undefined)validateLegacySegment(item.name);}catch{continue;}
    item.expectedStat=statInfo(st,directory?'directory':'file');item.review=st.isSymbolicLink()||(!directory&&st.nlink!==1n)?'链接或特殊文件需要人工确认':null;
    const existing=directory?currentCollection(snap,item.segments):currentPaper(snap,item.segments,item.name);item.existing=existing||null;
    const owners=directory?snap.collectionClaims[collectionClaimKey(item.segments)]:snap.claims[claimKey(item.segments,item.name)];
    if(!existing&&owners?.length)item.review='旧位置已有历史身份，请使用ID核对';
    if(!existing&&!item.review){try{if(directory)validateSegment(item.segments.at(-1));else validateSegment(item.name);}catch{item.review='新文件或目录名称需要人工确认';}}
    entries.push(item);if(directory&&!item.review)await walk(item.segments);
   }
  }await walk([]);return entries;
 }
 async function observe(s,classification){
  const snap=catalogView(),entries=await inventory(snap);s.generation++;
  for(const item of entries){const key=locationKey(item);let row=s.observations.find(r=>r.key===key);
   // A previously observed physical identity at an unclaimed new name is evidence for review,
   // not permission to upgrade a baseline/old observation into a fresh live import.
   if(!row&&!item.existing&&s.observations.some(r=>r.key!==key&&r.expectedStat.type===item.expectedStat.type&&r.expectedStat.dev===item.expectedStat.dev&&r.expectedStat.ino===item.expectedStat.ino))item.review='已有文件身份出现在新位置，请确认改名或移动';
   if(!row){const collection=Object.hasOwn(item,'name')?currentCollection(snap,item.segments):item.existing;const q=await qualification(collection?.collectionId,classification);row={observationId:randomUUID(),key,segments:item.segments,...(Object.hasOwn(item,'name')?{name:item.name}:{}),expectedStat:item.expectedStat,classification,...q,firstGeneration:s.generation,since:clock(),samples:1,state:item.review?'needs-review':'pending'};if(item.review)row.reason=item.review;s.observations.push(row);}
   else if(equal(row.expectedStat,item.expectedStat))row.samples++;else{row.expectedStat=item.expectedStat;row.since=clock();row.samples=1;}
   if(item.review){row.state='needs-review';row.reason=item.review;continue;}
   if(item.existing&&!row.registration){row.state='registered';if(item.existing.paperId)row.paperId=item.existing.paperId;row.collectionId=item.existing.collectionId;row.eligibility=row.paperId?s.imports.find(i=>i.paperId===row.paperId)?.eligibility??null:null;}
  }
  s.baselineComplete=true;return entries;
 }
 async function initialize(){
  if(initialized)return snapshot();if(stopped)fail('stopped');await fence(async(s,save)=>{await observe(s,'baseline');await save();});initialized=true;return snapshot();
 }
 async function withPolicyFence(fn){ready();if(typeof fn!=='function')fail('invalid');return fence(async(s,save)=>{ready();await observe(s,'baseline');await save();return fn();});}
 async function fileSignature(args){
  const path=Object.hasOwn(args,'name')?resolvePdfPath(root,args.segments,args.name):resolveCollectionPath(root,args.segments);const before=await lstat(path,{bigint:true});if(before.isSymbolicLink()||!equal(statInfo(before,args.expectedStat.type),args.expectedStat))return null;
  if(!Object.hasOwn(args,'name'))return {sourceSignature:null};if(before.nlink!==1n)return null;if(before.size>512n*1024n*1024n)fail('too-large');
  const handle=await open(path,constants.O_RDONLY|NOFOLLOW);try{if(!equal(statInfo(await handle.stat({bigint:true}),'file'),args.expectedStat))return null;const digest=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);if(!equal(statInfo(await handle.stat({bigint:true}),'file'),args.expectedStat)||!equal(statInfo(await lstat(path,{bigint:true}),'file'),args.expectedStat))return null;return {sourceSignature:digest.digest('hex')};}finally{await handle.close();}
 }
 function discoveryQualification(row){
  let observedTranslation=row.observedTranslation;const epoch=row.observedGlobalTranslationEpoch??null;
  // Bind a saved global grant only once a real parent CID exists; never consult a newer policy.
  if(epoch!==null&&row.classification==='live'&&Object.hasOwn(row,'name')){const parent=currentCollection(catalogView(),row.segments);observedTranslation=parent?{collectionId:parent.collectionId,epoch}:null;}
  return {classification:row.classification,observedPolicyEpoch:row.observedPolicyEpoch,observedTranslation};
 }
 async function registerOne(observationId){
  let prepared=await fence(async(s,save)=>{ready();const row=s.observations.find(r=>r.observationId===observationId);if(!row||row.state!=='pending')return null;if(row.registration)return {args:detach(row.registration),qualification:discoveryQualification(row)};return {row:detach(row)};});
  if(!prepared)return;
  if(!prepared.args){const row=prepared.row;let sampled;try{sampled=await fileSignature(row);}catch(e){if(['too-large','invalid'].includes(e.code))await fence(async(s,save)=>{const current=s.observations.find(r=>r.observationId===observationId);if(current){current.state='needs-review';current.reason='文件状态需要人工确认';await save();}});return;}if(!sampled)return;
   prepared=await fence(async(s,save)=>{ready();const current=s.observations.find(r=>r.observationId===observationId);if(!current||current.state!=='pending'||!equal(current.expectedStat,row.expectedStat))return null;
    if(!current.registration){const args={observationId:current.observationId,segments:current.segments,...(Object.hasOwn(current,'name')?{name:current.name}:{}),expectedStat:current.expectedStat,...(sampled.sourceSignature?{sourceSignature:sampled.sourceSignature}:{})};validateArgs(args);current.registration=args;if(sampled.sourceSignature)current.sourceSignature=sampled.sourceSignature;await save();}
    return {args:detach(current.registration),qualification:discoveryQualification(current)};
   });
  }
  if(!prepared||stopped)return;const proof=Symbol('persisted discovery');caps.set(proof,{observationId,args:canonical(prepared.args),qualification:detach(prepared.qualification)});
  try{const result=detach(await registerExisting(prepared.args,proof));await fence(async(s,save)=>{const row=s.observations.find(r=>r.observationId===observationId);if(!row)return;
    const entity=result.entity;
    if(typeof result.created!=='boolean'||!plain(entity)||!UUID.test(entity.collectionId)||(Object.hasOwn(row,'name')&&!UUID.test(entity.paperId)))fail('invalid');row.state='registered';delete row.reason;if(entity.paperId)row.paperId=entity.paperId;row.collectionId=entity.collectionId;if(result.sourceSignature)row.sourceSignature=result.sourceSignature;row.eligibility=result.eligibility===null?null:eligibility(result.eligibility);await save();});
  }catch(e){if(!stopped)await fence(async(s,save)=>{const row=s.observations.find(r=>r.observationId===observationId);if(row){row.reason='登记未完成，请核对文献状态';if(['invalid','needs-review','source-changed','pdf-invalid','too-large'].includes(e.code))row.state='needs-review';await save();}});}finally{caps.delete(proof);}
 }
 async function scan(){
  ready();if(scanWork)return scanWork;const task=(async()=>{const ids=await fence(async(s,save)=>{ready();await observe(s,'live');await save();return s.observations.filter(r=>r.state==='pending'&&(r.registration||r.samples>=2&&clock()-r.since>=stableMs)).sort((a,b)=>a.segments.length-b.segments.length||Number(Object.hasOwn(a,'name'))-Number(Object.hasOwn(b,'name'))).map(r=>r.observationId);});for(const id of ids){if(stopped)break;await registerOne(id);}return snapshot();})();scanWork=task;work.add(task);try{return await task;}finally{work.delete(task);scanWork=null;}
 }
 function authorizeDiscovery(proof,args){
  if(!initialized||stopped||broken||!caps.has(proof))return null;
  try{const detached=detach(args);validateArgs(detached);const cap=caps.get(proof),s=load().state,row=s.observations.find(r=>r.observationId===cap.observationId);if(!s.baselineComplete||!row||row.state==='needs-review'||!row.registration||canonical(detached)!==cap.args||!equal(detached,row.registration))return null;const q=discoveryQualification(row);return equal(q,cap.qualification)?detach(q):null;}catch{return null;}
 }
 async function captureIngestPolicy(args){
  ready();const input=detach(args);if(!keys(input,['operationId','requestHash','collectionId'])||typeof input.operationId!=='string'||!input.operationId||input.operationId.length>128||!HASH.test(input.requestHash)||!UUID.test(input.collectionId))fail('invalid');
  return fence(async(s,save)=>{ready();const old=s.captures.find(r=>r.operationId===input.operationId);if(old){if(old.requestHash!==input.requestHash||old.collectionId!==input.collectionId)fail('conflict');return detach(old.eligibility);}const captured=await qualification(input.collectionId,'live'),q={observedPolicyEpoch:captured.observedPolicyEpoch,observedTranslation:captured.observedTranslation};s.captures.push({...input,eligibility:q});await save();return detach(q);});
 }
 async function rememberImport(event){
  ready();const input=detach(event);if(!plain(input)||!UUID.test(input.paperId)||!HASH.test(input.sourceSignature))fail('invalid');const q=eligibility({observedPolicyEpoch:input.observedPolicyEpoch??null,observedTranslation:input.observedTranslation??null});
  return fence(async(s,save)=>{ready();const ref=catalog.resolvePaper({paperId:input.paperId});if(q.observedTranslation&&q.observedTranslation.collectionId!==ref.collectionId)fail('invalid');const old=s.imports.find(i=>i.paperId===input.paperId&&i.sourceSignature===input.sourceSignature);if(old){if(!equal(old.eligibility,q))fail('conflict');return detach(old.eligibility);}s.imports.push({paperId:input.paperId,sourceSignature:input.sourceSignature,eligibility:q});for(const r of s.observations)if(r.paperId===input.paperId&&(!r.sourceSignature||r.sourceSignature===input.sourceSignature)){r.eligibility=q;r.sourceSignature=input.sourceSignature;}await save();return detach(q);});
 }
 function getEligibility(args){
  if(!initialized||stopped||broken)return null;const input=detach(args);if(!keys(input,['paperId','sourceSignature'])||!UUID.test(input.paperId)||!HASH.test(input.sourceSignature))fail('invalid');
  try{const s=load().state;const ref=catalog.resolvePaper({paperId:input.paperId});const stored=s.imports.find(i=>i.paperId===input.paperId&&i.sourceSignature===input.sourceSignature)||s.observations.find(r=>r.state==='registered'&&r.paperId===input.paperId&&r.sourceSignature===input.sourceSignature);if(!stored||!stored.eligibility)return null;const q=eligibility(stored.eligibility);if(q.observedTranslation&&q.observedTranslation.collectionId!==ref.collectionId)return null;return q;}catch{return null;}
 }
 function snapshot(){return {initialized,baselineComplete:cached.baselineComplete,generation:cached.generation,pending:cached.observations.filter(r=>r.state!=='registered').map(r=>({observationId:r.observationId,segments:[...r.segments],...(Object.hasOwn(r,'name')?{name:r.name}:{}),state:r.state,...(r.reason?{reason:r.reason}:{})})),...(lastError?{error:lastError}:{})};}
 async function stop(){stopped=true;caps.clear();await Promise.allSettled([...work]);await tail;}
 return {initialize,scan,snapshot,withPolicyFence,authorizeDiscovery,captureIngestPolicy,rememberImport,getEligibility,stop};
}
