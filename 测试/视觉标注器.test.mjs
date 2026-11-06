// Self-authored structural / state / contrast MODEL tests. Not browser screenshots or visual acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountInspector } from '../查看器/index.mjs';

const all = node => [node,...node.children.flatMap(all)];
const cls = (d,name) => all(d.container).find(node => node.className.split(/\s+/).includes(name));
const controls = (d,label) => all(d.container).filter(node => node.getAttribute('aria-label') === label);
const control = (d,label) => { const nodes = controls(d,label); assert.equal(nodes.length,1,`one real control: ${label}`); return nodes[0]; };
const visible = node => { for(let n=node;n;n=n.parentNode) { if(n.hidden || n.inert) return false; if(n.parentNode?.tagName === 'DETAILS' && !n.parentNode.open && n.tagName !== 'SUMMARY') return false; } return true; };
const turn = () => new Promise(resolve => setImmediate(resolve));
class Node {
  constructor(document,tag,fragment=false) {
    Object.assign(this,{ownerDocument:document,tagName:tag.toUpperCase(),nodeType:fragment?11:1,children:[],parentNode:null,attributes:new Map(),events:new Map(),style:{},dataset:{},className:'',_text:'',_value:undefined,hidden:false,disabled:false,inert:false,checked:false,open:false});
    this.classList={add:value=>{this.className+=` ${value}`;}};
  }
  append(...nodes) { for(const node of nodes) { if(node.nodeType===11) { this.append(...[...node.children]);node.children=[];continue; } node.parentNode?.removeChild(node);node.parentNode=this;this.children.push(node); } }
  insertBefore(node,next) { node.parentNode?.removeChild(node); const index=this.children.indexOf(next); node.parentNode=this; if(index<0)this.children.push(node);else this.children.splice(index,0,node); }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]??null; }
  removeChild(node) { this.children=this.children.filter(child=>child!==node);node.parentNode=null; }
  replaceChildren(...nodes) { for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  set textContent(value) { this._text=String(value);for(const child of this.children)child.parentNode=null;this.children=[]; }
  get textContent() { return this._text+this.children.map(child=>child.textContent).join(''); }
  set innerHTML(value) { throw Error('HTML injection is not an allowed fixture operation'); }
  set value(value) { this._value=String(value); }
  get value() { return this._value??(this.tagName==='SELECT'?(this.children.find(child=>child.selected)??this.children[0])?.value??'':''); }
  setAttribute(key,value) { this.attributes.set(key,String(value)); }
  getAttribute(key) { return this.attributes.get(key)??null; }
  addEventListener(key,fn) { const values=this.events.get(key)??new Set();values.add(fn);this.events.set(key,values); }
  fire(key,event={}) { let result;for(const fn of this.events.get(key)??[])result=fn({target:this,type:key,preventDefault(){},...event});return result; }
  click() { if(this.disabled)return; if(this.tagName==='SUMMARY') { this.parentNode.open=!this.parentNode.open;this.parentNode.fire('toggle'); } if(this.tagName==='A')this.ownerDocument.anchors.push({node:this,href:this.href,download:this.download});return this.fire('click'); }
  focus() { this.ownerDocument.activeElement=this; }
  contains(node) { return all(this).includes(node); }
  setPointerCapture() {} releasePointerCapture() {}
  compareDocumentPosition(node) { return all(this.ownerDocument.host).indexOf(this)<all(this.ownerDocument.host).indexOf(node)?4:2; }
  querySelectorAll(selector) { return all(this).slice(1).filter(node => { const [tag,name]=selector.split('.');return (!tag||node.tagName===tag.toUpperCase())&&(!name||node.className.split(/\s+/).includes(name)); }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  getBoundingClientRect() { const width=visible(this)?this.ownerDocument.width:0;return {left:0,top:0,right:width,bottom:824,width,height:width?824:0}; }
  getContext() { if(this.context)return this.context;const node=this;return this.context=new Proxy({measureText:text=>({width:String(text).length*6}),drawImage(...args){node.ownerDocument.draws.push({canvas:node,args});}},{get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>(target[key]=value,true)}); }
}
function dom(width=1440) {
  const raf=new Map(), observers=[],copies=[],events=new Map();let serial=0;
  const document={width,draws:[],anchors:[],baseURI:'https://visual-model.example.test/viewer/r/frame-a',createElement(tag){return new Node(this,tag);},createElementNS(ns,tag){return new Node(this,tag);},createDocumentFragment(){return new Node(this,'fragment',true);},querySelector(selector){return this.host.querySelector(selector);}};
  const window={devicePixelRatio:1,navigator:{clipboard:{writeText:async value=>copies.push(value)}},matchMedia:query=>({matches:document.width<=Number(query.match(/max-width:\s*(\d+)/)?.[1]??900)}),requestAnimationFrame:fn=>(raf.set(++serial,fn),serial),cancelAnimationFrame:id=>raf.delete(id),addEventListener(key,fn){const values=events.get(key)??new Set();values.add(fn);events.set(key,values);},removeEventListener:(key,fn)=>events.get(key)?.delete(fn),ResizeObserver:class{constructor(fn){observers.push(fn);}observe(){}disconnect(){}}};
  document.defaultView=window;document.host=document.createElement('body');const container=document.createElement('div');document.container=container;document.host.append(container);
  return {container,document,window,copies,async fireWindow(key){for(const fn of events.get(key)??[])await fn();},flush(){const values=[...raf.values()];raf.clear();for(const fn of values)fn();},resize(value){document.width=value;for(const fn of observers)fn();}};
}
const current='revision-current', historical='revision-history';
function fixture() {
  const calls={trees:[],downloads:[],originals:0},frames=[
    {frameId:'frame-a',figmaNodeId:'2:1',revisionId:current,currentRevisionId:current,name:'当前目录名称不冒充历史画布',designFileId:'file-a',designFileName:'文件甲',pageId:'page-a',pageName:'页面甲',projectId:'project-a',bounds:{x:0,y:0,width:100,height:80}},
    {frameId:'frame-b',figmaNodeId:'2:9',revisionId:current,currentRevisionId:current,name:'另一同名目录',designFileId:'file-b',designFileName:'文件乙',pageId:'page-b',pageName:'页面乙',projectId:'project-a',bounds:{x:140,y:0,width:100,height:80}}
  ];
  const context={projectId:'project-a',projectName:'真实项目',designFileId:'file-a',designFileName:'文件甲',projectCanvasUrl:'/viewer/p/project-a',projectSlicesUrl:'/viewer/p/project-a/slices',files:[{designFileId:'file-a',name:'文件甲',pages:[{pageId:'page-a',name:'页面甲'}]},{designFileId:'file-b',name:'文件乙',pages:[{pageId:'page-b',name:'页面乙'}]}],permissions:{canView:true,canEdit:false}};
  const snapshot=(frameId,revisionId)=>{const f=frames.find(value=>value.frameId===frameId);return {frameId,revisionId,identity:{frameId,revisionId,projectId:'project-a',designFileId:f.designFileId,pageId:f.pageId,figmaNodeId:f.figmaNodeId},context:{...context,designFileId:f.designFileId},layerDoc:{contractVersion:1,frame:{id:f.figmaNodeId,type:'FRAME',name:revisionId===historical?'历史画布实际名':'当前画布实际名',width:100,height:80,absoluteBoundingBox:f.bounds,cornerRadius:0,fills:[],children:[{id:'2:2',type:'TEXT',name:'复制',width:40.000001,height:20.000001,absoluteBoundingBox:{x:1.000001,y:2.000001,width:40.000001,height:20.000001},characters:'甲😀乙Z',style:{fontSize:'MIXED'},textRuns:[{start:0,end:3,characters:'甲😀',style:{fontSize:12}},{start:3,end:5,characters:'乙Z',style:{fontSize:24}}],textStyleId:'style-a',componentId:'component-a'}]},styles:{TEXT:[{id:'style-a',name:'复制',fontSize:15}],FILL:[],EFFECT:[],GRID:[]},components:[{id:'component-a',name:'真实组件'}]},slices:[{sliceId:'slice-svg',assetId:'asset-svg',exportNodeId:'2:2',filename:'真实图标.svg',format:'SVG',mime:'image/svg+xml',scale:2,width:20,height:10,byteLength:88,frameId,revisionId},{sliceId:'slice-png',assetId:'asset-png',exportNodeId:f.figmaNodeId,filename:'真实图层.png',format:'PNG',mime:'image/png',scale:1,width:40,height:20,byteLength:104,frameId,revisionId}]};};
  const adapter={context,listFrames:async()=>({frames,context}),listRevisions:async()=>[{revisionId:current,name:'已发布当前',current:true},{revisionId:historical,name:'已发布历史'}],loadRevision:async(frameId,revisionId)=>{calls.trees.push([frameId,revisionId]);return snapshot(frameId,revisionId);},loadAsset:async()=>{calls.originals++;throw Error('originals must not be used for thumbnails');},getSliceDownloadUrl:async(frameId,revisionId,options)=>{calls.downloads.push({frameId,revisionId,kind:options.kind,sliceId:options.sliceId});return {url:'/authorized/history.zip',filename:'原始历史.zip',mime:'application/zip',byteLength:12,frameId,revisionId};}};
  return {adapter,frames,context,calls,snapshot};
}
async function open(width=1440,changes={}) { const d=dom(width),f=fixture();Object.assign(f.adapter,changes);const view=mountInspector(d.container,{adapter:f.adapter,initialFrameId:'frame-a',initialMode:'frame'});await view.ready;d.flush();return {d,f,view}; }

test('STRUCTURE: one desktop command header, full-bleed stage and mobile dock, no second layout toolbar/footer',async()=>{
  const {d,view}=await open();try {
    assert.deepEqual(cls(d,'ii-root').children.filter(node=>node.tagName!=='LINK').map(node=>node.className),['ii-header','ii-body','ii-status','ii-mobile-tasks']);
    assert.equal(cls(d,'ii-main').children.length,1);assert.ok(cls(d,'ii-main').children[0]===cls(d,'ii-stage'));assert.ok(cls(d,'ii-toolbar').parentNode===cls(d,'ii-header'));assert.ok(cls(d,'ii-stage-footer').parentNode===cls(d,'ii-stage'));assert.ok(cls(d,'ii-stage-footer').className.includes('ii-sr-only'));
    assert.equal(cls(d,'ii-tabs'),undefined);assert.equal(controls(d,'标注').length,0);assert.equal(controls(d,'切图').length,1);assert.equal(controls(d,'属性').length,1);assert.ok(control(d,'属性').parentNode===cls(d,'ii-header-actions'));assert.equal(controls(d,'目录').length,1);
    assert.deepEqual(Object.keys(view).sort(),['diagnostics','dispose','navigate','ready']);assert.equal(view.diagnostics.loadedTrees,1);
  }finally{view.dispose();}
});
test('STRUCTURE: left frames/layers are controlled pages of one complete file/Page tree, not permanent split',async()=>{
  const {d,f,view}=await open();try {
    const list=cls(d,'ii-frame-list'),tree=cls(d,'ii-tree'),identity={...view.diagnostics.identity},count=view.diagnostics.loadedLayerCount;
    assert.equal(list.parentNode.hidden,false);assert.equal(tree.parentNode.hidden,true);assert.equal(list.children.length,1);assert.match(list.textContent,/未分组/);assert.equal(all(list).filter(node=>node.className.split(/\s+/).includes('ii-frame-row')).length,2);
    control(d,'图层').click();assert.equal(list.parentNode.hidden,true);assert.equal(tree.parentNode.hidden,false);assert.equal(tree.children.length,count);assert.equal(control(d,'图层').getAttribute('aria-pressed'),'true');
    control(d,'画板').click();assert.equal(list.parentNode.hidden,false);assert.equal(tree.parentNode.hidden,true);assert.ok(cls(d,'ii-tree')===tree);assert.equal(f.calls.trees.length,1);assert.deepEqual(view.diagnostics.identity,identity);
  }finally{view.dispose();}
});
test('STRUCTURE: properties start with layer name/type and XY/WH, settings stay closed and real CSS is open beside shared properties',async()=>{
  const {d,view}=await open();try {
    cls(d,'ii-tree').children[1].click();const properties=cls(d,'ii-properties');assert.ok(properties.children[0]===cls(d,'ii-selected-layer'));assert.equal(properties.querySelectorAll('h3')[0].textContent,'复制');assert.match(properties.children[0].textContent,/TEXT/);
    assert.ok(properties.children[1]===cls(d,'ii-geometry'));assert.match(properties.children[1].textContent,/世界BBox.*W.*H/);assert.equal(properties.children[1].dataset.basis,'world-bounds');assert.doesNotMatch(cls(d,'ii-advanced').textContent,/局部宽|局部高|未提供|缺失/);assert.equal(cls(d,'ii-settings').open,false);assert.equal(cls(d,'ii-css-disclosure').open,true);assert.ok(cls(d,'ii-settings').parentNode===cls(d,'ii-inspector-heading'));assert.ok(properties.parentNode===cls(d,'ii-inspector'));assert.ok(cls(d,'ii-css-disclosure').parentNode===cls(d,'ii-details'));assert.equal(cls(d,'ii-css-settings').querySelectorAll('select').length,2);
    assert.equal(cls(d,'ii-tree').parentNode.hidden,false);assert.doesNotMatch(cls(d,'ii-advanced').textContent,/矩阵 2×3/);assert.match(cls(d,'ii-style-catalog').textContent,/真实组件|复制/);
  }finally{view.dispose();}
});
test('HISTORY: explicit revision state, snapshot title and current directory label remain separate',async()=>{
  const {d,f,view}=await open();try {
    await view.navigate({frameId:'frame-a',revisionId:historical});d.flush();assert.equal(cls(d,'ii-revision-state').textContent,'历史版本');assert.equal(cls(d,'ii-header').dataset.history,'true');assert.equal(cls(d,'ii-context-title').textContent,'历史画布实际名');assert.match(cls(d,'ii-breadcrumb').title,/真实项目.*历史画布实际名/);assert.match(control(d,'当前画板历史版本').title,/历史版本.*已发布历史/);assert.ok(!control(d,'当前画板历史版本').title.includes(historical));assert.ok(control(d,'当前画板历史版本').children.some(node=>node.value===historical));assert.match(cls(d,'ii-frame-list').textContent,/当前目录名称不冒充历史画布/);assert.equal(view.diagnostics.identity.revisionId,historical);assert.deepEqual(f.calls.trees.at(-1),['frame-a',historical]);
  }finally{view.dispose();}
});
test('EXPORTS: 48px thumbnail rows keep name/mime/scale/action, with identity-free actual export details',async()=>{
  const {d,view}=await open();try {
    control(d,'查看此版本全部切图').click();const list=cls(d,'ii-slice-list'),cards=list.children;assert.equal(cards.length,2);assert.equal(cards[0].children[0].textContent,'真实图标.svg');assert.match(cards[0].textContent,/SVG · 2×/);assert.equal(cards[0].querySelectorAll('canvas').length,0);assert.equal(cls(d,'ii-slice-advanced').open,false);assert.equal(cards[0].querySelectorAll('button')[0].getAttribute('aria-label'),'查看切图 · 真实图标.svg');assert.equal(cards[0].querySelectorAll('button').filter(node=>node.getAttribute('aria-label')==='下载原格式').length,1);
    assert.match(cls(d,'ii-scope-note').textContent,/仅筛选列表.*所选版本.*全部切图/);assert.match(cls(d,'ii-slice-count').textContent,/2 \/ 2/);cls(d,'ii-slice-advanced').children[0].click();assert.match(cls(d,'ii-slice-export-details').textContent,/20 × 10.*88 bytes/);assert.doesNotMatch(cls(d,'ii-slice-export-details').textContent,/slice-svg|asset-svg/);assert.equal(cards[0].dataset.sliceId,'slice-svg');assert.equal(view.diagnostics.identity.frameId,'frame-a');assert.equal(view.diagnostics.identity.revisionId,current);
  }finally{view.dispose();}
});
test('DOWNLOAD: node scope filters only list; historical ZIP hands exact revision to native HEAD/anchor, never Blob',async()=>{
  const saved=globalThis.fetch;let heads=0;globalThis.fetch=async(_,options)=>{assert.equal(options.method,'HEAD');heads++;return new Response(null,{headers:{'content-type':'application/zip','content-length':'12'}});};
  const {d,f,view}=await open();try {
    await view.navigate({frameId:'frame-a',revisionId:historical});cls(d,'ii-tree').children[1].click();const scope=control(d,'切图范围');scope.value='node';scope.fire('change');assert.equal(cls(d,'ii-slice-list').children.length,1);
    control(d,'下载此历史版本全部ZIP').click();await turn();assert.deepEqual(f.calls.downloads,[{frameId:'frame-a',revisionId:historical,kind:'zip',sliceId:null}]);assert.equal(heads,1);assert.equal(view.diagnostics.download.getRequests,0);assert.equal(view.diagnostics.download.state,'notSavedYet');assert.equal(d.document.anchors.length,1);assert.equal(d.document.anchors[0].download,'原始历史.zip');assert.match(cls(d,'ii-slices').textContent,/已交给浏览器；尚不能确认文件已保存。请查看浏览器下载列表。/);assert.equal(f.calls.originals,0);
  }finally{view.dispose();globalThis.fetch=saved;}
});
test('THUMBNAIL: without bounded getPreview route, PNG list never falls back to original loadAsset',async()=>{
  const {d,f,view}=await open();try{d.flush();await turn();d.flush();assert.equal(cls(d,'ii-slice-list').querySelectorAll('canvas').length,0);assert.match(cls(d,'ii-slice-list').textContent,/宿主未提供有界缩略图/);assert.equal(f.calls.originals,0);assert.equal(view.diagnostics.imagePlanCount,0);}finally{view.dispose();}
});
test('THUMBNAIL: bounded derivative draws in 96px backing / 48px display and never changes actual revision',async()=>{
  const savedFetch=globalThis.fetch,savedDecode=globalThis.createImageBitmap;const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);new DataView(bytes.buffer).setUint32(16,4);new DataView(bytes.buffer).setUint32(20,2);
  globalThis.fetch=async(_,options)=>{assert.equal(options.method,'GET');return new Response(bytes,{headers:{'content-type':'image/png','content-length':'33'}});};globalThis.createImageBitmap=async()=>({width:4,height:2,close(){}});
  const calls=[],{d,f,view}=await open(1440,{getPreview:async(assetId,options)=>{calls.push([assetId,options]);return {url:'/bounded/thumbnail.png',mime:'image/png',width:4,height:2,byteLength:33,frameId:options.frameId,revisionId:options.revisionId};}});
  try{await view.navigate({frameId:'frame-a',revisionId:historical});cls(d,'ii-tree').children[0].click();for(let index=0;index<8;index++){d.flush();await turn();}const thumbnail=cls(d,'ii-slice-preview');assert.equal(thumbnail.width,256);assert.equal(thumbnail.height,160);assert.equal(calls.length,1);assert.equal(calls[0][0],'asset-png');assert.equal(calls[0][1].maxDimension,256);assert.equal(calls[0][1].revisionId,historical);assert.ok(d.document.draws.some(value=>value.canvas===thumbnail));assert.equal(cls(d,'ii-slice-preview-status').dataset.state,'ready');assert.ok(all(d.container).some(node=>node.className==='ii-slice-preview-status'&&node.dataset.state==='ready'));assert.equal(f.calls.originals,0);assert.deepEqual(view.diagnostics.imageErrors,[]);}finally{view.dispose();globalThis.fetch=savedFetch;globalThis.createImageBitmap=savedDecode;}
});
for(const width of [375,768])test(`RESPONSIVE MODEL ${width}: original task controls move to bottom; one drawer, Esc and focus restore`,async()=>{
  const {d,view}=await open(width);try {
    const property=control(d,'属性'),directory=control(d,'目录');assert.equal(cls(d,'ii-tabs'),undefined);assert.equal(controls(d,'标注').length,0);assert.equal(controls(d,'切图').length,1);assert.ok(property.parentNode===cls(d,'ii-mobile-tasks'));assert.ok(directory.parentNode===cls(d,'ii-mobile-tasks'));assert.equal(cls(d,'ii-sidebar').inert,true);assert.equal(cls(d,'ii-inspector').inert,true);assert.equal(cls(d,'ii-main').inert,false);
    property.focus();property.click();assert.equal(cls(d,'ii-inspector').getAttribute('aria-modal'),'true');assert.equal(cls(d,'ii-sidebar').getAttribute('aria-modal'),'false');assert.equal(cls(d,'ii-main').inert,true);assert.ok(d.document.activeElement===control(d,'关闭属性'));cls(d,'ii-root').fire('keydown',{key:'Escape'});assert.ok(d.document.activeElement===property);assert.equal(cls(d,'ii-main').inert,false);
    directory.focus();directory.click();assert.equal(cls(d,'ii-sidebar').getAttribute('role'),'dialog');assert.equal(cls(d,'ii-inspector').inert,true);cls(d,'ii-root').fire('keydown',{key:'Escape'});assert.ok(d.document.activeElement===directory);
    d.resize(1440);assert.equal(cls(d,'ii-tabs'),undefined);assert.ok(control(d,'属性').parentNode===cls(d,'ii-header-actions'));assert.equal(controls(d,'标注').length,0);assert.equal(controls(d,'切图').length,1);assert.ok(cls(d,'ii-toolbar').children[0]===cls(d,'ii-zoom-tools'));assert.equal(cls(d,'ii-segment'),undefined);assert.equal(controls(d,'项目画布').length,0);assert.equal(controls(d,'单画板').length,0);assert.equal(view.diagnostics.loadedTrees,1);
  }finally{view.dispose();}
});
test('KEYBOARD: settings and stage disclosures close on Escape and restore summary focus',async()=>{
  const {d,view}=await open();try{for(const name of ['ii-settings','ii-stage-advanced']){const menu=cls(d,name);menu.children[0].click();assert.equal(menu.open,true);cls(d,'ii-root').fire('keydown',{key:'Escape'});assert.equal(menu.open,false);assert.ok(d.document.activeElement===menu.children[0]);}}finally{view.dispose();}
});
for(const width of [375,1024,1440])test(`SLICE NAV: one plain header action at ${width}, default/all-advanced/aria and no download dispatch`,async()=>{
  const {d,f,view}=await open(width);try{
    const library=control(d,'切图'),before={identity:{...view.diagnostics.identity},selected:view.diagnostics.selectedNodeId,task:cls(d,'ii-root').dataset.task,scope:control(d,'切图范围').value};
    assert.equal(library.tagName,'A');assert.equal(library.hidden,false);assert.equal(library.parentNode,cls(d,'ii-header-actions'));assert.equal(library.textContent,'切图');assert.equal(library.getAttribute('title'),'切图');assert.equal(library.querySelectorAll('svg').length,0);assert.equal(library.getAttribute('download'),null);assert.equal(library.download,undefined);assert.equal(library.events.get('click')?.size??0,0);
    assert.equal(all(cls(d,'ii-header-actions')).filter(node=>node.tagName==='A').length,1);assert.equal(cls(d,'ii-page-slices-link'),undefined);
    const check=()=>{const surfaces=all(d.container).flatMap(node=>[node._text,node.title,node.getAttribute('title'),node.getAttribute('aria-label')]).filter(Boolean).join('\n');assert.doesNotMatch(surfaces,/当页切图|项目切图库|project-a|file-[ab]|page-[ab]|frame-[ab]|revision-(?:current|history)|slice-(?:svg|png)|asset-(?:svg|png)|"figmaNodeId"/);assert.match(surfaces,/真实项目/);assert.match(surfaces,/当前画布实际名/);};check();for(const node of all(d.container))if(node.tagName==='DETAILS')node.open=true;check();
    library.click();assert.deepEqual({...view.diagnostics.identity},before.identity);assert.equal(view.diagnostics.selectedNodeId,before.selected);assert.equal(cls(d,'ii-root').dataset.task,before.task);assert.equal(control(d,'切图范围').value,before.scope);assert.equal(view.diagnostics.download.state,'idle');assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.originals,0);assert.equal(d.document.anchors.length,1);assert.equal(d.document.anchors[0].download,undefined);assert.equal(new URL(d.document.anchors[0].href).search,'?frameId=frame-a');
    assert.equal(cls(d,'ii-command-more'),undefined);assert.equal(cls(d,'ii-host-legal'),undefined);assert.doesNotMatch(d.container.textContent,/关于|开源|源码|上传插件/);
  }finally{view.dispose();}
});
test('SLICE NAV: current frame follows directory switches, revision history and browser back; never carries an old revision',async()=>{
  const {d,f,view}=await open();try{
    const library=control(d,'切图'),query=()=>Object.fromEntries(new URL(library.href).searchParams);assert.deepEqual(query(),{frameId:'frame-a'});
    await control(d,f.frames[1].name).click();assert.equal(view.diagnostics.identity.frameId,'frame-b');assert.deepEqual(query(),{frameId:'frame-b'});assert.equal(view.diagnostics.selectedNodeId,'2:9');assert.equal(view.diagnostics.sliceScope,'node');assert.equal(cls(d,'ii-root').dataset.task,'details');assert.equal(cls(d,'ii-details').hidden,false);assert.equal(cls(d,'ii-slices').hidden,true);
    const history=control(d,'当前画板历史版本');history.value=historical;await history.fire('change');assert.equal(view.diagnostics.identity.revisionId,historical);assert.deepEqual(query(),{frameId:'frame-b'});assert.equal(library.getAttribute('title'),'切图');
    f.adapter.resolveLocation=()=>({frameId:'frame-a',revisionId:historical});await d.fireWindow('popstate');assert.equal(view.diagnostics.identity.frameId,'frame-a');assert.equal(view.diagnostics.identity.revisionId,historical);assert.deepEqual(query(),{frameId:'frame-a'});assert.equal(new URL(library.href).pathname,'/viewer/p/project-a/slices');assert.equal(new URL(library.href).hash,'');assert.equal(f.calls.downloads.length,0);
    const treeCalls=f.calls.trees.length;view.dispose();await d.fireWindow('popstate');assert.equal(f.calls.trees.length,treeCalls);assert.equal(d.container.children.length,0);
  }finally{view.dispose();}
});
test('SLICE NAV: no host context keeps offline revision exports independent; unsafe navigation stays hidden',async()=>{
  const d=dom(),f=fixture();delete f.adapter.context;f.adapter.listFrames=async()=>f.frames;f.adapter.loadRevision=async(frameId,revisionId)=>{const value=f.snapshot(frameId,revisionId);delete value.context;return value;};const view=mountInspector(d.container,{adapter:f.adapter,initialFrameId:'frame-a'});try{await view.ready;assert.equal(control(d,'切图').hidden,true);assert.equal(control(d,'回项目画布').hidden,true);assert.equal(view.diagnostics.selectedNodeId,'2:1');control(d,'查看此版本全部切图').click();assert.equal(control(d,'切图范围').value,'frame');assert.equal(cls(d,'ii-slice-list').children.length,2);assert.equal(f.calls.downloads.length,0);}finally{view.dispose();}
  for(const path of ['https://foreign.invalid/viewer/p/project-a/slices','/api/projects/project-a/slices','/viewer/r/frame-a','/viewer/p/foreign-project/slices']){const d=dom(),f=fixture();f.context.projectSlicesUrl=path;const view=mountInspector(d.container,{adapter:f.adapter,initialFrameId:'frame-a'});try{await view.ready;assert.equal(control(d,'切图').hidden,true);assert.equal(f.calls.downloads.length,0);}finally{view.dispose();}}
});
test('LOCALE: new task/revision/scope labels bind in place; user layer/style/Unicode remain untouched',async()=>{
  const {d,view}=await open();try { const input=control(d,'语言');input.value='en';input.fire('change');assert.equal(view.diagnostics.language,'en');assert.ok(control(d,'Frames'));assert.ok(control(d,'Layers'));assert.equal(control(d,'Exports').textContent,'Exports');assert.equal(control(d,'Exports').querySelectorAll('svg').length,0);assert.equal(cls(d,'ii-revision-state').textContent,'Current revision');assert.match(cls(d,'ii-scope-note').textContent,/filters this list only/);assert.match(control(d,'Frame revision history').children[0].textContent,/Current revision/);cls(d,'ii-tree').children[1].click();assert.equal(cls(d,'ii-selected-layer').children[0].textContent,'复制');assert.equal(cls(d,'ii-text-value').textContent,'甲😀乙Z');control(d,'Copy complete text').click();await turn();assert.equal(d.copies.at(-1),'甲😀乙Z'); }finally{view.dispose();}
});
test('STATIC CONTRACT: Master neutral tokens, AA text, control edges, compact chrome budget, no image filter/Canvas transform',async()=>{
  const css=await readFile(new URL('../查看器/inspector.css',import.meta.url),'utf8'),source=await readFile(new URL('../查看器/index.mjs',import.meta.url),'utf8');
  const tokens=Object.fromEntries([...css.matchAll(/--ii-p-([a-z-]+):#([a-f0-9]{6})\b/g)].map(([,key,value])=>[key,value]));assert.equal(tokens.base,'101214');assert.equal(tokens.canvas,'0d0f12');assert.equal(tokens.panel,'181c20');assert.equal(tokens.accent,'9bc8bd');assert.equal(tokens.primary,'e4e9eb');
  const luminance=value=>value.match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0),contrast=(fg,bg)=>(Math.max(luminance(fg),luminance(bg))+.05)/(Math.min(luminance(fg),luminance(bg))+.05);
  for(const foreground of ['ink','secondary','muted','accent','danger'])for(const background of ['base','canvas','panel','raised','hover'])assert.ok(contrast(tokens[foreground],tokens[background])>=4.5,`${foreground}/${background}`);
  assert.ok(contrast(tokens.control,tokens.base)>=3);assert.ok(contrast(tokens.control,tokens.panel)>=3);assert.ok(contrast(tokens['primary-ink'],tokens.primary)>=4.5);
  assert.match(css,/\.ii-header\{[^}]*flex:0 0 52px;height:52px/);assert.match(css,/\.ii-status\{[^}]*flex:0 0 24px;height:24px/);assert.ok(900-52-24>=800,'declared stage budget; real Chrome dimensions remain a Parent gate');assert.match(css,/\.ii-header>\.ii-toolbar\{position:static/);assert.match(css,/grid-template-columns:232px minmax\(0,1fr\)312px/);assert.match(css,/\.ii-slice-preview,\.ii-slice-placeholder\{[^}]*width:48px;height:48px/);assert.match(css,/\.ii-frame-list,\.ii-tree\{flex:1/);assert.doesNotMatch(css,/height:28%|backdrop-filter|@import|https?:\/\//);assert.doesNotMatch(css,/\.ii-canvas\{[^}]*transform|(?:^|[;{])filter:/m);assert.doesNotMatch(css,/\.ii-(?:sidebar|main|stage)\{[^}]*height:160px/);assert.match(css,/min-height:44px/);assert.match(css,/focus-visible/);assert.match(css,/prefers-reduced-motion:reduce/);assert.doesNotMatch(source,/\.innerHTML\s*=|insertAdjacentHTML|new Blob|createObjectURL/);
});


test('U2: legacy world BBox is primary XY/WH; missing local values stay honest in advanced, CSS is not invented',async()=>{
  const d=dom(),f=fixture(),snapshots=[];
  f.adapter.loadRevision=async(frameId,revisionId)=>{const value=f.snapshot(frameId,revisionId);value.layerDoc.frame.children=[{id:'2:2',type:'RECTANGLE',name:'仅世界BBox',absoluteBoundingBox:{x:89,y:145.5,width:420.5,height:360.25},fills:[]}];snapshots.push({value,original:JSON.stringify(value)});return value;};
  const view=mountInspector(d.container,{adapter:f.adapter,initialFrameId:'frame-a'});try{await view.ready;cls(d,'ii-tree').children[1].click();const geometry=cls(d,'ii-geometry');assert.equal(geometry.dataset.basis,'world-bounds');assert.equal(geometry.children[0].textContent,'尺寸 / 世界BBox');assert.deepEqual(geometry.querySelectorAll('dt').map(node=>node.textContent),['W','H']);assert.deepEqual(geometry.querySelectorAll('dd').map(node=>node.textContent),['420.5px','360.25px']);assert.doesNotMatch(geometry.textContent,/缺失|未提供|局部/);assert.equal(cls(d,'ii-advanced'),undefined);assert.equal(cls(d,'ii-raw-details'),undefined);assert.equal(cls(d,'ii-css-disclosure'),undefined);for(const {value,original}of snapshots)assert.equal(JSON.stringify(value),original);}finally{view.dispose();}
});
test('U2: resolved style names and unknown/mixed references remain primary; missing only moves to the original missing disclosure',async()=>{
  const d=dom(),f=fixture();let actualSnapshot;
  f.adapter.loadRevision=async(frameId,revisionId)=>{const value=f.snapshot(frameId,revisionId);value.layerDoc.frame.children=[{id:'2:2',type:'RECTANGLE',name:'引用状态矩形',absoluteBoundingBox:{x:0,y:0,width:40,height:20},fillStyleId:'fill-a',strokeStyleId:'MIXED',effectStyleId:{state:'unknown',reason:'future-reference'}}];value.layerDoc.styles.FILL=[{id:'fill-a',name:'实际蓝色样式'}];actualSnapshot=value;return value;};
  const view=mountInspector(d.container,{adapter:f.adapter,initialFrameId:'frame-a'});try{await view.ready;cls(d,'ii-tree').children[1].click();const summary=cls(d,'ii-reference-summary');assert.deepEqual(summary.querySelectorAll('dt').map(node=>node.textContent),['填充样式','描边样式']);assert.match(summary.textContent,/实际蓝色样式/);assert.match(summary.textContent,/混合（无单一值）/);assert.doesNotMatch(summary.textContent,/未知（未解析）/);assert.doesNotMatch(summary.textContent,/missing|未提供|textStyleId|fillStyleId/);assert.equal(cls(d,'ii-missing'),undefined);assert.doesNotMatch(cls(d,'ii-properties').textContent,/文字样式未提供|网格样式未提供|组件未提供/);assert.doesNotMatch(cls(d,'ii-advanced').textContent,/textStyleId|fillStyleId|future-reference|fill-a/);assert.equal(cls(d,'ii-raw-details'),undefined);assert.equal(actualSnapshot.layerDoc.frame.children[0].strokeStyleId,'MIXED');assert.deepEqual(actualSnapshot.layerDoc.frame.children[0].effectStyleId,{state:'unknown',reason:'future-reference'});assert.equal(actualSnapshot.layerDoc.frame.children[0].fillStyleId,'fill-a');assert.equal(actualSnapshot.layerDoc.styles.FILL[0].id,'fill-a');assert.equal(view.diagnostics.selectedNodeId,'2:2');}finally{view.dispose();}
});
test('U2: historical task labels consistently say viewed revision, ZIP accessible name changes without changing download identity',async()=>{
  const {d,view}=await open(375);try{await view.navigate({frameId:'frame-a',revisionId:historical});assert.equal(control(d,'下载此历史版本全部ZIP').children[1].textContent,'下载此历史版本全部ZIP');assert.equal(controls(d,'下载当前版本全部切图 ZIP').length,0);assert.equal(controls(d,'所查看版本完整图层树').length,1);assert.ok(control(d,'切图范围').children.some(node=>node.textContent==='整个所查看版本'));assert.match(cls(d,'ii-directory-note').textContent,/目录为当前发布；画布为所查看版本/);assert.equal(cls(d,'ii-context-title').title,'历史画布实际名');assert.equal(view.diagnostics.identity.revisionId,historical);await view.navigate({frameId:'frame-a',revisionId:current});assert.equal(control(d,'下载此版本全部ZIP').children[1].textContent,'下载此版本全部ZIP');assert.equal(controls(d,'下载此历史版本全部ZIP').length,0);}finally{view.dispose();}
});
test('U2 STATIC: mobile header keeps direct project library in non-overlapping fourth slot and touch advanced is 44 by 44',async()=>{
  const css=await readFile(new URL('../查看器/inspector.css',import.meta.url),'utf8');const mobile=css.slice(css.indexOf('@media(max-width:900px)'));
  assert.match(mobile,/grid-template-columns:44px minmax\(0,1fr\)100px auto/);assert.match(mobile,/grid-template-columns:44px minmax\(0,1fr\)96px auto/);assert.ok(375-16-24-44-96-44>=120,'375 minimum label-target budget; real text width remains a Chrome check');
  assert.match(mobile,/\.ii-brand,\.ii-header-actions\{display:contents/);assert.match(mobile,/\.ii-header-actions>\.ii-library-link\{display:flex;grid-column:4;width:auto;min-width:44px/);assert.doesNotMatch(css,/\.ii-header-actions>\.ii-library-link>span\{[^}]*clip-path/);assert.match(css,/\.ii-header-actions>\.ii-button:not\(\.ii-library-link\)>span/);assert.doesNotMatch(css,/ii-host-legal|production-legal|ii-command-more/);assert.match(mobile,/\.ii-stage-advanced>summary\{width:44px;min-width:44px;min-height:44px/);assert.match(mobile,/\.ii-root :is\(button,input:not\(\[type=checkbox\]\),select,a,summary\)\{min-width:44px;min-height:44px/);assert.match(css,/\.ii-geometry dd\{[^}]*background:var\(--ii-bg\)/);
});
