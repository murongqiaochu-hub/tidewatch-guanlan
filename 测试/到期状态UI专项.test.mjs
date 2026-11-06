// Real, isolated Chromium; synthetic SDK/HTTP only. No service or real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileESM } from '../构建/esm-compiler.mjs';
import { inlinePluginUI, pluginFiles } from '../构建/build.mjs';
import { accountDisplayStatus } from '../界面/app.mjs';

const root = new URL('../', import.meta.url), chrome = '/usr/bin/chromium';
const expiry = '2040-01-01T00:00:00.000Z', deadline = Date.parse(expiry);
test('账户状态：期限边界、停用优先、角色与空期限', () => {
  const user = { role:'designer', status:'active', expiresAt:expiry };
  assert.equal(accountDisplayStatus(user,deadline-1).text,'正常');
  assert.deepEqual(accountDisplayStatus(user,deadline),{status:'expired',text:'已过期'});
  assert.equal(accountDisplayStatus({...user,status:'disabled'},deadline).text,'已停用');
  assert.equal(accountDisplayStatus({...user,status:'deleted'},deadline).text,'已删除');
  for(const change of [{expiresAt:null},{expiresAt:'invalid'},{role:'developer'},{role:'admin'}])assert.equal(accountDisplayStatus({...user,...change},deadline).text,'正常');
});
async function browser() {
  const profile=await mkdtemp(path.join(tmpdir(),'heron-expiry-ui-'));
  const child=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND','--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  let serial=0,buffer='';const pending=new Map(),errors=[];
  child.stdio[4].on('data',chunk=>{buffer+=chunk;let boundary;while((boundary=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,boundary));buffer=buffer.slice(boundary+1);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description);const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result)}}});
  child.on('exit',code=>{for(const p of pending.values())p.reject(Error('Chromium exited '+code));pending.clear()});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const call=(method,params={})=>send(method,params,sessionId);
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Network.setBlockedURLs',{urls:['http://*','https://*']});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
  const load=async html=>{const tree=await call('Page.getFrameTree');await call('Page.setDocumentContent',{frameId:tree.frameTree.frame.id,html})};
  const wait=condition=>evaluate(`new Promise((resolve,reject)=>{let n=0;function check(){if(${condition})return resolve(true);if(++n>300)return reject(Error('fixture timeout'));setTimeout(check,10)}check()})`);
  const close=async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));try{await send('Browser.close')}catch{}await exited;console.info('Preserved isolated profile: '+profile)};
  return {call,evaluate,load,wait,close,errors};
}
async function fixtureHTML() {
  const sources=new Map(await Promise.all(pluginFiles.map(async name=>[name,await readFile(new URL(name,root),'utf8')])));
  const ui=inlinePluginUI(sources.get('插件/ui.html'),sources.get('插件/ui.css'),compileESM(sources,'插件/ui.mjs').code).replace('content="disabled"','content="enabled"').replace('<head>','<head><script>window.fetch=(...a)=>parent.fixture.fetch(...a)</script>');
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{width:100vw;height:100vh;border:0;display:block}</style><body><script>{
  const user={id:'fixture-user',username:'fixture',role:'designer'};
  const fixture=window.fixture={expired:false,state:{production:true,phase:'idle',locked:false,sessionId:null,completed:[],mappingAvailable:false,total:0,done:0,exportTotal:0,exportDone:0,config:{origin:'https://fixture.invalid',allowLocalhost:false},rememberSupported:false}};
  fixture.fetch=async(url,options)=>{const p=new URL(url).pathname;const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});if(p==='/api/auth/login')return json({token:'synthetic-token',user});if(p==='/api/auth/me')return json(user);if(p==='/api/account/self')return fixture.expired?json({error:{code:'designer_expired',message:'private session_fixture'}},403):json({...user,status:'active',ownerId:null,displayName:'隔离设计师',createdAt:'2026-01-01T00:00:00Z',expiresAt:null,projectLimit:null,ownedProjectCount:1});if(p==='/api/projects')return json({projects:[{id:'fixture-project',name:'隔离项目',permissions:{canPublish:true}}]});if(p.endsWith('/groups'))return json({groups:[]});throw Error('Unexpected synthetic path '+p)};
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const m=event.data?.pluginMessage;if(m?.kind!=='request')return;let result;if(m.operation==='hello')result={product:'Independent Inspector · Development',height:640,state:fixture.state,verification:'DEVICE_VALIDATION_PENDING'};else if(m.operation==='list')result={scope:m.payload.scope,pageId:'1:1',frames:[{id:'2:1',name:'隔离画板'}],excluded:[]};else if(m.operation==='production-control')result=m.payload.action==='remember-read'?{remembered:null,supported:false}:{state:fixture.state};else throw Error('Unexpected SDK action');frame.contentWindow.postMessage({pluginMessage:{v:1,channel:m.channel,kind:'terminalAck',requestId:m.requestId,physicalDone:true,ok:true,cancelled:false,result}},'*')});
  const frame=document.createElement('iframe');frame.id='fixture';document.body.append(frame);frame.srcdoc=${JSON.stringify(ui).replace(/</g,'\\u003c')};}</script>`;
}
const doc="document.getElementById('fixture').contentDocument";
const el=id=>`${doc}.getElementById(${JSON.stringify(id)})`;
async function click(b,expression){const pos=await b.evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),f=document.getElementById('fixture')?.getBoundingClientRect();return{x:r.x+r.width/2+(f?.x||0),y:r.y+r.height/2+(f?.y||0)}})()`);for(const type of ['mousePressed','mouseReleased'])await b.call('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1})}
async function key(b,key,code,virtualKey){for(const type of ['keyDown','keyUp'])await b.call('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey})}

test('Chromium：到期遮罩、414×180/常规/窄矮滚动、键盘与返回登录', {skip:!existsSync(chrome),timeout:60000},async()=>{
  const b=await browser();try{
    for(const [width,height]of [[414,180],[414,640],[240,120]]){
      await b.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await b.load(await fixtureHTML());
      await b.wait(`${el('production-login')}&&!${el('production-login')}.disabled`);
      await b.evaluate(`fixture.expired=${height!==640};${el('production-username')}.value='fixture';${el('production-password')}.value='synthetic-password'`);await click(b,el('production-login'));
      if(height===640){await b.wait(`${el('app')}.dataset.productionPage==='workspace'&&!${el('production-project-open')}.disabled`);await b.evaluate('fixture.expired=true');await click(b,el('production-project-open'))}
      await b.wait(`${doc}.querySelector('dialog')?.open&&!${el('production-login')}.disabled`);
      const geometry=await b.evaluate(`(()=>{const d=${doc},dialog=d.querySelector('dialog'),r=dialog.getBoundingClientRect(),s=d.defaultView.getComputedStyle(dialog),backdrop=d.defaultView.getComputedStyle(dialog,'::backdrop');return {x:r.x,y:r.y,w:r.width,h:r.height,scroll:dialog.scrollHeight>dialog.clientHeight,overflow:s.overflowY,background:s.backgroundColor,backdrop:backdrop.backgroundColor,focus:d.activeElement.id,stage:d.getElementById('app').dataset.productionStage,page:d.getElementById('app').dataset.productionPage,workspace:d.getElementById('frame-selection').hidden,text:dialog.textContent}})()`);
      console.info(JSON.stringify({width,height,...geometry}));
      assert.equal(geometry.stage,'login');assert.equal(geometry.page,'login');assert.equal(geometry.workspace,true);assert.equal(geometry.focus,'designer-expired-title');assert.equal(geometry.background,'rgb(18, 43, 50)');assert.notEqual(geometry.backdrop,'rgba(0, 0, 0, 0)');assert.ok(Math.abs(geometry.x+geometry.w/2-width/2)<1);assert.ok(Math.abs(geometry.y+geometry.h/2-height/2)<1);assert.ok(geometry.h<=height-23);assert.doesNotMatch(geometry.text,/fixture|DESIGNER|session_/);
      if(height===120){assert.equal(geometry.scroll,true);assert.equal(geometry.overflow,'auto')}
      await key(b,'Tab','Tab',9);assert.equal(await b.evaluate(`${doc}.activeElement.textContent`),'返回登录');
      assert.equal(await b.evaluate(`(()=>{const d=${doc},s=d.defaultView.getComputedStyle(d.activeElement);return s.outlineOffset})()`),'0px');
      await b.evaluate('new Promise(resolve=>setTimeout(resolve,180))');
      if(process.env.HERON_UI_SCREENSHOT_DIR){const image=await b.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(process.env.HERON_UI_SCREENSHOT_DIR,`到期弹窗_${width}x${height}.png`),Buffer.from(image.data,'base64'))}
      if(height===640)await key(b,'Escape','Escape',27);else await click(b,`${doc}.querySelector('dialog button')`);
      await b.wait(`!${doc}.querySelector('dialog')`);assert.equal(await b.evaluate(`${doc}.activeElement.id`),'production-username');assert.equal(await b.evaluate(`${el('app')}.dataset.productionPage`),'login');
      if(height===640){await b.evaluate(`fixture.expired=false;${el('production-password')}.value='synthetic-password'`);await click(b,el('production-login'));await b.wait(`${el('app')}.dataset.productionPage==='workspace'&&!${el('production-project-open')}.disabled`)}
    }
    assert.deepEqual(b.errors,[]);
  }finally{await b.close()}
});

test('Chromium：账户列表跨期限更新、焦点与停用优先、清理timer', {skip:!existsSync(chrome),timeout:30000},async()=>{
  const b=await browser();try{
    const source=(await readFile(new URL('界面/app.mjs',root),'utf8')).replace(/export /g,'').replace("if(typeof document!=='undefined'&&typeof window!=='undefined')await mountWebApp()",'');
    await b.load('<!doctype html><meta charset="utf-8"><main id="app"></main>');
    await b.evaluate("Object.defineProperty(window,'localStorage',{value:{getItem(){return null},setItem(){},removeItem(){}}});true");
    await b.evaluate(`(async()=>{${source}\nlet now=${deadline-1};Date.now=()=>now;window.fixtureTimers=new Map();let serial=0;window.setTimeout=(fn,delay)=>{const id=++serial;fixtureTimers.set(id,{fn,delay});return id};window.clearTimeout=id=>fixtureTimers.delete(id);const self={id:'admin',username:'admin',role:'admin'},users=[{id:'designer',username:'designer',role:'designer',status:'active',expiresAt:${JSON.stringify(expiry)},projectLimit:null,ownedProjectCount:0},{id:'disabled',username:'disabled',role:'designer',status:'disabled',expiresAt:${JSON.stringify(expiry)},projectLimit:0,ownedProjectCount:0}];window.handle=await mountWebApp({context:{user:self,page:'accounts'},fetchAPI:async url=>new Response(JSON.stringify(url==='/api/account/self'?self:{users}),{headers:{'content-type':'application/json'}})});window.crossDeadline=()=>{now++;const next=[...fixtureTimers.values()][0];fixtureTimers.clear();next.fn()};})()`);
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.account-status')].map(n=>n.textContent)"),['正常','已停用']);
    assert.equal(await b.evaluate('[...fixtureTimers.values()][0].delay'),1);
    await b.evaluate("document.querySelector('[data-account-id=designer] summary').focus();window.originalRow=document.querySelector('[data-account-id=designer]');crossDeadline()");
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.account-status')].map(n=>n.textContent)"),['已过期','已停用']);
    assert.equal(await b.evaluate("document.activeElement.tagName==='SUMMARY'&&originalRow===document.querySelector('[data-account-id=designer]')"),true);
    await b.evaluate("document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));handle.dispose()");assert.equal(await b.evaluate('fixtureTimers.size'),0);assert.deepEqual(b.errors,[]);
  }finally{await b.close()}
});
