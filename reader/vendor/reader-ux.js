/* Native PDF annotation controls. Geometry stays in PDF user space. */
(() => {
  const style = document.createElement('style');
  style.textContent = `
    #reader-tools{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid var(--border);background:var(--panel);flex:none;flex-wrap:wrap;font-size:12px}
    #reader-tools select,#reader-tools input{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:3px}
    #annotation-color{width:32px;height:27px;padding:1px!important}#annotation-width{width:45px}
    #annotation-panel{position:fixed;z-index:45;right:12px;top:112px;width:min(310px,85vw);max-height:75vh;overflow:auto;padding:12px;background:var(--panel);border:1px solid var(--border);border-radius:9px;box-shadow:0 6px 24px #0003;font-size:12px;display:none}
    #annotation-panel.on{display:block}#annotation-panel textarea{box-sizing:border-box;width:100%;min-height:65px;margin:8px 0;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:6px}
    #annotation-list{margin-top:8px;max-height:30vh;overflow:auto}#annotation-list button{display:block;width:100%;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0;padding:7px;border:1px solid var(--border);border-radius:5px;color:var(--text);background:var(--bg);cursor:pointer}
    #annotation-status{color:var(--text-2);margin:8px 0;line-height:1.5}#annotation-panel .actions{display:flex;gap:5px;flex-wrap:wrap}
    .dpr-grab,.dpr-grab .textLayer :is(span,br){cursor:grab!important;user-select:none!important}.dpr-grabbing,.dpr-grabbing .textLayer :is(span,br){cursor:grabbing!important;user-select:none!important}
    .dpr-preview{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:visible}
  `;
  document.head.appendChild(style);
  const tools = document.createElement('div'); tools.id = 'reader-tools';
  tools.innerHTML = `<label>交互 <select id="interaction-mode" aria-label="交互模式"><option value="select">选取</option><option value="move">移动</option></select></label>
    <label>工具 <select id="annotation-tool" aria-label="阅读工具"><option value="none">询问 AI（默认）</option><option value="select-mark">选择标记（Delete 删除）</option><option value="highlight">文本高亮</option><option value="underline">下划线</option><option value="ink">墨迹笔</option><option value="marker">荧光笔</option><option value="rectangle">矩形</option><option value="ellipse">椭圆</option><option value="line">直线</option><option value="arrow">箭头</option><option value="note">便笺笔记</option><option value="freetext">插入文字批注</option></select></label>
    <input id="annotation-color" type="color" value="#ffc400" aria-label="批注颜色" title="批注颜色">
    <label>笔宽 <input id="annotation-width" type="number" min="1" max="20" value="2" aria-label="笔宽（PDF 点）"></label>
    <button id="annotation-undo" class="tbtn" title="撤销 Ctrl+Z">撤销</button><button id="annotation-redo" class="tbtn" title="重做 Ctrl+Shift+Z / Ctrl+Y">重做</button><button id="annotation-open" class="tbtn">批注列表</button><span style="color:var(--text-2)">选取模式：空格＋拖动平移</span>`;
  $('main').before(tools);
  const panel = document.createElement('aside'); panel.id='annotation-panel';panel.setAttribute('aria-label','PDF 批注编辑');
  panel.innerHTML=`<div style="display:flex;align-items:center"><strong>PDF 批注</strong><span class="spacer"></span><button id="annotation-close" class="tbtn" aria-label="关闭批注面板">✕</button></div>
    <div id="annotation-status" role="status">打开文献后加载批注</div><textarea id="annotation-note" placeholder="笔记／插入的文字；图形也可附加说明" aria-label="批注内容" maxlength="10000"></textarea>
    <div class="actions"><button id="annotation-save" class="tbtn">保存到 PDF</button><button id="annotation-delete" class="tbtn">删除批注</button><button id="annotation-cancel" class="tbtn">取消编辑</button></div><div id="annotation-list">暂无批注</div>`;
  document.body.appendChild(panel);
  const states = new Map(), histories = new Map(); let draft=null, target=null, saving=false, space=false, gesture=null, suppressMouseUntil=0;
  function history(ref){const key=keyOf(ref);if(!histories.has(key))histories.set(key,{undo:[],redo:[]});return histories.get(key);}
  function historyButtons(){const h=target&&history(target);$('annotation-undo').disabled=saving||!h?.undo.length;$('annotation-redo').disabled=saving||!h?.redo.length;}
  const labels={highlight:'高亮',underline:'下划线',ink:'墨迹',marker:'荧光笔',rectangle:'矩形',ellipse:'椭圆',line:'直线',arrow:'箭头',note:'笔记',freetext:'文字批注'};
  const editable = el => !!el?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]');
  const mode = () => $('interaction-mode').value;
  const tool = () => $('annotation-tool').value;
  const descriptor = page => {
    if (!current) return null;
    const variant = page?.dataset.doc === 'zh' ? 'zh' : zhVariant;
    return { ...(current.paperId?{paperId:current.paperId}:{}), topic:current.topic, name:current.name, variant:variant || 'orig' };
  };
  const keyOf = ref => JSON.stringify([ref.paperId||[ref.topic,ref.name],ref.variant]);
  const status = text => { $('annotation-status').textContent=text; };
  function state(ref) { return states.get(keyOf(ref)); }
  function load(ref) {
    const key=keyOf(ref), old=states.get(key);
    if(old?.loading) return old.ready;
    if(old?.version) return Promise.resolve();
    const entry={loading:true,version:null,items:[]};states.set(key,entry);
    for(const id of ['annotation-save','annotation-delete'])$(id).disabled=true;
    entry.ready=(async()=>{
      try {
        const q=new URLSearchParams(ref);const result=await api('/annotations?'+q);
        Object.assign(entry,result,{loading:false});
        if(target && keyOf(target)===key)for(const id of ['annotation-save','annotation-delete'])$(id).disabled=saving;
        if(target && keyOf(target)===key){renderList();if(!draft)status('标记完成即保存；便笺／文字批注单独输入，首次保存自动备份');}
      }catch(error){entry.loading=false;entry.error=error.message;if(target&&keyOf(target)===key)status('批注加载失败：'+error.message);}
    })();
    return entry.ready;
  }
  // Saved PDFs are invalidated across reader frames; payloads never carry note contents.
  const pendingUpdates=new Map();let refreshing=false;
  const updates=typeof BroadcastChannel==='function'?new BroadcastChannel('dpr.pdf-annotations.v1'):null;
  function announce(ref,page){if(ref.paperId)updates?.postMessage({type:'saved',ref:{paperId:ref.paperId,variant:ref.variant},page});}
  function queueUpdate(message){
    const ref=message?.ref;if(message?.type!=='saved'||!ref?.paperId||ref.paperId!==current?.paperId||!['orig','zh','dual'].includes(ref.variant)||!Number.isInteger(message.page)||message.page<1)return;
    const canonical={...descriptor(),paperId:ref.paperId,variant:ref.variant},key=keyOf(canonical),row=pendingUpdates.get(key)||{ref:canonical,pages:new Set()};row.pages.add(message.page);pendingUpdates.set(key,row);void refreshRemote();
  }
  async function refreshRemote(){
    if(refreshing||saving||draft||gesture||window.DprInk?.remoteUpdateBlocked?.()||window.DprReaderInkBridge?.syncBlocked?.())return;
    refreshing=true;
    try{for(const [key,row] of pendingUpdates){
      if(saving||draft||gesture||window.DprInk?.remoteUpdateBlocked?.()||window.DprReaderInkBridge?.syncBlocked?.())break;
      const expected=current,entry=states.get(key);if(!expected||expected.paperId!==row.ref.paperId){pendingUpdates.delete(key);continue;}
      const result=await api('/annotations?'+new URLSearchParams({paperId:row.ref.paperId,variant:row.ref.variant}));
      if(current!==expected||saving||draft||gesture||window.DprInk?.remoteUpdateBlocked?.())continue;
      if(entry?.version===result.version){pendingUpdates.delete(key);continue;}
      saving=true;historyButtons();
      try{
        // A hidden language variant is invalidated now and fetched when displayed.
        const shown=viewMode==='split'?['orig','zh']:[zhVariant||'orig'];
        if(shown.includes(row.ref.variant))for(const page of [...row.pages])await reload(row.ref,result,page);
        if(current!==expected)continue;
        states.set(key,result);histories.delete(key);pendingUpdates.delete(key);renderList();status('已同步其他阅读页的 PDF 批注，可继续编辑');
      }finally{saving=false;historyButtons();}
    }}catch{status('批注同步暂未完成，当前草稿保留；重新聚焦后重试');}
    finally{refreshing=false;}
  }
  if(updates)updates.onmessage=event=>queueUpdate(event.data);
  window.addEventListener('focus',()=>{if(current?.paperId)for(const variant of(viewMode==='split'?['orig','zh']:[zhVariant||'orig']))queueUpdate({type:'saved',ref:{paperId:current.paperId,variant},page:Math.max(1,curPage)});});
  document.addEventListener('pointerup',()=>{setTimeout(()=>void refreshRemote(),0);},true);
  window.addEventListener('pagehide',()=>updates?.close());
  function setTarget(ref) {
    if(!ref) return;
    if(draft && target && keyOf(target)!==keyOf(ref))return;
    target=ref;panel.setAttribute('aria-label', `PDF 批注：${ref.name} · ${ref.variant}`);void load(ref);renderList();historyButtons();
  }
  function renderList() {
    const list=$('annotation-list');list.replaceChildren();
    const items=target ? state(target)?.items || [] : [];
    if(!items.length){list.textContent='暂无批注';return;}
    for(const item of items){
      const b=document.createElement('button');b.type='button';
      b.textContent=`第 ${item.page} 页 · ${labels[item.type]||item.type}${item.note?' — '+item.note:''}`;
      b.style.borderLeft=`4px solid ${/^#[0-9a-f]{6}$/i.test(item.color)?item.color:'#aaa'}`;
      b.onclick=()=>{
        if(saving)return;
        if(draft && draft.id!==item.id){toast('请先保存或取消当前批注',4000);return;}
        draft=structuredClone(item);$('annotation-note').value=item.note||'';$('annotation-color').value=item.color;$('annotation-width').value=item.width;
        panel.classList.add('on');status('编辑后点“保存到 PDF”；删除仅影响当前批注');jumpToPage(item.page);preview();
      };list.appendChild(b);
    }
  }
  function syncCursor(){for(const id of ['pdf-pane','pdf-pane-zh'])$(id).classList.toggle('dpr-grab',mode()==='move'||space);}
  function clearPreview(){document.querySelectorAll('.dpr-preview').forEach(n=>n.remove());}
  function cancelDraft(){draft=null;$('annotation-note').value='';clearPreview();status('编辑已取消；PDF 未改变');void refreshRemote();}
  function toPdf(page,x,y){const box=page.getBoundingClientRect(),vp=page._dprViewport;return vp.convertToPdfPoint((x-box.left)*vp.width/box.width,(y-box.top)*vp.width/box.width);}
  function toView(vp,p){const[a,b,c,d,e,f]=vp.transform;return[a*p[0]+c*p[1]+e,b*p[0]+d*p[1]+f];}
  function rectOf(points){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const r=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];if(r[0]===r[2])r[2]+=.1;if(r[1]===r[3])r[3]+=.1;return r;}
  function newItem(page,kind,rects,points=[]){
    return{id:'dpr-'+Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join(''),page:+page.dataset.page,type:kind,color:$('annotation-color').value,width:Math.max(1,Math.min(20,+$('annotation-width').value||2)),opacity:kind==='highlight'?.35:kind==='marker'?.3:1,rects,points,note:''};
  }
  function beginDraft(page,item){
    if(saving)return;
    setTarget(descriptor(page));draft=item;$('annotation-note').value=item.note||'';preview();
    if(['note','freetext'].includes(item.type)){
      panel.classList.add('on');status('输入文字后保存到 PDF');$('annotation-note').focus();
    }else{
      panel.classList.remove('on');void save(false,true);
    }
  }
  function preview(){
    clearPreview();if(!draft||!target)return;
    const page=[...document.querySelectorAll('.page')].find(p=>+p.dataset.page===draft.page&&keyOf(descriptor(p))===keyOf(target));
    if(!page?._dprViewport)return;
    const vp=page._dprViewport, ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.classList.add('dpr-preview');svg.setAttribute('viewBox',`0 0 ${vp.width} ${vp.height}`);svg.style.width=vp.width+'px';svg.style.height=vp.height+'px';
    const color=$('annotation-color').value;
    const append=(tag,attrs)=>{const el=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));svg.appendChild(el);};
    if(['ink','marker','line','arrow'].includes(draft.type)){
      const pts=draft.points.map(p=>toView(vp,p));append('polyline',{points:pts.map(p=>p.join(',')).join(' '),stroke:color,'stroke-width':+$('annotation-width').value*vp.scale,'stroke-linecap':'round','stroke-linejoin':'round',fill:'none',opacity:draft.opacity});
    }else for(const r of draft.rects){
      const v=[...toView(vp,r.slice(0,2)),...toView(vp,r.slice(2))],x=Math.min(v[0],v[2]),y=Math.min(v[1],v[3]),w=Math.abs(v[2]-v[0]),h=Math.abs(v[3]-v[1]);
      if(draft.type==='ellipse')append('ellipse',{cx:x+w/2,cy:y+h/2,rx:w/2,ry:h/2,stroke:color,'stroke-width':2,fill:'none'});
      else if(draft.type==='underline')append('line',{x1:x,y1:y+h,x2:x+w,y2:y+h,stroke:color,'stroke-width':2});
      else append('rect',{x,y,width:w,height:h,stroke:color,'stroke-width':1,fill:draft.type==='highlight'?color:'none',opacity:draft.type==='highlight'?.35:1});
    }page.appendChild(svg);
  }
  async function reload(ref,result,pageNumber){
    const originalMode=viewMode, split=originalMode==='split',isZh=split&&ref.variant==='zh';
    const oldDoc=isZh?pdfDocZh:pdfDoc,box=$(isZh?'pdf-pages-zh':'pdf-pages'),pane=$(isZh?'pdf-pane-zh':'pdf-pane');
    const url=pdfUrl(ref.variant==='orig'?null:ref.variant)+'&dpr_revision='+encodeURIComponent(result.version);
    const fresh=await pdfjsLib.getDocument({url}).promise;let installed=false;
    try{
      if(!current||current.topic!==ref.topic||current.name!==ref.name||viewMode!==originalMode||(isZh?pdfDocZh:pdfDoc)!==oldDoc)throw new Error('文献或视图已切换');
      const boxes=split?[[$('pdf-pages'),pdfDoc],[$('pdf-pages-zh'),pdfDocZh]]:[[box,oldDoc]];
      if(boxes.some(([b,d])=>d&&b.children.length!==(pageMode==='paged'?1:d.numPages)))throw new Error('页面布局仍在加载，请稍后同步已保存的标记');
      const token=++renderToken,div=[...box.children].find(p=>+p.dataset.page===pageNumber),scale=zoomScale;
      if(div){
        const page=await fresh.getPage(pageNumber);if(token!==renderToken)throw new Error('页面已改变');
        const viewport=page.getViewport({scale}),replacement=makePageNode(pageNumber,viewport,isZh?'zh':'orig'),stage=document.createElement('div');
        Object.assign(stage.style,{position:'fixed',left:'-100000px',top:'0',visibility:'hidden',pointerEvents:'none'});stage.appendChild(replacement);document.body.appendChild(stage);
        try{
          await paintPage(page,replacement,viewport,token,false);
          if(token!==renderToken||!div.isConnected||viewMode!==originalMode)throw new Error('页面已改变');
          const before=div.getBoundingClientRect();div.style.width=viewport.width+'px';div.style.zoom='1';div._dprViewport=viewport;div.replaceChildren(...replacement.childNodes);div._dprPainted=true;
          const after=div.getBoundingClientRect();pane.scrollLeft+=after.left-before.left;pane.scrollTop+=after.top-before.top;
          normalizeTextReadingOrder(div.querySelector('.textLayer'),viewport);paintEqLayer(div,viewport,pageNumber);
        }finally{stage.remove();}
      }
      if(isZh)pdfDocZh=fresh;else{pdfDoc=fresh;findReset();}
      for(const node of box.children)node._dprDocument=fresh;
      installed=true;if(div)document.dispatchEvent(new CustomEvent('dpr-page-painted',{detail:{page:div}}));
      try{findReapply();}catch{}
      await oldDoc?.destroy?.();
    }finally{if(!installed)await fresh.destroy?.();}
  }
  async function save(deleting=false,automatic=false){
    if(saving||!draft||!target)return;
    if(deleting && !state(target)?.items.some(i=>i.id===draft.id)){cancelDraft();return;}
    const ref={...target};
    const item={...draft,note:$('annotation-note').value,color:$('annotation-color').value,width:Math.max(1,Math.min(20,+$('annotation-width').value||2))};
    let committed=false;
    saving=true;for(const id of ['annotation-save','annotation-delete'])$(id).disabled=true;status('正在保存 PDF…');
    try{
      await load(ref);
      const entry=state(ref);if(!entry?.version)throw new Error('尚未加载 PDF 版本，请稍后重试');
      const before=entry.items.find(i=>i.id===item.id)||null;
      const result=await api('/annotations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...ref,version:entry.version,...(deleting?{action:'delete',id:item.id}:{action:'upsert',item})})});
      const after=deleting?null:(result.items.find(i=>i.id===item.id)||item);
      const h=history(ref);h.undo.push({before:before&&structuredClone(before),after:after&&structuredClone(after),id:item.id});if(h.undo.length>100)h.undo.shift();h.redo=[];
      committed=true;states.set(keyOf(ref),result);draft=null;$('annotation-note').value='';clearPreview();renderList();announce(ref,item.page);
      // A page switch while saving must not reload the wrong paper.
      if(current&&current.topic===ref.topic&&current.name===ref.name)await reload(ref,result,item.page);
      status(deleting?'已删除并保存到 PDF':'已保存到 PDF（首次原始备份已保留）');
    }catch(error){
      const message=committed ? '已保存到 PDF，但页面刷新失败，请重开文献：'+error.message : '保存失败：'+error.message+'。草稿保留；如 PDF 已被外部修改，请重开文献后核对再保存。';
      status(message);if(automatic)toast(message+' 可打开批注列表重试或取消。',7000);
    }finally{saving=false;for(const id of ['annotation-save','annotation-delete'])$(id).disabled=false;historyButtons();void refreshRemote();}
  }
  async function applyHistory(redo=false){
    if(saving||!target)return;
    if(draft){toast('请先保存或取消当前批注',4000);return;}
    const ref={...target},h=history(ref),from=redo?h.redo:h.undo,to=redo?h.undo:h.redo,record=from.at(-1);
    if(!record)return;
    const entry=state(ref),item=redo?record.after:record.before;
    if(!entry?.version){toast('PDF 版本尚未加载',4000);return;}
    saving=true;historyButtons();for(const id of ['annotation-save','annotation-delete'])$(id).disabled=true;
    try{
      const result=await api('/annotations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...ref,version:entry.version,...(item?{action:'upsert',item}:{action:'delete',id:record.id})})});
      from.pop();to.push(record);states.set(keyOf(ref),result);renderList();announce(ref,(record.after||record.before).page);
      try{if(current&&current.topic===ref.topic&&current.name===ref.name)await reload(ref,result,(record.after||record.before).page);status(redo?'已重做并保存到 PDF':'已撤销并保存到 PDF');}
      catch(error){toast('操作已写入 PDF，但刷新失败，请重新打开文献：'+error.message,7000);}
    }catch(error){status('操作失败：'+error.message+'；请检查 PDF 是否被外部修改。');toast('操作未确认，请检查 PDF 后重试',6000);}
    finally{saving=false;for(const id of ['annotation-save','annotation-delete'])$(id).disabled=false;historyButtons();void refreshRemote();}
  }
  $('annotation-undo').onclick=()=>applyHistory(false);$('annotation-redo').onclick=()=>applyHistory(true);
  $('annotation-open').onclick=()=>{panel.classList.toggle('on');setTarget(descriptor());};
  $('annotation-close').onclick=()=>panel.classList.remove('on');
  $('annotation-cancel').onclick=cancelDraft;$('annotation-save').onclick=()=>save();$('annotation-delete').onclick=()=>save(true);
  for(const id of ['annotation-color','annotation-width'])$(id).addEventListener('input',preview);
  $('interaction-mode').onchange=()=>{finishGesture();syncCursor();if(mode()==='move'){window.getSelection()?.removeAllRanges();askPop.style.display='none';hideTrPop();invalidateTranslate();}};
  $('annotation-tool').onchange=()=>{
    finishGesture();window.getSelection()?.removeAllRanges();askPop.style.display='none';hideTrPop();invalidateTranslate();
    if(tool()!=='none'){$('interaction-mode').value='select';syncCursor();}
  };
  document.addEventListener('keydown',e=>{
    if(window.DprInk?.ownsTool?.())return;
    if(!editable(e.target)&&!e.altKey&&(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){
      e.preventDefault();e.stopImmediatePropagation();void applyHistory(e.key.toLowerCase()==='y'||e.shiftKey);return;
    }
    if(!editable(e.target)&&e.key==='Delete'&&tool()==='select-mark'&&draft){e.preventDefault();void save(true);return;}
    if(e.code==='Space'&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!editable(e.target)){
      e.preventDefault();space=true;syncCursor();
    }
    if(e.key==='Escape'&&gesture)finishGesture();
  },true);
  document.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;syncCursor();}},true);
  window.addEventListener('blur',()=>{space=false;finishGesture();syncCursor();});
  function finishGesture(){
    if(gesture){gesture.pane.classList.remove('dpr-grabbing');try{gesture.pane.releasePointerCapture(gesture.id);}catch{}gesture=null;suppressMouseUntil=Date.now()+80;}
  }
  document.addEventListener('pointerdown',e=>{
    if(window.DprInk?.ownsTool?.()||e.button!==0||editable(e.target))return;
    const pane=e.target.closest?.('#pdf-pane,#pdf-pane-zh');if(!pane)return;
    const page=e.target.closest('.page');
    if(mode()==='move'||space){
      e.preventDefault();e.stopImmediatePropagation();window.getSelection()?.removeAllRanges();
      gesture={kind:'pan',pane,id:e.pointerId,x:e.clientX,y:e.clientY,left:pane.scrollLeft,top:pane.scrollTop};pane.setPointerCapture(e.pointerId);pane.classList.add('dpr-grabbing');return;
    }
    if(page?._dprViewport&&tool()==='select-mark'){
      e.preventDefault();e.stopImmediatePropagation();
      const ref=descriptor(page);if(draft&&target&&keyOf(target)!==keyOf(ref)){toast('请先保存或取消当前批注',4000);return;}
      setTarget(ref);const [x,y]=toPdf(page,e.clientX,e.clientY),pad=6/page._dprViewport.scale;
      const item=[...(state(ref)?.items||[])].reverse().find(i=>i.page===+page.dataset.page&&i.rects.some(r=>x>=Math.min(r[0],r[2])-pad&&x<=Math.max(r[0],r[2])+pad&&y>=Math.min(r[1],r[3])-pad&&y<=Math.max(r[1],r[3])+pad));
      if(item){draft=structuredClone(item);$('annotation-note').value=item.note||'';$('annotation-color').value=item.color;$('annotation-width').value=item.width;preview();toast('已选择标记，按 Delete 删除',3000);}
      else {cancelDraft();toast('未找到可选的本阅读器标记',2500);}
      return;
    }
    if(!page?._dprViewport||['none','highlight','underline'].includes(tool())||saving)return;
    if(draft){e.preventDefault();toast('请先保存或取消当前批注',4000);return;}
    e.preventDefault();e.stopImmediatePropagation();window.getSelection()?.removeAllRanges();
    const first=toPdf(page,e.clientX,e.clientY);gesture={kind:'draw',pane,page,id:e.pointerId,tool:tool(),points:[first]};pane.setPointerCapture(e.pointerId);
  },true);
  document.addEventListener('pointermove',e=>{
    if(!gesture||e.pointerId!==gesture.id)return;
    e.preventDefault();
    if(gesture.kind==='pan'){gesture.pane.scrollLeft=gesture.left-e.clientX+gesture.x;gesture.pane.scrollTop=gesture.top-e.clientY+gesture.y;return;}
    const p=toPdf(gesture.page,e.clientX,e.clientY);if(gesture.points.length<10000){if(['ink','marker'].includes(gesture.tool))gesture.points.push(p);else gesture.points[1]=p;}
    const rect=rectOf(gesture.points);if(rect[0]===rect[2])rect[2]+=.1;if(rect[1]===rect[3])rect[3]+=.1;
    setTarget(descriptor(gesture.page));draft=newItem(gesture.page,gesture.tool,[rect],gesture.points);preview();
  },true);
  document.addEventListener('pointerup',e=>{
    if(!gesture||e.pointerId!==gesture.id)return;
    const g=gesture;
    if(g.kind==='draw'){
      let end=toPdf(g.page,e.clientX,e.clientY);if(g.points.length===1)g.points.push(end);
      let rect=rectOf(g.points);
      if(['note','freetext'].includes(g.tool)&&Math.abs(rect[2]-rect[0])+Math.abs(rect[3]-rect[1])<5){rect=[end[0],end[1]-50,end[0]+150,end[1]];}
      if(Math.abs(rect[2]-rect[0])+Math.abs(rect[3]-rect[1])>2)beginDraft(g.page,newItem(g.page,g.tool,[rect],g.points));else{draft=null;clearPreview();}
    }finishGesture();
  },true);
  document.addEventListener('pointercancel',finishGesture,true);
  document.addEventListener('mouseup',e=>{
    if(Date.now()<suppressMouseUntil||mode()==='move'||space){e.stopImmediatePropagation();return;}
    if(!e.target.closest?.('.page')||tool()==='none')return;
    e.stopImmediatePropagation();
    if(!['highlight','underline'].includes(tool())||saving)return;
    if(draft){toast('请先保存或取消当前批注',4000);return;}
    const selection=window.getSelection();if(!selection?.rangeCount||!selection.toString().trim())return;
    const range=selection.getRangeAt(0),start=range.startContainer.parentElement?.closest('.page'),end=range.endContainer.parentElement?.closest('.page');
    // Reject cross-document/page ranges rather than silently clipping them.
    if(!start||start!==end||!start._dprViewport){toast('请在同一页内选择要批注的文字',4000);return;}
    const pageBox=start.getBoundingClientRect();
    // Range may return both a span box and its text box; merge same-line overlap
    // before writing QuadPoints, otherwise native PDF viewers darken overlaps twice.
    const boxes=[];
    for(const r of [...range.getClientRects()].filter(r=>r.width>1&&r.height>1&&r.left>=pageBox.left-1&&r.right<=pageBox.right+1)){
      const old=boxes.find(b=>Math.min(b.bottom,r.bottom)-Math.max(b.top,r.top)>=Math.min(b.bottom-b.top,r.height)*.7&&r.left<=b.right+1&&r.right>=b.left-1);
      if(old){old.left=Math.min(old.left,r.left);old.right=Math.max(old.right,r.right);old.top=Math.min(old.top,r.top);old.bottom=Math.max(old.bottom,r.bottom);}
      else boxes.push({left:r.left,right:r.right,top:r.top,bottom:r.bottom});
    }
    const rects=boxes.map(r=>[...toPdf(start,r.left,r.top),...toPdf(start,r.right,r.bottom)]);
    if(!rects.length)return;e.stopImmediatePropagation();
    beginDraft(start,newItem(start,tool(),rects));window.getSelection().removeAllRanges();
  },true);
  document.addEventListener('dpr-page-painted',e=>{if(!draft)setTarget(descriptor(e.detail.page));preview();});
  window.addEventListener('beforeunload',e=>{if(draft||saving){e.preventDefault();e.returnValue='批注尚未保存';}});
  // The initial PDF can finish before this asset loads.
  for(const page of document.querySelectorAll('.page'))if(page._dprViewport)setTarget(descriptor(page));
  syncCursor();
})();
