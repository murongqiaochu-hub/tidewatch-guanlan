process.env.HANDOFF_PUBLIC_ORIGIN ||= 'https://service.example.test:49156';
// Real ephemeral Node HTTP + explicitly separate DOM/Canvas models. NOT Chrome/Figma/Device/visual/legal clearance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlatform } from '../平台/服务.mjs';
import { safeLocalNext as serverNext, installWebPages } from '../平台/网页.mjs';
import { mountWebApp, safeLocalNext as clientNext, projectInviteText, sliceZipPlan } from '../界面/app.mjs';
import { createHash } from 'node:crypto';
import { createProductionHTTP, validatePrepareResult, validateCommitResult } from '../插件/production-protocol.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';
import * as resourceAPI from '../查看器/resources.mjs';
import { syntheticPluginRelease } from './插件发行测试工具.mjs';
import { readStoredPluginZIP } from '../平台/插件发行.mjs';
import { storedZip } from '../宿主/stored-zip.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const walk=n=>[n,...n.children.flatMap(walk)];
const desc=(n,s)=>walk(n).filter(x=>matches(x,s));
function matches(n,s){if(s.startsWith('#'))return n.id===s.slice(1);if(s.startsWith('.'))return n.className.split(/\s+/).includes(s.slice(1));const m=s.match(/^(\w+)?\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]$/);if(m)return (!m[1]||n.tagName===m[1].toUpperCase())&&(m[3]===undefined?n.getAttribute(m[2])!==null:String(n[m[2]]??n.getAttribute(m[2]))===m[3]);return n.tagName===s.toUpperCase();}
class Element{
 constructor(doc,tag,type=1){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),nodeType:type,children:[],parentNode:null,attributes:new Map(),events:new Map(),style:{},dataset:{},className:'',id:'',name:'',type:'',disabled:false,hidden:false,checked:false,open:false,required:false,readOnly:false,autocomplete:'',_text:'',_value:undefined});this.classList={add:s=>{this.className+=' '+s;}};}
 append(...nodes){for(const node of nodes){node.parentNode?.removeChild(node);node.parentNode=this;this.children.push(node);}}
 prepend(node){this.append(node);this.children.unshift(this.children.pop());}removeChild(node){this.children=this.children.filter(x=>x!==node);node.parentNode=null;}remove(){this.parentNode?.removeChild(this);}replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
 get childElementCount(){return this.children.filter(n=>n.nodeType===1).length;}set textContent(s){this._text=String(s);this.children=[];}get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}set value(v){this._value=String(v);}get value(){return this._value??(this.tagName==='SELECT'?this.children.find(n=>n.tagName==='OPTION')?.value??'':'');}
 setAttribute(k,v){this.attributes.set(k,String(v));if(['id','name','type','role','content'].includes(k))this[k]=String(v);if(k==='class')this.className=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}getAttribute(k){return this.attributes.get(k)??null;}
 querySelectorAll(s){return s===':scope > .error'?this.children.filter(n=>matches(n,'.error')):desc(this,s).filter(n=>n!==this);}querySelector(s){return this.querySelectorAll(s)[0]??null;}closest(s){for(let n=this;n;n=n.parentNode)if(matches(n,s))return n;return null;}
 addEventListener(k,f){const a=this.events.get(k)??[];a.push(f);this.events.set(k,a);}removeEventListener(k,f){this.events.set(k,(this.events.get(k)??[]).filter(x=>x!==f));}async fire(k,e={}){for(const f of this.events.get(k)??[])await f({type:k,target:this,currentTarget:this,preventDefault(){},...e});}click(){if(this.disabled)return Promise.resolve();if(this.tagName==='SUMMARY'){this.parentNode.open=!this.parentNode.open;}return this.fire('click');}focus(){this.ownerDocument.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;void this.fire('close');}select(){}setPointerCapture(id){this.capture=id;}hasPointerCapture(id){return this.capture===id;}releasePointerCapture(){this.capture=null;}
 getBoundingClientRect(){return {x:0,y:0,left:0,top:0,right:800,bottom:600,width:800,height:600};}getContext(){if(!this.context)this.context=new Proxy({measureText:s=>({width:String(s).length*6}),drawImage:(...args)=>this.ownerDocument.draws.push(args),strokeRect:(...args)=>this.ownerDocument.boxes.push(args)},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});return this.context;}
}
function dom(origin='https://fixture.invalid'){
 const document={draws:[],boxes:[],createElement(tag){return new Element(this,tag);},createTextNode(text){const n=new Element(this,'text',3);n.textContent=text;return n;},querySelector(s){return this.body.querySelector(s);},addEventListener(){},removeEventListener(){}};document.body=document.createElement('body');const app=document.createElement('main');app.id='app';document.body.append(app);const entries=new Map(),assigned=[],queue=new Map();let serial=0;
 class FormDataModel{constructor(form){this.values=walk(form).filter(n=>['INPUT','SELECT','TEXTAREA'].includes(n.tagName)&&n.name&&!n.disabled&&(n.type!=='checkbox'||n.checked)).map(n=>[n.name,n.value]);}*[Symbol.iterator](){yield* this.values;}}
 const events=new Map(),timers=new Map();let timerSerial=0;const location={origin,href:origin+'/projects',pathname:'/projects',search:'',assign:url=>assigned.push(url)},window={document,location,FormData:FormDataModel,navigator:{clipboard:{writeText:async s=>{window.copied=s;}}},localStorage:{getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)},setTimeout(callback){const id=++timerSerial;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);},addEventListener(k,f){const a=events.get(k)??[];a.push(f);events.set(k,a);},removeEventListener(k,f){events.set(k,(events.get(k)??[]).filter(x=>x!==f));}};
 return {document,window,app,entries,assigned,queue,raf:fn=>(queue.set(++serial,fn),serial),cancel:id=>queue.delete(id),flush(){const q=[...queue.values()];queue.clear();q.forEach(f=>f());}};
}
const button=(d,label)=>walk(d.document.body).find(n=>n.tagName==='BUTTON'&&n.textContent===label);
const input=(d,name)=>walk(d.document.body).find(n=>n.name===name);
const password='Synthetic fixture password 2026';
async function fixture(t,{archiveFixtures=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'heron-web-ui-')),real=await fs.realpath(dir);assert.equal(real,dir);await fs.chmod(dir,0o700);
 const artifacts={};if(archiveFixtures){for(const [key,name]of [['sourceArchive','source.zip'],['pluginArchive','plugin.zip'],['legacySourceArchive','legacy.zip']]){const file=path.join(dir,name),emptyZIP=Buffer.alloc(22);emptyZIP.writeUInt32LE(0x06054b50);await fs.writeFile(file,key==='pluginArchive'?syntheticPluginRelease():emptyZIP,{mode:0o600});artifacts[key]=file;}}
 const platform=await createPlatform({dataDir:dir,secret:'synthetic-ui-fixture-secret-32-characters',bootstrapAdmin:{username:'admin',password},logger:{error(){}},artifacts});const address=await platform.listen(0),origin=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{await platform.close();assert.equal(await fs.realpath(dir),real);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert.match(path.basename(real),/^heron-web-ui-/);await fs.rm(real,{recursive:true});});
 const client=()=>{let cookie='';const calls=[];const send=async(url,options={})=>{const absolute=new URL(url,origin);assert.equal(absolute.origin,origin);const response=await fetch(absolute,{...options,redirect:'error',headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];calls.push({url:absolute.pathname+absolute.search,method:options.method??'GET',body:options.body});return response;};const json=async(url,{method='GET',body,...options}={})=>{const response=await send(url,{...options,method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};return {send,json,calls};};
 const admin=client(),logged=await admin.json('/api/auth/login',{method:'POST',body:{username:'admin',password}});return {platform,origin,admin,adminUser:logged.user,client};
}
test('C30 project toolbar removes invitation and card share directly creates without history',async t=>{
 const h=await fixture(t);await h.admin.json('/api/projects',{method:'POST',body:{name:'Invite project'}});const d=dom(h.origin),view=await mountWebApp({document:d.document,window:d.window,root:d.app,context:{page:'projects',user:h.adminUser},fetchAPI:h.admin.send});t.after(()=>view.dispose());assert.equal(button(d,'邀请'),undefined);await button(d,'分享').click();assert.ok(button(d,'创建邀请'));assert.equal(h.platform.vault.catalog.projectInvites.length,0);assert.equal(d.document.querySelector('.invite-list'),null);await d.document.querySelector('dialog').querySelector('form').fire('submit');assert.equal(h.platform.vault.catalog.projectInvites.length,1);assert.ok(button(d,'复制完整邀请'));
});
test('C30 multiple projects do not reintroduce toolbar invitation',async t=>{
 const h=await fixture(t);for(const name of ['First','Second'])await h.admin.json('/api/projects',{method:'POST',body:{name}});const d=dom(h.origin),view=await mountWebApp({document:d.document,window:d.window,root:d.app,context:{page:'projects',user:h.adminUser},fetchAPI:h.admin.send});t.after(()=>view.dispose());assert.equal(button(d,'邀请'),undefined);await button(d,'分享').click();assert.ok(button(d,'创建邀请'));assert.equal(h.platform.vault.catalog.projectInvites.length,0);assert.equal(input(d,'projectId').value,h.platform.vault.catalog.projects[0].id);
});
for(const role of ['admin','designer'])test(`C29 new registration belongs to ${role} inviter; existing account owner unchanged`,async t=>{
 const h=await fixture(t);let actor=h.admin,user=h.adminUser;if(role==='designer'){await h.admin.json('/api/admin/users',{method:'POST',body:{username:'designer29',password,role}});actor=h.client();user=(await actor.json('/api/auth/login',{method:'POST',body:{username:'designer29',password}})).user;}
 const project=await actor.json('/api/projects',{method:'POST',body:{name:'Scope'}}),{invite}=await actor.json(`/api/admin/projects/${project.id}/invites`,{method:'POST',body:{expiresDays:7,maxUses:3}}),member=h.client(),registered=await member.json(`/api/invites/${invite.rawToken}/register`,{method:'POST',body:{username:'new29',password,displayName:'New'}});assert.equal(registered.user.ownerId,user.id);assert.equal(registered.user.role,'developer');assert.ok((await actor.json('/api/admin/users')).users.some(u=>u.id===registered.user.id));
 const other=await h.admin.json('/api/admin/users',{method:'POST',body:{username:'existing29',password,role:'developer',ownerId:h.adminUser.id}}),existing=h.client();await existing.json('/api/auth/login',{method:'POST',body:{username:'existing29',password}});await existing.json(`/api/invites/${invite.rawToken}/claim`,{method:'POST',body:{}});assert.equal(h.platform.vault.catalog.users.find(u=>u.id===other.user.id).ownerId,h.adminUser.id);
});
test('C29 account manager visible only for developers and hidden value is not submitted',async t=>{
 const h=await fixture(t);const created=await h.admin.json('/api/admin/users',{method:'POST',body:{username:'designer29',password,role:'designer',displayName:'Designer'}});const d=dom(h.origin),view=await mountWebApp({document:d.document,window:d.window,root:d.app,context:{page:'accounts',user:h.adminUser},fetchAPI:h.admin.send});t.after(()=>view.dispose());const targetRow=walk(d.document.body).find(node=>node.tagName==='TR'&&node.dataset.accountId===created.user.id),editButton=targetRow&&walk(targetRow).find(node=>node.tagName==='BUTTON'&&node.textContent==='编辑资料');assert.ok(editButton);await editButton.click();assert.equal(input(d,'ownerId').disabled,true);assert.equal(input(d,'ownerId').parentNode.hidden,true);assert.match(input(d,'ownerId').parentNode.textContent,/账号管理人/);input(d,'role').value='developer';await input(d,'role').fire('change');assert.equal(input(d,'ownerId').disabled,false);input(d,'role').value='designer';await input(d,'role').fire('change');input(d,'displayName').value='Designer updated';await d.document.querySelector('dialog').querySelector('form').fire('submit');const call=h.admin.calls.find(c=>c.method==='PATCH'&&c.url.endsWith(created.user.id));assert.ok(call);assert.equal(Object.hasOwn(JSON.parse(call.body),'ownerId'),false);
});
test('C29 explanatory download note removed, menu and both actions retained',async()=>{const source=await fs.readFile(new URL('../界面/app.mjs',import.meta.url),'utf8');assert.ok(source.includes("menu('更多下载',[filteredZip,allZip]"));assert.ok(!source.includes('当前筛选与全项目分别准备；不替代跨页所选项。'));});
const bootOf=html=>JSON.parse(html.match(/<script type="application\/json" id="app-context"[^>]*>([\s\S]*?)<\/script>/)?.[1]??'null');

