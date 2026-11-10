// Persistent admission for enrichment. Configured storage parents and injected adapters are trusted.
// No endpoint credentials, source text, or authorization objects are written to this journal.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requestPaperEnrichment, parseEnrichmentResponse, proposePaperName, MAX_INPUT_CHARS, EnrichmentError, enrichmentFailureReason } from './paper-enrichment.js';
const HASH = /^[a-f0-9]{64}$/;
const MANUAL_SUMMARY = 'manual-summary';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES = new Set(['queued','running','done','needs-review','failed','request-unknown','skipped']);
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const MAX_BYTES = 4 * 1024 * 1024;
const hash = x => createHash('sha256').update(x).digest('hex');
const copy = x => structuredClone(x);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype,null].includes(Object.getPrototypeOf(x));
const text = (x,max=256) => typeof x === 'string' && x.length > 0 && x.length <= max && x.isWellFormed() && !/[\x00-\x1f\x7f]/.test(x);
const featureList = (x,empty=false) => Array.isArray(x) && x.length <= 2 && (empty || x.length > 0) && x.every(v => ['summary','name'].includes(v)) && new Set(x).size === x.length;
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
const keys = (object,allowed) => plain(object) && Object.keys(object).every(k=>allowed.includes(k));
const summaryOnly = features => Array.isArray(features) && features.length===1 && features[0]==='summary';
function manualInput(input,allowed) {
  if(!Object.hasOwn(input,'intent') && !Object.hasOwn(input,'expectedRevision'))return false;
  if(!keys(input,allowed) || input.intent!==MANUAL_SUMMARY || !Object.hasOwn(input,'expectedRevision') || !(input.expectedRevision===null || typeof input.expectedRevision==='string' && HASH.test(input.expectedRevision)))fail('invalid');
  return true;
}
const intentScope = p => p.intent===MANUAL_SUMMARY ? {intent:MANUAL_SUMMARY,expectedRevision:p.metadataRevision} : {};
export class EnrichmentQueueError extends Error {
  constructor(code) {
    super({invalid:'文献信息任务数据无效，原记录已保留',conflict:'计划或版本已变化，请刷新后重新确认',forbidden:'请通过可信界面明确授权费用与范围',io:'文献信息任务存储失败，原记录已保留',stopped:'文献信息服务已停止'}[code] || '文献信息任务未完成');
    this.name='EnrichmentQueueError';this.code=code;this.status={invalid:400,conflict:409,forbidden:403,io:500,stopped:409}[code] || 500;
  }
}
const fail = code => { throw new EnrichmentQueueError(code); };
const safeError = e => e instanceof EnrichmentQueueError ? e : new EnrichmentQueueError('io');
const alive = pid => { try { process.kill(pid,0);return true; } catch(e) { return e.code !== 'ESRCH'; } };
function defaults() { return {format:'dpr-enrichment-queue',version:1,revision:0,automation:{revision:null,autoSummary:false,autoName:false,epoch:0,watermark:0},plans:[],jobs:[],ingests:[]}; }
function validate(s) {
  if (!keys(s,['format','version','revision','automation','plans','jobs','ingests']) || s.format !== 'dpr-enrichment-queue' || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !plain(s.automation)) fail('invalid');
  const a=s.automation;
  if (!keys(a,['revision','autoSummary','autoName','epoch','watermark']) || !(a.revision === null || HASH.test(a.revision)) || typeof a.autoSummary !== 'boolean' || typeof a.autoName !== 'boolean' || !Number.isSafeInteger(a.epoch) || a.epoch < 0 || !Number.isSafeInteger(a.watermark) || a.watermark < 0) fail('invalid');
  if (!Array.isArray(s.plans) || s.plans.length > 4000 || !Array.isArray(s.jobs) || s.jobs.length > 2000 || !Array.isArray(s.ingests) || s.ingests.length > 4000) fail('invalid');
  const plans=new Set(),ops=new Set(),jobs=new Set();
  for (const p of s.plans) {
    if (!keys(p,['planId','paperId','features','requestFeatures','sourceSignature','metadataRevision','endpointSignature','locationSignature','model','inputChars','maxOutputTokens','policyEpoch','localName','costNotice','createdAt','intent']) || !UUID.test(p.planId) || plans.has(p.planId) || !UUID.test(p.paperId) || !HASH.test(p.sourceSignature) || !HASH.test(p.endpointSignature) || !HASH.test(p.locationSignature) || !(p.metadataRevision === null || HASH.test(p.metadataRevision)) || !featureList(p.features,true) || !featureList(p.requestFeatures,true) || !text(p.model,256) || !Number.isSafeInteger(p.policyEpoch) || p.policyEpoch < 0 || !Number.isSafeInteger(p.inputChars) || p.inputChars < 0 || p.inputChars > MAX_INPUT_CHARS) fail('invalid');
    if(p.intent!==undefined && (p.intent!==MANUAL_SUMMARY || !summaryOnly(p.features) || !summaryOnly(p.requestFeatures)))fail('invalid');
    plans.add(p.planId);
  }
  for (const j of s.jobs) {
    if (!keys(j,['jobId','paperId','planId','operationId','fingerprint','features','status','sent','automatic','policyEpoch','createdAt','updatedAt','retryOf','owner','proposedName','reason','intent']) || !UUID.test(j.jobId) || jobs.has(j.jobId) || !text(j.operationId) || ops.has(j.operationId) || !plans.has(j.planId) || !UUID.test(j.paperId) || !STATES.has(j.status) || typeof j.sent !== 'boolean' || typeof j.automatic !== 'boolean' || !HASH.test(j.fingerprint) || !featureList(j.features,true) || (j.owner && (!Number.isSafeInteger(j.owner.pid) || j.owner.pid < 1 || !UUID.test(j.owner.token)))) fail('invalid');
    const p=s.plans.find(p=>p.planId===j.planId);
    if(p.intent===MANUAL_SUMMARY ? j.intent!==MANUAL_SUMMARY || j.automatic || !summaryOnly(j.features) : j.intent!==undefined)fail('invalid');
    jobs.add(j.jobId);ops.add(j.operationId);
  }
  for (const i of s.ingests) if (!keys(i,['paperId','ingestSeq','sourceSignature','epoch']) || !UUID.test(i.paperId) || !Number.isSafeInteger(i.ingestSeq) || i.ingestSeq < 1 || !Number.isSafeInteger(i.epoch) || i.epoch < 1 || !HASH.test(i.sourceSignature)) fail('invalid');
}
function publicPlan(p) {
  const {endpointSignature,locationSignature,requestFeatures,localName,...visible}=p;
  return copy(visible);
}
function publicJob(j) {
  const {owner,fingerprint,...visible}=j;return copy(visible);
}
function endpointInfo(endpoint) {
  if (!plain(endpoint) || !text(endpoint.baseUrl,4000) || !text(endpoint.apiKey,8192) || !text(endpoint.model,500)) fail('invalid');
  const model=endpoint.model.split(endpoint.apiKey).join('[已隐藏]').slice(0,256);
  return {signature:hash(JSON.stringify([endpoint.baseUrl,endpoint.model,endpoint.apiKey,endpoint.revision ?? null])),model};
}
function location(ref) { return hash(JSON.stringify([ref.paperId,ref.collectionId,ref.locationRevision,ref.status])); }
export function createEnrichmentService(options) {
  const {storageDir,resolvePaper,readText,readMetadata,writeCandidate,applyCandidate,renamePaper,resolveEndpoint,getIngestSeq,authorize,withPolicyFence=fn=>fn(),request=requestPaperEnrichment,now=Date.now}=options || {};
  if (typeof storageDir !== 'string' || !isAbsolute(storageDir) || ![resolvePaper,readText,readMetadata,writeCandidate,applyCandidate,renamePaper,resolveEndpoint,getIngestSeq,authorize,withPolicyFence,request,now].every(f=>typeof f==='function')) fail('invalid');
  const root=resolve(storageDir),file=join(root,'.dpr-enrichment-queue.json'),lockPath=file+'.lock';
  let initialized=false,stopped=false,revocation=0,pendingPolicyChanges=0;
  const active=new Set(),controllers=new Set();
  const timestamp=()=>{const value=now();const date=new Date(value);if(!Number.isFinite(date.getTime()))fail('invalid');return date.toISOString();};
  async function regular(path,optional=false) {
    try {const st=await lstat(path);if(st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)fail('invalid');return st;}
    catch(e){if(optional && e.code==='ENOENT')return null;throw e;}
  }
  async function load() {
    const before=await regular(file,true);if(!before)return {state:defaults(),revision:null};
    if(before.size > MAX_BYTES)fail('invalid');
    const handle=await open(file,constants.O_RDONLY|NOFOLLOW);
    try {
      const st=await handle.stat();if(!same(st,before) || st.nlink!==1 || st.size > MAX_BYTES)fail('conflict');
      const bytes=Buffer.alloc(st.size+1);let count=0;
      while(count<bytes.length){const r=await handle.read(bytes,count,bytes.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}
      const after=await handle.stat();if(count!==st.size || after.size!==st.size || after.mtimeMs!==st.mtimeMs)fail('conflict');
      const raw=bytes.subarray(0,count);let state;try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('invalid');}validate(state);return {state,revision:hash(raw)};
    } finally {await handle.close();}
  }
  async function removeOwned(path,st) {if(!path || !st)return;try{const current=await lstat(path);if(!current.isSymbolicLink()&&same(current,st))await unlink(path);}catch{}}
  async function transaction(mutate) {
    let lock,lockSt,tmp,tmpSt;
    try {
      const st=await lstat(root);if(st.isSymbolicLink() || !st.isDirectory())fail('invalid');
      for(let attempt=0;attempt<80;attempt++) {
        try {lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);break;}
        catch(e) {
          if(e.code!=='EEXIST')throw e;
          const old=await regular(lockPath,true);
          if(old && old.size>0 && old.size<4096) {
            let owner;try{const h=await open(lockPath,constants.O_RDONLY|NOFOLLOW);try{owner=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}catch{}
            if(owner && Number.isSafeInteger(owner.pid) && owner.pid>0 && UUID.test(owner.token) && !alive(owner.pid)) {await removeOwned(lockPath,old);continue;}
          }
          if(attempt===79)fail('conflict');
          await new Promise(r=>setTimeout(r,5));
        }
      }
      if(!lock)fail('conflict');lockSt=await lock.stat();await lock.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()}),'utf8');await lock.sync();
      const loaded=await load(),before=JSON.stringify(loaded.state);
      const value=await mutate(loaded.state);
      if(JSON.stringify(loaded.state)!==before) {
        loaded.state.revision++;validate(loaded.state);const content=JSON.stringify(loaded.state);if(Buffer.byteLength(content)>MAX_BYTES)fail('invalid');
        tmp=file+'.tmp-'+randomUUID();const out=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,0o600);
        try{tmpSt=await out.stat();await out.writeFile(content,'utf8');await out.sync();}finally{await out.close();}
        if((await load()).revision!==loaded.revision || !same(await regular(lockPath),lockSt))fail('conflict');
        await rename(tmp,file);tmp=undefined;
      }
      return value;
    } catch(e){throw safeError(e);}
    finally {await removeOwned(tmp,tmpSt);if(lock)await lock.close().catch(()=>{});await removeOwned(lockPath,lockSt);}
  }
  function ready() {if(!initialized)fail('invalid');if(stopped)fail('stopped');}
  async function state() {ready();try{return (await load()).state;}catch(e){throw safeError(e);}}
  async function authority(proof,context) {if(stopped || await authorize(proof,copy(context))!==true)fail('forbidden');}
  async function context(paperId) {
    if(!UUID.test(paperId))fail('invalid');
    const ref=copy(await resolvePaper({paperId}));
    if(ref?.paperId!==paperId || ref.status!=='active' || !Number.isSafeInteger(ref.locationRevision))fail('conflict');
    const metadata=await readMetadata(ref),endpoint=copy(await resolveEndpoint()),input=await readText(ref);
    if(!plain(input) || typeof input.text!=='string' || !input.text.isWellFormed() || input.text.length>5*MAX_INPUT_CHARS || !HASH.test(input.sourceSignature) || !plain(metadata) || !(metadata.revision===null || HASH.test(metadata.revision)) || !plain(metadata.summary) || !['empty','api','manual','model'].includes(metadata.summary.source) || typeof metadata.summary.text!=='string')fail('invalid');
    return {ref,text:input.text,sourceSignature:input.sourceSignature,metadata,endpoint,...endpointInfo(endpoint)};
  }
  function consistent(plan,ctx,automation,includeMetadata=true) {
    return ctx.sourceSignature===plan.sourceSignature && ctx.signature===plan.endpointSignature && location(ctx.ref)===plan.locationSignature && automation.epoch===plan.policyEpoch && (!includeMetadata || ctx.metadata.revision===plan.metadataRevision);
  }
  function autoAllowed(job,automation) {return !job.automatic || (pendingPolicyChanges===0 && job.features.every(f=>f==='summary'?automation.autoSummary:automation.autoName));}
  async function plan(args) {
    ready();const input=copy(args);if(!plain(input) || !UUID.test(input.paperId) || !featureList(input.features))fail('invalid');
    const manual=manualInput(input,['paperId','features','intent','expectedRevision']);
    if(manual && !summaryOnly(input.features))fail('invalid');
    const policy=(await state()).automation,ctx=await context(input.paperId);
    if(manual && input.expectedRevision!==ctx.metadata.revision)fail('conflict');
    const features=manual ? input.features : input.features.filter(f=>f!=='summary' || ctx.metadata.summary.text.trim()==='');
    const proposal=features.includes('name')?proposePaperName(ctx.metadata.bibliography):{name:null};
    const requestFeatures=features.filter(f=>f!=='name' || !proposal.name);
    const p={planId:randomUUID(),paperId:input.paperId,features,requestFeatures,sourceSignature:ctx.sourceSignature,metadataRevision:ctx.metadata.revision,endpointSignature:ctx.signature,locationSignature:location(ctx.ref),model:ctx.model,inputChars:Math.min(ctx.text.length,MAX_INPUT_CHARS),maxOutputTokens:2048,policyEpoch:policy.epoch,localName:proposal.name || null,costNotice:requestFeatures.length?'将向已配置模型发送文献文本并产生API费用；本次计划尚未发送':'本次可使用本地信息，无API请求',createdAt:timestamp()};
    if(manual)p.intent=MANUAL_SUMMARY;
    await transaction(s=>{if(s.automation.epoch!==policy.epoch)fail('conflict');if(s.plans.length>=4000)fail('invalid');s.plans.push(p);});return publicPlan(p);
  }
  async function updateJob(jobId,patch) {return transaction(s=>{const j=s.jobs.find(x=>x.jobId===jobId);if(!j)fail('invalid');Object.assign(j,patch,{updatedAt:timestamp()});delete j.owner;return publicJob(j);});}
  async function finish(job,planData,ctx,result,localGeneration,proof) {
    let proposedName=null;
    if(result?.proposedName && text(result.proposedName,120) && !result.proposedName.includes(ctx.endpoint.apiKey))proposedName=result.proposedName;
    // Candidate payload uses the frozen source and original metadata CAS base; late manual edits stay authoritative.
    const patch={expectedRevision:planData.metadataRevision,sourceSignature:planData.sourceSignature,model:ctx.model,operationId:job.operationId};
    if(job.features.includes('summary') && typeof result?.summary==='string' && result.summary.trim() && result.summary.length<=65536)patch.summaryText=result.summary.split(ctx.endpoint.apiKey).join('[已隐藏]');
    if(job.features.includes('name') && plain(result?.bibliography))patch.bibliography=copy(result.bibliography);
    let finalStatus='needs-review';
    await transaction(async s=>{
      const current=s.jobs.find(j=>j.jobId===job.jobId);if(!current || current.status!=='running')return;
      let latest;try{latest=await context(job.paperId);}catch{current.status='needs-review';current.reason='文献状态已变化，请人工核对';return;}
      const valid=consistent(planData,latest,s.automation,false) && autoAllowed(job,s.automation) && !stopped && revocation===localGeneration;
      const metadataStable=latest.metadata.revision===planData.metadataRevision;
      let candidate;
      if(Object.hasOwn(patch,'summaryText') || Object.hasOwn(patch,'bibliography'))candidate=await writeCandidate(latest.ref,copy(patch));
      const authorized=()=>!stopped && revocation===localGeneration && s.automation.epoch===job.policyEpoch && autoAllowed(job,s.automation);
      const beforeApply=await context(job.paperId);
      const stillValid=consistent(planData,beforeApply,s.automation,false) && authorized();
      const manual=planData.intent===MANUAL_SUMMARY && !job.automatic;
      const allowedSources=manual ? ['empty','api','manual','model'] : ['empty','api'];
      const canApply=valid && stillValid && metadataStable && (job.automatic || manual) && allowedSources.includes(beforeApply.metadata.summary.source) && candidate?.candidate?.baseRevision===planData.metadataRevision && beforeApply.metadata.revision===candidate?.revision;
      let applied;
      if(canApply && authorized()) {
        if(manual)await authority(proof,{action:job.retryOf?'retry':'run',...(job.retryOf?{jobId:job.retryOf}:{}),paperId:job.paperId,planId:planData.planId,operationId:job.operationId,features:job.features,...intentScope(planData)});
        applied=await applyCandidate(beforeApply.ref,{revision:candidate.revision,operationId:job.operationId},{authorize:authorized,sourceSignature:planData.sourceSignature,allowedSources,...intentScope(planData)});
        finalStatus='done';
      }
      const beforeRename=job.automatic && job.features.includes('name')?await context(job.paperId):null;
      const renameValid=beforeRename && consistent(planData,beforeRename,s.automation,false) && beforeRename.metadata.revision===(applied?.revision ?? candidate?.revision ?? latest.metadata.revision);
      if(job.automatic && job.features.includes('name') && valid && stillValid && renameValid && metadataStable && proposedName && result.namingReady===true && authorized()) {
        await renamePaper(beforeRename.ref,{name:proposedName,expectedLocationRevision:beforeRename.ref.locationRevision,operationId:job.operationId+'-rename',sourceSignature:planData.sourceSignature,authorize:authorized});
        if(!job.features.includes('summary') || canApply)finalStatus='done';
      } else if(job.features.includes('name')) finalStatus='needs-review';
      if(!job.features.length)finalStatus='skipped';
      const bibliographyIssue=Array.isArray(result.reviewReasons)?['bibliography-shape','bibliography-missing'].find(reason=>result.reviewReasons.includes(reason)):null;
      if(applied&&job.features.includes('name')&&bibliographyIssue)current.reason='['+bibliographyIssue+'] 摘要已保存；书目待核对，文件名保持不变';
      current.status=finalStatus;current.proposedName=proposedName;current.updatedAt=timestamp();delete current.owner;
    });
    return publicJob((await load()).state.jobs.find(j=>j.jobId===job.jobId));
  }
  async function perform(job,p,proof,localGeneration) {
    const controller=new AbortController();controllers.add(controller);let received=false;
    try {
      const ctx=await context(job.paperId);
      await authority(proof,{action:job.automatic?'automatic':job.retryOf?'retry':'run',...(job.retryOf?{jobId:job.retryOf}:{}),paperId:job.paperId,planId:p.planId,operationId:job.operationId,features:job.features,policyEpoch:job.policyEpoch,...intentScope(p)});
      await transaction(s=>{
        if(!consistent(p,ctx,s.automation) || !autoAllowed(job,s.automation) || stopped || revocation!==localGeneration)fail('conflict');
        const j=s.jobs.find(x=>x.jobId===job.jobId);if(j.status!=='queued')fail('conflict');
        j.status='running';j.sent=p.requestFeatures.length>0;j.owner={pid:process.pid,token:randomUUID()};j.updatedAt=timestamp();
      });
      let result;
      if(p.requestFeatures.length) {
        // The sent journal is durable before dispatch. Recheck after persistence, then invoke
        // the trusted request adapter while the policy lock still orders disable vs send.
        const dispatch=await transaction(async s=>{
          await authority(proof,{action:job.automatic?'automatic':job.retryOf?'retry':'run',...(job.retryOf?{jobId:job.retryOf}:{}),paperId:job.paperId,planId:p.planId,operationId:job.operationId,features:job.features,policyEpoch:job.policyEpoch,...intentScope(p)});
          const fresh=await context(job.paperId);
          if(!consistent(p,fresh,s.automation) || !autoAllowed(job,s.automation) || stopped || revocation!==localGeneration)fail('conflict');
          const promise=Promise.resolve(request({endpoint:fresh.endpoint,text:fresh.text,features:p.requestFeatures,signal:controller.signal}));
          // Attach immediately while releasing the local journal lock, not while holding a network wait.
          promise.catch(()=>{});return {promise};
        });
        result=await dispatch.promise;
      } else {
        result={summary:'',bibliography:ctx.metadata.bibliography,proposedName:p.localName,namingReady:false};
        if(job.features.includes('name') && p.localName) {
          const checked=parseEnrichmentResponse(JSON.stringify({bibliography:ctx.metadata.bibliography}),{text:ctx.text,features:['name']});
          // Local bibliography follows the same evidence gate as API extraction.
          result={...checked,proposedName:job.automatic?checked.proposedName:p.localName};
        }
      }
      received=true;
      return await finish(job,p,ctx,result,localGeneration,proof);
    } catch(e) {
      const latest=(await load()).state.jobs.find(j=>j.jobId===job.jobId);
      const beforeDispatch=e instanceof EnrichmentError && e.beforeDispatch===true;
      const status=received?'needs-review':beforeDispatch?'failed':latest?.sent ? (['http-error','invalid-response'].includes(e?.code)?'failed':'request-unknown') : 'skipped';
      return updateJob(job.jobId,{status,reason:enrichmentFailureReason(e,status)});
    } finally {controllers.delete(controller);}
  }
  async function begin(args,proof,automaticEpoch=null,retryOf=null) {
    ready();const input=copy(args);if(!plain(input) || !UUID.test(input.planId) || !text(input.operationId))fail('invalid');
    const manual=manualInput(input,['planId','operationId','confirmCosts','intent','expectedRevision']);
    const fingerprint=hash(JSON.stringify(manual ? [input.planId,retryOf,input.intent,input.expectedRevision] : [input.planId,retryOf]));
    const initial=await state(),existing=initial.jobs.find(j=>j.operationId===input.operationId);
    if(existing){if(existing.fingerprint!==fingerprint)fail('conflict');return publicJob(existing);}
    const p=initial.plans.find(x=>x.planId===input.planId);if(!p)fail('invalid');
    if((p.intent===MANUAL_SUMMARY)!==manual || manual && input.expectedRevision!==p.metadataRevision)fail('conflict');
    if(automaticEpoch!==null && (p.intent!==undefined || p.policyEpoch!==automaticEpoch))fail('conflict');
    if(p.requestFeatures.length && input.confirmCosts!==true)fail('forbidden');
    await authority(proof,{action:automaticEpoch!==null?'automatic':retryOf?'retry':'run',...(retryOf?{jobId:retryOf}:{}),paperId:p.paperId,planId:p.planId,operationId:input.operationId,features:p.features,policyEpoch:p.policyEpoch,...intentScope(p)});
    const localGeneration=revocation,ctx=await context(p.paperId);
    const reserved=await transaction(s=>{
      const old=s.jobs.find(j=>j.operationId===input.operationId);if(old){if(old.fingerprint!==fingerprint)fail('conflict');return {job:copy(old),created:false};}
      if(!consistent(p,ctx,s.automation) || stopped || localGeneration!==revocation)fail('conflict');
      if(s.jobs.length>=2000)fail('invalid');
      const job={jobId:randomUUID(),paperId:p.paperId,planId:p.planId,operationId:input.operationId,fingerprint,features:copy(p.features),status:'queued',sent:false,owner:{pid:process.pid,token:randomUUID()},automatic:automaticEpoch!==null,policyEpoch:p.policyEpoch,createdAt:timestamp(),updatedAt:timestamp(),...(retryOf?{retryOf}:{})};
      if(manual)job.intent=MANUAL_SUMMARY;
      if(!autoAllowed(job,s.automation))fail('conflict');s.jobs.push(job);return {job:copy(job),created:true};
    });
    if(!reserved.created)return publicJob(reserved.job);
    const work=perform(reserved.job,p,proof,localGeneration);active.add(work);
    try{return await work;}finally{active.delete(work);}
  }
  async function jobs({paperId}={}) {if(paperId!==undefined && !UUID.test(paperId))fail('invalid');return (await state()).jobs.filter(j=>!paperId || j.paperId===paperId).map(publicJob);}
  async function getAutomation() {return copy((await state()).automation);}
  async function setAutomation(args,proof) {
    ready();const input=copy(args);if(!plain(input) || typeof input.autoSummary!=='boolean' || typeof input.autoName!=='boolean')fail('invalid');
    const expected=Object.hasOwn(input,'expectedRevision')?input.expectedRevision:input.revision;
    // Pause late automatic admissions and revoke old work before the observation fence can wait.
    pendingPolicyChanges++;revocation++;
    try {
      // Lock order: observer fence, then short journal lock; no ingestion/request runs here.
      return await withPolicyFence(async()=>{
        const old=await getAutomation(),enabling=(!old.autoSummary&&input.autoSummary)||(!old.autoName&&input.autoName);
        if(enabling){if(input.confirmCosts!==true)fail('forbidden');await authority(proof,{action:'set-automation',features:[...(input.autoSummary?['summary']:[]),...(input.autoName?['name']:[])]});}
        const watermark=enabling?await getIngestSeq():old.watermark;
        if(!Number.isSafeInteger(watermark)||watermark<0)fail('invalid');
        return transaction(s=>{
          if(s.automation.revision!==expected)fail('conflict');
          if(s.automation.autoSummary===input.autoSummary && s.automation.autoName===input.autoName)return copy(s.automation);
          const next={revision:null,autoSummary:input.autoSummary,autoName:input.autoName,epoch:s.automation.epoch+1,watermark};next.revision=hash(JSON.stringify([next,randomUUID()]));s.automation=next;
          for(const j of s.jobs)if(j.automatic && j.status==='queued'){j.status='skipped';j.reason='自动规则已变化，请重新明确确认';}
          return copy(next);
        });
      });
    } finally {pendingPolicyChanges--;}
  }
  async function admitNew(args) {
    ready();const event=copy(args);if(!plain(event)||!UUID.test(event.paperId)||!Number.isSafeInteger(event.ingestSeq)||event.ingestSeq<1||!HASH.test(event.sourceSignature))fail('invalid');
    const observed=Object.hasOwn(event,'observedPolicyEpoch');
    if(observed && event.observedPolicyEpoch!==null && (!Number.isSafeInteger(event.observedPolicyEpoch)||event.observedPolicyEpoch<0))fail('invalid');
    const skipped={paperId:event.paperId,status:'skipped',reason:'该事件未满足启用后新增导入条件'};
    if(pendingPolicyChanges)return skipped;
    const policy=await getAutomation();
    if(pendingPolicyChanges || (observed && event.observedPolicyEpoch!==policy.epoch) || event.origin!=='import' || (!policy.autoSummary&&!policy.autoName) || event.ingestSeq<=policy.watermark)return skipped;
    const ref=await resolvePaper({paperId:event.paperId});if(ref.origin!=='import'||ref.ingestSeq!==event.ingestSeq||ref.status!=='active')return skipped;
    const local=await readText(ref);if(local.sourceSignature!==event.sourceSignature)return skipped;
    const claimed=await transaction(s=>{
      if(pendingPolicyChanges || s.automation.epoch!==policy.epoch || s.ingests.some(x=>x.paperId===event.paperId && x.ingestSeq===event.ingestSeq))return false;
      s.ingests.push({paperId:event.paperId,ingestSeq:event.ingestSeq,sourceSignature:event.sourceSignature,epoch:policy.epoch});return true;
    });
    if(!claimed)return skipped;
    try {
      const p=await plan({paperId:event.paperId,features:[...(policy.autoSummary?['summary']:[]),...(policy.autoName?['name']:[])]});
      return await begin({planId:p.planId,operationId:'auto-'+event.paperId+'-'+event.ingestSeq+'-'+policy.epoch,confirmCosts:true},undefined,policy.epoch);
    } catch(e) {if(e instanceof EnrichmentQueueError && [403,409].includes(e.status))return skipped;throw e;}
  }
  async function retry(args,proof) {
    ready();const input=copy(args);if(!plain(input)||!UUID.test(input.jobId)||!text(input.operationId))fail('invalid');
    const saved=await state(),old=saved.jobs.find(j=>j.jobId===input.jobId);if(!old || !['failed','request-unknown'].includes(old.status) || old.operationId===input.operationId)fail('conflict');
    const manual=manualInput(input,['jobId','operationId','confirmCosts','intent','expectedRevision']);
    const oldPlan=saved.plans.find(p=>p.planId===old.planId);
    if((oldPlan.intent===MANUAL_SUMMARY)!==manual)fail('conflict');
    const existing=saved.jobs.find(j=>j.operationId===input.operationId);if(existing){
      const retryPlan=saved.plans.find(p=>p.planId===existing.planId);
      if(existing.retryOf!==input.jobId || manual && input.expectedRevision!==retryPlan.metadataRevision)fail('conflict');return publicJob(existing);
    }
    const scope=manual ? {intent:MANUAL_SUMMARY,expectedRevision:input.expectedRevision} : {};
    if(input.confirmCosts!==true)fail('forbidden');await authority(proof,{action:'retry',jobId:old.jobId,paperId:old.paperId,operationId:input.operationId,features:old.features,...scope});
    const p=await plan({paperId:old.paperId,features:old.features,...scope});return begin({planId:p.planId,operationId:input.operationId,confirmCosts:true,...scope},proof,null,old.jobId);
  }
  async function initialize() {
    if(initialized)return getAutomation();
    try{await mkdir(root,{recursive:true});await realpath(root);await transaction(s=>{for(const j of s.jobs)if(['queued','running'].includes(j.status) && (!j.owner || !alive(j.owner.pid))){j.status=j.sent?'request-unknown':'failed';j.reason='先前任务中断，请核对后明确重试';delete j.owner;}});initialized=true;return getAutomation();}catch(e){throw safeError(e);}
  }
  async function stop() {stopped=true;revocation++;for(const c of controllers)c.abort();await Promise.allSettled([...active]);}
  return {initialize,plan,run:(args,authorization)=>begin(args,authorization),jobs,retry,getAutomation,setAutomation,admitNew,stop};
}
