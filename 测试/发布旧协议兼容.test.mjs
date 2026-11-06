// Ordinary synthetic compatibility tests only: no server, real network, filesystem,
// production data, deletion, or execution of the separate security regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublishing } from '../平台/发布.mjs';
import { TABLES } from '../平台/仓库.mjs';
import { createPermissions } from '../平台/权限.mjs';
import { validatePrepareResult, validateSessionResult } from '../插件/production-protocol.mjs';

const start = Date.parse('2026-01-01T00:00:00.000Z');
const source = {kind:'figma-file',fileKey:'FixtureFile'};
const document = {contractVersion:1,frame:{id:'2:1',type:'FRAME',name:'Synthetic',children:[],absoluteBoundingBox:{x:10,y:20,width:100,height:80}}};
const bytes = Buffer.from(JSON.stringify(document));
const hash = createHash('sha256').update(bytes).digest('hex');
const initial = () => {
  const catalog = Object.fromEntries(TABLES.map(table => [table,[]]));
  catalog.users.push({id:'user',username:'fixture',role:'designer',status:'active',sessionVersion:0});
  catalog.projects.push({id:'project',ownerId:'user',name:'Fixture'});
  catalog.frameGroups.push({id:'old-group',projectId:'project',name:'Old'},{id:'new-group',projectId:'project',name:'New'});
  catalog.designFiles.push({id:'file',projectId:'project',figmaFileKey:'FixtureFile',publishingSource:source});
  catalog.pages.push({id:'page',designFileId:'file',figmaPageId:'1:1',name:'Page'});
  catalog.frames.push({id:'frame',projectId:'project',designFileId:'file',pageId:'page',figmaNodeId:'2:1',groupId:'old-group',currentRevisionId:'revision',state:'published',x:10,y:20,width:100,height:80});
  catalog.frameRevisions.push({id:'revision',frameId:'frame',projectId:'project',designFileId:'file',pageId:'page',figmaNodeId:'2:1',assetHash:'b'.repeat(64),layerDocAssetId:'asset'});
  catalog.assets.push({id:'asset',sha256:hash,mime:'application/json',bytes:bytes.length,relativePath:`${hash.slice(0,2)}/${hash}.json`});
  return catalog;
};

// Isolated transactional model: each draft commits atomically only on success.
// Asset bodies and staging live in memory; discardStaged is a non-deleting spy.
function fixture() {
  let now = start, catalog = initial(), tail = Promise.resolve();
  const staged = new Map(), counts = {read:0,stage:0,put:0,discard:0};
  const hooks = {read:null,stage:null};
  const vault = {
    get catalog() { return catalog; },
    transact(worker,{signal}={}) {
      const work = tail.then(async()=>{
        if(signal?.aborted) throw Object.assign(new Error('aborted'),{status:499});
        const next = structuredClone(catalog);
        const d = {
          all: table => next[table],
          byId: (table,id) => next[table].find(row=>row.id===id),
          add: (table,row) => { assert.ok(!next[table].some(value=>value.id===row.id)); next[table].push(structuredClone(row)); return row; },
          patch: (table,id,changes) => { const index=next[table].findIndex(row=>row.id===id); assert.notEqual(index,-1,`${table}/${id}`); return next[table][index]={...next[table][index],...structuredClone(changes)}; }
        };
        const result=await worker(d);
        if(signal?.aborted) throw Object.assign(new Error('aborted'),{status:499});
        catalog=next; return result;
      });
      tail=work.catch(()=>{}); return work;
    },
    async readOriginal(asset) { counts.read++; hooks.read?.(); assert.equal(asset.sha256,hash); return Buffer.from(bytes); },
    async stageAsset(sessionId,descriptor,value) { counts.stage++; staged.set(`${sessionId}:${descriptor.sha256}`,Buffer.from(value)); hooks.stage?.(); return {sessionId,sha256:descriptor.sha256}; },
    async readStaged(sessionId,digest) { const value=staged.get(`${sessionId}:${digest}`); if(!value) throw Object.assign(new Error('missing'),{status:404}); return Buffer.from(value); },
    async putOriginal() { counts.put++; throw new Error('Unexpected synthetic original write'); },
    async discardStaged() { counts.discard++; throw new Error('Synthetic cleanup forbidden'); }
  };
  const auth = {actor:()=>({id:'user',username:'fixture',role:'designer',sessionVersion:0})};
  const permissions = createPermissions({vault,clock:()=>now});
  const req={headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}};
  const service = createPublishing({vault,auth,permissions,clock:()=>now,publishIntentKey:Buffer.alloc(32,0x47)});
  const operationInput = async extra => {
    const {operationId}=await service.createIntent(req,'project');
    return {operationId,projectId:'project',frameIds:['2:1'],...extra,writerSecret:Buffer.alloc(32,0x53).toString('base64url')};
  };
  const createOperation = async extra => {
    const input=await operationInput(extra); await service.createOperation(req,input);
    await service.publishSource(req,'project',{source,name:'Fixture',frameIds:input.frameIds,operationId:input.operationId,writerSecret:input.writerSecret});
    return input;
  };
  const body = extra => ({projectId:'project',designFile:{designFileId:'file'},source,requireBaseRevision:true,coordinateMode:'project-xy',frames:[{figmaNodeId:'2:1',figmaPageId:'1:1',name:'Synthetic',x:10,y:20,width:100,height:80,hash:'a'.repeat(64),layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:'revision'}],...extra});
  return {service,vault,req,body,operationInput,createOperation,counts,hooks,staged,setTime:value=>{now=value;}};
}
const keys = value => Object.keys(value).sort();
const legacyPrepareKeys=['sessionId','status','expiresAt','designFileId','maxUploadBytes','uploadPolicy','missingAssetSha256','frames'].sort();
const legacyQueryKeys=['sessionId','status','expiresAt','uploaded','uploadPolicy','frames'].sort();
const session = (h,id) => h.vault.catalog.publishSessions.find(row=>row.id===id);
const frame = h => h.vault.catalog.frames.find(row=>row.id==='frame');

for(const extra of [{},{groupId:null},{groupId:'new-group'}]) test(`legacy: 精确响应和续传分组 ${JSON.stringify(extra)}`,async()=>{
  const h=fixture(), body=h.body(extra), prepared=await h.service.prepare(h.req,body);
  assert.deepEqual(keys(prepared),legacyPrepareKeys);
  assert.equal(validatePrepareResult(prepared,body),prepared);
  const queried=await h.service.query(h.req,prepared.sessionId);
  assert.deepEqual(keys(queried),legacyQueryKeys);
  assert.equal(validateSessionResult(queried,prepared.sessionId),queried);
  assert.equal(Object.hasOwn(session(h,prepared.sessionId),'groupId'),extra.groupId==='new-group');
  const result=await h.service.commit(h.req,prepared.sessionId);
  assert.equal(result.status,'committed');
  assert.equal(frame(h).groupId,extra.groupId==='new-group'?'new-group':'old-group');
  const finalQuery=await h.service.query(h.req,prepared.sessionId);
  assert.deepEqual(keys(finalQuery),legacyQueryKeys); assert.equal(validateSessionResult(finalQuery,prepared.sessionId),finalQuery);
});

test('旧草稿中已存的 legacy groupId:null 也不能清除既有分组',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  await h.vault.transact(d=>d.patch('publishSessions',prepared.sessionId,{groupId:null}));
  await h.service.commit(h.req,prepared.sessionId);
  assert.equal(frame(h).groupId,'old-group');
});

test('无 operation 且明确 set/null：持久记录清组意图，响应仍兼容旧严格字段',async()=>{
  const h=fixture(), body=h.body({groupId:null,groupAssignment:'set'});
  const prepared=await h.service.prepare(h.req,body);
  assert.deepEqual(keys(prepared),legacyPrepareKeys); assert.equal(validatePrepareResult(prepared,body),prepared);
  assert.equal(session(h,prepared.sessionId).groupAssignment,'set');
  assert.equal(Object.hasOwn(session(h,prepared.sessionId),'groupId'),true);
  assert.equal(session(h,prepared.sessionId).groupId,null);
  const query=await h.service.query(h.req,prepared.sessionId);
  assert.deepEqual(keys(query),legacyQueryKeys); assert.equal(validateSessionResult(query,prepared.sessionId),query);
  await h.service.commit(h.req,prepared.sessionId);
  assert.equal(frame(h).groupId,null); assert.equal(session(h,prepared.sessionId).groupAssignment,'set');
});

test('无 operation 的明确 set 可移动到指定分组',async()=>{
  const h=fixture(), body=h.body({groupId:'new-group',groupAssignment:'set'});
  const prepared=await h.service.prepare(h.req,body);
  assert.equal(session(h,prepared.sessionId).groupAssignment,'set');
  await h.service.commit(h.req,prepared.sessionId);
  assert.equal(frame(h).groupId,'new-group');
});

test('groupAssignment 仅允许 set 且必须同时明确提供合法 groupId',async()=>{
  const variants=[{groupAssignment:'set'}, {groupAssignment:'set',groupId:undefined},
    ...[null,undefined,'','replace',false,true,1,{},[]].map(groupAssignment=>({groupId:null,groupAssignment}))];
  for(const extra of variants){
    const h=fixture(), before=structuredClone(h.vault.catalog);
    await assert.rejects(h.service.prepare(h.req,h.body(extra)),{status:400,code:'invalid_group_assignment'});
    assert.deepEqual(h.vault.catalog,before);
  }
  const h=fixture(), before=structuredClone(h.vault.catalog);
  await assert.rejects(h.service.prepare(h.req,h.body({groupId:'bad id',groupAssignment:'set'})),{status:400,code:'invalid_group_id'});
  assert.deepEqual(h.vault.catalog,before);
});

test('operation 批次完整请求 hash 包含 groupAssignment，重放意图变化被拒绝',async()=>{
  const h=fixture(),operation=await h.createOperation({groupId:null});
  const body=h.body({operationId:operation.operationId,writerSecret:operation.writerSecret,batchIndex:0,groupId:null,groupAssignment:'set'});
  const prepared=await h.service.prepare(h.req,body);
  assert.equal(session(h,prepared.sessionId).groupAssignment,'set');
  assert.equal((await h.service.prepare(h.req,body)).sessionId,prepared.sessionId);
  const before=structuredClone(h.vault.catalog),withoutFlag={...body}; delete withoutFlag.groupAssignment;
  await assert.rejects(h.service.prepare(h.req,withoutFlag),{status:409,code:'batch_request_mismatch'});
  assert.deepEqual(h.vault.catalog,before);
  await h.service.commit(h.req,prepared.sessionId,{writerSecret:operation.writerSecret}); assert.equal(frame(h).groupId,null);
});

test('新 operation 显式 null 才表示清组，扩展字段仅属于新协议',async()=>{
  const h=fixture(),operation=await h.createOperation({groupId:null});
  const prepared=await h.service.prepare(h.req,h.body({operationId:operation.operationId,writerSecret:operation.writerSecret,batchIndex:0,groupId:null}));
  assert.equal(prepared.automaticExpiry,false); assert.equal(prepared.operationId,operation.operationId); assert.equal(prepared.expiresAt,null);
  const query=await h.service.query(h.req,prepared.sessionId);
  assert.equal(query.automaticExpiry,false); assert.equal(query.operationId,operation.operationId);
  h.setTime(start+10*24*60*60*1000); // Operation sessions have no legacy expiry.
  await h.service.commit(h.req,prepared.sessionId,{writerSecret:operation.writerSecret});
  assert.equal(frame(h).groupId,null);
});

for(const extra of [{},{groupId:'new-group'}]) test(`新 operation 缺省/指定分组行为 ${JSON.stringify(extra)}`,async()=>{
  const h=fixture(), operation=await h.createOperation(extra);
  const prepared=await h.service.prepare(h.req,h.body({operationId:operation.operationId,writerSecret:operation.writerSecret,batchIndex:0,...extra}));
  await h.service.commit(h.req,prepared.sessionId,{writerSecret:operation.writerSecret});
  assert.equal(frame(h).groupId,extra.groupId || 'old-group');
});

test('legacy 过期 SID 保持 open 和项目锁；查询不写入，迟到 upload/commit 均拒绝',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  h.setTime(Date.parse(prepared.expiresAt));
  const before=structuredClone(h.vault.catalog);
  const queried=await h.service.query(h.req,prepared.sessionId);
  assert.equal(queried.status,'open'); assert.deepEqual(keys(queried),legacyQueryKeys);
  await assert.rejects(h.service.upload(h.req,prepared.sessionId,hash,bytes),{status:409,code:'session_expired'});
  await assert.rejects(h.service.commit(h.req,prepared.sessionId),{status:409,code:'session_expired'});
  const attemptedOperation=await h.operationInput();
  await assert.rejects(h.service.createOperation(h.req,attemptedOperation),{status:409,code:'publish_session_active'});
  assert.deepEqual(h.vault.catalog,before); assert.equal(h.counts.read,0); assert.equal(h.counts.stage,0); assert.equal(h.counts.discard,0);
});

test('legacy 期限缺失或损坏时拒绝写入，保持未解决状态',async()=>{
  for(const expiresAt of [null,'invalid']) {
    const h=fixture(), prepared=await h.service.prepare(h.req,h.body());
    await h.vault.transact(d=>d.patch('publishSessions',prepared.sessionId,{expiresAt}));
    const before=structuredClone(h.vault.catalog);
    await assert.rejects(h.service.upload(h.req,prepared.sessionId,hash,bytes),{status:409,code:'session_expired'});
    await assert.rejects(h.service.commit(h.req,prepared.sessionId),{status:409,code:'session_expired'});
    assert.deepEqual(h.vault.catalog,before); assert.equal(h.counts.discard,0);
  }
});

test('legacy 上传中跨过期限时最终事务拒绝，未记已上传且内存暂存保留',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  h.hooks.stage=()=>h.setTime(Date.parse(prepared.expiresAt));
  await assert.rejects(h.service.upload(h.req,prepared.sessionId,hash,bytes),{status:409,code:'session_expired'});
  assert.deepEqual(session(h,prepared.sessionId).uploaded,[]);
  assert.equal(session(h,prepared.sessionId).status,'open');
  assert.deepEqual(h.staged.get(`${prepared.sessionId}:${hash}`),bytes);
  assert.equal(h.counts.discard,0);
});

test('legacy 提交读取中跨过期限时最终事务拒绝，无新修订、不清理',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  const before=structuredClone(h.vault.catalog);
  h.hooks.read=()=>h.setTime(Date.parse(prepared.expiresAt));
  await assert.rejects(h.service.commit(h.req,prepared.sessionId),{status:409,code:'session_expired'});
  assert.deepEqual(h.vault.catalog,before); assert.equal(frame(h).currentRevisionId,'revision');
  assert.equal(h.counts.read,1); assert.equal(h.counts.discard,0);
});

test('到期前已提交的 legacy 重复 commit 仅读取原结果，不创建新修订',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  const first=await h.service.commit(h.req,prepared.sessionId), before=structuredClone(h.vault.catalog);
  h.setTime(Date.parse(prepared.expiresAt));
  const replay=await h.service.commit(h.req,prepared.sessionId);
  assert.equal(replay.idempotent,true); assert.deepEqual(replay.frames,first.frames);
  assert.deepEqual(h.vault.catalog,before);
});

test('未知 legacy session 状态不得臆作 aborted，也不尝试清理',async()=>{
  const h=fixture(), prepared=await h.service.prepare(h.req,h.body({groupId:null}));
  await h.vault.transact(d=>d.patch('publishSessions',prepared.sessionId,{status:'future-state'}));
  const before=structuredClone(h.vault.catalog);
  await assert.rejects(h.service.abort(h.req,prepared.sessionId),{status:409,code:'session_state_unknown'});
  assert.deepEqual(h.vault.catalog,before); assert.equal(h.counts.discard,0);
});

test('未知 operation 或任意未知批次禁止取消，所有已知批次也不能部分中止',async()=>{
  const h=fixture(),operation=await h.createOperation({groupId:null});
  const prepared=await h.service.prepare(h.req,h.body({operationId:operation.operationId,writerSecret:operation.writerSecret,batchIndex:0,groupId:null}));
  const existing=structuredClone(session(h,prepared.sessionId));
  await h.vault.transact(d=>{
    d.add('publishSessions',{...existing,id:'second',batchIndex:1,prepareResult:{...existing.prepareResult,sessionId:'second'},status:'future-state'});
  });
  const before=structuredClone(h.vault.catalog);
  await assert.rejects(h.service.cancelOperation(h.req,operation.operationId,{writerSecret:operation.writerSecret}),{status:409,code:'session_state_unknown'});
  assert.deepEqual(h.vault.catalog,before); assert.equal(session(h,prepared.sessionId).status,'open');
  await h.vault.transact(d=>d.patch('publishOperations',operation.operationId,{status:'future-operation'}));
  const unknown=structuredClone(h.vault.catalog);
  await assert.rejects(h.service.cancelOperation(h.req,operation.operationId,{writerSecret:operation.writerSecret}),{status:409,code:'operation_state_unknown'});
  assert.deepEqual(h.vault.catalog,unknown); assert.equal(h.counts.discard,0);
});

test('已知 open operation 可明确取消且只中止其 open 批次',async()=>{
  const h=fixture(),operation=await h.createOperation({groupId:null});
  const prepared=await h.service.prepare(h.req,h.body({operationId:operation.operationId,writerSecret:operation.writerSecret,batchIndex:0,groupId:null}));
  const result=await h.service.cancelOperation(h.req,operation.operationId,{writerSecret:operation.writerSecret});
  assert.equal(result.status,'cancelled'); assert.equal(session(h,prepared.sessionId).status,'aborted');
  assert.equal(h.counts.discard,0);
});
