// A-owned structural/contrast checks. Native DOM-model and actual Chrome/visual acceptance remain separate gates.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {installWebPages} from '../平台/网页.mjs'
import {mountWebApp,safeLocalNext,projectInviteText,sliceZipPlan} from '../界面/app.mjs'
import * as resourceAPI from '../查看器/resources.mjs'
const css=await readFile(new URL('../界面/base.css',import.meta.url),'utf8')
const app=await readFile(new URL('../界面/app.mjs',import.meta.url),'utf8')
const canvas=await readFile(new URL('../界面/画布.mjs',import.meta.url),'utf8')
const server=await readFile(new URL('../平台/网页.mjs',import.meta.url),'utf8')
const sha=text=>createHash('sha256').update(text).digest('hex')
function shell(page,{role='admin',name='真实 <项目>',artifacts={}}={}){
 const routes=[],user={id:'qa',username:'qa',displayName:name,role,status:'active',passwordHash:'never-in-boot',sessionVersion:9},ctx={route:(method,pattern,handler)=>routes.push({method,pattern,handler}),vault:{},auth:{actor:()=>user},permissions:{requireRead(){}},error:(status,code,message)=>Object.assign(Error(message),{status,code}),artifacts};installWebPages(ctx)
 let body,headers,status;const res={writeHead(s,h){status=s;headers=h},end(value){body=value}}
 if(page==='error')ctx.renderErrorPage({},res,{status:404,code:'not_found',message:'<script>bad</script>'})
 else {const url=({projects:'/projects',accounts:'/accounts',login:'/login',canvas:'/viewer/p/qa'})[page],route=routes.find(item=>item.method==='GET'&&item.pattern.test(url));route.handler({url},res,{url:new URL(url,'https://fixture.invalid'),params:{projectId:'qa'}})}
 return {body,headers,status,boot:JSON.parse(body.match(/<script type="application\/json" id="app-context"[^>]*>([\s\S]*?)<\/script>/)[1])}
}

test('Master: 208 workspace navigation and neutral primary action are the real tokens',()=>{
 for(const value of ['#0b2026','#081a1e','#0d242a','#112b32','#15343b','#eaf3f1','#88a7a3','#8fd9c4','#e6f1ee'])assert.ok(css.includes(value),value)
 assert.match(css,/--nav-width:208px/);assert.match(css,/--command-height:52px/)
 assert.match(css,/button\.primary,a\.button\.primary\s*\{\s*background:var\(--button-bg\); color:var\(--button-text\)/)
 assert.doesNotMatch(css,/#79d7e5|#8eb8ff|@import|https?:\/\/|prefers-color-scheme/)
 for(const rule of ['focus-visible','prefers-reduced-motion','min-height:44px','[data-selected=true]','[aria-current]','[aria-pressed=true]'])assert.ok(css.includes(rule),rule)
})

test('SSR: semantic workspace, current navigation, escaped boot, nonce and error state remain intact',()=>{
 const project=shell('projects');assert.equal(project.status,200);assert.match(project.body,/<aside id="workspace-nav"/);assert.match(project.body,/<nav class="workspace-links" aria-label="主导航">/);assert.match(project.body,/<a href="\/projects" aria-current="page">/);assert.match(project.body,/nav-toggle/);assert.match(project.body,/跳至内容/);assert.doesNotMatch(project.body,/class="topbar"|class="site-footer"|passwordHash|sessionVersion/)
 assert.ok(project.body.includes('真实 &lt;项目&gt;'));assert.match(project.headers['Content-Security-Policy'],/script-src 'self' 'nonce-/);assert.match(project.headers['Content-Security-Policy'],/frame-ancestors 'none'; base-uri 'none'; form-action 'self'/);assert.equal(project.headers['Content-Length'],Buffer.byteLength(project.body))
 const developer=shell('projects',{role:'developer'});assert.doesNotMatch(developer.body,/href="\/accounts"/)
 const error=shell('error');assert.equal(error.status,404);const visibleError=error.body.replace(/<script[\s\S]*?<\/script>/g,'');assert.match(visibleError,/页面不存在或已被移除/);assert.doesNotMatch(visibleError,/bad|not_found|<script/);assert.equal(error.boot.message,'<script>bad</script>');assert.equal(error.boot.code,'not_found');assert.doesNotMatch(error.body,/<script>bad<\/script>/)
 const edit=shell('canvas');assert.match(edit.body,/class="canvas-shell"/);assert.doesNotMatch(edit.body,/<aside|workspace-mobile|site-footer/)
})

test('Portal: full-width project rows, honest file placeholder and named permission menu replace isolated cards',()=>{
 for(const name of ['project-list','project-row','project-open','project-placeholder','project-actions','项目操作','文件数未提供','尚未发布','data-project-id'])assert.ok(app.includes(name),name)
 assert.match(app,/permissions\.canShare===true/);assert.match(app,/permissions\.canManage===true/);assert.match(app,/permissions\.canAssignOwner===true/);assert.match(app,/permissions\.canDelete===true/)
 assert.doesNotMatch(app,/picsum|unsplash|最近更新|活跃项目|今日访问|window\.open|location\.reload|setInterval/)
 assert.match(css,/\.action-menu>summary\s*\{[^}]*white-space:nowrap/)
 assert.match(app,/roleName\(user\.role\)/);assert.match(app,/管理范围内的账户/);assert.match(app,/dialog\.showModal\(\)/)
 assert.match(app,/selected\.set\(id,item\)/);assert.match(app,/已选 \$\{selected\.size\} 项（跨页）/)
})

test('Canvas: one command row plus directory and floating dock; original fit math is byte-identical',()=>{
 for(const name of ['canvas-toolbar','canvas-directory','canvas-page-list','canvas-zoom-dock','关闭画板分组','Shift 多选 / 轴锁','Alt 暂停 6px 吸附'])assert.ok(canvas.includes(name),name)
 assert.match(canvas,/theme\.canvas/);assert.match(canvas,/context\.drawImage\(image\.bitmap,b\.x,b\.y,b\.width,b\.height\)/)
 const fit=canvas.slice(canvas.indexOf('  function fit()'),canvas.indexOf('  function imageKey('));assert.equal(sha(fit),'de7cf33ad9d0232edd1c6e3573efd04c2e24c14de53732db2da331276f79d5a5')
 assert.match(canvas,/positions\.size>1000/);assert.match(canvas,/expectedLayoutVersion/);assert.match(canvas,/已回滚预测/);assert.match(canvas,/saveState!=='idle'/)
 assert.match(css,/#app\.canvas-page[^}]*height:100dvh/);assert.match(css,/max-width:760px/);assert.match(css,/\.canvas-toolbar \{ --command-height:56px/)
})

test('Security: source/about surfaces and routes are absent while plugin archive route remains exact',()=>{
 assert.doesNotMatch(server,/production-legal|关于与开源声明|第三方许可与源码|legacySourceArchive|software-license/)
 assert.match(server,/\[\['\/plugin\.zip','pluginArchive','application\/zip','plugin\.zip'\]\]/)
})

test('Master text, muted labels, focus and neutral button meet AA contrast on UI surfaces',()=>{
 const lum=color=>color.match(/../g).map(s=>parseInt(s,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)
 const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05)
 for(const bg of ['101214','14171a','181c20','20252b'])for(const fg of ['edf0f3','bbc3ce','929eac','9bc8bd'])assert.ok(contrast(fg,bg)>=4.5,`${fg}/${bg}`)
 assert.ok(contrast('e4e9eb','182023')>=7)
})

test('Public helper semantics stay exact and never broaden selection, redirect or invite origin',()=>{
 for(const value of ['//evil.invalid','/%2f%2fevil','/\\evil','/bad%zz'])assert.equal(safeLocalNext(value),'/projects')
 assert.throws(()=>sliceZipPlan([]),/不会回退/);assert.deepEqual(sliceZipPlan(Array.from({length:1001},(_,i)=>({id:'a'+i}))).map(rows=>rows.length),[499,499,3])
 assert.throws(()=>projectInviteText('真实项目',{link:'//evil.invalid'},'https://fixture.invalid'))
 assert.match(projectInviteText('真实项目',{link:'/share/'+'a'.repeat(43)},'https://fixture.invalid'),/未提供（服务器未返回）/)
})

test('U2 essential control border resolves from the actual input rule to at least 3:1',()=>{
 const vars=new Map([...css.matchAll(/(--[\w-]+)\s*:\s*(#[a-f0-9]{6}|var\(--[\w-]+\))/g)].map(([,key,value])=>[key,value])),resolve=key=>{const value=vars.get(key);assert.ok(value,key);return value.startsWith('#')?value.slice(1):resolve(value.slice(4,-1))},rule=css.match(/\ninput,select,textarea\s*\{([^}]+)\}/)[1]
 assert.match(rule,/border:1px solid var\(--control-border\)/);assert.equal(resolve('--control-border'),'64717f');assert.equal(resolve('--border'),'2e353e')
 const lum=hex=>hex.match(/../g).map(s=>parseInt(s,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0),a=lum(resolve('--control-border')),b=lum(resolve('--bg'));assert.ok((a+.05)/(b+.05)>=3)
 assert.match(css,/\.project-row[^}]*min-height:80px/);assert.match(css,/\.project-placeholder[^}]*width:76px; height:56px/)
})

// Self-authored DOM + JPEG-header/decode MODEL: deliberately not a browser or real JPEG codec claim.
const turn=()=>new Promise(resolve=>setImmediate(resolve)),walk=node=>[node,...node.children.flatMap(walk)]
const match=(node,selector)=>selector[0]==='.'?node.className.split(/\s+/).includes(selector.slice(1)):selector[0]==='#'?node.id===selector.slice(1):node.tagName===selector.toUpperCase()
class CoverNode {
 constructor(doc,tag,type=1){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),nodeType:type,children:[],parentNode:null,attributes:new Map(),events:new Map(),dataset:{},className:'',_text:'',value:'',id:'',hidden:false,disabled:false,style:{}});this.classList={add:name=>this.className+=' '+name}}
 append(...nodes){for(const node of nodes){node.parentNode?.removeChild(node);node.parentNode=this;this.children.push(node)}}removeChild(node){this.children=this.children.filter(value=>value!==node);node.parentNode=null}replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes)}prepend(node){this.children.unshift(node);node.parentNode=this}remove(){this.parentNode?.removeChild(this)}
 set textContent(value){this._text=String(value);this.children=[]}get textContent(){return this._text+this.children.map(node=>node.textContent).join('')}get childElementCount(){return this.children.filter(node=>node.nodeType===1).length}
 setAttribute(key,value){this.attributes.set(key,String(value));if(['id','name','type'].includes(key))this[key]=String(value);if(key==='class')this.className=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value)}getAttribute(key){return this.attributes.get(key)??null}
 querySelectorAll(selector){return walk(this).slice(1).filter(node=>match(node,selector))}querySelector(selector){return this.querySelectorAll(selector)[0]??null}addEventListener(key,fn){const list=this.events.get(key)||[];list.push(fn);this.events.set(key,list)}removeEventListener(key,fn){this.events.set(key,(this.events.get(key)||[]).filter(value=>value!==fn))}async fire(key,event={}){for(const fn of this.events.get(key)||[])await fn({currentTarget:this,target:this,preventDefault(){},...event})}focus(){this.ownerDocument.activeElement=this}
 getBoundingClientRect(){return {top:0,bottom:80,width:800,height:80}}getContext(){return {clearRect(){},drawImage:(...args)=>this.ownerDocument.draws.push(args)}}
}
function coverDOM({observe=false}={}){
 const events=new Map(),observers=[],document={draws:[],createElement(tag){return new CoverNode(this,tag)},createElementNS(_,tag){return this.createElement(tag)},createTextNode(text){const node=new CoverNode(this,'text',3);node.textContent=text;return node},querySelector(selector){return this.body.querySelector(selector)}};document.body=document.createElement('body');const root=document.createElement('main');document.body.append(root);let closed=0,decoded=0
 const window={innerHeight:900,location:{origin:'https://fixture.invalid',href:'https://fixture.invalid/projects',pathname:'/projects',search:'',assign(){}},navigator:{},localStorage:{getItem(){return null}},addEventListener(key,fn){const list=events.get(key)||[];list.push(fn);events.set(key,list)},removeEventListener(key,fn){events.set(key,(events.get(key)||[]).filter(value=>value!==fn))},createImageBitmap:async()=>{decoded++;return {width:3,height:2,close(){closed++}}}}
 if(observe)window.IntersectionObserver=class{constructor(callback){this.callback=callback;this.nodes=new Set();observers.push(this)}observe(node){this.nodes.add(node)}disconnect(){this.nodes.clear()}}
 return {document,window,root,events,observers,get decoded(){return decoded},get closed(){return closed},async settle(){for(let i=0;i<24;i++)await turn()},visible(ids){for(const observer of observers)observer.callback([...observer.nodes].map(target=>({target,isIntersecting:ids.includes(target.dataset.projectId)})))}}
}
const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217])
const projectRows=count=>Array.from({length:count},(_,i)=>({id:'project'+i,name:i===9?'target':'项目'+i,designFileCount:1,permissions:{}}))
const coverMeta=id=>({id,files:[{id:'file',pages:[{id:'page',frames:[{id:'frame'+id,name:'真实画板',currentRevisionId:'rev'+id,previewBaseUrl:'/api/previews/'+id,previewWidth:3,previewHeight:2,previewBytes:jpeg.length}]}]}]})
function coverFetch(projects,{metadata=async id=>coverMeta(id),headWidth=3}={}){const calls=[];const fetchAPI=async(url,options={})=>{const path=new URL(url,'https://fixture.invalid').pathname;calls.push({path,...options});if(path==='/api/projects')return Response.json({projects});if(path.endsWith('/canvas'))return Response.json(await metadata(path.split('/')[3],options.signal));if(path.startsWith('/api/previews/'))return new Response(options.method==='HEAD'?null:jpeg,{headers:{'content-type':'image/jpeg','content-length':String(jpeg.length),'x-heron-preview-width':String(headWidth),'x-heron-preview-height':'2'}});throw Error('Unexpected request '+path)};return {fetchAPI,calls}}
const mountCovers=(d,fetchAPI)=>mountWebApp({document:d.document,window:d.window,root:d.root,context:{page:'projects',user:{role:'developer'}},fetchAPI,resourceAPI})

test('U2 project covers share physical2/64Mi/80Mi; only eight visible rows request real LOD256; dispose closes bitmaps',async()=>{
 const d=coverDOM(),f=coverFetch(projectRows(10)),view=await mountCovers(d,f.fetchAPI);try{await d.settle();assert.equal(f.calls.filter(call=>call.path.endsWith('/canvas')).length,8);assert.equal(d.document.draws.length,8);assert.equal(d.decoded,8);assert.equal(walk(d.root).filter(node=>node.tagName==='IMG').length,0);assert.ok(f.calls.every(call=>!call.path.includes('/api/assets/')));assert.ok(f.calls.every(call=>call.credentials==='same-origin'&&call.redirect==='error'));const r=d.root.projectCoverDiagnostics.resources;assert.ok(r.peak.physical<=2);assert.ok(r.peak.pixels<=67108864);assert.ok(r.peak.encoded<=83886080);assert.equal(r.physical,0)}finally{view.dispose();await d.settle()}assert.equal(d.closed,8);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,0)
})

test('U2 IO demand starts no offscreen metadata and cancels/reclaims when rows leave the viewport',async()=>{
 const d=coverDOM({observe:true}),f=coverFetch(projectRows(10)),view=await mountCovers(d,f.fetchAPI);try{await d.settle();assert.equal(f.calls.length,1);d.visible(['project3']);await d.settle();assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/canvas')).map(call=>call.path),['/api/projects/project3/canvas']);assert.equal(d.decoded,1);d.visible([]);await d.settle();assert.equal(d.closed,1);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,0);d.visible(['project4']);await d.settle();assert.equal(d.decoded,2)}finally{view.dispose();await d.settle()}assert.equal(d.closed,2)
})

test('U2 search cancels metadata without releasing physical slots until actual work settles, and never draws stale rows',async()=>{
 const held=[],d=coverDOM(),f=coverFetch(projectRows(10),{metadata:(id,signal)=>id==='project0'||id==='project1'?new Promise(resolve=>held.push({id,signal,resolve})):Promise.resolve(coverMeta(id))}),view=await mountCovers(d,f.fetchAPI)
 try{await d.settle();assert.equal(held.length,2);const search=walk(d.root).find(node=>node.getAttribute('aria-label')==='搜索项目');search.value='target';await search.fire('input');await d.settle();assert.ok(held.every(item=>item.signal.aborted));assert.equal(f.calls.filter(call=>call.path.endsWith('/canvas')).length,2);assert.equal(d.root.projectCoverDiagnostics.resources.physical,2);for(const item of held)item.resolve(coverMeta(item.id));await d.settle();assert.equal(f.calls.filter(call=>call.path.endsWith('/canvas')).length,3);assert.equal(d.decoded,1);assert.equal(d.document.draws.length,1);assert.ok(f.calls.filter(call=>call.path.startsWith('/api/previews/')).every(call=>call.path.includes('project9')))}finally{for(const item of held)item.resolve(coverMeta(item.id));view.dispose();await d.settle()}
 assert.equal(d.root.projectCoverDiagnostics.resources.physical,0);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,0)
})

test('U2 render reuses the physical pool while cancelled prior metadata still owns both slots',async()=>{
 const held=[],d=coverDOM(),f=coverFetch(projectRows(2),{metadata:(id,signal)=>held.length<2?new Promise(resolve=>held.push({id,signal,resolve})):Promise.resolve(coverMeta(id))}),view=await mountCovers(d,f.fetchAPI)
 try{await d.settle();assert.equal(held.length,2);await view.render();await d.settle();assert.ok(held.every(item=>item.signal.aborted));assert.equal(f.calls.filter(call=>call.path.endsWith('/canvas')).length,2);assert.equal(d.root.projectCoverDiagnostics.resources.physical,2);for(const item of held)item.resolve(coverMeta(item.id));await d.settle();assert.equal(d.document.draws.length,2);assert.ok(d.root.projectCoverDiagnostics.resources.peak.physical<=2)}finally{for(const item of held)item.resolve(coverMeta(item.id));view.dispose();await d.settle()}
 assert.equal(d.root.projectCoverDiagnostics.resources.physical,0)
})

test('U2 pagehide holds the physical and pixel lease until an uncancellable decode actually ends',async()=>{
 const d=coverDOM(),f=coverFetch(projectRows(1));let finish,closed=0;d.window.createImageBitmap=()=>new Promise(resolve=>finish=()=>resolve({width:3,height:2,close(){closed++}}));const view=await mountCovers(d,f.fetchAPI)
 try{await d.settle();assert.equal(typeof finish,'function');for(const fn of [...d.events.get('pagehide')||[]])fn();assert.equal(d.root.projectCoverDiagnostics.resources.physical,1);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,6);finish();await d.settle();assert.equal(d.document.draws.length,0);assert.equal(closed,1);assert.equal(d.root.projectCoverDiagnostics.resources.physical,0);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,0)}finally{finish?.();view.dispose();await d.settle()}
})

test('U2 missing/foreign/failed and oversized preview metadata stay honest placeholders, never GET an original',async()=>{
 for(const mode of ['empty','foreign','denied','oversized']){const d=coverDOM(),f=coverFetch(projectRows(1),{headWidth:mode==='oversized'?300:3,metadata:async id=>{if(mode==='denied')throw Error('HTTP 403 permission revoked');const value=coverMeta(id);if(mode==='empty')value.files=[];if(mode==='foreign')value.files[0].pages[0].frames[0].previewBaseUrl='https://evil.invalid/image';return value}}),view=await mountCovers(d,f.fetchAPI);try{await d.settle();assert.equal(d.decoded,0,mode);assert.equal(d.document.draws.length,0,mode);assert.equal(f.calls.filter(call=>call.path.includes('/api/previews/')&&call.method==='GET').length,0,mode);const box=d.root.querySelector('.project-placeholder');assert.match(box.getAttribute('aria-label'),/文件占位/);assert.ok(box.querySelector('svg'));assert.equal(d.root.projectCoverDiagnostics.resources.physical,0)}finally{view.dispose();await d.settle()}}
})
