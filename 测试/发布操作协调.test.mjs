// Run only this isolated suite; it never imports/runs the earlier safety suites.
// Command: node --test --test-concurrency=1 测试/发布操作协调.test.mjs
// Every fixture is synthetic. Keep its directory, catalog, originals and staging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { openVault, platformError } from '../平台/仓库.mjs';
import { createPublishing, sessionManifestHash } from '../平台/发布.mjs';
import { createPermissions } from '../平台/权限.mjs';
import { createPlatform } from '../平台/服务.mjs';
import { createAccountProjectService } from '../平台/账户项目.mjs';
import { sha256 } from '../平台/下载.mjs';

const source={kind:'figma-file',fileKey:'SyntheticP'};
// Synthetic fixed keys never printed or included in assertion diagnostics.
const intentKey=Buffer.alloc(32,0x35),writerBytes=Buffer.alloc(32,0x79),writerSecret=writerBytes.toString('base64url');
function opId(label,{user='alice',project='p'}={}){
  if(/^op_[a-f0-9]{32}_[a-f0-9]{64}$/.test(label))return label;
  const nonce=createHash('sha256').update(JSON.stringify([user,project,label])).digest('hex').slice(0,32);
  const signature=createHmac('sha256',intentKey).update('heron-publish-intent-v1\0').update(JSON.stringify([user,project,nonce])).digest('hex');
  return `op_${nonce}_${signature}`;
}
const hasCode=code=>error=>error.code===code;
const json=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function payload(index=0,fields={}){
  const node=`1:${index+1}`,box={x:index*10,y:0,width:2,height:2};
  const bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id:node,type:'FRAME',name:`Synthetic ${index}`,absoluteBoundingBox:box,children:[]}}));
  const hash=sha256(bytes);
  return {bytes,frame:{figmaNodeId:node,figmaPageId:'0:1',name:`Synthetic ${index}`,...box,order:index,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null,...fields}};
}
const operationBody=(id,frames,extra={})=>({operationId:opId(id,{project:extra.projectId||'p'}),projectId:'p',frameIds:frames.map(p=>p.frame.figmaNodeId),...extra,writerSecret});
const prepareBody=(frames,extra={})=>({projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:frames.map(p=>p.frame),...extra,...(extra.operationId?{operationId:opId(extra.operationId),writerSecret}:{})});
async function fixture(t){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'publish-operations-'))),dataDir=path.join(directory,'data');
  t.diagnostic(`保留隔离数据: ${directory}`);
  let now=1_800_000_000_000,backing,vault,service,permissions,closed=false;
  const hooks={};
  const auth={actor(req){if(!req.user)throw platformError(401,'authentication_required');return req.user;}};
  async function open(){
    backing=await openVault({dataDir,clock:()=>now,limits:{fault:point=>hooks.fault?.(point)}});
    vault={...backing,get catalog(){return backing.catalog;},get readVersion(){return backing.readVersion;},
      async readStaged(...args){const bytes=await backing.readStaged(...args);await hooks.afterRead?.();return bytes;},
      async stageAsset(...args){const value=await backing.stageAsset(...args);await hooks.afterStage?.();return value;},
      // Legacy cleanup is disabled in this fixture too: no test data is deleted.
      async discardStaged(){return {removed:false,reason:'fixture_retains_data'};}
    };
    permissions=createPermissions({vault,clock:()=>now});service=createPublishing({vault,auth,permissions,clock:()=>now,publishIntentKey:intentKey});
  }
  await open();t.after(async()=>{if(!closed)await backing.close();});
  await vault.transact(d=>{
    for(const [id,role]of [['alice','designer'],['bob','designer'],['reader','developer'],['admin','admin']])d.add('users',{id,username:id,role,status:'active',sessionVersion:0});
    for(const [id,ownerId]of [['p','alice'],['p2','alice'],['q','bob']])d.add('projects',{id,ownerId,name:`Synthetic ${id}`});
    for(const id of ['bob','reader'])d.add('projectMembers',{id:`member_${id}`,projectId:'p',userId:id});
    d.add('frameGroups',{id:'g',projectId:'p',name:'Synthetic group'});d.add('frameGroups',{id:'gq',projectId:'q',name:'Foreign group'});
    for(const [id,projectId,key]of [['f','p','SyntheticP'],['f2','p','SyntheticP2'],['fq','q','SyntheticQ']])d.add('designFiles',{id,projectId,figmaFileKey:key,publishingSource:{kind:'figma-file',fileKey:key}});
  });
  const h={directory,dataDir,hooks,auth,get vault(){return vault;},get service(){return service;},get permissions(){return permissions;},clock:()=>now,advance:ms=>{now+=ms;},
    req(id='alice'){const u=vault.catalog.users.find(u=>u.id===id);return {user:{id:u.id,username:u.username,role:u.role,sessionVersion:u.sessionVersion},headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}};},
    async reopen(){await backing.close();await open();},
    async close(){await backing.close();closed=true;}
  };
  return h;
}
async function bind(h,id,frames,req=h.req()){
  return h.service.publishSource(req,'p',{source,frameIds:frames.map(p=>p.frame.figmaNodeId),operationId:opId(id),writerSecret});
}
const framed=bytes=>Buffer.concat([Buffer.from('GLP1'),writerBytes,bytes]);
async function upload(h,sid,frames,req=h.req()){
  const operation=h.vault.catalog.publishSessions.find(s=>s.id===sid)?.operationId;
  for(const p of frames)await h.service.upload(req,sid,p.frame.layerDocSha256,operation?framed(p.bytes):p.bytes);
}
const finish=(h,req,id)=>h.service.finishOperation(req,opId(id),{writerSecret,catalogReadVersion:h.vault.readVersion});
const cancel=(h,req,id)=>h.service.cancelOperation(req,opId(id),{writerSecret});
const commit=(h,req,sid)=>h.service.commit(req,sid,{writerSecret});
const abort=(h,req,sid)=>h.service.abort(req,sid,{writerSecret});
async function publish(h,frames,extra={}){
  const prepared=await h.service.prepare(h.req(),prepareBody(frames,extra));await upload(h,prepared.sessionId,frames);
  return {prepared,result:extra.operationId?await commit(h,h.req(),prepared.sessionId):await h.service.commit(h.req(),prepared.sessionId)};
}

test('同服务两个协调器事务争锁；不同项目可并行，重复 create 不重置操作',async t=>{
  const h=await fixture(t),frames=[payload()],second=createPublishing({vault:h.vault,auth:h.auth,permissions:h.permissions,clock:h.clock,publishIntentKey:intentKey});
  const intent=await h.service.createIntent(h.req(),'p'),first={...operationBody('one',frames),operationId:intent.operationId};
  const outcomes=await Promise.allSettled([h.service.createOperation(h.req(),first),second.createOperation(h.req(),operationBody('two',frames))]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'publish_operation_active');
  const id=outcomes.find(r=>r.status==='fulfilled').value.operationId,version=h.vault.readVersion;
  await second.createOperation(h.req(),operationBody(id,frames));assert.equal(h.vault.readVersion,version);
  await assert.rejects(second.createOperation(h.req(),operationBody(id,[payload(1)])),hasCode('operation_request_mismatch'));
  await assert.rejects(second.createOperation(h.req(),{...operationBody('legacy-id',frames),operationId:'legacy-id'}),hasCode('invalid_operation_intent'));
  assert.equal(h.vault.readVersion,version);
  assert.equal((await second.createOperation(h.req(),operationBody('other-project',frames,{projectId:'p2'}))).lockScope,'service');
  assert.equal(h.vault.catalog.publishOperations.length,2);
});

test('prepare 同键并发返回精确原 SID；完整请求哈希覆盖原 manifestHash 遗漏字段',async t=>{
  const h=await fixture(t),frames=[payload()],req=h.req();await h.service.createOperation(req,operationBody(opId('op'),frames));await bind(h,opId('op'),frames,req);
  const body=prepareBody(frames,{operationId:opId('op'),batchIndex:0});
  const values=await Promise.all([h.service.prepare(req,body),h.service.prepare(req,json(body))]);
  assert.equal(values[0].sessionId,values[1].sessionId);assert.equal(h.vault.catalog.publishSessions.length,1);
  const reordered=Object.fromEntries(Object.entries(body).reverse());reordered.frames=body.frames.map(f=>Object.fromEntries(Object.entries(f).reverse()));
  assert.equal((await h.service.prepare(req,reordered)).sessionId,values[0].sessionId);
  const mutations=[
    b=>{b.frames[0].layerDocSha256='a'.repeat(64);},b=>{b.frames[0].layerDocBytes++;},
    b=>{b.frames[0].previewSha256='b'.repeat(64);b.frames[0].previewBytes=80;b.frames[0].previewMime='image/png';},
    b=>{b.frames[0].exports=[{sha256:'c'.repeat(64),bytes:20,mime:'image/svg+xml',exportNodeId:'1:1',fileName:'a.svg',pluginExportSetting:{constraint:{type:'SCALE',value:2}}}];},
    b=>{b.frames[0].transform=[[1,0,5],[0,1,6]];},b=>{b.frames[0].designScale=2;},b=>{b.frames[0].designSpec='ios';},
    b=>{b.frames[0].figmaPageId='0:2';},b=>{b.frames[0].pageName='Other';},b=>{b.frames[0].pageOrder=2;},
    b=>{b.designFile.name='Other';},b=>{b.source.fileKey='Other';},b=>{b.groupId=null;},b=>{b.coordinateMode='project-xy';}
  ];
  const before=h.vault.readVersion;
  for(const mutate of mutations){const changed=json(body);mutate(changed);assert.equal(sessionManifestHash(changed.frames),sessionManifestHash(body.frames));const code=changed.source.fileKey===body.source.fileKey?'batch_request_mismatch':'operation_source_mismatch';await assert.rejects(h.service.prepare(req,changed),hasCode(code));}
  assert.equal(h.vault.readVersion,before);assert.equal(h.vault.catalog.publishSessions.length,1);
  await assert.rejects(h.service.prepare(req,prepareBody(frames,{operationId:opId('op')})),hasCode('invalid_operation_batch'));
  await assert.rejects(h.service.prepare(req,prepareBody(frames,{batchIndex:0})),hasCode('invalid_operation_batch'));
});

test('27 画板分 16+11；部分成功和全批已提交都不会自动 finish',async t=>{
  const h=await fixture(t),frames=Array.from({length:27},(_,i)=>payload(i)),req=h.req();
  await h.service.createOperation(req,operationBody(opId('op'),frames,{groupId:'g'}));await bind(h,opId('op'),frames,req);
  const first=await publish(h,frames.slice(0,16),{operationId:opId('op'),batchIndex:0,groupId:'g'});
  let state=await h.service.queryOperation(req,opId('op'));assert.equal(state.status,'partial');assert.equal(state.committedFrames.length,16);assert.equal(state.remainingFrameIds.length,11);
  await assert.rejects(finish(h,req,opId('op')),hasCode('operation_incomplete'));
  await assert.rejects(h.service.createOperation(req,operationBody('too-soon',frames)),hasCode('publish_operation_active'));
  const next=await h.service.prepare(req,prepareBody(frames.slice(16),{operationId:opId('op'),batchIndex:1,groupId:'g'}));
  await assert.rejects(finish(h,req,opId('op')),hasCode('operation_sessions_open'));
  await upload(h,next.sessionId,frames.slice(16));await commit(h,req,next.sessionId);
  state=await h.service.queryOperation(req,opId('op'));assert.equal(state.status,'partial');assert.equal(state.committedFrames.length,27);
  assert.equal((await h.service.listOperations(req,'p')).operations.length,1);
  state=await finish(h,req,opId('op'));assert.equal(state.status,'completed');assert.deepEqual(state.remainingFrameIds,[]);
  assert.equal(h.vault.catalog.frames.filter(f=>f.groupId==='g').length,27);assert.equal(h.vault.catalog.frameRevisions.length,27);
  const version=h.vault.readVersion;await finish(h,req,opId('op'));assert.equal(h.vault.readVersion,version);
  assert.deepEqual(json(await h.service.committedResult(req,first.prepared.sessionId)),json(first.result));
  assert.equal((await h.service.listOperations(req,'p')).operations.length,0);
  await h.service.createOperation(req,operationBody('next',frames));
  await h.reopen();assert.equal((await h.service.queryOperation(h.req(),opId('op'))).status,'completed');
});

test('prepare rename 后丢响应：重开仓库后只用 GET 恢复原 SID，不产生任何新写入',async t=>{
  const h=await fixture(t),frames=[payload()],controller=new AbortController();
  await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  h.hooks.fault=point=>{if(point==='afterRename'){h.hooks.fault=null;controller.abort();}};
  // Ignore the response exactly as a disconnected client must; recovery only GETs.
  await h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0}),{signal:controller.signal});
  assert.equal(controller.signal.aborted,true);
  const disk=JSON.parse(await readFile(path.join(h.dataDir,'catalog.json'),'utf8')),sid=disk.publishSessions[0].id;
  await h.reopen();const version=h.vault.readVersion,state=await h.service.queryOperation(h.req(),opId('op'));
  assert.equal(state.batches[0].sessionId,sid);assert.equal(state.batches[0].prepareResult.sessionId,sid);
  assert.deepEqual(state.batches[0].uploaded,[]);assert.equal((await h.service.query(h.req(),sid)).status,'open');
  assert.equal((await h.service.listOperations(h.req(),'p')).operations[0].batches[0].sessionId,sid);
  await assert.rejects(h.service.queryOperation(h.req(),'unknown'),hasCode('not_found'));
  assert.equal(h.vault.readVersion,version);assert.equal(h.vault.catalog.publishSessions.length,1);
});

test('prepare 持久化前失败：GET 保留操作但没有 SID，绝不隐式重传或解锁',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  h.hooks.fault=point=>{if(point==='beforeFileSync'){h.hooks.fault=null;throw platformError(503,'synthetic_write_failure');}};
  await assert.rejects(h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0})),hasCode('synthetic_write_failure'));
  await h.reopen();const version=h.vault.readVersion,state=await h.service.queryOperation(h.req(),opId('op'));
  assert.equal(state.status,'open');assert.deepEqual(state.batches,[]);assert.equal(h.vault.catalog.frames.length,0);
  assert.equal((await h.service.listOperations(h.req(),'p')).operations.length,1);assert.equal(h.vault.readVersion,version);
  await assert.rejects(h.service.createOperation(h.req(),operationBody('retry',frames)),hasCode('publish_operation_active'));
});

test('create 响应丢失后按客户端持久 ID 和项目列表恢复；请求快照不受调用方后续修改',async t=>{
  const h=await fixture(t),frames=[payload()],body=operationBody(opId('lost-create'),frames),controller=new AbortController();
  h.hooks.fault=point=>{if(point==='afterRename'){h.hooks.fault=null;controller.abort();}};
  const creating=h.service.createOperation(h.req(),body,{signal:controller.signal});body.frameIds.push('unrequested');await creating;
  await h.reopen();const beforeRead=h.vault.readVersion,state=await h.service.queryOperation(h.req(),opId('lost-create'));assert.deepEqual(state.frameIds,['1:1']);
  assert.equal((await h.service.listOperations(h.req(),'p')).operations[0].operationId,opId('lost-create'));assert.equal(h.vault.readVersion,beforeRead);
  assert.equal(JSON.stringify(state).includes(writerSecret),false);
  // This continuation represents the original owner still holding its private proof;
  // the GET-only recovery above neither obtains that proof nor mutates state.
  await bind(h,opId('lost-create'),frames);
  const prepare=prepareBody(frames,{operationId:opId('lost-create'),batchIndex:0}),pending=h.service.prepare(h.req(),prepare);prepare.frames[0].name='mutated after submission';
  const result=await pending;assert.equal(h.vault.catalog.publishSessions[0].items[0].manifest.name,'Synthetic 0');
  assert.equal((await h.service.queryOperation(h.req(),opId('lost-create'))).batches[0].sessionId,result.sessionId);
});

test('只有 designFileId 的历史 open session 仍阻挡新操作，并原样保留未知字段',async t=>{
  const h=await fixture(t),frames=[payload()];
  await h.vault.transact(d=>d.add('publishSessions',{id:'legacy',designFileId:'f',status:'open',createdBy:'alice',expiresAt:'2000-01-01T00:00:00.000Z',items:[],legacyExtension:{retained:true}}));
  await assert.rejects(h.service.createOperation(h.req(),operationBody(opId('op'),frames)),hasCode('publish_session_active'));
  assert.equal((await h.service.listOperations(h.req(),'p')).legacySessions[0].sessionId,'legacy');
  assert.equal((await h.service.query(h.req(),'legacy')).status,'open');
  await h.service.abort(h.req(),'legacy');await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  assert.deepEqual(json(h.vault.catalog.publishSessions[0].legacyExtension),{retained:true});
});

test('旧 open 会话和新操作双向阻挡；到期拒写但不按 TTL 解锁',async t=>{
  const h=await fixture(t),frames=[payload()],old=await h.service.prepare(h.req(),prepareBody(frames));
  h.advance(365*86400000);const version=h.vault.readVersion;
  assert.equal((await h.service.query(h.req(),old.sessionId)).status,'open');assert.equal(h.vault.readVersion,version);
  assert.equal((await h.service.listOperations(h.req(),'p')).legacySessions[0].sessionId,old.sessionId);
  await assert.rejects(h.service.createOperation(h.req(),operationBody(opId('op'),frames)),hasCode('publish_session_active'));
  await assert.rejects(upload(h,old.sessionId,frames),hasCode('session_expired'));
  await assert.rejects(h.service.commit(h.req(),old.sessionId),hasCode('session_expired'));
  assert.equal(h.vault.catalog.publishSessions.find(s=>s.id===old.sessionId).status,'open');
  await h.service.abort(h.req(),old.sessionId); // Explicit test action; fixture retains staged data.
  await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  await assert.rejects(h.service.prepare(h.req(),prepareBody(frames)),hasCode('publish_operation_active'));
  await assert.rejects(h.service.publishSource(h.req(),'p',{source,frameIds:['1:1']}),hasCode('publish_operation_active'));
  assert.equal(h.vault.catalog.publishSessions.length,1);
  await cancel(h,h.req(),opId('op'));
  const fresh=await h.service.prepare(h.req(),prepareBody([payload(1)]));assert.ok(fresh.sessionId);
  assert.equal(h.vault.catalog.publishSessions.find(s=>s.id===old.sessionId).status,'aborted');
});

test('open/partial/未知操作和未知会话均不自动过期；取消只能显式发生',async t=>{
  const h=await fixture(t),frames=[payload(),payload(1)];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const first=await publish(h,[frames[0]],{operationId:opId('op'),batchIndex:0});
  const next=await h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:1}));
  h.advance(365*86400000);assert.equal((await h.service.query(h.req(),next.sessionId)).status,'open');
  await h.vault.transact(d=>{d.patch('publishOperations',opId('op'),{status:'unknown'});d.patch('publishSessions',next.sessionId,{status:'unknown'});});
  const version=h.vault.readVersion;assert.equal((await h.service.listOperations(h.req(),'p')).operations[0].status,'unknown');
  assert.equal((await h.service.query(h.req(),next.sessionId)).status,'unknown');assert.equal(h.vault.readVersion,version);
  await assert.rejects(h.service.createOperation(h.req(),operationBody('next',frames)),hasCode('publish_operation_active'));
  await assert.rejects(h.service.prepare(h.req(),prepareBody([payload(2)],{operationId:opId('op'),batchIndex:2})),hasCode('operation_not_open'));
  await assert.rejects(cancel(h,h.req(),opId('op')),hasCode('operation_state_unknown'));
  assert.equal((await h.service.query(h.req(),next.sessionId)).status,'unknown');
  assert.equal((await h.service.committedResult(h.req(),first.prepared.sessionId)).frames.length,1);
  assert.equal(h.vault.catalog.frameRevisions.length,1);
  await assert.rejects(h.service.createOperation(h.req(),operationBody('next',frames)),hasCode('publish_operation_active'));
});

test('只取消批次不会释放操作锁；操作取消保留已提交结果与原始 staging',async t=>{
  const h=await fixture(t),frames=[payload(),payload(1)];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const first=await publish(h,[frames[0]],{operationId:opId('op'),batchIndex:0});
  const next=await h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:1}));await upload(h,next.sessionId,[frames[1]]);
  await abort(h,h.req(),next.sessionId);
  await assert.rejects(finish(h,h.req(),opId('op')),hasCode('operation_incomplete'));
  await assert.rejects(h.service.createOperation(h.req(),operationBody('retry',frames)),hasCode('publish_operation_active'));
  assert.equal((await h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:1}))).status,'aborted');
  await assert.rejects(h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:2})),hasCode('operation_frames_mismatch'));
  const cancelled=await cancel(h,h.req(),opId('op'));assert.equal(cancelled.committedFrames[0].revisionId,first.result.frames[0].revisionId);
  assert.ok((await readdir(path.join(h.dataDir,'tmp',next.sessionId))).includes(frames[1].frame.layerDocSha256));
  assert.ok((await readdir(path.join(h.dataDir,'tmp',first.prepared.sessionId))).includes(frames[0].frame.layerDocSha256));
  const version=h.vault.readVersion;await cancel(h,h.req(),opId('op'));assert.equal(h.vault.readVersion,version);
  await assert.rejects(commit(h,h.req(),next.sessionId),hasCode('session_closed'));
});

test('操作/SID/result/list 严格按项目及创建用户隔离，管理员也不能隐式接管',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const batch=await publish(h,frames,{operationId:opId('op'),batchIndex:0});
  const recovered=h.req(),beforeRecovery=h.vault.readVersion;
  assert.equal((await h.service.queryOperation(recovered,opId('op'))).status,'partial');
  assert.equal((await h.service.query(recovered,batch.prepared.sessionId)).status,'committed');
  assert.equal(JSON.stringify(await h.service.listOperations(recovered,'p')).includes(writerSecret),false);
  await assert.rejects(h.service.publishSource(recovered,'p',{source,frameIds:['1:1'],operationId:opId('op')}),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.prepare(recovered,{...prepareBody(frames,{operationId:opId('op'),batchIndex:1}),writerSecret:undefined}),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.upload(recovered,batch.prepared.sessionId,frames[0].frame.layerDocSha256,Buffer.concat([Buffer.from('GLP1'),Buffer.alloc(32,0x23),frames[0].bytes])),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.commit(recovered,batch.prepared.sessionId),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.abort(recovered,batch.prepared.sessionId),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.finishOperation(recovered,opId('op'),{writerSecret:undefined,catalogReadVersion:h.vault.readVersion}),hasCode('writer_secret_invalid'));
  await assert.rejects(h.service.cancelOperation(recovered,opId('op'),{writerSecret:undefined}),hasCode('writer_secret_invalid'));
  assert.equal(h.vault.readVersion,beforeRecovery);
  for(const id of ['bob','reader','admin']){
    const req=h.req(id);assert.deepEqual((await h.service.listOperations(req,'p')).operations,[]);
    for(const action of [()=>h.service.queryOperation(req,opId('op')),()=>h.service.query(req,batch.prepared.sessionId),()=>h.service.committedResult(req,batch.prepared.sessionId),()=>finish(h,req,opId('op')),()=>cancel(h,req,opId('op')),()=>abort(h,req,batch.prepared.sessionId),()=>commit(h,req,batch.prepared.sessionId)])await assert.rejects(action,hasCode('not_found'));
  }
  await assert.rejects(h.service.createOperation(h.req('bob'),operationBody(opId('op'),frames,{projectId:'q'})),hasCode('not_found'));
  await assert.rejects(h.service.listOperations(h.req(),'q'),hasCode('project_forbidden'));
  await assert.rejects(h.service.prepare(h.req(),prepareBody(frames,{projectId:'p2',operationId:opId('op'),batchIndex:1})),hasCode('operation_project_mismatch'));
  const held=h.req();await h.vault.transact(d=>d.patch('users','alice',{status:'disabled',sessionVersion:1}));
  for(const action of [()=>h.service.queryOperation(held,opId('op')),()=>h.service.listOperations(held,'p'),()=>h.service.query(held,batch.prepared.sessionId),()=>finish(h,held,opId('op')),()=>cancel(h,held,opId('op'))])await assert.rejects(action,e=>e.status===401);
});

test('上传/提交物理 IO 中撤权或显式取消，最终事务不得发布或自动释放',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const batch=await h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0}));await upload(h,batch.sessionId,frames);
  const held=h.req();h.hooks.afterRead=async()=>{h.hooks.afterRead=null;await h.vault.transact(d=>d.patch('users','alice',{status:'disabled',sessionVersion:1}));};
  await assert.rejects(commit(h,held,batch.sessionId),e=>e.status===401);assert.equal(h.vault.catalog.frameRevisions.length,0);
  assert.equal(h.vault.catalog.publishOperations[0].status,'open');assert.equal(h.vault.catalog.publishSessions[0].status,'open');
  await h.vault.transact(d=>d.patch('users','alice',{status:'active'}));
  h.hooks.afterRead=async()=>{h.hooks.afterRead=null;await cancel(h,h.req(),opId('op'));};
  await assert.rejects(commit(h,h.req(),batch.sessionId),hasCode('session_closed'));assert.equal(h.vault.catalog.frameRevisions.length,0);
  assert.equal((await h.service.queryOperation(h.req(),opId('op'))).status,'cancelled');
});

test('upload 落盘期间取消，后续上传登记不能复活操作；重复上传仍核验字节',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const batch=await h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0}));
  await upload(h,batch.sessionId,frames);await upload(h,batch.sessionId,frames);
  assert.deepEqual((await h.service.query(h.req(),batch.sessionId)).uploaded,[frames[0].frame.layerDocSha256]);
  const bad=Buffer.from(frames[0].bytes);bad[0]^=1;
  await assert.rejects(h.service.upload(h.req(),batch.sessionId,frames[0].frame.layerDocSha256,framed(bad)),hasCode('sha256_mismatch'));
  h.hooks.afterStage=async()=>{h.hooks.afterStage=null;await cancel(h,h.req(),opId('op'));};
  await assert.rejects(upload(h,batch.sessionId,frames),hasCode('session_closed'));
  const state=await h.service.queryOperation(h.req(),opId('op'));assert.equal(state.status,'cancelled');assert.equal(state.batches[0].status,'aborted');
  assert.equal(h.vault.catalog.frameRevisions.length,0);assert.ok((await readdir(path.join(h.dataDir,'tmp',batch.sessionId))).includes(frames[0].frame.layerDocSha256));
});

test('排队期间撤权在 prepare 事务内重新检查；未知操作不得绕到旧 prepare',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const held=h.req(),revoke=h.vault.transact(d=>d.patch('users','alice',{status:'disabled',sessionVersion:1}));
  const prepared=h.service.prepare(held,prepareBody(frames,{operationId:opId('op'),batchIndex:0}));
  await revoke;await assert.rejects(prepared,e=>e.status===401);assert.equal(h.vault.catalog.publishSessions.length,0);
  await h.vault.transact(d=>{d.patch('users','alice',{status:'active'});d.patch('publishOperations',opId('op'),{status:'unrecognized'});});
  await assert.rejects(h.service.prepare(h.req(),prepareBody(frames)),hasCode('publish_operation_active'));
  await assert.rejects(h.service.prepare(h.req(),prepareBody(frames,{operationId:'not-known',batchIndex:0})),hasCode('not_found'));
  assert.equal(h.vault.catalog.publishSessions.length,0);
});

test('finish 必须重新检查事务时的未决会话和完整结果，不能仅凭 partial 或计数',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const batch=await h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0}));await upload(h,batch.sessionId,frames);
  const entered=deferred(),release=deferred();h.hooks.afterRead=async()=>{entered.resolve();await release.promise;};
  const committing=commit(h,h.req(),batch.sessionId);await entered.promise;
  try{await assert.rejects(finish(h,h.req(),opId('op')),hasCode('operation_sessions_open'));}finally{release.resolve();}
  await committing;h.hooks.afterRead=null;
  const result=h.vault.catalog.publishSessions[0].commitResult;
  await h.vault.transact(d=>d.patch('publishSessions',batch.sessionId,{commitResult:{...result,frames:[{...result.frames[0],figmaNodeId:'wrong-node'}]}}));
  await assert.rejects(finish(h,h.req(),opId('op')),hasCode('operation_incomplete'));
  assert.equal(h.vault.catalog.publishOperations[0].status,'partial');
  await h.vault.transact(d=>d.patch('publishSessions',batch.sessionId,{commitResult:result}));
  assert.equal((await finish(h,h.req(),opId('op'))).status,'completed');
});

test('分批不得遗漏、越界、重复画板或换来源；分组省略与 null 语义固定',async t=>{
  const h=await fixture(t),frames=[payload(),payload(1)];await h.service.createOperation(h.req(),operationBody(opId('op'),frames,{groupId:'g'}));await bind(h,opId('op'),frames);
  await assert.rejects(h.service.prepare(h.req(),prepareBody([frames[0]],{operationId:opId('op'),batchIndex:0})),hasCode('operation_group_mismatch'));
  await assert.rejects(h.service.prepare(h.req(),prepareBody([payload(2)],{operationId:opId('op'),batchIndex:0,groupId:'g'})),hasCode('operation_frames_mismatch'));
  await h.service.prepare(h.req(),prepareBody([frames[0]],{operationId:opId('op'),batchIndex:0,groupId:'g'}));
  await assert.rejects(h.service.prepare(h.req(),prepareBody([frames[0]],{operationId:opId('op'),batchIndex:1,groupId:'g'})),hasCode('operation_frames_mismatch'));
  await assert.rejects(h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:1,groupId:'g',designFile:{designFileId:'f2'},source:{kind:'figma-file',fileKey:'SyntheticP2'}})),hasCode('operation_source_mismatch'));
  const resolved=await h.service.publishSource(h.req(),'p',{source,frameIds:['1:2'],operationId:opId('op'),writerSecret});assert.equal(resolved.designFileId,'f');
  assert.equal(h.vault.catalog.publishSessions.length,1);
});

test('保留此前 dirty 的显式 groupId:null 清空分组和提交结果查询',async t=>{
  const h=await fixture(t),p=payload(),prior=await publish(h,[p],{groupId:'g'});
  const next=payload(0,{baseRevisionId:prior.result.frames[0].revisionId});await h.service.createOperation(h.req(),operationBody(opId('op'),[next],{groupId:null}));await bind(h,opId('op'),[next]);
  const batch=await publish(h,[next],{operationId:opId('op'),batchIndex:0,groupId:null});
  assert.equal(h.vault.catalog.frames[0].groupId,null);assert.equal((await finish(h,h.req(),opId('op'))).status,'completed');
  assert.deepEqual(json(await h.service.committedResult(h.req(),batch.prepared.sessionId)),json(batch.result));
});

test('跨批坐标别名不能重复发布同一目标画板',async t=>{
  const h=await fixture(t),frames=[payload(),payload(1,{x:0,y:0})];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  await h.service.prepare(h.req(),prepareBody([frames[0]],{operationId:opId('op'),batchIndex:0,coordinateMode:'project-xy'}));
  await assert.rejects(h.service.prepare(h.req(),prepareBody([frames[1]],{operationId:opId('op'),batchIndex:1,coordinateMode:'project-xy'})),hasCode('operation_frame_overlap'));
  assert.equal(h.vault.catalog.publishSessions.length,1);assert.equal(h.vault.catalog.frames.length,1);
});

test('仓库 invariant 阻止绕开协调器并发锁、重复键、旧 open 及活动期换 owner',async t=>{
  const h=await fixture(t),frames=[payload()];await h.service.createOperation(h.req(),operationBody(opId('op'),frames));await bind(h,opId('op'),frames);
  const op=h.vault.catalog.publishOperations[0];
  await assert.rejects(h.vault.transact(d=>d.add('publishOperations',{...op,id:'collision'})),hasCode('catalog_relations_invalid'));
  await assert.rejects(h.vault.transact(d=>d.add('publishSessions',{id:'legacy',projectId:'p',designFileId:'f',createdBy:'alice',status:'open'})),hasCode('catalog_relations_invalid'));
  const accounts=createAccountProjectService({vault:h.vault,auth:h.auth,permissions:h.permissions,clock:h.clock});
  await assert.rejects(accounts.updateProject(h.req('admin').user,'p',{ownerId:'bob',expectedOwnerId:'alice'}),hasCode('catalog_relations_invalid'));
  const batch=await h.service.prepare(h.req(),prepareBody(frames,{operationId:opId('op'),batchIndex:0})),s=h.vault.catalog.publishSessions[0];
  await assert.rejects(h.vault.transact(d=>d.add('publishSessions',{...s,id:'duplicate',prepareResult:{...s.prepareResult,sessionId:'duplicate'}})),hasCode('catalog_relations_invalid'));
  await assert.rejects(h.vault.transact(d=>d.patch('publishSessions',batch.sessionId,{projectId:'q',designFileId:'fq'})),hasCode('catalog_relations_invalid'));
  await assert.rejects(h.vault.transact(d=>d.patch('publishOperations',opId('op'),{status:'completed'})),hasCode('catalog_relations_invalid'));
});

test('仅本机隔离 HTTP：无签名旧 ID 拒绝，签名 operation 与旧发布均可用',async t=>{
  const h=await fixture(t),app=await createPlatform({dataDir:h.dataDir,vault:h.vault,secret:randomBytes(48),clock:h.clock,host:'127.0.0.1',logger:{error(){}}});
  const address=await app.listen(0),origin=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await app.close();await h.close();});
  const tokens=Object.fromEntries(h.vault.catalog.users.map(u=>[u.id,app.auth.issueAccess(u)]));
  async function request(route,{user='alice',body,method=body===undefined?'GET':'POST',headers={}}={}){
    const response=await fetch(origin+route,{method,headers:{Authorization:`Bearer ${tokens[user]}`,Origin:'null',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  }
  const frames=[payload()],version=h.vault.readVersion;
  assert.equal((await request('/api/publish/operations',{body:{...operationBody('http',frames),operationId:'http'}})).status,403);
  const empty=await request('/api/publish/operations?projectId=p');assert.equal(empty.status,200);assert.deepEqual(empty.value.operations,[]);
  assert.equal((await request('/api/publish/operations/http')).status,404);
  assert.equal((await request('/api/publish/operations/http/finish',{body:{writerSecret,catalogReadVersion:h.vault.readVersion}})).status,404);
  assert.equal((await request('/api/publish/operations/http/cancel',{body:{writerSecret}})).status,404);
  assert.equal(h.vault.readVersion,version);
  const prepared=await request('/api/publish/sessions',{body:prepareBody(frames)});
  assert.equal(prepared.status,200);assert.equal(prepared.value.status,'open');
  assert.equal((await request(`/api/publish/sessions/${prepared.value.sessionId}`)).value.sessionId,prepared.value.sessionId);
  assert.equal((await request(`/api/publish/sessions/${prepared.value.sessionId}/abort`,{body:{}})).value.status,'aborted');
  const intent=await request('/api/publish/intent?projectId=p');assert.equal(intent.status,200);
  const id=intent.value.operationId,created=await request('/api/publish/operations',{body:{...operationBody('http',frames),operationId:id}});
  assert.equal(created.status,200);assert.equal(created.value.status,'open');assert.equal(JSON.stringify(created.value).includes(writerSecret),false);
  assert.equal((await request(`/api/publish/operations/${id}`)).value.operationId,id);
  assert.equal((await request(`/api/publish/operations/${id}/finish`,{body:{writerSecret,catalogReadVersion:h.vault.readVersion}})).status,409);
  assert.equal((await request(`/api/publish/operations/${id}/cancel`,{body:{writerSecret}})).value.status,'cancelled');
});
