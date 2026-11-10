import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {Tldraw,getSnapshot,loadSnapshot,DefaultColorStyle,DefaultSizeStyle,GeoShapeGeoStyle,ArrowShapeUtil,defaultEditorAssetUrls} from 'tldraw';
import {createInkSession,pageGeometry,pageRef,refKey,restoreRecovery,archiveRecovery,vectorDocument,sameInkRows,writeRecoveryCache,clearRecoveryCache,reconcileInkSessions,sameInkPaper,createInkMutationLease} from './ink-model.mjs';
import assetUrls from './ink-assets.json';
import 'tldraw/tldraw.css';
import './ink.css';

const bridge=window.DprReaderInkBridge;
const keyName='dpr.ink.licenseKey';
const tools=[['read','文字选择','M5 3v18 M2 3h6 M2 21h6 M14 8h7 M14 12h7 M14 16h5'],['draw','钢笔','m4 20 3-8L17 2l5 5-10 10z M7 12l5 5'],['highlight','荧光','m3 14 9-11 8 7-9 11z M3 21h15'],['ellipse','圈画','M22 12a10 8 0 1 1-20 0 10 8 0 1 1 20 0'],['rectangle','矩形','M3 4h18v16H3z'],['arrow','箭头','M3 21 21 3 M11 3h10v10'],['text','文字','M3 4h18 M12 4v17 M7 21h10'],['select','选墨迹','M4 2v18l5-5 5 7 3-2-5-7h8z'],['eraser','橡皮','m3 13 10-11 9 8-10 11H9z M7 9l9 8']];
const colors=[['blue','#4263a0','靛蓝'],['black','#273632','墨黑'],['red','#cb625d','朱红'],['green','#347653','松绿'],['orange','#d99d43','暖橙']];
class PaperArrow extends ArrowShapeUtil{canBind(){return false;}}
const shapeUtils=[PaperArrow];
const editorAssetUrls={...assetUrls,fonts:{...defaultEditorAssetUrls.fonts,...assetUrls.fonts}};
const editorOptions={maxPages:1,maxShapesPerPage:10000};
const components={Background:null,Grid:null,ContextMenu:null,OnTheCanvas:null,InFrontOfTheCanvas:null};
const sessions=new Map(),mounted=new Map(),saveFailures=new WeakMap();
let active=null,tool='read',color='blue',size='s',navigation=false,syncSuspended=false,space=false,saveTimer,captureTimer,refresh=()=>{},inkChannel=null;
function safeLocalGet(key){try{return localStorage.getItem(key);}catch{return null;}}
function recoveryKey(ref){return 'dpr.ink.recovery.'+refKey(ref);}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function api(ref,body){const address={...(ref.paperId?{paperId:ref.paperId}:{topic:ref.topic,name:ref.name}),variant:ref.variant},query=new URLSearchParams(address);const response=await fetch('/paper-reader/api/ink'+(body?'':'?'+query),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...address,...body})}:undefined);const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'墨迹读写失败'),{code:data.code,status:response.status});return data;}
function remember(s){if(!s.dirty||s.recoveryCandidate)return;try{writeRecoveryCache(s,localStorage,crypto.randomUUID());}catch{bridge.toast('墨迹恢复缓存空间不足，请先保存或导出草稿',7000);}}
function drawingGesture(){return [...mounted.values()].some(item=>item.gesture||item.editor.inputs?.isPointing||item.editor.inputs?.isDragging);}
function remoteUpdateBlocked(){return isInkLocked()||drawingGesture();}
function applyRemote(s,document){
 const targets=[...mounted.values()].filter(item=>item.session===s&&!item.failed);
 for(const item of targets){const saved=document.pages[item.geometry.page];if(saved&&(Math.abs(saved.width-item.geometry.width)>.1||Math.abs(saved.height-item.geometry.height)>.1||saved.rotation!==item.geometry.rotation))throw Error('PDF 页面尺寸或方向已变化，请核对旧墨迹');}
 for(const item of targets){
  const ed=item.editor,camera={...ed.getCamera()},currentTool=ed.getCurrentToolId(),snapshot=document.pages[item.geometry.page]?.snapshot||item.emptySnapshot;
  loadSnapshot(ed.store,{document:snapshot});ed.clearHistory();ed.setCamera(camera,{immediate:true,force:true});ed.setCurrentTool(currentTool);
  item.lastSnapshot=JSON.stringify(vectorDocument(getSnapshot(ed.store).document));item.pending=false;
 }
}
function notifySaved(s){inkChannel?.postMessage({ref:s.ref.paperId?{paperId:s.ref.paperId,variant:s.ref.variant}:{topic:s.ref.topic,name:s.ref.name,variant:s.ref.variant},revision:s.revision});}
function refreshSession(s){return s.refresh().catch(e=>{bridge.toast('墨迹同步暂未完成：'+e.message,5000);});}
function refreshCurrent(){collect();for(const s of sessions.values())if(s.loaded&&sameInkPaper(s.ref,bridge.current()))void refreshSession(s);}
function session(ref){reconcileInkSessions(sessions,bridge.current());const k=refKey(ref);if(!sessions.has(k)){const s=createInkSession({ref,read:r=>api(r),write:(r,b)=>api(r,b),capture:()=>collect(false,true),blocked:()=>remoteUpdateBlocked(),apply:doc=>applyRemote(s,doc),saved:notifySaved,changed:s=>{if(s.dirty)remember(s);refresh();}});s.viewKey=k;try{const key=recoveryKey(ref),legacyKey=recoveryKey({...ref,paperId:undefined}),primary=safeLocalGet(key),raw=primary||safeLocalGet(legacyKey);s.recoveryCandidate=JSON.parse(raw||'null');if(s.recoveryCandidate)s.recoverySource={key:primary?key:legacyKey,raw};}catch{s.recoveryCandidate=null;}sessions.set(k,s);reconcileInkSessions(sessions,bridge.current());s.load().then(()=>refresh()).catch(()=>refresh());}return sessions.get(k);}
function capture(item){if(!item.pending||!item.session.loaded||item.failed||item.session.recoveryCandidate)return;const snapshot=vectorDocument(getSnapshot(item.editor.store).document),serialized=JSON.stringify(snapshot);if(serialized===item.lastSnapshot){item.pending=false;return;}item.session.setPage(item.geometry.page,{width:item.geometry.width,height:item.geometry.height,rotation:item.geometry.rotation,snapshot});item.lastSnapshot=serialized;item.pending=false;}
function collect(complete=false,force=complete){clearTimeout(captureTimer);for(const item of mounted.values()){if(complete)item.editor.complete();if(force)item.pending=true;capture(item);}}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{void saveAll().catch(()=>{});},650);}
function changed(){for(const item of mounted.values())item.pending=true;clearTimeout(captureTimer);captureTimer=setTimeout(()=>{for(const item of mounted.values())capture(item);scheduleSave();refresh();},180);}
async function saveAll(){clearTimeout(saveTimer);collect(false,true);const dirty=[...sessions.values()].filter(s=>s.dirty);for(const s of dirty){try{await s.save();saveFailures.delete(s);if(!s.dirty&&!s.recoveryCandidate)try{clearRecoveryCache(s,localStorage);}catch{}}catch(e){remember(s);refresh();const key=JSON.stringify([s.revision,e.status,e.code,e.message]);if(saveFailures.get(s)!==key){saveFailures.set(s,key);bridge.toast('墨迹保存未完成：'+e.message+'；可导出草稿保留当前编辑',8000);}throw e;}}refresh();}
const mutationLease=createInkMutationLease({capture:()=>collect(true),flush:saveAll,onLock:()=>{for(const item of mounted.values())configureEditor(item);refresh();},onUnlock:()=>{for(const item of mounted.values())configureEditor(item);refresh();}});
function isInkLocked(){return navigation||mutationLease.locked||syncSuspended||bridge.syncBlocked?.()===true;}
function configureEditor(item){const ed=item.editor,readonly=!!(isInkLocked()||tool==='read'||item.session.error||item.session.recoveryCandidate||item.failed);if(ed.getInstanceState().isReadonly!==readonly)ed.updateInstanceState({isReadonly:readonly});if(tool==='read'){if(ed.getInstanceState().isFocused)ed.blur?.();return;}ed.setStyleForNextShapes(DefaultColorStyle,color);ed.setStyleForNextShapes(DefaultSizeStyle,size);const target=tool==='rectangle'||tool==='ellipse'?'geo':tool;if(target==='geo')ed.setStyleForNextShapes(GeoShapeGeoStyle,tool);if(ed.getCurrentToolId()!==target)ed.setCurrentTool(target);}
function selectTool(next){if(isInkLocked())return;collect(true);tool=next;const legacy=document.getElementById('annotation-tool');legacy.value=next==='read'?'none':'tl-'+next;legacy.dispatchEvent(new Event('change',{bubbles:true}));for(const item of mounted.values())configureEditor(item);refresh();scheduleSave();}
function Icon({path}){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>;}
function PageInk({row,licenseKey}){
 const ref=useRef(null),runtime=useRef(null),g=row.geometry,s=row.session;
 // PDF owns zoom. Bound SDK pattern LODs before its first canvas render.
 const cameraOptions=useRef({isLocked:true,wheelBehavior:'none',zoomSteps:[g.zoom]}).current;
 const onMount=ed=>{
  const item={editor:ed,session:s,geometry:g,failed:false,pending:false,gesture:false,emptySnapshot:vectorDocument(getSnapshot(ed.store).document)};runtime.current=item;
  const saved=s.document.pages[g.page];
  try{
   if(saved){if(Math.abs(saved.width-g.width)>.1||Math.abs(saved.height-g.height)>.1||saved.rotation!==g.rotation)throw Error('PDF 页面尺寸或方向已变化，请核对旧墨迹');loadSnapshot(ed.store,{document:saved.snapshot});}
   // Imported records are data: only six vector tools, never links/media/assets.
   const allowed=new Set(['draw','highlight','geo','line','arrow','text']);
   ed.sideEffects.registerBeforeCreateHandler('shape',shape=>{if(!allowed.has(shape.type))throw Error('此阅读器仅支持矢量墨迹');return shape;});
   ed.registerExternalContentHandler('files',async()=>{});ed.registerExternalContentHandler('url',async()=>{});
   ed.setCameraOptions({isLocked:false,wheelBehavior:'none',zoomSteps:[g.zoom]});ed.setCamera({x:0,y:0,z:g.zoom},{immediate:true,force:true});ed.setCameraOptions({isLocked:true});
   ed.updateInstanceState({isGridMode:false,isToolLocked:true});
  }catch(e){item.failed=true;bridge.toast('墨迹暂按只读保留：'+e.message,8000);}
  item.lastSnapshot=JSON.stringify(vectorDocument(getSnapshot(ed.store).document));
  mounted.set(row.key,item);configureEditor(item);
  const stop=ed.store.listen(()=>{item.pending=true;clearTimeout(captureTimer);captureTimer=setTimeout(()=>{capture(item);scheduleSave();refresh();},180);},{scope:'document',source:'user'});item.stop=stop;
 };
 useLayoutEffect(()=>{const item=runtime.current;if(!item)return;item.geometry=g;item.editor.setCameraOptions({zoomSteps:[g.zoom]});item.editor.setCamera({x:0,y:0,z:g.zoom},{immediate:true,force:true});},[g.left,g.top,g.zoom,g.screenWidth,g.screenHeight]);
 useEffect(()=>()=>{const item=runtime.current;if(item){item.pending=true;capture(item);item.stop?.();if(mounted.get(row.key)===item)mounted.delete(row.key);if(active===item)active=null;scheduleSave();}},[]);
 useEffect(()=>{const node=ref.current;if(!node)return;const wheel=e=>{e.preventDefault();e.stopImmediatePropagation();bridge.wheel(e,row.pane);refresh();};node.addEventListener('wheel',wheel,{capture:true,passive:false});return()=>node.removeEventListener('wheel',wheel,true);},[row.pane]);
 return <div ref={ref} className="dpr-ink-page" data-ink-page={g.page} data-ink-variant={s.ref.variant} style={{left:g.left-row.paneRect.left,top:g.top-row.paneRect.top,width:g.screenWidth,height:g.screenHeight,pointerEvents:tool==='read'||isInkLocked()?'none':'auto'}}
  onPointerDownCapture={e=>{active=runtime.current;if(active)active.gesture=true;if(space){e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget._inkPan={id:e.pointerId,x:e.clientX,y:e.clientY,left:row.pane.scrollLeft,top:row.pane.scrollTop};}}}
  onPointerMoveCapture={e=>{const p=e.currentTarget._inkPan;if(p?.id===e.pointerId){e.preventDefault();e.stopPropagation();row.pane.scrollLeft=p.left+p.x-e.clientX;row.pane.scrollTop=p.top+p.y-e.clientY;}}}
  onPointerUpCapture={e=>{if(runtime.current)runtime.current.gesture=false;if(e.currentTarget._inkPan){e.preventDefault();e.stopPropagation();e.currentTarget._inkPan=null;e.currentTarget.releasePointerCapture(e.pointerId);}else setTimeout(()=>{if(runtime.current){capture(runtime.current);scheduleSave();refresh();}},0);}}
  onPointerCancelCapture={e=>{if(runtime.current){runtime.current.gesture=false;runtime.current.pending=true;capture(runtime.current);scheduleSave();}e.currentTarget._inkPan=null;}}>
  <Tldraw hideUi inferDarkMode={false} shapeUtils={shapeUtils} licenseKey={licenseKey||undefined} assetUrls={editorAssetUrls} components={components} onMount={onMount} options={editorOptions} cameraOptions={cameraOptions} />
 </div>;
}
function App(){
 const [,render]=useState(0),[rows,setRows]=useState([]),[licenseKey,setKey]=useState(()=>safeLocalGet(keyName)||''),[showLicense,setShowLicense]=useState(false),[licenseDraft,setDraft]=useState(''),[collapsed,setCollapsed]=useState(false);
 const licensePanel=useRef(null),morePanel=useRef(null);
 const enabled=!!licenseKey||__INK_DEV__;
 refresh=()=>render(n=>n+1);
 useEffect(()=>{let alive=true;fetch('/paper-reader/api/ink-license').then(r=>r.ok?r.json():null).then(row=>{if(alive&&row?.licenseKey)setKey(row.licenseKey);}).catch(()=>{});return()=>{alive=false;};},[]);
 useEffect(()=>{
  if(typeof BroadcastChannel==='function'){
   inkChannel=new BroadcastChannel('dpr.ink.saved.v1');
   inkChannel.onmessage=({data})=>{if(!data?.ref||!Object.hasOwn(data,'revision'))return;for(const s of sessions.values())if(s.loaded&&sameInkPaper(s.ref,data.ref)&&s.ref.variant===data.ref.variant&&s.revision!==data.revision)void refreshSession(s);};
  }
  const focus=()=>refreshCurrent(),visibility=()=>{if(document.visibilityState==='visible')refreshCurrent();};
  window.addEventListener('focus',focus);document.addEventListener('visibilitychange',visibility);
  const dismiss=e=>{const target=e.target;if(e.type==='keydown'&&e.key!=='Escape')return;if(e.type==='keydown'||!morePanel.current?.contains(target)){if(morePanel.current)morePanel.current.open=false;}if(e.type==='keydown'||(!licensePanel.current?.contains(target)&&!target.closest?.('[aria-label="墨迹许可"]')))setShowLicense(false);};
  document.addEventListener('pointerdown',dismiss,true);document.addEventListener('focusin',dismiss,true);document.addEventListener('keydown',dismiss,true);
  const select=document.getElementById('annotation-tool');
  for(const [id,label] of tools.filter(t=>t[0]!=='read')){const o=document.createElement('option');o.value='tl-'+id;o.textContent='新墨迹 · '+label;select.appendChild(o);}
  const change=()=>{if(isInkLocked())return;const next=select.value.startsWith('tl-')?select.value.slice(3):'read';if(tool!==next){collect();tool=next;for(const item of mounted.values())configureEditor(item);refresh();scheduleSave();}};
  select.addEventListener('change',change);
  let raf=0,alive=true;
  const update=()=>{
   if(!alive)return;if(navigation){setRows(prev=>prev.length?[]:prev);raf=0;return;}collect();reconcileInkSessions(sessions,bridge.current());const list=[];
   for(const id of ['pdf-pane','pdf-pane-zh']){
    const pane=document.getElementById(id),pr=pane.getBoundingClientRect();if(pr.width<1||pr.height<1)continue;
    for(const page of pane.querySelectorAll('.page')){
     if(!page._dprPainted||!bridge.isCurrentPage(page))continue;const g=pageGeometry(page);if(g.top+g.screenHeight<pr.top-100||g.top>pr.bottom+100||g.left+g.screenWidth<pr.left||g.left>pr.right)continue;
     const r=pageRef(bridge.current(),bridge.variant(),page.dataset.doc);if(!r)continue;const s=session(r);if(!s.loaded)continue;
     const key=s.viewKey+':'+g.page;list.push({key,pane,paneRect:pr,geometry:g,session:s});
    }
   }
   setRows(prev=>sameInkRows(prev,list)?prev:list);raf=0;
  };
  const request=()=>{if(!raf)raf=requestAnimationFrame(update);};
  const painted=()=>{if(!navigation)request();};
  const didNavigate=()=>{navigation=false;for(const item of mounted.values())configureEditor(item);request();};
  const observer=new MutationObserver(request);for(const id of ['pdf-pages','pdf-pages-zh'])observer.observe(document.getElementById(id),{childList:true,subtree:false,attributes:true,attributeFilter:['style','class']});
  const resize=new ResizeObserver(request);for(const id of ['pdf-pane','pdf-pane-zh']){const pane=document.getElementById(id);resize.observe(pane);pane.addEventListener('scroll',request,{passive:true});}
  // CSS zoom is written on page wrappers and may leave the native raster untouched.
  const zoomObserver=new MutationObserver(request);for(const id of ['pdf-pages','pdf-pages-zh'])zoomObserver.observe(document.getElementById(id),{subtree:true,attributes:true,attributeFilter:['style']});
  document.addEventListener('dpr-page-painted',painted);window.addEventListener('resize',request);
  const redraw=setInterval(request,350);request();
  window.DprInk={inspect:()=>({navigation,mutationLocked:mutationLease.locked,tool,pages:[...mounted.values()].map(item=>({ref:item.session.ref,page:item.geometry.page,contextId:item.editor.contextId,canUndo:item.editor.getCanUndo(),canRedo:item.editor.getCanRedo(),tool:item.editor.getCurrentToolId(),readonly:item.editor.getInstanceState().isReadonly,focused:item.editor.getInstanceState().isFocused,shapeCount:item.editor.getCurrentPageShapes().length,selected:item.editor.getSelectedShapeIds(),camera:item.editor.getCamera()}))}),remoteUpdateBlocked,ownsTool:()=>tool!=='read',adoptIdentity(ref,previous){if(previous&&!previous.paperId)reconcileInkSessions(sessions,{...previous,paperId:ref.paperId});reconcileInkSessions(sessions,ref);request();},suspendSync(){syncSuspended=true;collect(true);for(const item of mounted.values())configureEditor(item);refresh();},async rejoinSync(){reconcileInkSessions(sessions,bridge.current());await saveAll();if(mutationLease.locked)await mutationLease.resume(mutationLease.operationId);},resumeSync(){syncSuspended=false;for(const item of mounted.values())configureEditor(item);refresh();},async prepareMutation(operationId){if(navigation||syncSuspended)throw Error('阅读器正在切换文献，请稍后重试');await mutationLease.prepare(operationId);},async resumeMutation(operationId){reconcileInkSessions(sessions,bridge.current());await mutationLease.resume(operationId);request();},async beforeNavigate(){if(mutationLease.locked||syncSuspended||bridge.syncBlocked?.())throw Error('文献操作正在保存，请等待完成');collect(true);navigation=true;for(const item of mounted.values())configureEditor(item);try{await saveAll();setRows([]);}catch(e){navigation=false;for(const item of mounted.values())configureEditor(item);throw e;}},didNavigate,flush:saveAll};
  const unload=e=>{collect();for(const s of sessions.values())remember(s);if([...sessions.values()].some(s=>s.dirty)){e.preventDefault();e.returnValue='墨迹正在保存，请稍后再关闭';}};
  window.addEventListener('beforeunload',unload);
  const keydown=e=>{
   if(tool==='read'||e.target.closest?.('button,summary,a[href],input,textarea,select,[role="menuitem"],[contenteditable="true"]'))return;
   if(isInkLocked()){e.preventDefault();e.stopImmediatePropagation();return;}
   if(e.code==='Space'){space=true;e.preventDefault();e.stopImmediatePropagation();return;}
   if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopImmediatePropagation();const ed=active?.editor;if(ed){e.key.toLowerCase()==='y'||e.shiftKey?ed.redo():ed.undo();changed();}return;}
   if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopImmediatePropagation();if(active){active.editor.deleteShapes(active.editor.getSelectedShapeIds());capture(active);scheduleSave();refresh();}}
  };
  const keyup=e=>{if(e.code==='Space')space=false;};document.addEventListener('keydown',keydown,true);document.addEventListener('keyup',keyup,true);
  const blur=()=>{space=false;collect();scheduleSave();};window.addEventListener('blur',blur);
  return()=>{alive=false;inkChannel?.close();inkChannel=null;clearTimeout(saveTimer);clearTimeout(captureTimer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('focusin',dismiss,true);document.removeEventListener('keydown',dismiss,true);clearInterval(redraw);cancelAnimationFrame(raf);observer.disconnect();zoomObserver.disconnect();resize.disconnect();select.removeEventListener('change',change);document.removeEventListener('dpr-page-painted',painted);window.removeEventListener('resize',request);window.removeEventListener('beforeunload',unload);document.removeEventListener('keydown',keydown,true);document.removeEventListener('keyup',keyup,true);window.removeEventListener('blur',blur);for(const id of ['pdf-pane','pdf-pane-zh'])document.getElementById(id).removeEventListener('scroll',request);delete window.DprInk;};
 },[]);
 // A load completion needs another geometry pass even if the PDF already painted.
 const currentSessions=[...sessions.values()].filter(s=>sameInkPaper(s.ref,bridge.current()));
 const pending=currentSessions.some(s=>s.dirty),failure=currentSessions.find(s=>s.error),canDraw=enabled&&!failure&&!currentSessions.some(s=>s.recoveryCandidate);
 const conflict=currentSessions.some(s=>s.conflict);
 const status=failure?'保存失败':conflict?'冲突草稿已保留':pending?'保存中…':enabled?'已保存':'未启用';
 const recovery=[...sessions.values()].filter(s=>s.loaded&&s.recoveryCandidate&&sameInkPaper(s.ref,bridge.current()));
 function restore(s){if(isInkLocked())return;try{collect(true);restoreRecovery(s,s.recoveryCandidate);for(const item of mounted.values())if(item.session===s){const saved=s.document.pages[item.geometry.page];if(saved)loadSnapshot(item.editor.store,{document:saved.snapshot});}s.recoveryCandidate=null;remember(s);for(const item of mounted.values())configureEditor(item);refresh();scheduleSave();bridge.toast('已恢复本机未保存草稿，正在保存');}catch(e){bridge.toast(e.message,7000);}}
 function useDisk(s){if(isInkLocked())return;try{archiveRecovery(s,localStorage,crypto.randomUUID());for(const item of mounted.values())configureEditor(item);refresh();bridge.toast('草稿已另存本机备份，继续使用磁盘版；可通过“导出”取回',7000);}catch(e){bridge.toast('请先导出草稿：'+e.message,7000);}}
 function choose(id){if(id!=='read'&&!canDraw){setShowLicense(!enabled);if(failure)bridge.toast('请先导出草稿并重新打开文献，原墨迹已保留',6000);else if(enabled)bridge.toast('请先处理恢复草稿，再继续编辑墨迹',5000);return;}selectTool(id);}
 const groups=new Map();for(const row of rows){
  // Keep live editor history; cold blank pages need no SDK until an ink tool is chosen.
  if(tool==='read'&&!mounted.has(row.key)&&!Object.values(row.session.document.pages[row.geometry.page]?.snapshot?.store||{}).some(record=>record.typeName==='shape'))continue;
  const id=row.pane.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);
 }
 return <>
  <div className="dpr-ink-toolbar" role="toolbar" aria-label="墨迹与阅读工具">
   <div className="dpr-ink-heading"><span className="dpr-ink-brand"><span>纸间</span><small>INK</small></span><button type="button" className="dpr-ink-toggle" aria-expanded={!collapsed} aria-controls="dpr-ink-body" onClick={()=>setCollapsed(v=>!v)}>{collapsed?'展开笔记工具':'收起笔记工具'}</button></div>
   <div className="dpr-ink-body" id="dpr-ink-body" hidden={collapsed}>
   <div className="dpr-ink-tools">{tools.map(([id,label,path])=><button key={id} type="button" data-ink-tool={id} aria-label={label} title={id==='read'?'文字选择 · 划词问 AI':label} aria-pressed={tool===id} onClick={()=>choose(id)}><Icon path={path}/><span>{label}</span></button>)}</div>
   <span className="dpr-ink-divider"/>
   <div className="dpr-ink-settings"><div className="dpr-ink-colors" aria-label="墨迹颜色">{colors.map(([id,hex,label])=><button key={id} aria-label={label} title={label} aria-pressed={color===id} style={{'--ink-swatch':hex}} onClick={()=>{if(isInkLocked())return;color=id;for(const m of mounted.values())m.editor.setStyleForNextShapes(DefaultColorStyle,color);refresh();}} />)}</div>
   <select aria-label="墨迹笔宽" value={size} onChange={e=>{if(isInkLocked())return;size=e.target.value;for(const m of mounted.values())m.editor.setStyleForNextShapes(DefaultSizeStyle,size);refresh();}}><option value="s">细</option><option value="m">中</option><option value="l">粗</option></select>
   </div></div>
  </div>
  {createPortal(<div className="dpr-ink-actions">
   <div className="dpr-ink-history"><button title="撤销墨迹" aria-label="撤销墨迹" onClick={()=>{if(isInkLocked())return;active?.editor.undo();changed();}}>↶</button><button title="重做墨迹" aria-label="重做墨迹" onClick={()=>{if(isInkLocked())return;active?.editor.redo();changed();}}>↷</button></div>
   <span className={'dpr-ink-status'+(failure||conflict?' is-error':'')} role="status" title="墨迹独立保存，不修改 PDF">{status}</span>
   <button className="dpr-ink-save" onClick={()=>void saveAll().catch(()=>{})}>保存</button>
   <details ref={morePanel} className="dpr-ink-more" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.currentTarget.open=false;e.currentTarget.querySelector('summary').focus();}}}>
    <summary aria-label="墨迹选项">墨迹选项</summary>
    <div>
     <button title="导出墨迹草稿（不含 PDF）" onClick={e=>{e.currentTarget.closest('details').open=false;collect();download('论文墨迹草稿.json',{format:'dpr-ink-backup',version:1,documents:[...sessions.values()].map(s=>s.recovery()),archivedDrafts:Object.keys(localStorage).filter(k=>k.startsWith('dpr.ink.archive.')).map(k=>{try{return JSON.parse(localStorage.getItem(k));}catch{return {format:'dpr-ink-raw-backup',raw:localStorage.getItem(k)};}}).filter(Boolean)});}}>导出墨迹</button>
     <button title="配置 tldraw 许可" aria-label="墨迹许可" onClick={e=>{e.currentTarget.closest('details').open=false;setShowLicense(!showLicense);}}>许可设置</button>
    </div>
   </details>
  </div>,document.getElementById('ink-actions'))}
  {recovery.map(s=><div key={refKey(s.ref)} className="dpr-ink-recovery" role="status"><span>发现本机未保存墨迹草稿 · {s.ref.variant}</span><button onClick={()=>restore(s)}>恢复草稿</button><button onClick={()=>download('墨迹恢复草稿.json',s.recoveryCandidate)}>导出草稿</button><button onClick={()=>useDisk(s)}>保留磁盘版继续</button><small>{s.recoveryCandidate.revision===s.revision?'磁盘版本一致，可恢复继续编辑':'磁盘已有其他版本，请先导出并核对'}</small></div>)}
  {showLicense&&<form ref={licensePanel} className="dpr-ink-license" onSubmit={e=>{e.preventDefault();if(isInkLocked())return;const key=licenseDraft.trim();if(!key){bridge.toast('请粘贴已获授权的 tldraw license key');return;}try{localStorage.setItem(keyName,key);}catch{bridge.toast('许可保存失败，请检查站点存储权限');return;}collect();setKey(key);setDraft('');setShowLicense(false);bridge.toast('许可已提交 SDK 校验；授权状态以画布提示为准',5000);}}><strong>本机墨迹许可</strong><label>tldraw license key<input type="password" autoComplete="off" value={licenseDraft} onChange={e=>setDraft(e.target.value)} placeholder={licenseKey?'已配置；填入新 key 可更新':'粘贴已取得的许可 key'} /></label><button type="submit">保存许可</button><button type="button" onClick={()=>setShowLicense(false)}>取消</button><small>仅保存在此 DSH 页面来源的本机存储中，交由 SDK 校验。保留授权水印。</small></form>}
  {enabled&&[...groups].map(([id,list])=>createPortal(<div key={id} className="dpr-ink-pane" style={{left:list[0].paneRect.left,top:list[0].paneRect.top,width:list[0].pane.clientWidth,height:list[0].pane.clientHeight}}>{list.map(row=><PageInk key={row.key} row={row} licenseKey={licenseKey}/>)}</div>,document.body))}
 </>;
}
const host=document.createElement('div');host.id='dpr-ink-controls';document.getElementById('reader-tools').before(host);createRoot(host).render(<App/>);
