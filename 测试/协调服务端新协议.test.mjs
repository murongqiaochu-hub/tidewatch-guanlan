import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openVault } from '../平台/仓库.mjs';
import { createPublishing, installPublishing } from '../平台/发布.mjs';
import { sha256 } from '../平台/下载.mjs';

function fixture(){
 const root=Object.fromEntries(['publishSessions','publishOperations','designFiles','projects','frameGroups','frames','pages','frameRevisions','assets','revisionAssets','auditLogs'].map(k=>[k,[]]));root.projects.push({id:'p',ownerId:'u'});root.designFiles.push({id:'f',projectId:'p',figmaFileKey:'Key',publishingSource:{kind:'figma-file',fileKey:'Key'}});
 let queue=Promise.resolve(),version=0;const staged=new Map();
 const vault={get catalog(){return root;},get readVersion(){return `synthetic:${version}`;},transact(fn){const run=queue.then(()=>{const draft=structuredClone(root);const d={all:k=>draft[k],byId:(k,id)=>draft[k].find(x=>x.id===id),add:(k,x)=>draft[k].push(x),patch:(k,id,x)=>Object.assign(draft[k].find(y=>y.id===id),x)};const result=fn(d);for(const k of Object.keys(root))root[k]=draft[k];version++;return result;});queue=run.catch(()=>{});return run;},async stageAsset(id,d,b){staged.set(id+':'+d.sha256,Buffer.from(b));},async readStaged(id,h){return staged.get(id+':'+h);},async putOriginal(x){return {...x,data:undefined,relativePath:'synthetic'};},async discardStaged(){}};
 const auth={actor:req=>({id:req.userId || 'u',username:req.userId || 'u'})},permissions={requireRead(){},requirePublish(user){if(user.id==='revoked')throw Object.assign(new Error('forbidden'),{status:403,code:'forbidden'});}},publishIntentKey=Buffer.alloc(32,7);return {vault,auth,permissions,publishIntentKey,svc:createPublishing({vault,auth,permissions,publishIntentKey}),req:{headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}},staged};
}
const source={kind:'figma-file',fileKey:'Key'};
test('操作写者隔离、原 SID 恢复、GLP1 原字节及显式终态',async()=>{
 const {svc,req,vault,staged}=fixture(),secret=randomBytes(32).toString('base64url'),wrong=randomBytes(32).toString('base64url');
 const {operationId}=await svc.createIntent(req,'p'),other=(await svc.createIntent(req,'p')).operationId;
 const claim={operationId,projectId:'p',frameIds:['1:1'],groupId:null,writerSecret:secret};
 const op=await svc.createOperation(req,claim);assert.equal(op.status,'open');assert(!JSON.stringify(op).includes(secret));assert(!JSON.stringify(vault.catalog).includes(secret));
 await assert.rejects(svc.createOperation(req,{...claim,operationId:other}),e=>e.code==='publish_operation_active');
 await assert.rejects(svc.publishSource(req,'p',{source,frameIds:['1:1']}),e=>e.code==='publish_operation_active');
 await assert.rejects(svc.publishSource(req,'p',{source,frameIds:['1:1'],operationId:operationId,writerSecret:wrong}),e=>e.code==='writer_secret_invalid');
 await svc.publishSource(req,'p',{source,frameIds:['1:1'],operationId:operationId,writerSecret:secret});
 const box={x:0,y:0,width:2,height:2},bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id:'1:1',type:'FRAME',name:'F',absoluteBoundingBox:box,children:[]}})),hash=sha256(bytes);
 const body={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[{figmaNodeId:'1:1',figmaPageId:'0:1',name:'F',...box,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null}],operationId:operationId,batchIndex:0,groupId:null,writerSecret:secret};
 const prepared=await svc.prepare(req,body),again=await svc.prepare(req,body);assert.equal(again.sessionId,prepared.sessionId);assert.equal((await svc.queryOperation(req,operationId)).batches[0].sessionId,prepared.sessionId);
 await assert.rejects(svc.prepare(req,{...body,frames:[{...body.frames[0],name:'Other'}]}),e=>e.code==='batch_request_mismatch');
 await assert.rejects(svc.upload(req,prepared.sessionId,hash,bytes),e=>e.code==='writer_secret_invalid');
 await assert.rejects(svc.upload(req,prepared.sessionId,hash,Buffer.concat([Buffer.from('GLP1'),Buffer.from(wrong,'base64url'),bytes])),e=>e.code==='writer_secret_invalid');
 await svc.upload(req,prepared.sessionId,hash,Buffer.concat([Buffer.from('GLP1'),Buffer.from(secret,'base64url'),bytes]));assert.deepEqual(staged.get(prepared.sessionId+':'+hash),bytes);
 await assert.rejects(svc.commit(req,prepared.sessionId),e=>e.code==='writer_secret_invalid');
 const committed=await svc.commit(req,prepared.sessionId,{writerSecret:secret});assert.equal(committed.status,'committed');
 await assert.rejects(svc.finishOperation(req,operationId,{writerSecret:wrong,catalogReadVersion:vault.readVersion}),e=>e.code==='writer_secret_invalid');
 const before=vault.readVersion;await vault.transact(d=>d.patch('frames',committed.frames[0].frameId,{name:'layout changed'}));
 await assert.rejects(svc.finishOperation(req,operationId,{writerSecret:secret,catalogReadVersion:before}),e=>e.code==='catalog_version_conflict');
 assert.equal((await svc.finishOperation(req,operationId,{writerSecret:secret,catalogReadVersion:vault.readVersion})).status,'completed');
 assert(!JSON.stringify(await svc.queryOperation(req,operationId)).includes(vault.catalog.publishOperations[0].writerDigest));
});

test('先前旧会话与操作互斥，显式取消阻断迟到写且未知状态锁定',async()=>{
 const {svc,req,vault}=fixture(),secret=randomBytes(32).toString('base64url');
 await vault.transact(d=>d.add('publishSessions',{id:'old',projectId:'p',designFileId:'f',createdBy:'u',status:'open'}));
 const {operationId}=await svc.createIntent(req,'p'),next=(await svc.createIntent(req,'p')).operationId,third=(await svc.createIntent(req,'p')).operationId;
 const claim={operationId,projectId:'p',frameIds:['1:1'],writerSecret:secret};
 await assert.rejects(svc.createOperation(req,claim),e=>e.code==='publish_session_active');
 await vault.transact(d=>d.patch('publishSessions','old',{status:'aborted'}));await svc.createOperation(req,claim);
 await assert.rejects(svc.cancelOperation(req,operationId,{writerSecret:randomBytes(32).toString('base64url')}),e=>e.code==='writer_secret_invalid');
 assert.equal((await svc.cancelOperation(req,operationId,{writerSecret:secret})).status,'cancelled');
 await assert.rejects(svc.publishSource(req,'p',{source,frameIds:['1:1'],operationId:operationId,writerSecret:secret}),e=>e.code==='operation_not_open');
 await svc.createOperation(req,{...claim,operationId:next});await vault.transact(d=>d.patch('publishOperations',next,{status:'unknown'}));
 await assert.rejects(svc.cancelOperation(req,next,{writerSecret:secret}),e=>e.code==='operation_state_unknown');
 await assert.rejects(svc.createOperation(req,{...claim,operationId:third}),e=>e.code==='publish_operation_active');
});

test('显式取消与在途 commit 争胜：取消先落库则 commit 无法写终态',async()=>{
 const {svc,req,vault}=fixture(),secret=randomBytes(32).toString('base64url'),box={x:0,y:0,width:2,height:2};
 const bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id:'1:1',type:'FRAME',name:'F',absoluteBoundingBox:box,children:[]}})),hash=sha256(bytes),{operationId}=await svc.createIntent(req,'p');
 await svc.createOperation(req,{operationId:operationId,projectId:'p',frameIds:['1:1'],writerSecret:secret});
 await svc.publishSource(req,'p',{source,frameIds:['1:1'],operationId:operationId,writerSecret:secret});
 const body={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[{figmaNodeId:'1:1',figmaPageId:'0:1',name:'F',...box,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null}],operationId:operationId,batchIndex:0,writerSecret:secret};
 const {sessionId}=await svc.prepare(req,body);await svc.upload(req,sessionId,hash,Buffer.concat([Buffer.from('GLP1'),Buffer.from(secret,'base64url'),bytes]));
 let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),read=vault.readStaged;
 vault.readStaged=async(...args)=>{const value=await read(...args);entered();await gate;return value;};
 const commit=svc.commit(req,sessionId,{writerSecret:secret});await waiting;
 await assert.rejects(svc.recoverCancel({...req,userId:'other'},operationId,{projectId:'p'}),e=>e.code==='not_found');
 assert.equal((await svc.recoverCancel(req,operationId,{projectId:'p'})).status,'cancelled');release();
 await assert.rejects(commit,e=>e.code==='session_closed');assert.equal(vault.catalog.frameRevisions.length,0);assert.equal((await svc.query(req,sessionId)).status,'aborted');
 assert.equal((await svc.createOperation(req,{operationId:operationId,projectId:'p',frameIds:['1:1'],writerSecret:secret})).status,'cancelled');
});

test('恢复取消保留已提交批次并关闭另一批次',async()=>{
 const {svc,req,vault}=fixture(),secret=randomBytes(32).toString('base64url'),ids=['1:1','1:2'],{operationId}=await svc.createIntent(req,'p');
 await svc.createOperation(req,{operationId:operationId,projectId:'p',frameIds:ids,writerSecret:secret});await svc.publishSource(req,'p',{source,frameIds:ids,operationId:operationId,writerSecret:secret});
 async function prepare(id,index){const box={x:index,y:0,width:2,height:2},bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id,type:'FRAME',name:id,absoluteBoundingBox:box,children:[]}})),hash=sha256(bytes),body={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[{figmaNodeId:id,figmaPageId:'0:1',name:id,...box,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null}],operationId:operationId,batchIndex:index,writerSecret:secret};return {...await svc.prepare(req,body),bytes,hash};}
 const first=await prepare(ids[0],0);await svc.upload(req,first.sessionId,first.hash,Buffer.concat([Buffer.from('GLP1'),Buffer.from(secret,'base64url'),first.bytes]));await svc.commit(req,first.sessionId,{writerSecret:secret});
 const second=await prepare(ids[1],1),result=await svc.recoverCancel(req,operationId,{projectId:'p'});assert.equal(result.status,'cancelled');assert.equal(result.committedFrames.length,1);assert.deepEqual(result.remainingFrameIds,['1:2']);assert.equal((await svc.query(req,second.sessionId)).status,'aborted');assert.equal(vault.catalog.frameRevisions.length,1);
 await assert.rejects(svc.commit(req,second.sessionId,{writerSecret:secret}),e=>e.code==='session_closed');
});

test('1001目标可分批冻结source，旧会话开启时拒绝旧source与prepare',async()=>{
 const {svc,req,vault}=fixture(),secret=randomBytes(32).toString('base64url'),ids=Array.from({length:1001},(_,i)=>`1:${i}`),{operationId}=await svc.createIntent(req,'p');
 await svc.createOperation(req,{operationId:operationId,projectId:'p',frameIds:ids,writerSecret:secret});
 for(const frameIds of [ids.slice(0,1000),ids.slice(1000)])await svc.publishSource(req,'p',{source,frameIds,operationId:operationId,writerSecret:secret});
 assert.equal((await svc.queryOperation(req,operationId)).frameIds.length,1001);
 const content=Buffer.from('{}'),digest=sha256(content),makeFrame=(id,i)=>({figmaNodeId:id,figmaPageId:'0:1',name:id,x:i,y:0,width:2,height:2,hash:digest,layerDocSha256:digest,layerDocBytes:content.length,exports:[],baseRevisionId:null});
 for(const [batchIndex,batch] of [ids.slice(0,1000),ids.slice(1000)].entries()){
   const b={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:batch.map((id,i)=>makeFrame(id,i+batchIndex*1000)),operationId:operationId,batchIndex,writerSecret:secret};
   const prepared=await svc.prepare(req,b);assert.equal(prepared.frames.length,batch.length);assert.equal((await svc.prepare(req,b)).sessionId,prepared.sessionId);
 }
 assert.equal((await svc.queryOperation(req,operationId)).batches.length,2);
 await svc.cancelOperation(req,operationId,{writerSecret:secret});
 await vault.transact(d=>d.add('publishSessions',{id:'old',projectId:'p',designFileId:'f',createdBy:'u',status:'open'}));
 await assert.rejects(svc.publishSource(req,'p',{source,frameIds:['1:1']}),e=>e.code==='publish_session_active');
 const bytes=Buffer.from('{}'),hash=sha256(bytes),frame={figmaNodeId:'1:1',figmaPageId:'0:1',name:'F',x:0,y:0,width:2,height:2,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null};
 await assert.rejects(svc.prepare(req,{projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[frame]}),e=>e.code==='publish_session_active');
});

test('签名 intent 防跨账号伪造，先取消tombstone阻迟到claim，撤权拒绝',async()=>{
 const h=fixture(),{svc,req,vault}=h,writerSecret=randomBytes(32).toString('base64url');
 const {operationId,projectId}=await svc.createIntent(req,'p');assert.match(operationId,/^op_[a-f0-9]{32}_[a-f0-9]{64}$/);
 await assert.rejects(svc.recoverCancel({...req,userId:'other'},operationId,{projectId}),e=>e.code==='not_found');
 await assert.rejects(svc.createOperation({...req,userId:'other'},{operationId,projectId,frameIds:['1:1'],writerSecret}),e=>e.code==='invalid_operation_intent');
 await assert.rejects(svc.recoverCancel({...req,userId:'revoked'},operationId,{projectId}),e=>e.code==='forbidden');
 await assert.rejects(svc.recoverCancel(req,'legacy_unknown',{projectId}),e=>e.code==='not_found');
 await assert.rejects(svc.createOperation(req,{operationId:'legacy_unknown',projectId,frameIds:['1:1'],writerSecret}),e=>e.code==='invalid_operation_intent');
 const reopened=createPublishing({vault,auth:h.auth,permissions:h.permissions,publishIntentKey:h.publishIntentKey});
 const result=await reopened.recoverCancel(req,operationId,{projectId});assert.equal(result.status,'cancelled');assert.equal(result.cancelTombstone,true);assert.deepEqual(result.frameIds,[]);assert.equal((await reopened.queryOperation(req,operationId)).cancelTombstone,true);assert.equal(vault.catalog.auditLogs.length,1);
 await assert.rejects(svc.createOperation(req,{operationId,projectId,frameIds:['1:1'],writerSecret}),e=>e.code==='operation_cancelled');
 assert.equal((await reopened.recoverCancel(req,operationId,{projectId})).status,'cancelled');assert.equal(vault.catalog.auditLogs.length,1);
});

test('intent密钥轮换后未知旧intent fail-closed，已有操作仍可本人取消',async()=>{
 const h=fixture(),{svc,req,vault}=h,secret=randomBytes(32).toString('base64url'),unknown=(await svc.createIntent(req,'p')).operationId,known=(await svc.createIntent(req,'p')).operationId;
 await svc.createOperation(req,{operationId:known,projectId:'p',frameIds:['1:1'],writerSecret:secret});
 const rotated=createPublishing({vault,auth:h.auth,permissions:h.permissions,publishIntentKey:Buffer.alloc(32,8)});
 await assert.rejects(rotated.recoverCancel(req,unknown,{projectId:'p'}),e=>e.code==='not_found');
 await assert.rejects(rotated.createOperation(req,{operationId:unknown,projectId:'p',frameIds:['1:1'],writerSecret:secret}),e=>e.code==='invalid_operation_intent');
 assert.equal((await rotated.recoverCancel(req,known,{projectId:'p'})).status,'cancelled');
});

test('隔离Vault重开后签名intent及取消tombstone仍有效',async t=>{
 const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'heron-coordination-'))),dataDir=path.join(directory,'data');t.diagnostic(`保留隔离目录: ${directory}`);
 let vault=await openVault({dataDir});const auth={actor:req=>({id:req.id,username:req.id})},permissions={requireRead(){},requirePublish(){}},key=Buffer.alloc(32,7),req={id:'u'},secret=randomBytes(32).toString('base64url');
 try{
  await vault.transact(d=>{d.add('users',{id:'u'});d.add('users',{id:'v'});d.add('projects',{id:'p',ownerId:'u'});});
  let svc=createPublishing({vault,auth,permissions,publishIntentKey:key}),intent=await svc.createIntent(req,'p');
  await vault.close();vault=await openVault({dataDir});svc=createPublishing({vault,auth,permissions,publishIntentKey:key});
  await assert.rejects(svc.recoverCancel({id:'v'},intent.operationId,{projectId:'p'}),e=>e.code==='not_found');
  assert.equal((await svc.recoverCancel(req,intent.operationId,{projectId:'p'})).status,'cancelled');
  await vault.close();vault=await openVault({dataDir});svc=createPublishing({vault,auth,permissions,publishIntentKey:key});
  assert.equal((await svc.queryOperation(req,intent.operationId)).status,'cancelled');
  await assert.rejects(svc.createOperation(req,{...intent,frameIds:['1:1'],writerSecret:secret}),e=>e.code==='operation_cancelled');
 }finally{await vault.close();}
});

test('真实隔离Vault中间写入改变版本，finish持锁拒绝旧版本',async t=>{
 const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'heron-cas-'))),backing=await openVault({dataDir:path.join(directory,'data')});t.diagnostic(`保留隔离目录: ${directory}`);
 let discarded=0;const vault={...backing,get catalog(){return backing.catalog;},get readVersion(){return backing.readVersion;},async discardStaged(){discarded++;}};
 const auth={actor:()=>({id:'u',username:'u'})},permissions={requireRead(){},requirePublish(){}},svc=createPublishing({vault,auth,permissions,publishIntentKey:Buffer.alloc(32,7)}),secret=randomBytes(32).toString('base64url'),req={headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}};
 try{
  await vault.transact(d=>{d.add('users',{id:'u'});d.add('projects',{id:'p',ownerId:'u'});d.add('designFiles',{id:'f',projectId:'p',figmaFileKey:'Key',publishingSource:source});});
  const box={x:0,y:0,width:2,height:2},bytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id:'1:1',type:'FRAME',name:'F',absoluteBoundingBox:box,children:[]}})),hash=sha256(bytes),{operationId}=await svc.createIntent(req,'p');
  await svc.createOperation(req,{operationId:operationId,projectId:'p',frameIds:['1:1'],writerSecret:secret});await svc.publishSource(req,'p',{source,frameIds:['1:1'],operationId:operationId,writerSecret:secret});
  const body={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[{figmaNodeId:'1:1',figmaPageId:'0:1',name:'F',...box,hash,layerDocSha256:hash,layerDocBytes:bytes.length,exports:[],baseRevisionId:null}],operationId:operationId,batchIndex:0,writerSecret:secret};
  const {sessionId}=await svc.prepare(req,body);await svc.upload(req,sessionId,hash,Buffer.concat([Buffer.from('GLP1'),Buffer.from(secret,'base64url'),bytes]));
  const markerPath=path.join(directory,'data','tmp',sessionId,'.staging-owner.json'),markerBefore=await readFile(markerPath);await svc.commit(req,sessionId,{writerSecret:secret});assert.deepEqual(await backing.readStaged(sessionId,hash),bytes);assert.deepEqual(await readFile(markerPath),markerBefore);
  const oldVersion=vault.readVersion;await vault.transact(d=>d.patch('projects','p',{name:'intervening layout'}));
  await assert.rejects(svc.finishOperation(req,operationId,{writerSecret:secret,catalogReadVersion:oldVersion}),e=>e.code==='catalog_version_conflict');assert.equal((await svc.queryOperation(req,operationId)).status,'partial');
  assert.equal((await svc.finishOperation(req,operationId,{writerSecret:secret,catalogReadVersion:vault.readVersion})).status,'completed');
  const legacyId='2:1',legacyBox={x:5,y:0,width:2,height:2},legacyBytes=Buffer.from(JSON.stringify({contractVersion:1,frame:{id:legacyId,type:'FRAME',name:'G',absoluteBoundingBox:legacyBox,children:[]}})),legacyHash=sha256(legacyBytes),legacyBody={projectId:'p',designFile:{designFileId:'f'},source,requireBaseRevision:true,frames:[{figmaNodeId:legacyId,figmaPageId:'0:1',name:'G',...legacyBox,hash:legacyHash,layerDocSha256:legacyHash,layerDocBytes:legacyBytes.length,exports:[],baseRevisionId:null}]};
  const legacy=await svc.prepare(req,legacyBody);await svc.upload(req,legacy.sessionId,legacyHash,legacyBytes);const legacyMarkerPath=path.join(directory,'data','tmp',legacy.sessionId,'.staging-owner.json'),legacyMarker=await readFile(legacyMarkerPath);await svc.abort(req,legacy.sessionId);assert.deepEqual(await backing.readStaged(legacy.sessionId,legacyHash),legacyBytes);assert.deepEqual(await readFile(legacyMarkerPath),legacyMarker);assert.equal(discarded,0);
 }finally{await backing.close();}
});

test('新 operation HTTP 路由注册且使用现有认证/CORS处理',()=>{
 const h=fixture(),routes=[];installPublishing({...h,route:(method,pattern,handler,options)=>routes.push({method,pattern,handler,options})});
 for(const [method,path] of [['GET','/api/publish/intent'],['POST','/api/publish/operations'],['GET','/api/publish/operations'],['GET','/api/publish/operations/op'],['POST','/api/publish/operations/op/finish'],['POST','/api/publish/operations/op/cancel'],['POST','/api/publish/operations/op/recover-cancel']])assert(routes.some(r=>r.method===method&&r.pattern.test(path)));
 assert(routes.every(r=>!r.options?.public));
});
