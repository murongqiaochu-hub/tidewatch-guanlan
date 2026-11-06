// C30 native DOM model tests; no production network, storage, deployment or browser visual claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatform } from '../平台/服务.mjs';
import { mountWebApp, projectInviteText } from '../界面/app.mjs';
// Reuse the existing self-contained DOM model without importing/running its legacy test cases.
const legacy = await readFile(new URL('./网页C29邀请.test.mjs', import.meta.url), 'utf8');
const modelStart = legacy.indexOf('const walk=n=>'), modelEnd = legacy.indexOf("const password='", modelStart);
assert.ok(modelStart >= 0 && modelEnd > modelStart, 'existing DOM model boundaries');
const { dom, walk, button, input } = new Function(legacy.slice(modelStart, modelEnd) + '\nreturn {dom,walk,button,input};')();
const projects = [{ id:'p1', name:'项目甲', designFileCount:0, permissions:{canShare:true} }, { id:'p2', name:'项目乙', designFileCount:0, permissions:{canShare:true} }];
const row = {id:'i1',projectId:'p1',projectName:'项目甲',creatorName:'designer.full.username',createdByUserId:'u1',label:'项目甲-261102',status:'active',usesCount:1,maxUses:50,createdAt:'2026-11-02T08:00:00Z',expiresAt:'2026-11-09T08:00:00Z'};
const dialog=d=>d.document.querySelector('dialog');
const control=(d,label)=>walk(d.document.body).find(n=>n.getAttribute('aria-label')===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t,{page='invites',rows=[row],intercept,user={role:'admin'}}={}){
  const d=dom(),calls=[];let stored=structuredClone(rows);
  const fetchAPI=async(url,options={})=>{
    const call={url,method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined};calls.push(call);
    assert.equal(options.credentials,'same-origin');
    const replacement=await intercept?.(call,d);if(replacement)return replacement;
    if(url==='/api/projects'||url==='/api/admin/projects')return Response.json({projects});
    if(url.endsWith('/default-label'))return Response.json({label:url.includes('/p2/')?'项目乙-261102':'项目甲-261102'});
    if(url==='/api/admin/invites')return Response.json({invites:stored});
    if(call.method==='POST'&&url.endsWith('/invites')){const invite={...row,...call.body,id:'new',projectId:url.includes('/p2/')?'p2':'p1',label:call.body.autoLabel?call.body.label+'-1':call.body.label,link:'/share/'+'a'.repeat(43)};stored.push(invite);return Response.json({invite});}
    if(call.method==='PATCH'){stored=stored.map(item=>item.id===url.split('/').at(-1)?{...item,...call.body}:item);return Response.json({invite:stored[0]});}
    if(call.method==='DELETE'){const inviteId=url.split('/').at(-1);stored=stored.filter(item=>item.id!==inviteId);return Response.json({deleted:true,inviteId});}
    throw new Error('Unexpected fixture request: '+url);
  };
  const view=await mountWebApp({document:d.document,window:d.window,root:d.app,context:{page,user},fetchAPI});t.after(()=>view.dispose());return {d,calls,view};
}
test('C30 project toolbar removes invite; card share opens creation directly, not history',async t=>{
  const {d,calls}=await setup(t,{page:'projects'});assert.equal(button(d,'邀请'),undefined);await button(d,'分享').click();
  assert.equal(input(d,'projectId').value,'p1');assert.equal(input(d,'label').value,'项目甲-261102');assert.ok(button(d,'创建邀请'));assert.equal(dialog(d).querySelector('details'),null);
  assert.ok(!calls.some(c=>c.method==='GET'&&c.url.endsWith('/invites')));assert.ok(!calls.some(c=>c.method==='POST'));
  await dialog(d).querySelector('form').fire('submit');const sent=calls.find(c=>c.method==='POST');assert.deepEqual(sent.body,{label:'项目甲-261102',expiresDays:7,maxUses:50,autoLabel:true});
  assert.match(dialog(d).textContent,/项目甲-261102-1/);const output=control(d,'完整项目邀请');assert.match(output.value,/分享人：designer.full.username/);assert.doesNotMatch(output.value,/已脱敏|\*\*\*/);await button(d,'复制完整邀请').click();assert.equal(d.window.copied,output.value);
  await dialog(d).querySelector('form').fire('submit');assert.equal(calls.filter(c=>c.method==='POST').length,1);dialog(d).close();assert.equal(d.document.querySelector('textarea'),null);
});
test('C30 table searches remark/project/full creator/status, edits and confirms deletion',async t=>{
  const {d,calls}=await setup(t,{rows:[row,{...row,id:'i2',label:'另一个',projectName:'项目乙',creatorName:'other.user',status:'expired'}]});assert.equal(d.app.querySelectorAll('tbody')[0].children.length,2);
  for(const [label,value] of [['搜索备注','261102'],['搜索项目','项目甲'],['搜索分享人','full.username']]){const search=control(d,label);search.value=value;await search.fire('input');assert.equal(d.app.querySelector('tbody').children.length,1);assert.match(d.app.querySelector('tbody').textContent,/designer.full.username/);search.value='';await search.fire('input');}
  const state=control(d,'邀请状态');state.value='expired';await state.fire('change');assert.doesNotMatch(d.app.querySelector('tbody').textContent,/designer.full.username/);state.value='active';await state.fire('change');
  await button(d,'编辑').click();assert.ok(Number(input(d,'expiresDays').value)>=1&&Number(input(d,'expiresDays').value)<=30);input(d,'label').value='新的备注';input(d,'expiresDays').value='3';await input(d,'expiresDays').fire('input');input(d,'maxUses').value='12';await dialog(d).querySelector('form').fire('submit');assert.deepEqual(calls.find(c=>c.method==='PATCH'),{url:'/api/admin/invites/i1',method:'PATCH',body:{label:'新的备注',expiresDays:3,maxUses:12}});assert.match(d.app.textContent,/新的备注/);
  await button(d,'删除').click();assert.ok(!calls.some(c=>c.method==='DELETE'));assert.match(dialog(d).textContent,/已领取成员不会删除/);await button(d,'取消').click();assert.ok(!calls.some(c=>c.method==='DELETE'));
  await button(d,'删除').click();await dialog(d).querySelector('form').fire('submit');assert.equal(calls.filter(c=>c.method==='DELETE').length,1);assert.equal(calls.find(c=>c.method==='DELETE').url,'/api/admin/invites/i1');assert.doesNotMatch(d.app.querySelector('tbody').textContent,/新的备注/);
  assert.equal(button(d,'复制完整邀请'),undefined);
});
test('C30 creation project switch refreshes default, custom label sets autoLabel false, refreshes table',async t=>{
  const {d,calls}=await setup(t);await button(d,'创建邀请').click();const before=calls.filter(c=>c.url==='/api/admin/invites').length;
  input(d,'label').value='临时备注';await input(d,'label').fire('input');input(d,'projectId').value='p2';await input(d,'projectId').fire('change');assert.equal(input(d,'label').value,'项目乙-261102');
  input(d,'label').value='手工备注';await input(d,'label').fire('input');await dialog(d).querySelector('form').fire('submit');const sent=calls.find(c=>c.method==='POST');assert.equal(sent.url,'/api/admin/projects/p2/invites');assert.equal(sent.body.autoLabel,false);assert.equal(sent.body.label,'手工备注');assert.equal(calls.filter(c=>c.url==='/api/admin/invites').length,before+1);assert.match(d.app.querySelector('tbody').textContent,/手工备注/);
});
test('C30 default-label failure blocks creation until explicit successful retry',async t=>{
  let fail=true;const {d,calls}=await setup(t,{intercept:c=>c.url.endsWith('/default-label')&&fail?Response.json({message:'bad'},{status:503}):null});await button(d,'创建邀请').click();const form=dialog(d).querySelector('form');assert.equal(form.querySelector('button[type=submit]').disabled,true);assert.equal(input(d,'label').value,'');assert.match(dialog(d).textContent,/默认备注读取失败/);await form.fire('submit');assert.ok(!calls.some(c=>c.method==='POST'));fail=false;await button(d,'重试默认备注').click();assert.equal(form.querySelector('button[type=submit]').disabled,false);assert.equal(input(d,'label').value,'项目甲-261102');
});
test('C30 late default responses cannot replace current project label',async t=>{
  let resolve;const pending=new Promise(r=>{resolve=r});const {d}=await setup(t,{intercept:c=>c.url.includes('/p1/invites/default-label')?pending:null});const opening=button(d,'创建邀请').click();await tick();assert.equal(dialog(d).querySelector('button[type=submit]').disabled,true);input(d,'projectId').value='p2';await input(d,'projectId').fire('change');assert.equal(input(d,'label').value,'项目乙-261102');resolve(Response.json({label:'迟到的甲'}));await opening;assert.equal(input(d,'label').value,'项目乙-261102');
});
test('C30 list has loading, empty and recoverable error; scope uses server result without guessing owner',async t=>{
  let fail=true;const {d,calls}=await setup(t,{rows:[],user:{role:'designer'},intercept:(c,d)=>{if(c.url==='/api/admin/invites'){assert.match(d.app.textContent,/正在读取邀请/);return fail?Response.json({message:'bad'},{status:403}):null;}}});assert.match(d.app.textContent,/邀请读取失败/);assert.match(d.app.textContent,/HTTP 403/);assert.match(d.app.textContent,/我创建的邀请/);fail=false;await button(d,'刷新').click();assert.match(d.app.textContent,/暂无邀请/);assert.ok(calls.filter(c=>c.url==='/api/admin/invites').every(c=>c.method==='GET'&&c.body===undefined));
});
test('C30 numeric validation prevents writes and ambiguous create is never replayed',async t=>{
  const {d,calls}=await setup(t,{intercept:c=>c.method==='POST'?Response.json({message:'bad'},{status:503}):null});await button(d,'创建邀请').click();const form=dialog(d).querySelector('form');input(d,'expiresDays').value='31';await form.fire('submit');assert.ok(!calls.some(c=>c.method==='POST'));input(d,'expiresDays').value='7';await form.fire('submit');assert.match(dialog(d).textContent,/不会自动重发/);assert.equal(form.querySelector('button[type=submit]').disabled,true);await form.fire('submit');assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('C30 isolated real HTTP + DOM: create auto label, edit, delete and refresh use actual contracts',async t=>{
  const base=await realpath(tmpdir()),dir=await mkdtemp(path.join(base,'heron-c30-ui-')),password='Synthetic C30 test password 2026';
  const platform=await createPlatform({dataDir:dir,secret:'synthetic-c30-ui-secret-32-characters',bootstrapAdmin:{username:'full.admin.username',password},logger:{error(){}}});
  t.after(async()=>{await platform.close();assert.equal(await realpath(dir),dir);assert.equal(path.dirname(dir),base);assert.ok(path.basename(dir).startsWith('heron-c30-ui-'));await rm(dir,{recursive:true});});
  const address=await platform.listen(0),origin=`http://127.0.0.1:${address.port}`,calls=[];let cookie='';
  const send=async(url,options={})=>{const target=new URL(url,origin);assert.equal(target.origin,origin);const response=await fetch(target,{...options,redirect:'error',headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];calls.push({url,method:options.method||'GET',body:options.body});return response;};
  const post=async(url,body)=>{const response=await send(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const {user}=await post('/api/auth/login',{username:'full.admin.username',password});await post('/api/projects',{name:'C30 HTTP 项目'});const d=dom(origin),view=await mountWebApp({document:d.document,window:d.window,root:d.app,context:{page:'invites',user},fetchAPI:send});t.after(()=>view.dispose());
  await button(d,'创建邀请').click();assert.match(input(d,'label').value,/^C30 HTTP 项目-\d{6}$/);await dialog(d).querySelector('form').fire('submit');assert.ok(control(d,'完整项目邀请'));assert.match(control(d,'完整项目邀请').value,/分享人：full.admin.username/);assert.match(d.app.querySelector('tbody').textContent,/full.admin.username/);dialog(d).close();
  await button(d,'编辑').click();input(d,'label').value='HTTP 修改备注';input(d,'expiresDays').value='4';input(d,'maxUses').value='6';await dialog(d).querySelector('form').fire('submit');assert.equal(dialog(d),null);assert.match(d.app.querySelector('tbody').textContent,/HTTP 修改备注/);
  await button(d,'删除').click();await dialog(d).querySelector('form').fire('submit');assert.equal(dialog(d),null);assert.match(d.app.querySelector('tbody').textContent,/暂无邀请/);assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
});
test('C30 editing only label never silently extends invitation expiry',async t=>{const {d,calls}=await setup(t);await button(d,'编辑').click();input(d,'label').value='仅改备注';await dialog(d).querySelector('form').fire('submit');assert.deepEqual(calls.find(c=>c.method==='PATCH').body,{label:'仅改备注'});});
test('C30 full username share text and canvas callback, responsive table contracts',async()=>{
  const text=projectInviteText('项目',{...row,link:'/share/'+'b'.repeat(43)},'https://fixture.invalid');assert.match(text,/分享人：designer.full.username/);assert.throws(()=>projectInviteText('项目',{link:'//evil.invalid'},'https://fixture.invalid'));
  const source=await readFile(new URL('../界面/app.mjs',import.meta.url),'utf8'),css=await readFile(new URL('../界面/base.css',import.meta.url),'utf8');assert.match(source,/mountProjectCanvas\(\{root:app,projectId:boot.projectId,api,onInvite:shareProject\}\)/);assert.match(css,/\.invite-table-wrap\s*\{\s*overflow-x:auto/);assert.match(css,/\.invite-table\s*\{\s*min-width:1040px/);
});
