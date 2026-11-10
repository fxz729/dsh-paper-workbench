export function pageRef(current, variant, column) {
  return current ? {...(current.paperId?{paperId:current.paperId}:{}),topic:current.topic,name:current.name,variant:column==='zh'?'zh':variant||'orig'} : null;
}
export const refKey = ref => JSON.stringify(ref.paperId?[ref.paperId,ref.variant]:[ref.topic,ref.name,ref.variant]);
export const sameInkPaper = (a,b) => !!a&&!!b&&(a.paperId&&b.paperId?a.paperId===b.paperId:a.topic===b.topic&&a.name===b.name);
// Upgrade the existing ref object: queued writes close over it. Keep viewKey unchanged
// so the mounted SDK editor, selection and undo stack survive identity registration.
export function reconcileInkSessions(sessions,current) {
  if(!current?.paperId)return;
  const updates=[...sessions].filter(([,s])=>sameInkPaper(s.ref,current)).map(([oldKey,s])=>{
    const next={...s.ref,paperId:current.paperId,topic:current.topic,name:current.name};return {oldKey,s,next,key:refKey(next)};
  });
  for(const {s,key} of updates)if(sessions.has(key)&&sessions.get(key)!==s)throw Error('墨迹身份存在冲突，请先导出草稿');
  for(const {oldKey,s,next,key} of updates){
    if(!s.viewKey)s.viewKey=oldKey;
    if(key!==oldKey&&s.recoveryRaw)s.legacyRecovery={key:'dpr.ink.recovery.'+oldKey,raw:s.recoveryRaw};
    Object.assign(s.ref,next);
    if(s.recoveryCandidate&&sameInkPaper(s.recoveryCandidate.ref,current))s.recoveryCandidate={...s.recoveryCandidate,ref:{...s.recoveryCandidate.ref,...next}};
    if(s.recoveryCandidate&&s.recoverySource&&s.recoverySource.key!=='dpr.ink.recovery.'+key)s.legacyRecovery=s.recoverySource;
    if(key!==oldKey){sessions.delete(oldKey);sessions.set(key,s);}
  }
}
// Separate from navigation: no rows, documents, stores or SDK history are replaced.
export function createInkMutationLease({capture,flush,onLock,onUnlock}) {
  let owner=null,flight=null;
  return {
    get locked(){return owner!==null;},get operationId(){return owner;},
    prepare(operationId){
      if(owner!==null&&owner!==operationId)return Promise.reject(Error('另一个文献操作仍在保存'));
      if(flight)return flight;
      owner=operationId;
      try{capture();onLock();flight=Promise.resolve().then(flush);}
      catch(error){onLock();flight=Promise.reject(error);}
      flight.catch(()=>{});return flight;
    },
    async resume(operationId){
      if(owner===null)return;
      if(owner!==operationId)throw Error('文献恢复操作身份不匹配');
      await flight?.catch(()=>{});owner=null;flight=null;onUnlock();
    },
  };
}
export function writeRecoveryCache(session,storage,unique) {
  if(!session.dirty||session.recoveryCandidate)return;
  const key='dpr.ink.recovery.'+refKey(session.ref),raw=JSON.stringify(session.recovery()),current=storage.getItem(key);
  if(current&&current!==session.recoveryRaw&&current!==raw){
    const archive='dpr.ink.archive.'+refKey(session.ref)+'.'+unique;
    if(storage.getItem(archive))throw Error('草稿备份编号已存在');
    storage.setItem(archive,current);
    if(storage.getItem(archive)!==current)throw Error('草稿备份验证失败');
  }
  storage.setItem(key,raw);session.recoveryRaw=raw;
}
function clearLegacyRecovery(session,storage) {
  const old=session.legacyRecovery;
  if(old&&storage.getItem(old.key)===old.raw)storage.removeItem(old.key);
  if(old&&session.recoverySource?.key===old.key)session.recoverySource=null;
  session.legacyRecovery=null;
}
export function clearRecoveryCache(session,storage) {
  const key='dpr.ink.recovery.'+refKey(session.ref);
  if(session.recoveryRaw&&storage.getItem(key)===session.recoveryRaw)storage.removeItem(key);
  session.recoveryRaw=null;clearLegacyRecovery(session,storage);
}
export function archiveRecovery(session,storage,unique) {
  if(!session.recoveryCandidate)return null;
  const key='dpr.ink.archive.'+refKey(session.ref)+'.'+unique;
  if(storage.getItem?.(key))throw Error('草稿备份编号已存在，请重试');
  const raw=JSON.stringify(session.recoveryCandidate);
  storage.setItem(key,raw);
  if(storage.getItem(key)!==raw)throw Error('草稿备份验证失败，请先导出');
  const currentKey='dpr.ink.recovery.'+refKey(session.ref);
  if(storage.getItem(currentKey)===raw)storage.removeItem(currentKey);
  session.recoveryCandidate=null;clearLegacyRecovery(session,storage);
  return key;
}
export function restoreRecovery(session,record) {
  if(record?.format!=='dpr-ink-recovery'||record.version!==1||refKey(record.ref||{})!==refKey(session.ref))throw Error('恢复草稿的文献身份不匹配');
  if(record.revision!==session.revision)throw Error('恢复草稿的版本与磁盘不同，请先导出草稿并核对');
  if(!record.document?.pages||Array.isArray(record.document.pages))throw Error('恢复草稿格式无效');
  for(const [page,value] of Object.entries(record.document.pages))session.setPage(page,value);
}
export function sameInkRows(a,b) {
  return a.length===b.length&&a.every((row,i)=>{
    const other=b[i];
    return row.key===other.key&&row.session===other.session&&row.pane===other.pane&&
      ['left','top','width','height'].every(k=>row.paneRect[k]===other.paneRect[k])&&
      ['page','width','height','rotation','left','top','screenWidth','screenHeight','zoom'].every(k=>row.geometry[k]===other.geometry[k]);
  });
}
export function vectorDocument(snapshot) {
  const store={};
  for(const [id,record] of Object.entries(snapshot.store)){
    if(record.typeName==='user')continue; // SDK user registry is not ink or session history.
    if(!['document','page','shape'].includes(record.typeName))throw Error('墨迹仅支持本地矢量记录');
    store[id]=record;
  }
  return {...snapshot,store};
}
export function pageGeometry(page) {
  const vp=page._dprViewport,r=page.getBoundingClientRect();
  const width=vp.width/vp.scale,height=vp.height/vp.scale;
  return {page:+page.dataset.page,width,height,rotation:vp.rotation||0,left:r.left,top:r.top,screenWidth:r.width,screenHeight:r.height,zoom:r.width/width};
}
export function createInkSession({ref,read,write,changed=()=>{},capture=()=>{},apply=()=>{},blocked=()=>false,saved=()=>{}}) {
  let loaded=false,loading,revision=null,document={pages:{}},dirty=false,sequence=0,tail=Promise.resolve(),error=null,conflict=false;
  const state={
    ref,
    get document(){return document;},get revision(){return revision;},get dirty(){return dirty;},get loaded(){return loaded;},get error(){return error;},get conflict(){return conflict;},
    load(){
      if(loaded)return Promise.resolve(state);
      if(loading)return loading;
      loading=read(ref).then(row=>{revision=row.revision;document=structuredClone(row.document);loaded=true;error=null;changed(state);return state;},e=>{error=e;throw e;}).finally(()=>{loading=null;});
      return loading;
    },
    refresh(){
      const task=tail.catch(()=>{}).then(async()=>{
        if(!loaded)await state.load();
        capture();
        if(dirty||state.recoveryCandidate||blocked())return false;
        const seq=sequence,row=await read(ref);
        capture();
        if(dirty||sequence!==seq||state.recoveryCandidate||blocked())return false;
        if(row.revision===revision)return false;
        const next=structuredClone(row.document);
        apply(next);
        document=next;revision=row.revision;error=null;conflict=false;changed(state);return true;
      });
      tail=task;return task;
    },
    setPage(page,value){
      if(!loaded)throw Error('墨迹尚未加载，请稍后再试');
      if(JSON.stringify(document.pages[page])===JSON.stringify(value))return false;
      document.pages[page]=structuredClone(value);sequence++;dirty=true;changed(state);return true;
    },
    save(){
      const task=tail.catch(()=>{}).then(async()=>{
        if(!loaded)throw Error('墨迹尚未加载，已保留原数据');
        if(!dirty)return;
        const seq=sequence,body={revision,document:structuredClone(document)};
        try{const row=await write(ref,body);revision=row.revision;error=null;conflict=false;if(sequence===seq)dirty=false;changed(state);saved(state);return row;}
        catch(e){conflict=e.status===409;error=conflict?null:e;dirty=true;changed(state);throw e;}
      });
      tail=task;return task;
    },
    recovery(){return {format:'dpr-ink-recovery',version:1,ref,revision,document:structuredClone(document),savedAt:Date.now()};},
  };
  return state;
}
