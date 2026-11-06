// Scope: real ephemeral TCP/Vault for management; self-authored MODEL-DOM and bitmap codec.
// This is NOT Chrome, native JPEG decoding, a screenshot, or production/account data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createPlatform} from '../平台/服务.mjs'
import {mountWebApp,projectCoverCandidates} from '../界面/app.mjs'
import * as resourceAPI from '../查看器/resources.mjs'
const tick=()=>new Promise(resolve=>setImmediate(resolve)),settle=async()=>{for(let i=0;i<24;i++)await tick()},walk=node=>[node,...node.children.flatMap(walk)]
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function matches(node,selector){
 if(selector[0]==='.')return node.className.split(/\s+/).includes(selector.slice(1))
 if(selector[0]==='#')return node.id===selector.slice(1)
 const attr=selector.match(/^(\w+)?\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]$/)
 if(attr)return (!attr[1]||node.tagName===attr[1].toUpperCase())&&(attr[3]===undefined?node.getAttribute(attr[2])!==null:String(node[attr[2]]??node.getAttribute(attr[2]))===attr[3])
 return node.tagName===selector.toUpperCase()
}
class ModelNode{
 constructor(doc,tag,type=1){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),nodeType:type,parentNode:null,children:[],attributes:new Map(),events:new Map(),dataset:{},style:{},className:'',id:'',name:'',type:'',disabled:false,hidden:false,checked:false,open:false,scrollTop:0,_text:'',_value:undefined});this.classList={add:value=>this.className+=' '+value}}
 get isConnected(){return this===this.ownerDocument.body||Boolean(this.parentNode?.isConnected)}
 set disabled(value){this._disabled=Boolean(value);if(this._disabled&&this.ownerDocument.activeElement===this)this.ownerDocument.activeElement=this.ownerDocument.body}get disabled(){return this._disabled}
 append(...nodes){for(const node of nodes){node.parentNode?.removeChild(node);node.parentNode=this;this.children.push(node)}}
 prepend(node){this.append(node);this.children.unshift(this.children.pop())}
 removeChild(node){this.children=this.children.filter(value=>value!==node);node.parentNode=null;if(walk(node).includes(this.ownerDocument.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body}
 remove(){this.parentNode?.removeChild(this)}
 replaceChildren(...nodes){for(const child of [...this.children])this.removeChild(child);this._text='';this.append(...nodes)}
 get childElementCount(){return this.children.filter(node=>node.nodeType===1).length}
 set textContent(value){this.replaceChildren();this._text=String(value)}get textContent(){return this._text+this.children.map(node=>node.textContent).join('')}
 set value(value){this._value=String(value)}get value(){return this._value??(this.tagName==='SELECT'?this.children[0]?.value??'':'')}
 setAttribute(key,value){this.attributes.set(key,String(value));if(['id','name','type'].includes(key))this[key]=String(value);if(key==='class')this.className=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value)}
 getAttribute(key){return this.attributes.get(key)??null}removeAttribute(key){this.attributes.delete(key)}
 querySelectorAll(selector){return selector===':scope > .error'?this.children.filter(node=>matches(node,'.error')):walk(this).slice(1).filter(node=>matches(node,selector))}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null}closest(selector){for(let node=this;node;node=node.parentNode)if(matches(node,selector))return node;return null}
 addEventListener(key,fn,options={}){const list=this.events.get(key)||[];list.push({fn,once:options.once});this.events.set(key,list)}
 removeEventListener(key,fn){this.events.set(key,(this.events.get(key)||[]).filter(item=>item.fn!==fn))}
 async fire(key,event={}){for(const item of [...this.events.get(key)||[]]){if(item.once)this.removeEventListener(key,item.fn);await item.fn({currentTarget:this,target:this,preventDefault(){},...event})}}
 click(){return this.disabled?Promise.resolve():this.fire('click')}
 focus(options){if(this.isConnected&&!this.disabled){this.focusOptions=options;this.ownerDocument.activeElement=this}}
 showModal(){this.open=true;this.ownerDocument.shown.push(this);this.querySelector('input')?.focus()}close(){this.open=false;this.ownerDocument.closed.push(this);void this.fire('close')}
 select(){this.ownerDocument.selected=this}
 getBoundingClientRect(){return {top:0,bottom:80,width:800,height:80}}
 getContext(){return {clearRect(){},drawImage:(...args)=>this.ownerDocument.draws.push(args)}}
}
function dom(origin='https://fixture.invalid'){
 const events=new Map(),document={draws:[],shown:[],closed:[],createElement(tag){return new ModelNode(this,tag)},createElementNS(_,tag){return this.createElement(tag)},createTextNode(text){const node=new ModelNode(this,'text',3);node.textContent=text;return node},querySelector(selector){return this.body.querySelector(selector)}}
 document.body=document.createElement('body');document.activeElement=document.body;const root=document.createElement('main');document.body.append(root)
 class FormDataModel{constructor(form){this.values=walk(form).filter(node=>['INPUT','SELECT','TEXTAREA'].includes(node.tagName)&&node.name&&!node.disabled&&(node.type!=='checkbox'||node.checked)).map(node=>[node.name,node.value])}*[Symbol.iterator](){yield* this.values}}
 let closed=0,decoded=0
 const window={innerHeight:900,location:{origin,href:origin+'/projects',pathname:'/projects',search:'',assign(){}},navigator:{clipboard:{async writeText(text){window.copied=text}}},FormData:FormDataModel,localStorage:{getItem(){return null}},addEventListener(key,fn){const list=events.get(key)||[];list.push(fn);events.set(key,list)},removeEventListener(key,fn){events.set(key,(events.get(key)||[]).filter(value=>value!==fn))},async createImageBitmap(){decoded++;return {width:3,height:2,close(){closed++}}}}
 return {document,window,root,events,get decoded(){return decoded},get closed(){return closed}}
}
const button=(d,text,root=d.document.body)=>walk(root).find(node=>node.tagName==='BUTTON'&&node.textContent===text)
const control=(d,name)=>walk(d.document.body).find(node=>node.name===name)
const dialog=d=>d.document.body.querySelector('dialog')
const submit=d=>dialog(d).querySelector('form').fire('submit')
const mount=(d,fetchAPI,user={role:'developer'})=>mountWebApp({document:d.document,window:d.window,root:d.root,context:{page:'projects',user},fetchAPI,resourceAPI})
const frame=(id,name='普通画板',extra={})=>({id,name,currentRevisionId:'revision-'+id,previewBaseUrl:'/api/previews/'+id,...extra})
const metadata=(id,frames)=>({id,files:[{id:'file',name:'设计文件',pages:[{id:'page',name:'普通页面',frames}]}]})
// JPEG header is sufficient only for our explicitly MODEL bitmap codec, not a browser-valid JPEG claim.
const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217])
function coverFetch(projects,{meta=id=>metadata(id,[frame(id)]),head=()=>({width:3,height:2,bytes:jpeg.length}),getBytes=()=>jpeg}={}){
 const calls=[];return {calls,fetchAPI:async(url,options={})=>{const pathname=new URL(url,'https://fixture.invalid').pathname;calls.push({pathname,...options});if(pathname==='/api/projects')return Response.json({projects});if(pathname.endsWith('/canvas'))return Response.json(await meta(pathname.split('/')[3],options.signal));if(!/^\/api\/previews\/[-\w]+\/256\.jpg$/.test(pathname))throw Error('Unexpected or original-image request '+pathname);const info=head(pathname);return new Response(options.method==='HEAD'?null:getBytes(pathname),{status:info.status??200,headers:{'content-type':info.mime??'image/jpeg','content-length':String(info.bytes),'x-heron-preview-width':String(info.width),'x-heron-preview-height':String(info.height)}})}}
}
const projects=count=>Array.from({length:count},(_,index)=>({id:'project'+index,name:index===9?'target':'项目'+index,designFileCount:1,permissions:{}}))

test('[MODEL] cover candidates honor page/frame keywords only, numeric source order, missing=0 and stable ties without DTO mutation',()=>{
 const data={files:[{name:'普通文件',order:9,pages:[{name:'普通页面',order:4,frames:[frame('later','主画板',{order:8}),frame('tie-a','INDEX',{order:2}),frame('tie-b','首页',{order:2}),frame('default','主入口'),frame('fraction','主内容',{order:.25}),frame('invalid','主内容',{order:'-10'}),{id:'no-preview',name:'index',order:-100}]}]},{name:'index文件',order:-9,pages:[{name:'普通页面',frames:[frame('file-keyword')]}]},{pages:[{name:'首屏页面',frames:[frame('page-keyword')]}]}]}
 const before=JSON.stringify(data);assert.deepEqual(projectCoverCandidates(data).map(row=>row.id),['default','invalid','fraction','tie-a','tie-b','later','page-keyword','file-keyword']);assert.equal(JSON.stringify(data),before)
 const fileNameOnly={files:[{name:'主工程',pages:[{name:'普通页面',frames:[frame('ordinary','普通',{order:0})]}]},{name:'其他文件',pages:[{name:'普通页面',frames:[frame('home','首页',{order:10})]}]}]};assert.deepEqual(projectCoverCandidates(fileNameOnly).map(row=>row.id),['home','ordinary'])
 const noMatch=metadata('p',[frame('late','其他',{order:8}),frame('first','普通',{order:0}),frame('same','普通',{order:0})]);assert.deepEqual(projectCoverCandidates(noMatch).map(row=>row.id),['first','same','late'])
})

test('[MODEL-DOM] legacy missing raster metadata and logical floats use real bounded HEAD headers; keyword page wins, no original GET/img',async()=>{
 const d=dom(),data={id:'project0',files:[{pages:[{name:'普通页',frames:[frame('early','早画板',{order:0})]},{name:'INDEX首页',frames:[frame('chosen','内容',{order:2,width:3.5,height:2.25,previewWidth:null,previewHeight:null,previewBytes:null})]}]}]},f=coverFetch(projects(1),{meta:()=>data}),view=await mount(d,f.fetchAPI)
 try{await settle();assert.equal(d.decoded,1);assert.equal(d.root.projectCoverDiagnostics.rows[0].state,'ready');assert.deepEqual(f.calls.filter(row=>row.pathname.includes('/previews/')).map(row=>[row.method,row.pathname]),[['HEAD','/api/previews/chosen/256.jpg'],['GET','/api/previews/chosen/256.jpg']]);assert.equal(walk(d.root).filter(node=>node.tagName==='IMG').length,0)}finally{view.dispose();await settle()}assert.equal(d.closed,1)
})

test('[MODEL-DOM] first verifiable candidate wins after invalid keyword HEAD; no-match uses source-first; empty stays honest',async()=>{
 for(const mode of ['keyword-fallback','no-match','empty']){const d=dom(),data=metadata('project0',mode==='empty'?[]:[frame('later','普通',{order:8}),frame('first','普通',{order:0}),frame('bad','主画板',{order:2})]),f=coverFetch(projects(1),{meta:()=>data,head:url=>({width:url.includes('/bad/')?300:3,height:2,bytes:jpeg.length})});if(mode==='no-match')data.files[0].pages[0].frames=data.files[0].pages[0].frames.filter(row=>row.id!=='bad');const view=await mount(d,f.fetchAPI)
  try{await settle();assert.equal(d.decoded,mode==='empty'?0:1);const gets=f.calls.filter(row=>row.method==='GET'&&row.pathname.includes('/previews/'));assert.deepEqual(gets.map(row=>row.pathname),mode==='empty'?[]:['/api/previews/first/256.jpg']);if(mode==='empty')assert.match(d.root.querySelector('.project-placeholder').getAttribute('aria-label'),/文件占位/)}finally{view.dispose();await settle()}}
})

for(const fault of ['width','fraction','encoded','mime','truncated','actual-size'])test('[MODEL-DOM] bounded cover fails closed: '+fault,async()=>{
 const d=dom(),f=coverFetch(projects(1),{head:()=>({width:fault==='width'?257:fault==='fraction'?3.5:3,height:2,bytes:fault==='encoded'?2*1024*1024+1:jpeg.length,mime:fault==='mime'?'image/png':'image/jpeg'}),getBytes:()=>fault==='truncated'?jpeg.slice(0,8):jpeg});if(fault==='actual-size')d.window.createImageBitmap=async()=>({width:4,height:2,close(){d.badClosed=true}});const view=await mount(d,f.fetchAPI)
 try{await settle();assert.equal(d.document.draws.length,0);assert.equal(d.root.projectCoverDiagnostics.rows[0].state,'error');if(['width','fraction','encoded','mime'].includes(fault))assert.equal(f.calls.filter(row=>row.method==='GET'&&row.pathname.includes('/previews/')).length,0,'invalid bounded HEAD must never trigger preview GET');if(fault==='actual-size')assert.equal(d.badClosed,true);assert.match(d.root.querySelector('.project-placeholder').getAttribute('aria-label'),/文件占位/)}finally{view.dispose();await settle()}
})

test('[MODEL-DOM] one shared physical2/pixels64Mi/encoded80Mi/native96 pool persists across rerender and closes all bitmaps',async()=>{
 const d=dom(),f=coverFetch(projects(10)),view=await mount(d,f.fetchAPI);try{await settle();const before=d.root.projectCoverDiagnostics.resources;assert.equal(d.decoded,8);assert.deepEqual([before.limits.physical,before.limits.pixels,before.limits.encoded,before.limits.native],[2,67108864,83886080,96]);assert.ok(before.peak.physical<=2);assert.ok(before.peak.pixels<=67108864);assert.ok(before.peak.encoded<=83886080);await view.render();await settle();assert.equal(d.closed,8);assert.equal(d.decoded,16)}finally{view.dispose();await settle()}assert.equal(d.closed,16);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,0)
})

test('[MODEL-DOM] cancelled metadata keeps physical lanes until settlement, then newest search alone gets HEAD/GET',async()=>{
 const held=[],d=dom(),f=coverFetch(projects(10),{meta:(id,signal)=>held.length<2?new Promise(resolve=>held.push({id,signal,resolve})):metadata(id,[frame(id)])}),view=await mount(d,f.fetchAPI)
 try{await settle();const search=walk(d.root).find(node=>node.getAttribute('aria-label')==='搜索项目');search.value='target';await search.fire('input');await settle();assert.equal(held.length,2);assert.ok(held.every(row=>row.signal.aborted));assert.equal(d.root.projectCoverDiagnostics.resources.physical,2);assert.equal(f.calls.filter(row=>row.pathname.endsWith('/canvas')).length,2);for(const row of held)row.resolve(metadata(row.id,[frame(row.id)]));await settle();assert.equal(d.decoded,1);assert.ok(f.calls.filter(row=>row.pathname.includes('/previews/')).every(row=>row.pathname.includes('project9')))}finally{for(const row of held)row.resolve(metadata(row.id,[]));view.dispose();await settle()}
})

test('[MODEL-DOM] abort during bitmap decode never releases leases early and closes stale bitmap without drawing',async()=>{
 const d=dom(),f=coverFetch(projects(1)),gate=deferred();let closed=0;d.window.createImageBitmap=()=>gate.promise;const view=await mount(d,f.fetchAPI)
 try{await settle();for(const fn of d.events.get('pagehide')||[])fn();assert.equal(d.root.projectCoverDiagnostics.resources.physical,1);assert.equal(d.root.projectCoverDiagnostics.resources.decodedAndReservedPixels,6);gate.resolve({width:3,height:2,close(){closed++}});await settle();assert.equal(closed,1);assert.equal(d.document.draws.length,0);assert.equal(d.root.projectCoverDiagnostics.resources.physical,0)}finally{gate.resolve({width:3,height:2,close(){}});view.dispose();await settle()}
})

test('[MODEL-DOM] abort cancels a bounded GET reader and holds physical/encoded leases until reader cancellation settles',async()=>{
 const d=dom(),gate=deferred();let cancelled=0
 const f=coverFetch(projects(1)),view=await mount(d,async(url,o={})=>{if(o.method==='GET'&&String(url).includes('/api/previews/'))return new Response(new ReadableStream({start(controller){controller.enqueue(jpeg.slice(0,8))},cancel(){cancelled++;return gate.promise}}),{headers:{'content-type':'image/jpeg','content-length':String(jpeg.length)}});return f.fetchAPI(url,o)})
 try{await settle();assert.equal(d.root.projectCoverDiagnostics.resources.physical,1);assert.ok(d.root.projectCoverDiagnostics.resources.encodedAndReservedBytes>0);for(const fn of d.events.get('pagehide')||[])fn();await settle();assert.equal(cancelled,1);assert.equal(d.root.projectCoverDiagnostics.resources.physical,1);assert.equal(d.decoded,0);gate.resolve();await settle();assert.equal(d.root.projectCoverDiagnostics.resources.physical,0);assert.equal(d.root.projectCoverDiagnostics.resources.encodedAndReservedBytes,0);assert.equal(d.document.draws.length,0)}finally{gate.resolve();view.dispose();await settle()}
})

const fixturePassword='Synthetic interactivity fixture password 2026'
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'heron-project-interaction-'));await fs.chmod(dir,0o700);const canonical=await fs.realpath(dir);assert.equal(canonical,dir)
 const platform=await createPlatform({dataDir:dir,secret:'synthetic-only-project-fixture-key-32chars',bootstrapAdmin:{username:'admin',password:fixturePassword},logger:{error(){}}}),address=await platform.listen(0),origin='http://127.0.0.1:'+address.port,calls=[];let cookie=''
 t.after(async()=>{await platform.close();assert.equal(await fs.realpath(dir),canonical);assert.equal(path.dirname(canonical),await fs.realpath(os.tmpdir()));assert.match(path.basename(canonical),/^heron-project-interaction-/);await fs.rm(canonical,{recursive:true,force:false})})
 const send=async(url,options={})=>{const target=new URL(url,origin);assert.equal(target.origin,origin);calls.push({url:target.pathname,method:options.method??'GET',body:options.body});const response=await fetch(target,{...options,redirect:'error',headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response}
 const json=async(url,{method='GET',body}={})=>{const response=await send(url,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value}
 const user=(await json('/api/auth/login',{method:'POST',body:{username:'admin',password:fixturePassword}})).user,project=await json('/api/projects',{method:'POST',body:{name:'独立测试项目（空格 ）'}})
 return {platform,origin,calls,send,json,user,project,base:'/api/admin/projects/'+project.id,async reader(name){return (await json('/api/admin/users',{method:'POST',body:{username:name,password:fixturePassword,displayName:name,role:'developer'}})).user}}
}

test('[TCP/Vault + MODEL-DOM] C30 creation excludes all history and closing clears one-time link output',async t=>{
 const h=await fixture(t),base=h.base+'/invites',old=(await h.json(base,{method:'POST',body:{label:'已撤销历史'}})).invite,expired=(await h.json(base,{method:'POST',body:{label:'过期项'}})).invite,exhausted=(await h.json(base,{method:'POST',body:{label:'耗尽项'}})).invite
 await h.json(base+'/'+old.id,{method:'DELETE'});await h.platform.vault.transact(d=>{d.patch('projectInvites',expired.id,{expiresAt:'2000-01-01T00:00:00.000Z'});d.patch('projectInvites',exhausted.id,{usesCount:50})})
 let failRefresh=false;const d=dom(h.origin),view=await mount(d,async(url,o={})=>{if(failRefresh&&url===base&&(o.method??'GET')==='GET')throw Error('synthetic refresh failure');return h.send(url,o)},h.user)
 try{await button(d,'分享').click();const modal=dialog(d);assert.doesNotMatch(modal.textContent,/已撤销历史|过期项|耗尽项/);assert.equal(modal.querySelector('.invite-list'),null);control(d,'label').value='本次新邀请';await submit(d);const current=(await h.json(base)).invites.find(row=>row.label==='本次新邀请'),area=modal.querySelector('.invite-output');assert.ok(current);assert.equal(area.querySelector('textarea').value.includes('/share/'),true);assert.ok(button(d,'复制完整邀请'));assert.equal(button(d,'撤销邀请'),undefined);modal.close();assert.equal(area.childElementCount,0);assert.equal(button(d,'复制完整邀请'),undefined);assert.equal(h.platform.vault.catalog.projectInvites.find(row=>row.id===current.id).status,'active')}finally{view.dispose();modalClose(d)}
})
const modalClose=d=>dialog(d)?.close()

test('[TCP/Vault + MODEL-DOM] delete auto-loads Chinese preview; exact name/ack/token enforced; stale409 refreshes same modal and requires re-confirmation without DELETE replay',async t=>{
 const h=await fixture(t),reader=await h.reader('stale.reader'),d=dom(h.origin),gate=deferred();let hold=false,entered=false
 const view=await mount(d,async(url,o={})=>{if(hold&&url===h.base&&o.method==='DELETE'){entered=true;await gate.promise}return h.send(url,o)},h.user)
 try{await button(d,'删除项目').click();const modal=dialog(d),form=modal.querySelector('form'),ok=form.querySelector('button[type=submit]');assert.equal(d.document.activeElement,control(d,'confirmName'),'initial preflight restores the input focused before disabling');assert.deepEqual(control(d,'confirmName').focusOptions,{preventScroll:true});assert.equal(h.calls.filter(row=>row.url.endsWith('/delete-preview')).length,1);assert.equal(button(d,'刷新预检'),undefined);const text=modal.textContent;for(const label of ['项目成员','项目邀请','邀请领取记录','设计文件','页面','分区','画板','画板版本','版本资源关联','发布会话'])assert.ok(text.includes(label),label);assert.doesNotMatch(text,/projectMembers|projectInvites|inviteClaims|designFiles|frameRevisions|revisionAssets|publishSessions/)
  control(d,'confirmName').value=h.project.name+' ';control(d,'acknowledge').checked=true;await submit(d);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,0);control(d,'confirmName').value=h.project.name;control(d,'acknowledge').checked=false;await submit(d);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,0)
  await h.json(h.base+'/members/'+reader.id,{method:'PUT',body:{}});control(d,'acknowledge').checked=true;modal.scrollTop=147;ok.focus();await submit(d);assert.equal(dialog(d),modal);assert.equal(modal.open,true);assert.equal(d.document.shown.length,1);assert.equal(d.document.closed.length,0);assert.equal(modal.scrollTop,147);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,1);assert.equal(h.calls.filter(row=>row.url.endsWith('/delete-preview')).length,2);assert.equal(control(d,'confirmName').value,'');assert.equal(control(d,'acknowledge').checked,false);assert.equal(d.document.activeElement,control(d,'confirmName'),'fresh stale preview focuses enabled name input, never body or old submit');assert.deepEqual(control(d,'confirmName').focusOptions,{preventScroll:true});assert.match(modal.textContent,/重新确认|重新输入/);assert.match(modal.textContent,/HTTP 409/);await submit(d);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,1)
  control(d,'confirmName').value=h.project.name;control(d,'acknowledge').checked=true;hold=true;const first=submit(d);await settle();assert.equal(entered,true);assert.equal(ok.disabled,true);await form.fire('submit');gate.resolve();await first;const writes=h.calls.filter(row=>row.method==='DELETE');assert.equal(writes.length,2);const firstBody=JSON.parse(writes[0].body),lastBody=JSON.parse(writes[1].body);assert.deepEqual(Object.keys(lastBody).sort(),['acknowledge','confirmName','previewToken']);assert.equal(lastBody.acknowledge,true);assert.equal(lastBody.confirmName,h.project.name);assert.notEqual(firstBody.previewToken,lastBody.previewToken);assert.equal(h.platform.vault.catalog.projects.some(row=>row.id===h.project.id),false)
 }finally{gate.resolve();view.dispose();modalClose(d)}
})

test('[TCP/Vault + MODEL-DOM] active and unknown publish states block deletion; reopen alone gets a fresh authoritative preview',async t=>{
 const h=await fixture(t);await h.platform.vault.transact(d=>d.add('publishSessions',{id:'unknown-session',projectId:h.project.id,status:'unknown-state'}));const d=dom(h.origin),view=await mount(d,h.send,h.user)
 try{await button(d,'删除项目').click();const first=dialog(d);assert.equal(first.querySelector('button[type=submit]').disabled,true);assert.match(first.textContent,/进行中或状态未知/);assert.doesNotMatch(first.textContent,/project_busy/);control(d,'confirmName').value=h.project.name;control(d,'acknowledge').checked=true;await submit(d);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,0);await h.platform.vault.transact(d=>d.patch('publishSessions','unknown-session',{status:'aborted'}));first.close();await button(d,'删除项目').click();assert.equal(dialog(d).querySelector('button[type=submit]').disabled,false);assert.equal(h.calls.filter(row=>row.url.endsWith('/delete-preview')).length,2);assert.equal(button(d,'刷新预检'),undefined)}finally{view.dispose();modalClose(d)}
})

test('[TCP/Vault + MODEL-DOM] unknown deletion outcome locks repeats and retains warnings; preflight failure never removes safety copy',async t=>{
 const h=await fixture(t),d=dom(h.origin),previewGate=deferred();let failPreview=false,holdPreview=false
 const view=await mount(d,async(url,o={})=>{if(url===h.base&&o.method==='DELETE')throw TypeError('synthetic transport loss');if(url.endsWith('/delete-preview')){if(failPreview)throw TypeError('synthetic preflight loss');if(holdPreview)await previewGate.promise}return h.send(url,o)},h.user)
 try{await button(d,'删除项目').click();const modal=dialog(d);control(d,'confirmName').value=h.project.name;control(d,'acknowledge').checked=true;await submit(d);assert.equal(modal.querySelector('button[type=submit]').disabled,true);assert.match(modal.textContent,/禁止重复提交/);assert.match(modal.textContent,/原始资产保留/);assert.ok(modal.querySelector('.error'));await submit(d);assert.equal(h.platform.vault.catalog.projects.length,1);modal.close();failPreview=true;await button(d,'删除项目').click();assert.equal(dialog(d).querySelector('button[type=submit]').disabled,true);assert.match(dialog(d).textContent,/禁止删除/);assert.match(dialog(d).textContent,/必须完成服务器关系与发布状态预检/);assert.ok(d.document.activeElement===d.document.body,'failed preflight does not steal focus back to an input');dialog(d).close();await settle();failPreview=false;holdPreview=true;const opening=button(d,'删除项目').click();await settle();const pendingDialog=dialog(d);pendingDialog.close();await settle();const elsewhere=button(d,'新建项目');elsewhere.focus();previewGate.resolve();await opening;assert.ok(d.document.activeElement===elsewhere,'settled GET cannot restore focus into a closed modal');assert.equal(dialog(d),null);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,0)}finally{previewGate.resolve();view.dispose();modalClose(d)}
})

test('[MODEL-DOM + TCP/Vault] all known technical count keys use Chinese and unknown keys stay non-technical; unknown sessions fail closed',async t=>{
 const h=await fixture(t),d=dom(h.origin),view=await mount(d,async(url,o={})=>{const response=await h.send(url,o);if(!url.endsWith('/delete-preview'))return response;const data=await response.json();data.counts={...data.counts,users:1,projects:2,assets:3,auditLogs:4,rememberedLogins:5,futureInternalTable:6};data.activePublishSessions=null;return Response.json(data)},h.user)
 try{await button(d,'删除项目').click();const modal=dialog(d);for(const label of ['用户','项目','原始资源','审计记录','记住登录记录','其他关联记录'])assert.ok(modal.textContent.includes(label));assert.doesNotMatch(modal.textContent,/futureInternalTable|rememberedLogins|auditLogs|assets/);assert.equal(modal.querySelector('button[type=submit]').disabled,true);assert.match(modal.textContent,/未知（禁止删除）/)}finally{view.dispose();modalClose(d)}
})

test('[TCP/Vault + MODEL-DOM] grant/revoke reconcile authoritative data in the same dialog, preserve focus/scroll and reject double clicks',async t=>{
 const h=await fixture(t),one=await h.reader('member.one'),two=await h.reader('member.two'),spare=await h.reader('member.spare'),disabled=await h.reader('member.disabled');await h.json('/api/admin/users/'+disabled.id,{method:'PATCH',body:{status:'disabled'}});await h.json(h.base+'/members/'+one.id,{method:'PUT',body:{}})
 const d=dom(h.origin),gate=deferred(),revokeGate=deferred();let hold=false,putCount=0,holdRevoke=false,deleteCount=0
 const view=await mount(d,async(url,o={})=>{if(url.startsWith(h.base+'/members/')&&o.method==='PUT'){putCount++;if(hold)await gate.promise}if(url.startsWith(h.base+'/members/')&&o.method==='DELETE'){deleteCount++;if(holdRevoke)await revokeGate.promise}return h.send(url,o)},h.user)
 try{await button(d,'成员').click();const modal=dialog(d),select=walk(modal).find(node=>node.tagName==='SELECT'),grant=button(d,'授予读取'),list=modal.querySelector('.member-list'),oneRow=walk(list).find(node=>node.dataset.userId===one.id);assert.ok(oneRow);assert.ok(!select.children.some(node=>node.value===h.user.id||node.value===disabled.id));assert.equal(button(d,'撤销读取',walk(list).find(node=>node.dataset.userId===h.user.id)),undefined)
  select.value=two.id;grant.focus();modal.scrollTop=238;list.scrollTop=31;hold=true;const first=grant.click();await settle();assert.equal(grant.disabled,true);await grant.fire('click');await button(d,'撤销读取',oneRow).fire('click');assert.equal(putCount,1);assert.equal(h.calls.filter(row=>row.method==='DELETE').length,0);await h.json('/api/admin/users/'+two.id,{method:'PATCH',body:{displayName:'服务器权威新名称'}});gate.resolve();await first;assert.equal(dialog(d),modal);assert.equal(d.document.shown.length,1);assert.equal(d.document.closed.length,0);assert.equal(modal.scrollTop,238);assert.equal(list.scrollTop,31);assert.equal(d.document.activeElement,grant);assert.equal(walk(list).find(node=>node.dataset.userId===one.id),oneRow);assert.match(list.textContent,/服务器权威新名称/);assert.ok(!select.children.some(node=>node.value===two.id));assert.ok(h.calls.filter(row=>row.url===h.base+'/members'&&row.method==='GET').length>=2)
  const twoRow=walk(list).find(node=>node.dataset.userId===two.id),revoke=button(d,'撤销读取',twoRow);revoke.focus();holdRevoke=true;const removing=revoke.click();await settle();await revoke.fire('click');assert.equal(deleteCount,1);revokeGate.resolve();await removing;assert.equal(dialog(d),modal);assert.equal(modal.scrollTop,238);assert.equal(list.scrollTop,31);assert.equal(walk(list).some(node=>node.dataset.userId===two.id),false);assert.ok(select.children.some(node=>node.value===two.id));assert.equal(d.document.activeElement,select);assert.ok(h.platform.vault.catalog.projectMembers.some(row=>row.userId===one.id));assert.ok(!h.platform.vault.catalog.projectMembers.some(row=>row.userId===two.id));assert.equal(h.platform.vault.catalog.users.find(row=>row.id===two.id).role,'developer');assert.equal(h.platform.vault.catalog.projects[0].ownerId,h.user.id)
 }finally{gate.resolve();revokeGate.resolve();view.dispose();modalClose(d)}
})

test('[TCP/Vault + MODEL-DOM] successful grant followed by failed authority GET locks further writes until explicit in-place reread',async t=>{
 const h=await fixture(t),reader=await h.reader('read.failure'),d=dom(h.origin);let fail=false,puts=0
 const view=await mount(d,async(url,o={})=>{if(o.method==='PUT'){puts++;const response=await h.send(url,o);fail=true;return response}if(fail&&url===h.base+'/members')throw Error('synthetic member refresh failure');return h.send(url,o)},h.user)
 try{await button(d,'成员').click();const modal=dialog(d),grant=button(d,'授予读取');await grant.click();assert.equal(puts,1);assert.equal(grant.disabled,true);assert.match(modal.textContent,/不会自动重复/);assert.ok(button(d,'重新读取成员'));await grant.fire('click');assert.equal(puts,1);fail=false;await button(d,'重新读取成员').click();assert.equal(dialog(d),modal);assert.match(modal.querySelector('.member-list').textContent,/read.failure/);assert.ok(h.platform.vault.catalog.projectMembers.some(row=>row.userId===reader.id));assert.equal(d.document.shown.length,1)}finally{view.dispose();modalClose(d)}
})
