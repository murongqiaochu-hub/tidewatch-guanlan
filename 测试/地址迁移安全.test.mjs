// Copy this self-contained file to 测试/地址迁移安全.test.mjs.
// MODEL-SDK/DOM only; all HTTP calls are synthetic stubs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { compileESM } from '../构建/esm-compiler.mjs';
import { inlinePluginUI, pluginFiles } from '../构建/build.mjs';
import { BRAND, applyBrandTokens } from '../品牌/identity.mjs';
const root = new URL('../', import.meta.url);
const ORIGIN='https://new-service.example.test', LEGACY='http://old-service.example.test:4318';
class Element {
  constructor(tag='div',fragment=false){this.tagName=tag.toUpperCase();this.nodeType=fragment?11:1;this.dataset={};this.style={setProperty(){}};this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.events=new Map();this.children=[];this.parentNode=null;}
  addEventListener(k,f){this.events.set(k,[...(this.events.get(k)||[]),f]);}
  removeEventListener(){} focus(){} contains(x){return this===x||this.children.some(child=>child.contains?.(x));}
  setAttribute(k,v){this[k]=v;} getAttribute(k){return this[k];}
  removeChild(node){const index=this.children.indexOf(node);if(index<0)throw new Error('Node is not a child');this.children.splice(index,1);if(node.parentNode===this)node.parentNode=null;return node;}
  insertBefore(node,referenceNode=null){if(referenceNode!==null&&referenceNode.parentNode!==this)throw new Error('Reference node is not a child');if(node===referenceNode)return node;if(node.nodeType===11){for(const child of [...node.children])this.insertBefore(child,referenceNode);return node;}node.parentNode?.removeChild(node);const index=referenceNode===null?this.children.length:this.children.indexOf(referenceNode);if(index<0)throw new Error('Reference node is not a child');this.children.splice(index,0,node);node.parentNode=this;return node;}
  before(...nodes){const parent=this.parentNode;if(!parent)return;for(const node of nodes)parent.insertBefore(node,this);}
  append(...ns){for(const n of ns)this.insertBefore(n,null);if(this.tagName==='SELECT'&&!this.value)this.value=ns[0]?.value||'';}
  replaceChildren(...ns){for(const child of [...this.children])this.removeChild(child);if(this.tagName==='SELECT')this.value='';this.append(...ns);}
  dispatch(k){for(const f of this.events.get(k)||[])f({isTrusted:true,preventDefault(){}});}
}
function verifyInsertionSemantics(makeNode){const parent=makeNode('section'),oldParent=makeNode('aside'),first=Object.assign(makeNode('i'),{label:'first'}),reference=Object.assign(makeNode('b'),{label:'reference'}),tail=Object.assign(makeNode('i'),{label:'tail'}),moved=Object.assign(makeNode('button'),{label:'moved'}),other=Object.assign(makeNode('span'),{label:'other'});parent.append(first,reference,tail);oldParent.append(moved,other);parent.insertBefore(moved,reference);assert.deepEqual(parent.children.map(node=>node.label),['first','moved','reference','tail']);assert.deepEqual(oldParent.children.map(node=>node.label),['other']);assert.equal(moved.parentNode,parent);parent.insertBefore(tail,first);assert.deepEqual(parent.children.map(node=>node.label),['tail','first','moved','reference']);parent.insertBefore(reference,reference);assert.deepEqual(parent.children.map(node=>node.label),['tail','first','moved','reference']);oldParent.append(moved);reference.before(moved,other);assert.deepEqual(parent.children.map(node=>node.label),['tail','first','moved','other','reference']);assert.deepEqual(oldParent.children,[]);assert.equal(moved.parentNode,parent);assert.equal(other.parentNode,parent);const last=Object.assign(makeNode('i'),{label:'last'});parent.insertBefore(last,null);assert.deepEqual(parent.children.map(node=>node.label),['tail','first','moved','other','reference','last']);}
test('MODEL DOM fixture: insertBefore/before preserve order and reparent nodes',()=>verifyInsertionSemantics(tag=>new Element(tag)));
function attachQuotaAnchors(nodes){const page=nodes.get('production-project-page'),searchParent=new Element('label'),popover=nodes.get('production-create-popover'),errorParent=new Element('div');page.append(searchParent);searchParent.append(nodes.get('production-project-search'));popover.append(errorParent);errorParent.append(nodes.get('production-create-error'));}
function assertQuotaPlacement($){const page=$('production-project-page'),searchParent=$('production-project-search').parentNode,pageIndex=page.children.indexOf(searchParent),error=$('production-create-error'),errorIndex=error.parentNode.children.indexOf(error);assert.ok(searchParent&&pageIndex>0);assert.equal(page.children[pageIndex-1].dataset.accountQuota,'true');assert.ok(error.parentNode&&errorIndex>0);assert.equal(error.parentNode.children[errorIndex-1].dataset.accountQuota,'true');}
const wire=v=>Array.isArray(v)?v.map(wire):v&&typeof v==='object'?Object.assign(Object.create(null),Object.fromEntries(Object.entries(v).map(([k,x])=>[k,wire(x)]))):v;
const settle=async(predicate,describe)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('lifecycle did not settle: '+describe());};
async function fixture(rememberedOrigin){
  const sources=new Map(await Promise.all(pluginFiles.map(async name=>[name,applyBrandTokens(await fs.readFile(new URL(name,root),'utf8'))])));
  const config={serviceOrigin:ORIGIN,serviceOrigins:[ORIGIN,LEGACY],allowLocalhost:false};
  const prefix=`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify(config)});\n`;
  const mainCode=prefix+compileESM(sources,'插件/main.mjs').code,uiCode=prefix+compileESM(sources,'插件/ui.mjs').code;
  const html=inlinePluginUI(sources.get('插件/ui.html'),sources.get('插件/ui.css'),uiCode).replace('content="disabled"','content="enabled"');
  const nodes=new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m=>[m[2],new Element(m[1])]));attachQuotaAnchors(nodes);
  const $=k=>nodes.get(k);$('scope').value='selection';$('scale').value='1';
  const doc={getElementById:k=>nodes.get(k)||null,createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t),addEventListener(){},removeEventListener(){},querySelectorAll:()=>[],querySelector(q){if(q==='meta[name="independent-production"]')return{content:'enabled'};if(q==='meta[name="figma-parent-origin"]')return{content:'https://www.figma.com'};return q.startsWith('#')?nodes.get(q.slice(1))||null:null;}};
  const key='independent-inspector.publish.pending.v1.production-refresh';
  const remembered={origin:rememberedOrigin,allowLocalhost:false,username:'synthetic',refreshToken:'SYNTHETIC_PRIOR_TOKEN',refreshExpiresAt:Date.now()+86400000};
  const storage=new Map([[key,remembered]]),events=new Set(),calls=[];let callback,shown=0;
  const parent={postMessage(data,target){assert.equal(target,'*');queueMicrotask(()=>callback?.(wire(data.pluginMessage),{origin:'null'}));}};
  const user={id:'usr_synthetic',username:'synthetic',role:'admin'};
  const win={parent,crypto:webcrypto,AbortController,setTimeout,clearTimeout,addEventListener(_,f){events.add(f);},removeEventListener(_,f){events.delete(f);},async fetch(url,options){
    calls.push({url,body:options.body?JSON.parse(new TextDecoder().decode(options.body)):null});
    if(url.endsWith('/api/auth/refresh'))return Response.json({error:'synthetic temporary outage'},{status:503});
    if(url.endsWith('/api/auth/login'))return Response.json({token:'SYNTHETIC_ACCESS',user});
    if(url.endsWith('/api/auth/me'))return Response.json(user);
    if(url.endsWith('/api/auth/remembered-logout'))return Response.json({ok:true});
    return Response.json({projects:[]});
  }};
  const sdk={editorType:'figma',root:{id:'0:0',name:'Synthetic'},currentPage:{id:'1:1',name:'Synthetic',selection:[],children:[]},clientStorage:{async getAsync(k){return wire(storage.get(k));},async setAsync(k,v){storage.set(k,v);}},ui:{resize(){},postMessage(data,options){assert.equal(options.origin,'*');queueMicrotask(()=>{for(const f of events)f({source:parent,origin:'null',data:wire({pluginMessage:data})});});}},showUI(_html,options){shown++;assert.equal(options.title,BRAND.pluginName);callback=sdk.ui.onmessage;vm.runInNewContext(uiCode,{window:win,document:doc,Uint8Array,ArrayBuffer,DataView,URL,TextEncoder,TextDecoder,setTimeout,clearTimeout});}};
  const context=vm.createContext({figma:sdk,__html__:html,Uint8Array,ArrayBuffer,DataView,setTimeout,clearTimeout});
  vm.runInContext(mainCode,context);
  const describe=()=>$('status').textContent+' / '+$('production-auth-status').textContent;
  await settle(()=>['服务地址已更新','自动登录未完成'].some(text=>String($('production-auth-status').textContent||'').includes(text))&&!$('production-login').disabled,describe);
  assertQuotaPlacement($);
  assert.equal(vm.runInContext('typeof URL',context),'undefined');
  assert.equal(shown,1,'main/UI have separate valid injected lexical bootstraps; main must showUI exactly once');
  const before=JSON.stringify([...storage]);
  assert.equal(before,JSON.stringify([[key,remembered]]),'blocked/failed automatic refresh must preserve prior remembered origin and token');
  return {$,calls,storage,key,remembered,describe,async login(){
    $('production-origin').value=ORIGIN;$('production-remember').checked=false;$('production-username').value='synthetic';$('production-password').value='SYNTHETIC_PASSWORD';$('production-login').dispatch('click');
    await settle(()=>$('app').dataset.productionStage==='workspace'&&!$('production-login').disabled,describe);
    assert.equal($('production-password').value,'');assert.equal(storage.get(key),null);
  }};
}
test('compiled migration: manual new-service login never sends old-origin remembered token',async()=>{
  const f=await fixture(LEGACY);assert.equal(f.calls.length,0,'legacy remembered resume must fail closed before HTTP');await f.login();
  assert.ok(f.calls.every(c=>c.body?.refreshToken!==f.remembered.refreshToken),'prior refresh token must not cross origin, even for revocation');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/api/auth/login')).length,1);
  assert.ok(f.$('production-auth-status').textContent.includes('原服务撤销尚未确认'),'local clear does not prove remote revocation');
});
test('compiled same-service login still revokes remembered token on its exact original origin',async()=>{
  const f=await fixture(ORIGIN);await f.login();
  const revoked=f.calls.filter(c=>c.url.endsWith('/api/auth/remembered-logout'));
  assert.equal(revoked.length,1);assert.equal(new URL(revoked[0].url).origin,ORIGIN);assert.equal(revoked[0].body.refreshToken,f.remembered.refreshToken);
  assert.ok(!f.$('production-auth-status').textContent.includes('原服务撤销尚未确认'));
});
