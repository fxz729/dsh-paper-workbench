/* Keep painted pages in place while zooming; replace only a ready visible raster. */
let zoomRasterTimer = null, zoomRasterBusy = false, zoomRasterPending = false;
function zoomColumns() {
  const columns=[{pane:$('pdf-pane'),box:$('pdf-pages'),doc:pdfDoc,key:'orig'}];
  if(viewMode==='split'&&pdfDocZh)columns.push({pane:$('pdf-pane-zh'),box:$('pdf-pages-zh'),doc:pdfDocZh,key:'zh'});
  return columns;
}
function zoomAnchor(column,point) {
  const box=column.pane.getBoundingClientRect();
  const x=point?.pane===column.pane?point.x:box.left+column.pane.clientWidth/2;
  const y=point?.pane===column.pane?point.y:box.top+column.pane.clientHeight/2;
  const pages=[...column.box.children].filter(p=>p._dprViewport);
  const page=pages.find(p=>{const r=p.getBoundingClientRect();return r.top<=y&&r.bottom>=y;})||pages.reduce((a,p)=>Math.abs(p.getBoundingClientRect().top-y)<Math.abs(a.getBoundingClientRect().top-y)?p:a,pages[0]);
  if(!page)return null;
  const r=page.getBoundingClientRect();
  return {page,x,y,nx:(x-r.left)/r.width,ny:(y-r.top)/r.height};
}
function restoreZoomAnchor(column,a) {
  if(!a?.page.isConnected)return;
  const r=a.page.getBoundingClientRect();
  column.pane.scrollLeft+=r.left+r.width*a.nx-a.x;
  column.pane.scrollTop+=r.top+r.height*a.ny-a.y;
}
function queueZoomRaster() {
  clearTimeout(zoomRasterTimer);
  const token=renderToken;
  zoomRasterTimer=setTimeout(()=>{
    zoomRasterTimer=null;
    if(token!==renderToken)return;
    if(zoomRasterBusy){zoomRasterPending=true;return;}
    zoomRasterBusy=true;zoomRasterPending=false;
    void sharpenZoom(token).catch(e=>{
      if(token===renderToken)toast('缩放画面已保留，清晰化失败：'+e.message,5000);
    }).finally(()=>{
      zoomRasterBusy=false;
      if(zoomRasterPending){zoomRasterPending=false;queueZoomRaster();}
    });
  },140);
}
function stablePdfZoom(scale,point) {
  const columns=zoomColumns();
  // Initial loading, paper changes and mode changes still use the normal renderer.
  if(columns.some(c=>!c.pane.clientHeight||c.box.children.length!==(pageMode==='paged'?1:c.doc.numPages)||[...c.box.children].some(p=>p._dprDocument!==c.doc)))return false;
  ++renderToken; // Discard stale high-resolution work, never discard visible content.
  crafFn(splitRaf);splitRaf=0;
  const anchors=columns.map(c=>zoomAnchor(c,point));
  splitSyncing=true;
  columns.forEach(c=>{
    c.pane.style.overflowAnchor='none';
    for(const p of c.box.children)p.style.zoom=String(scale/p._dprViewport.scale);
  });
  columns.forEach((c,i)=>restoreZoomAnchor(c,anchors[i]));
  requestAnimationFrame(()=>{splitSyncing=false;});
  $('zoom-label').textContent=Math.round(scale/1.5*100)+'%';
  queueZoomRaster();
  return true;
}
async function sharpenZoom(token) {
  const scale=zoomScale;
  const candidates=[];
  for(const column of zoomColumns()){
    const box=column.pane.getBoundingClientRect();
    for(const div of column.box.children){
      const r=div.getBoundingClientRect();
      if(div._dprViewport?.scale!==scale&&r.bottom>=box.top-box.height/2&&r.top<=box.bottom+box.height/2)candidates.push({column,div,distance:Math.abs((r.top+r.bottom-box.top-box.bottom)/2)});
    }
  }
  candidates.sort((a,b)=>a.distance-b.distance);
  for(const {column,div} of candidates){
    if(token!==renderToken||!div.isConnected||column.doc!==div._dprDocument)return;
    const page=await column.doc.getPage(+div.dataset.page);
    if(token!==renderToken)return;
    const viewport=page.getViewport({scale}),replacement=makePageNode(+div.dataset.page,viewport,column.key);
    const stage=document.createElement('div');
    Object.assign(stage.style,{position:'fixed',left:'-100000px',top:'0',visibility:'hidden',pointerEvents:'none'});
    stage.appendChild(replacement);document.body.appendChild(stage);
    try{
      await paintPage(page,replacement,viewport,token,false);
      if(token!==renderToken||!div.isConnected)return;
      // The new canvas and text layer are complete. This synchronous swap keeps the
      // outer page, scroll geometry and old pixels intact until the same frame.
      const anchor=zoomAnchor(column);
      div.style.zoom='1';div.style.width=viewport.width+'px';
      div._dprViewport=viewport;
      div.replaceChildren(...replacement.childNodes);
      restoreZoomAnchor(column,anchor);
      normalizeTextReadingOrder(div.querySelector('.textLayer'),viewport);
      paintEqLayer(div,viewport,+div.dataset.page);
      document.dispatchEvent(new CustomEvent('dpr-page-painted',{detail:{page:div}}));
    }finally{stage.remove();}
  }
  if(token===renderToken){try{findReapply();}catch{}}
}
for(const id of ['pdf-pane','pdf-pane-zh'])$(id).addEventListener('scroll',()=>{
  if([...$(id).querySelectorAll('.page')].some(p=>p.style.zoom&&p.style.zoom!=='1'))queueZoomRaster();
},{passive:true});
