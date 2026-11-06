// Synthetic compiled SDK/DOM and fetch only; no live service or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { compileESM } from '../构建/esm-compiler.mjs';
import { pluginFiles } from '../构建/build.mjs';
import { customHTTPSOrigin, createProductionHTTP } from '../插件/production-protocol.mjs';
const custom = { serviceMode:'custom-https', serviceOrigin:null, serviceOrigins:[], allowLocalhost:false };
const A='https://a.example.test:9443', B='https://[2001:db8::2]:8443';
const remembered = {origin:A,allowLocalhost:false,username:'old-user',refreshToken:'synthetic-old-refresh',refreshExpiresAt:4102444800000};
const rememberKey='independent-inspector.publish.pending.v1.production-refresh';
const good = [
 ['HTTPS://EXAMPLE.TEST:443/','https://example.test'],['https://10.0.0.1:9443','https://10.0.0.1:9443'],
 ['https://[2001:0DB8:0:0:0:0:0:2]:8443',B],['https://[::1]','https://[::1]'],
 ['https://[::ffff:192.0.2.1]','https://[::ffff:c000:201]'],['https://xn--fiqs8s.test','https://xn--fiqs8s.test']
];
const bad=['','http://a.test','http://192.168.1.2','https://user@a.test','https://u:p@a.test','https://a.test/path','https://a.test/?q=1','https://a.test#','https://a.test?','https://a.test\\evil','https://a.test\n','https://a.test\u007f','https://a..test','https://-a.test','https://a_test','https://a.test:0','https://a.test:65536','https://127.1','https://0127.0.0.1','https://256.1.1.1','https://0x7f000001','https://a.123','https://[1:2:3]','https://[1::2::3]','https://[1:2:3:4:5:6:7:8::]','https://[::ffff:999.0.0.1]','https://[fe80::1%25eth0]','https://%61.test','https:////a.test'];
test('strict custom HTTPS origin normalization and malformed authority rejection',()=>{
 for(const [input,want]of good){assert.equal(customHTTPSOrigin(input),want);assert.equal(new URL(want).origin,want)}
 for(const input of bad)assert.throws(()=>customHTTPSOrigin(input),e=>e.code==='BAD_ORIGIN',input);
});
class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.dataset={};this.style={setProperty(){}};this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.events=new Map();this.children=[];this.textContent='';}
 addEventListener(k,f){this.events.set(k,[...(this.events.get(k)||[]),f]);} removeEventListener(){} focus(){} scrollIntoView(){} setAttribute(k,v){this[k]=v;}
 append(...nodes){for(const n of nodes){if(n.parentNode)n.parentNode.children=n.parentNode.children.filter(x=>x!==n);n.parentNode=this;this.children.push(n)}if(this.tagName==='SELECT'&&!this.value)this.value=nodes[0]?.value||'';}
 insertBefore(n){this.append(n)} before(n){this.parentNode?.append(n)}
 replaceChildren(...nodes){this.children=[];if(this.tagName==='SELECT')this.value='';this.append(...nodes)}
 dispatch(k,extra={}){for(const f of this.events.get(k)||[])f({isTrusted:true,preventDefault(){},...extra})}
}
const wire=v=>Array.isArray(v)?v.map(wire):v&&typeof v==='object'?Object.assign(Object.create(null),Object.fromEntries(Object.entries(v).map(([k,x])=>[k,wire(x)]))):v;
const settle=async p=>{for(let i=0;i<300;i++){if(p())return;await new Promise(r=>setTimeout(r,5))}assert.ok(p(),'fixture did not settle')};
async function fixture({saved=null,config=custom}={}){
 const sources=new Map(await Promise.all(pluginFiles.map(async n=>[n,await fs.readFile(new URL('../'+n,import.meta.url),'utf8')])));
 sources.set('插件/ui.mjs',sources.get('插件/ui.mjs').replace('mountPluginUI();','globalThis.fixtureUI = mountPluginUI();'));
 const html=sources.get('插件/ui.html'), mainCode=compileESM(sources,'插件/main.mjs').code, uiCode=compileESM(sources,'插件/ui.mjs').code;
 const nodes=new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m=>[m[2],new Element(m[1])]));
 const $=k=>nodes.get(k);$('scope').value='selection';$('design-scale').value='1';
 for(const name of ['production-origin','production-remember']){const label=new Element('label');label.append($(name));$('production-login-form').append(label)}
 $('production-project-page').append($('production-project-search'));$('production-create-popover').append($('production-create-error'));
 const doc={getElementById:$,createElement:t=>new Element(t),createElementNS:(_n,t)=>new Element(t),addEventListener(){},removeEventListener(){},querySelector(q){if(q==='meta[name="independent-production"]')return{content:'enabled'};if(q==='meta[name="figma-parent-origin"]')return{content:'https://www.figma.com'};return q[0]==='#'?$(q.slice(1)):null}};
 const storage=new Map(saved?[[rememberKey,wire(saved)]]:[]),calls=[],listeners=new Set(),user={id:'user_fixture',username:'fixture',role:'admin'};let callback,uiContext,releaseClaim=null,holdClaim=false;
 const parent={postMessage(data,target){assert.equal(target,'*');queueMicrotask(()=>callback?.(wire(data.pluginMessage),{origin:'null'}))}};
 const win={parent,crypto:webcrypto,AbortController,setTimeout,clearTimeout,addEventListener(_k,f){listeners.add(f)},removeEventListener(_k,f){listeners.delete(f)},async fetch(url,options){
  const u=new URL(url);calls.push({origin:u.origin,path:u.pathname,options});assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
  let value;
  if(u.pathname==='/api/auth/login')value={token:'synthetic-access',user,...(JSON.parse(new TextDecoder().decode(options.body)).rememberLogin?{refreshToken:'synthetic-new-refresh',refreshExpiresAt:4102444800000}:{})};
  else if(u.pathname==='/api/auth/refresh')value={token:'synthetic-access',user,refreshExpiresAt:4102444800000};
  else if(u.pathname==='/api/auth/me')value=user;
  else if(u.pathname==='/api/account/self')value={...user,expiresAt:null,projectLimit:null,ownedProjectCount:1};
  else if(u.pathname==='/api/projects')value={projects:[{id:'project_fixture',name:'Project '+u.origin,permissions:{canPublish:true}}]};
  else if(u.pathname.endsWith('/groups'))value={groups:[]};
  else if(u.pathname==='/api/publish/intent')value={projectId:'project_fixture',operationId:'op_'+'a'.repeat(32)+'_'+'b'.repeat(64)};
  else if(u.pathname==='/api/publish/operations'){if(holdClaim)await new Promise(resolve=>{releaseClaim=resolve});throw new TypeError('synthetic uncertain claim')}
  else if(u.pathname==='/api/auth/remembered-logout')value={ok:true};
  else throw Error('unexpected fixture request '+u.pathname);
  return Response.json(value);
 }};
 const frame={id:'2:1',type:'FRAME',name:'Fixture frame'};
 const sdk={editorType:'figma',root:{id:'0:0',name:'Fixture'},fileKey:'fixtureFile',currentPage:{id:'1:1',name:'Page',selection:[frame],children:[frame]},clientStorage:{async getAsync(k){return storage.get(k)},async setAsync(k,v){storage.set(k,v)},async keysAsync(){return [...storage.keys()]}},ui:{resize(){},postMessage(data){queueMicrotask(()=>{for(const f of listeners)f({source:parent,origin:'null',data:wire({pluginMessage:data})})})}},showUI(){callback=sdk.ui.onmessage;uiContext=vm.createContext({window:win,document:doc,btoa,URL,Uint8Array,ArrayBuffer,DataView,TextEncoder,TextDecoder,setTimeout,clearTimeout,__INDEPENDENT_PRODUCTION__:config});vm.runInContext(uiCode,uiContext)}};
 const mainContext=vm.createContext({figma:sdk,__html__:html,__INDEPENDENT_PRODUCTION__:config,Uint8Array,ArrayBuffer,DataView,setTimeout,clearTimeout});vm.runInContext(mainCode,mainContext);
 await settle(()=>uiContext?.fixtureUI);await uiContext.fixtureUI.ready;
 const command=(action,payload={})=>vm.runInContext(`fixtureUI.bridge.request('production-control', ${JSON.stringify({action,...payload})})`,uiContext);
 return {$,calls,storage,mainContext,command,async close(){await uiContext.fixtureUI.dispose()},async login(origin=A){if(origin!==$('production-origin').value){$('production-origin').value=origin;$('production-origin').dispatch('input')}$('production-username').value='new-user';$('production-password').value='synthetic-new-password';$('production-login').dispatch('click');await settle(()=>$('app').dataset.productionStage==='workspace'&&!$('production-login').disabled)},hold(){holdClaim=true},claimReady:()=>Boolean(releaseClaim),release(){releaseClaim?.()}};
}
test('custom starts blank without HTTP; URL-less main accepts domains, IPv4 and IPv6 only',async()=>{
 const f=await fixture();try{
 assert.equal(vm.runInContext('typeof URL',f.mainContext),'undefined');assert.equal(f.$('production-origin').value,'');assert.equal(f.calls.length,0);assert.match(f.$('production-auth-status').textContent,/HTTPS/);
 for(const [input,origin]of good)await f.command('connect-account',{service:{origin,allowLocalhost:false},namespace:'src_fixture_'+'a'.repeat(32)});
 for(const origin of bad)await assert.rejects(async()=>f.command('connect-account',{service:{origin,allowLocalhost:false},namespace:'src_fixture_'+'a'.repeat(32)}));
 assert.equal(f.calls.length,0);
 }finally{await f.close()}
});
test('saved login requires exact displayed origin and explicit restore; stale restore never switches back',async()=>{
 const f=await fixture({saved:remembered});try{
 assert.equal(f.calls.length,0);assert.equal(f.$('production-origin').value,A);assert.match(f.$('production-resume').textContent,/a\.example\.test:9443/);assert.equal(f.$('production-resume').hidden,false);
 f.$('production-origin').value=B;f.$('production-origin').dispatch('input');assert.equal(f.$('production-username').value,'');assert.equal(f.$('production-resume').disabled,true);
 f.$('production-resume').dispatch('click');await settle(()=>!f.$('production-login').disabled);assert.equal(f.calls.length,0);assert.equal(f.$('production-origin').value,B);
 f.$('production-remember').checked=true;await f.login(B);assert.ok(f.calls.every(c=>c.origin===B));assert.equal(f.storage.get(rememberKey).refreshToken,remembered.refreshToken);assert.equal(f.storage.get(rememberKey).origin,A);
 assert.ok(!f.calls.some(c=>c.path==='/api/auth/refresh'||c.path==='/api/auth/remembered-logout'));
 const sent=JSON.parse(new TextDecoder().decode(f.calls.find(c=>c.path==='/api/auth/login').options.body));assert.equal(sent.username,'new-user');assert.equal(sent.password,'synthetic-new-password');
 f.$('production-origin').value=A;f.$('production-origin').dispatch('input');assert.equal(f.$('app').dataset.productionStage,'login');assert.equal(f.$('production-project').children.length,0);
 f.$('production-resume').dispatch('click');await settle(()=>f.calls.some(c=>c.path==='/api/auth/refresh')&&!f.$('production-login').disabled);assert.ok(f.calls.filter(c=>c.path==='/api/auth/refresh').every(c=>c.origin===A));
 }finally{await f.close()}
});
test('local clear of another server remembered login never sends old refresh to new server',async()=>{
 const f=await fixture({saved:remembered});try{f.$('production-origin').value=B;f.$('production-origin').dispatch('input');f.$('production-logout').dispatch('click');await settle(()=>f.storage.get(rememberKey)===null&&!f.$('production-login').disabled);assert.equal(f.calls.length,0)}finally{await f.close()}
});
test('switch clears access token/project groups and requires login; active and unknown uploads cannot switch',async()=>{
 const f=await fixture();try{
 await f.login(A);f.$('production-origin').value=B;f.$('production-origin').dispatch('input');assert.equal(f.$('app').dataset.productionStage,'login');assert.equal(f.$('production-password').value,'');assert.equal(f.$('production-project').children.length,0);
 const before=f.calls.length;await f.login(B);assert.ok(f.calls.slice(before).every(c=>c.origin===B));assert.equal(f.calls[before].options.headers.Authorization,undefined);
 f.hold();f.$('publish').dispatch('click');try{await settle(f.claimReady)}catch(e){e.message+=JSON.stringify({status:f.$('status').textContent,count:f.$('selection-summary').textContent,project:f.$('production-project').value,disabled:f.$('publish').disabled,calls:f.calls.map(c=>c.path),state:(await f.command('status')).state});throw e}
 const status=await f.command('status');assert.equal(status.state.locked,true);
 await assert.rejects(async()=>f.command('connect-account',{service:{origin:A,allowLocalhost:false},namespace:'src_other_'+'c'.repeat(32)}),e=>e.code==='BUSY');
 f.release();await settle(()=>!f.$('production-login').disabled);const unknown=await f.command('status');assert.equal(unknown.state.phase,'unknownClaim');assert.equal(unknown.state.service.origin,B);assert.equal(f.$('production-origin').disabled,true);
 await assert.rejects(async()=>f.command('connect-account',{service:{origin:A,allowLocalhost:false},namespace:'src_other_'+'c'.repeat(32)}),e=>e.code==='UNKNOWN_COMMIT');
 f.$('production-origin').value=A;f.$('production-origin').dispatch('input');assert.equal(f.$('production-origin').value,B);assert.equal((await f.command('status')).state.phase,'unknownClaim');
 await assert.rejects(async()=>f.command('publish',{projectId:'project_fixture',scope:'selection',scale:1,includeSlices:true,chunkCapacity:16}),e=>e.code==='UNKNOWN_COMMIT');
 assert.equal(f.calls.filter(c=>c.path==='/api/publish/operations').length,1);
 }finally{f.release();await f.close()}
});
test('editing back to the same saved origin creates a fresh client and still requires explicit restoration',async()=>{
 const f=await fixture({saved:remembered});try{
 f.$('production-resume').dispatch('click');await settle(()=>f.$('app').dataset.productionStage==='workspace'&&!f.$('production-login').disabled);
 const before=f.calls.length;f.$('production-origin').value=A;f.$('production-origin').dispatch('input');assert.equal(f.$('app').dataset.productionStage,'login');assert.equal(f.calls.length,before);
 f.$('production-resume').dispatch('click');await settle(()=>f.$('app').dataset.productionStage==='workspace'&&!f.$('production-login').disabled);assert.equal(f.calls.filter(c=>c.path==='/api/auth/refresh').length,2);
 }finally{await f.close()}
});
test('invalid custom login never dispatches HTTP and clears entered password',async()=>{
 const f=await fixture();try{for(const origin of bad){f.$('production-origin').value=origin;f.$('production-username').value='fixture';f.$('production-password').value='synthetic-password';f.$('production-login').dispatch('click');await settle(()=>!f.$('production-login').disabled&&f.$('production-password').value==='');assert.equal(f.calls.length,0)}}finally{await f.close()}
});
test('fixed no-mode release still autorestores only its configured origin',async()=>{
 const f=await fixture({saved:remembered,config:{serviceOrigin:A,serviceOrigins:[A],allowLocalhost:false}});try{assert.equal(f.$('app').dataset.productionStage,'workspace');assert.equal(f.calls.filter(c=>c.path==='/api/auth/refresh').length,1);assert.ok(f.calls.every(c=>c.origin===A))}finally{await f.close()}
});
test('HTTP transport retains redirect:error and rejects a cross-origin redirected response',async()=>{
 const seen=[];const client=createProductionHTTP({origin:A,fetchAPI:async(url,options)=>{seen.push({url,options});const response=Response.json({token:'synthetic-access',user:{}});Object.defineProperty(response,'redirected',{value:true});Object.defineProperty(response,'url',{value:B+'/api/auth/login'});return response}});
 await assert.rejects(client.login({username:'fixture',password:'synthetic-password'}),e=>e.code==='HTTP_RESPONSE_INVALID');assert.equal(seen.length,1);assert.equal(seen[0].options.redirect,'error');assert.equal(new URL(seen[0].url).origin,A);
});
