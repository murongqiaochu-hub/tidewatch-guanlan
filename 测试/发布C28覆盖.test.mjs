// Synthetic temporary vaults only; no production reads, credentials, build or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openVault } from '../平台/仓库.mjs';
import { createPublishing } from '../平台/发布.mjs';
import { createPermissions } from '../平台/权限.mjs';
import { sha256 } from '../平台/下载.mjs';
const writerBytes=Buffer.alloc(32,17),writerSecret=writerBytes.toString('base64url');
const source={kind:'figma-file',fileKey:'C28Synthetic'};
const code=value=>error=>error.code===value;
const equal=(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function payload(index=0,name='original',baseRevisionId=null){
  const box={x:index*100,y:0,width:20,height:20},id=`1:${index}`;
  const bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id,type:'FRAME',name,absoluteBoundingBox:box,children:[]}}));
  const hash=sha256(bytes);
  return {bytes,frame:{figmaNodeId:id,figmaPageId:'0:1',name,...box,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId}};
}
async function fixture(t){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'heron-c28-'));const hooks={};
  const backing=await openVault({dataDir,limits:{fault:point=>hooks.fault?.(point)}});t.after(()=>backing.close());
  const vault={...backing,get catalog(){return backing.catalog;},get readVersion(){return backing.readVersion;},async readStaged(...args){const result=await backing.readStaged(...args);await hooks.afterRead?.();return result;},async stageAsset(...args){const result=await backing.stageAsset(...args);await hooks.afterStage?.();return result;}};
  await vault.transact(d=>{
    for(const id of ['alice','bob'])d.add('users',{id,username:id,role:id==='bob'?'admin':'designer',status:'active',sessionVersion:0});
    for(const id of ['p','q'])d.add('projects',{id,ownerId:'alice',name:id});
    d.add('projectMembers',{id:'member',projectId:'p',userId:'bob'});
    d.add('designFiles',{id:'f',projectId:'p',figmaFileKey:source.fileKey,publishingSource:source});
  });
  const service=createPublishing({vault,auth:{actor:req=>req.user},permissions:createPermissions({vault}),publishIntentKey:Buffer.alloc(32,19)});
  const req=(id='alice')=>({user:vault.catalog.users.find(u=>u.id===id),headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}});
  const claimBody=async(frames,{user='alice',projectId='p',...extra}={})=>({...await service.createIntent(req(user),projectId),frameIds:frames.map(p=>p.frame.figmaNodeId),writerSecret,...extra});
  const claim=async(frames,extra={})=>{const body=await claimBody(frames,extra);await service.createOperation(req(extra.user),body);return body;};
  const prepare=async(frames,op,batchIndex=0)=>{
    if(op)await service.publishSource(req(),'p',{source,frameIds:frames.map(p=>p.frame.figmaNodeId),operationId:op.operationId,writerSecret});
    return service.prepare(req(),{projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,coordinateMode:'project-xy',frames:frames.map(p=>p.frame),...(op?{operationId:op.operationId,batchIndex,writerSecret}:{})});
  };
  const upload=async(s,p)=>service.upload(req(),s.sessionId,p.frame.layerDocSha256,s.operationId?Buffer.concat([Buffer.from('GLP1'),writerBytes,p.bytes]):p.bytes);
  const commit=s=>service.commit(req(),s.sessionId,{writerSecret});
  const publish=async(frames,op,batchIndex=0)=>{const s=await prepare(frames,op,batchIndex);for(const p of frames)await upload(s,p);return commit(s);};
  return {vault,service,req,claim,claimBody,prepare,upload,commit,publish,hooks};
}

test('C28 显式新claim废止响应未知旧任务；重复与迟到claim幂等不取消更新任务',async t=>{
  const h=await fixture(t),p=payload(),old=await h.claim([p]),s=await h.prepare([p],old);
  const next=await h.claimBody([p],{replacePrevious:true});
  await h.service.createOperation(h.req(),next);
  assert.equal(h.vault.catalog.publishOperations.find(o=>o.id===old.operationId).status,'cancelled');
  assert.equal(h.vault.catalog.publishSessions.find(o=>o.id===s.sessionId).status,'aborted');
  const version=h.vault.readVersion;await h.service.createOperation(h.req(),structuredClone(next));assert.equal(h.vault.readVersion,version);
  const newer=await h.claim([p],{replacePrevious:true}),after=h.vault.readVersion;
  assert.equal((await h.service.createOperation(h.req(),next)).status,'cancelled');
  assert.equal(h.vault.readVersion,after);assert.equal(h.vault.catalog.publishOperations.find(o=>o.id===newer.operationId).status,'open');
  await assert.rejects(h.commit(s),code('session_closed'));
  await assert.rejects(h.service.finishOperation(h.req(),old.operationId,{writerSecret,catalogReadVersion:h.vault.readVersion}),code('operation_not_open'));
});

test('C28 不传保持旧锁；仅接受true且无效intent/group/writer不能产生废止',async t=>{
  const h=await fixture(t),p=payload(),old=await h.claim([p]);
  await assert.rejects(h.claim([p]),code('publish_operation_active'));
  for(const replacePrevious of [false,null,'true',1])await assert.rejects(h.claim([p],{replacePrevious}),code('invalid_replace_previous'));
  await assert.rejects(h.claim([p],{replacePrevious:true,groupId:'missing'}),code('group_not_found'));
  const body=await h.claimBody([p],{replacePrevious:true});
  await assert.rejects(h.service.createOperation(h.req(),{...body,operationId:'invalid'}),code('invalid_operation_intent'));
  await assert.rejects(h.service.createOperation(h.req(),{...body,writerSecret:'bad'}),code('writer_secret_invalid'));
  assert.equal(h.vault.catalog.publishOperations.find(o=>o.id===old.operationId).status,'open');assert.equal(h.vault.catalog.auditLogs.length,0);
});

test('C28 他人操作/legacy会话不能被取消；本用户其他项目不动',async t=>{
  const h=await fixture(t),p=payload(),other=await h.claim([p],{user:'bob'}),ownElsewhere=await h.claim([p],{projectId:'q'});
  const before=structuredClone(h.vault.catalog);
  await assert.rejects(h.claim([p],{replacePrevious:true}),code('publish_operation_active'));
  equal(h.vault.catalog,before);
  await h.service.cancelOperation(h.req('bob'),other.operationId,{writerSecret});
  await h.vault.transact(d=>{
    for(const user of ['alice','bob'])d.add('publishSessions',{id:`legacy_${user}`,designFileId:'f',status:'open',createdBy:user,items:[]});
  });
  const version=h.vault.readVersion;
  await assert.rejects(h.claim([p],{replacePrevious:true}),code('publish_session_active'));assert.equal(h.vault.readVersion,version);
  assert.equal(h.vault.catalog.publishSessions.find(s=>s.id==='legacy_alice').status,'open');
  await h.service.abort(h.req('bob'),'legacy_bob');await h.claim([p],{replacePrevious:true});
  assert.equal(h.vault.catalog.publishSessions.find(s=>s.id==='legacy_alice').status,'aborted');
  assert.equal(h.vault.catalog.publishOperations.find(o=>o.id===ownElsewhere.operationId).status,'open');
});

test('C28 partial已提交保留；仅选中画板成功后替换，失败保留currentRevision和未选画板',async t=>{
  const h=await fixture(t),a=payload(),b=payload(1),old=await h.claim([a,b]);
  const initial=await h.publish([a,b],old),before=structuredClone(h.vault.catalog.frames),revisions=initial.frames.map(f=>f.revisionId);
  const next=await h.claim([payload(0,'new',revisions[0])],{replacePrevious:true});
  equal(h.vault.catalog.frames,before);
  assert.equal(h.vault.catalog.publishSessions[0].status,'committed');
  const changed=payload(0,'new',revisions[0]),s=await h.prepare([changed],next);
  await assert.rejects(h.commit(s),code('assets_missing'));equal(h.vault.catalog.frames,before);
  await h.upload(s,changed);const result=await h.commit(s);
  assert.notEqual(result.frames[0].revisionId,revisions[0]);assert.equal(result.frames[0].previousRevisionId,revisions[0]);
  equal(h.vault.catalog.frames.find(f=>f.figmaNodeId===b.frame.figmaNodeId),before.find(f=>f.figmaNodeId===b.frame.figmaNodeId));
  assert.equal(h.vault.catalog.frameRevisions.length,3);
  assert.equal((await h.service.commit(h.req(),initial.sessionId,{writerSecret})).idempotent,true);
  assert.equal(h.vault.catalog.frames.find(f=>f.figmaNodeId===a.frame.figmaNodeId).currentRevisionId,result.frames[0].revisionId);
});

test('C28 旧commit已读完staging后迟到仍拒绝，不覆盖新提交',async t=>{
  const h=await fixture(t),p=payload(),old=await h.claim([p]),s=await h.prepare([p],old);await h.upload(s,p);
  const entered=deferred(),release=deferred();h.hooks.afterRead=async()=>{h.hooks.afterRead=null;entered.resolve();await release.promise;};
  const late=assert.rejects(h.commit(s),code('session_closed'));await entered.promise;
  try{
    const replacement=payload(0,'replacement'),next=await h.claim([replacement],{replacePrevious:true}),result=await h.publish([replacement],next);
    release.resolve();await late;
    assert.equal(h.vault.catalog.frames[0].currentRevisionId,result.frames[0].revisionId);assert.equal(h.vault.catalog.frameRevisions.length,1);
  }finally{release.resolve();}
});

test('C28 旧upload已写staging后迟到拒绝，不复活旧会话',async t=>{
  const h=await fixture(t),p=payload(),old=await h.claim([p]),s=await h.prepare([p],old);
  const entered=deferred(),release=deferred();h.hooks.afterStage=async()=>{h.hooks.afterStage=null;entered.resolve();await release.promise;};
  const late=assert.rejects(h.upload(s,p),code('session_closed'));await entered.promise;
  try{await h.claim([p],{replacePrevious:true});}finally{release.resolve();}
  await late;equal(h.vault.catalog.publishSessions.find(row=>row.id===s.sessionId).uploaded,[]);
});

test('C28 新claim持久化失败整体回滚；同目标仍使用baseRevision冲突保护',async t=>{
  const h=await fixture(t),p=payload(),old=await h.claim([p]);await h.publish([p],old);
  const before=structuredClone(h.vault.catalog),body=await h.claimBody([p],{replacePrevious:true});
  h.hooks.fault=point=>{if(point==='beforeFileSync'){h.hooks.fault=null;throw Object.assign(new Error('synthetic'),{code:'synthetic_failure'});}};
  await assert.rejects(h.service.createOperation(h.req(),body),code('storage_io_error'));equal(h.vault.catalog,before);
  await h.service.createOperation(h.req(),body);const s=await h.prepare([p],body);
  await assert.rejects(h.commit(s),code('revision_conflict'));
  equal(h.vault.catalog.frames,before.frames);equal(h.vault.catalog.frameRevisions,before.frameRevisions);
});
