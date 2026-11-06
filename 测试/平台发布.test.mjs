import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublishing, validateSource, validatePrepare, fingerprint } from '../平台/发布.mjs';
import { installAssets } from '../平台/资源.mjs';
import { sha256, problem, validateBytes } from '../平台/下载.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';

const tables=['users','projects','frameGroups','projectMembers','projectInvites','inviteClaims','designFiles','pages','sections','frames','frameRevisions','assets','revisionAssets','publishSessions','auditLogs','rememberedLogins'];
function modelVault() {
  let catalog=Object.fromEntries(tables.map(t=>[t,[]])), tail=Promise.resolve(); const staged=new Map(),original=new Map();
  const vault={get catalog(){return catalog;}, failNext:false, afterRead:null,
    transact(fn) { const run=tail.then(async()=>{const next={...catalog};const copied=new Set();const copy=t=>{if(!copied.has(t)){next[t]=[...next[t]];copied.add(t);}return next[t];};const d={all:t=>next[t],byId:(t,id)=>next[t].find(r=>r.id===id),add:(t,r)=>copy(t).push(r),patch:(t,id,f)=>{const a=copy(t),n=a.findIndex(r=>r.id===id);assert.ok(n>=0);a[n]={...a[n],...f};},remove:(t,id)=>{next[t]=next[t].filter(r=>r.id!==id);copied.add(t);},set:(t,a)=>{next[t]=a;copied.add(t);}};const result=await fn(d);if(vault.failNext){vault.failNext=false;throw problem(503,'injected_save_failure');}catalog=next;return result;});tail=run.catch(()=>{});return run;},
    async stageAsset(s,d,b){validateBytes(d,b);staged.set(s+'/'+d.sha256,Buffer.from(b));return d;},
    async readStaged(s,h){const b=staged.get(s+'/'+h);if(!b)throw problem(409,'missing');await vault.afterRead?.();return Buffer.from(b);},
    async putOriginal(d){validateBytes(d,d.data);original.set(d.sha256,Buffer.from(d.data));return {id:'a_'+d.sha256,sha256:d.sha256,mime:d.mime,bytes:d.bytes,relativePath:d.sha256.slice(0,2)+'/'+d.sha256+({'application/json':'.json','image/png':'.png'}[d.mime] || '.bin')};},
    async readOriginal(a){const b=original.get(a.sha256);if(!b)throw problem(409,'missing');await vault.afterRead?.();return Buffer.from(b);}
  };return vault;
}
function harness(vault=modelVault()) {
  let now=1_800_000_000_000,allowed=true;const user={id:'u'},req={headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}};
  const ctx={vault,clock:()=>now,auth:{actor:()=>user},permissions:{requireRead(){if(!allowed)throw problem(403,'forbidden');},requirePublish(){if(!allowed)throw problem(403,'forbidden');}}};
  return {...ctx,req,service:createPublishing(ctx),advance:n=>now+=n,revoke:()=>{allowed=false;}};
}
function payload({node='1:1',page='0:1',name='Original',width=1.25,height=2.5,exports=[],docMutate,base=null,preview}={}) {
  const doc={contractVersion:1,frame:{id:node,type:'FRAME',name,absoluteBoundingBox:{x:-1.5,y:2.125,width,height},children:[{id:node+':child',type:'RECTANGLE',name:'Child',children:[]}]},styles:{TEXT:[],FILL:[],EFFECT:[],GRID:[]},components:[]};docMutate?.(doc);
  const bytes=Buffer.from(JSON.stringify(doc)),hash=sha256(bytes),f={figmaNodeId:node,figmaPageId:page,name,pageName:'Page',pageOrder:0,x:-1.5,y:2.125,width,height,order:0,layerDocSha256:hash,layerDocBytes:bytes.length,exports,baseRevisionId:base};
  const assets=new Map([[hash,{sha256:hash,bytes:bytes.length,mime:'application/json',data:bytes}]]);
  if(preview){f.previewSha256=sha256(preview);f.previewBytes=preview.length;f.previewMime='image/png';assets.set(f.previewSha256,{sha256:f.previewSha256,bytes:preview.length,mime:'image/png',data:preview});}
  f.hash=fingerprint(f);return {f,assets};
}
async function resolve(h,source={kind:'figma-file',fileKey:'File123'},name='File',frameIds=['1:1']){return h.service.publishSource(h.req,'p',{source,name,frameIds});}
function body(file,frames){return {projectId:'p',designFile:{designFileId:file.designFileId},source:file.source,requireBaseRevision:true,frames};}
async function prepared(h,p=payload()){const file=await resolve(h,undefined,undefined,[p.f.figmaNodeId]);const r=await h.service.prepare(h.req,body(file,[p.f]));return {file,r,p};}
async function upload(h,r,p){for(const a of p.assets.values()){h.req.headers['x-asset-mime']=a.mime;await h.service.upload(h.req,r.sessionId,a.sha256,a.data);}}
async function published(h,p=payload()){const x=await prepared(h,p);await upload(h,x.r,p);const result=await h.service.commit(h.req,x.r.sessionId);return {...x,result};}
const code=c=>e=>e.code===c;

test('[MODEL] strict public source is alnum 1–128',()=>{assert.doesNotThrow(()=>validateSource({kind:'figma-file',fileKey:'a'.repeat(128)}));for(const fileKey of ['','a-b','a_b','a'.repeat(129)])assert.throws(()=>validateSource({kind:'figma-file',fileKey}));});
test('[MODEL] launch namespace shape is explicit',()=>{assert.doesNotThrow(()=>validateSource({kind:'plugin-launch',namespace:'src_task_'+ 'a'.repeat(32)}));assert.throws(()=>validateSource({kind:'plugin-launch',namespace:'root-name'}));});
test('[MODEL] source identity stable despite file name/root-node changes',async()=>{const h=harness(),a=await resolve(h),b=await resolve(h,undefined,'Renamed',['9:9']);assert.equal(a.designFileId,b.designFileId);assert.deepEqual({...b.baseRevisions},{'9:9':null});});
test('[MODEL] identical names do not join different sources',async()=>{const h=harness(),a=await resolve(h),b=await resolve(h,{kind:'figma-file',fileKey:'Other123'});assert.notEqual(a.designFileId,b.designFileId);});
test('[MODEL] source lookup refuses >1000 or duplicate frame IDs',async()=>{const h=harness();await assert.rejects(resolve(h,undefined,undefined,['1:1','1:1']));await assert.rejects(resolve(h,undefined,undefined,Array.from({length:1001},(_,i)=>'f'+i)));});
test('[MODEL] prepare persists SID and ISO TTL120min',async()=>{const h=harness(),{r}=await prepared(h);assert.equal(h.vault.catalog.publishSessions[0].id,r.sessionId);assert.equal(Date.parse(r.expiresAt),h.clock()+7_200_000);assert.equal(r.frames[0].status,'new');});
test('[MODEL] fingerprint preserves original descriptor expression',()=>{const p=payload();assert.equal(p.f.hash,sha256(Buffer.from(JSON.stringify([p.f.layerDocSha256,null,[],null]))));p.f.hash='a'.repeat(64);assert.doesNotThrow(()=>validatePrepare(body({designFileId:'f',source:{kind:'figma-file',fileKey:'Ab'}},[p.f])));assert.notEqual(fingerprint(p.f),p.f.hash,'producer content hash is separate from dependency assetHash');});
test('[MODEL] base revision is mandatory and never guessed',async()=>{const h=harness(),file=await resolve(h),p=payload();delete p.f.baseRevisionId;await assert.rejects(h.service.prepare(h.req,body(file,[p.f])));});
test('[MODEL] prepare conflict still returns persistent open SID',async()=>{const h=harness(),x=await published(h),p=payload(),r=await h.service.prepare(h.req,body(x.file,[p.f]));assert.equal(r.frames[0].status,'conflict');assert.equal((await h.service.query(h.req,r.sessionId)).status,'open');});
test('[MODEL] top missing hashes unique, per-frame preview/export duplicate preserved',async()=>{const png=await makeProceduralPng(2,2),h=harness(),p=payload({preview:png});p.f.exports=[{sha256:sha256(png),bytes:png.length,mime:'image/png',format:'PNG',exportNodeId:p.f.figmaNodeId,fileName:'same.png'}];p.f.hash=fingerprint(p.f);const {r}=await prepared(h,p);assert.equal(new Set(r.missingAssetSha256).size,r.missingAssetSha256.length);assert.equal(r.frames[0].missingAssetSha256.filter(s=>s===sha256(png)).length,2);});
test('[MODEL] PDF descriptors rejected, never converted',()=>{const p=payload({exports:[{sha256:'a'.repeat(64),bytes:10,mime:'application/pdf',format:'PDF',exportNodeId:'1:1',fileName:'x.pdf'}]});assert.throws(()=>validatePrepare(body({designFileId:'f',source:{kind:'figma-file',fileKey:'Ab'}},[p.f])),code('unsupported_export'));});
test('[MODEL] duplicate frame nodes rejected',async()=>{const h=harness(),file=await resolve(h),p=payload();await assert.rejects(h.service.prepare(h.req,body(file,[p.f,p.f])),code('duplicate_frame'));});
test('[MODEL] upload strict MIME header and original SHA/length',async()=>{const h=harness(),{r,p}=await prepared(h);h.req.headers['x-asset-mime']='image/png';await assert.rejects(h.service.upload(h.req,r.sessionId,p.f.layerDocSha256,[...p.assets.values()][0].data),code('mime_mismatch'));h.req.headers['x-asset-mime']='application/json';await assert.rejects(h.service.upload(h.req,r.sessionId,p.f.layerDocSha256,Buffer.from('bad')),code('size_mismatch'));});
test('[MODEL] LayerDoc root mismatch is rejected without modifying bytes',async()=>{const h=harness(),p=payload({docMutate:d=>{d.frame.id='wrong';}}),{r}=await prepared(h,p);await assert.rejects(upload(h,r,p),code('invalid_layer_doc'));assert.equal(h.vault.catalog.assets.length,0);});
test('[MODEL] floating dimensions preserved and checked against root',async()=>{const h=harness(),p=payload({width:1.125,height:2.875}),x=await published(h,p);assert.equal(h.vault.catalog.frames[0].width,1.125);assert.equal(h.vault.catalog.frameRevisions[0].manifest.height,2.875);assert.ok(x.result.frames[0].revisionId);});
test('[MODEL] root dimension mismatch rejected',async()=>{const h=harness(),p=payload({docMutate:d=>{d.frame.absoluteBoundingBox.width=99;}}),{r}=await prepared(h,p);await assert.rejects(upload(h,r,p),code('layer_doc_dimensions'));});
test('[MODEL] duplicate subtree ID rejected',async()=>{const h=harness(),p=payload({docMutate:d=>{d.frame.children.push(d.frame.children[0]);}}),{r}=await prepared(h,p);await assert.rejects(upload(h,r,p),code('invalid_layer_subtree'));});
test('[MODEL] export outside original subtree rejected',async()=>{const h=harness(),png=await makeProceduralPng(1,1),p=payload({exports:[{sha256:sha256(png),bytes:png.length,mime:'image/png',exportNodeId:'outside',fileName:'x.png'}]}),{r}=await prepared(h,p);await assert.rejects(upload(h,r,p),code('export_outside_subtree'));});
test('[MODEL] staged bytes have no public asset/revision rows',async()=>{const h=harness(),{r,p}=await prepared(h);await upload(h,r,p);assert.equal(h.vault.catalog.assets.length,0);assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,0);assert.equal((await h.service.query(h.req,r.sessionId)).uploaded.length,1);});
test('[MODEL] missing required upload fails commit atomically',async()=>{const h=harness(),{r}=await prepared(h);await assert.rejects(h.service.commit(h.req,r.sessionId));assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,0);assert.equal(h.vault.catalog.frameRevisions.length,0);});
test('[MODEL] one competing frame CAS blocks every frame in same session',async()=>{
  const h=harness(),base=await published(h),a=payload({base:base.result.frames[0].revisionId}),b=payload({node:'2:2'}),file=await resolve(h,undefined,undefined,['1:1','2:2']);
  const mixed=await h.service.prepare(h.req,body(file,[a.f,b.f]));await upload(h,mixed,a);await upload(h,mixed,b);
  await assert.rejects(h.service.prepare(h.req,body(file,[a.f])),code('publish_session_active'));
  const frame=mixed.frames.find(f=>f.figmaNodeId==='1:1'),current=h.vault.catalog.frameRevisions.find(r=>r.id===base.result.frames[0].revisionId),competitor={...current,id:'competing_revision',previousRevisionId:current.id,createdAt:new Date(h.clock()+1).toISOString(),publishedAt:new Date(h.clock()+1).toISOString()};
  await h.vault.transact(d=>{d.add('frameRevisions',competitor);d.patch('frames',frame.frameId,{currentRevisionId:competitor.id,updatedAt:competitor.publishedAt});});
  await assert.rejects(h.service.commit(h.req,mixed.sessionId),code('revision_conflict'));
  assert.equal(h.vault.catalog.frameRevisions.length,2);assert.equal(h.vault.catalog.assets.length,1);
  assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,1);
  assert.equal(h.vault.catalog.frames.find(f=>f.figmaNodeId==='1:1').currentRevisionId,competitor.id);
  assert.equal(h.vault.catalog.frames.find(f=>f.figmaNodeId==='2:2').currentRevisionId,null);
  assert.equal(h.vault.catalog.publishSessions.find(s=>s.id===mixed.sessionId).status,'open');
});
test('[MODEL] same SID idempotency returns original mapping after newer revision',async()=>{const h=harness(),first=await published(h),p=payload({name:'Changed',base:first.result.frames[0].revisionId}),second=await h.service.prepare(h.req,body(first.file,[p.f]));await upload(h,second,p);await h.service.commit(h.req,second.sessionId);const recovered=await h.service.commit(h.req,first.r.sessionId);assert.equal(recovered.idempotent,true);assert.deepEqual(recovered.frames,first.result.frames);});
test('[MODEL] committed query never invents latest revision mapping',async()=>{const h=harness(),x=await published(h),q=await h.service.query(h.req,x.r.sessionId);assert.equal(q.status,'committed');assert.equal(Object.hasOwn(q.frames[0],'revisionId'),false);});
test('[MODEL] abort is terminal and preserves committed session',async()=>{const h=harness(),x=await published(h);assert.equal((await h.service.abort(h.req,x.r.sessionId)).status,'committed');const {r}=await prepared(h);assert.equal((await h.service.abort(h.req,r.sessionId)).status,'aborted');assert.equal((await h.service.abort(h.req,r.sessionId)).status,'aborted');});
test('[MODEL] expired legacy session rejects commit but preserves open state and lock',async()=>{const h=harness(),{r,p,file}=await prepared(h);await upload(h,r,p);h.advance(7_200_001);await assert.rejects(h.service.commit(h.req,r.sessionId),code('session_expired'));const q=await h.service.query(h.req,r.sessionId);assert.equal(q.status,'open');assert.equal(q.expiresAt,r.expiresAt);await assert.rejects(h.service.prepare(h.req,body(file,[p.f])),code('publish_session_active'));});
test('[MODEL] permission revoked during physical read prevents commit',async()=>{const h=harness(),{r,p}=await prepared(h);await upload(h,r,p);h.vault.afterRead=async()=>h.revoke();await assert.rejects(h.service.commit(h.req,r.sessionId),code('forbidden'));assert.equal(h.vault.catalog.frameRevisions.length,0);assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,0);});
test('[MODEL] injected persistence failure publishes no next root',async()=>{const h=harness(),{r,p}=await prepared(h);await upload(h,r,p);const original=h.vault.putOriginal;h.vault.putOriginal=async d=>{const a=await original(d);h.vault.failNext=true;return a;};await assert.rejects(h.service.commit(h.req,r.sessionId),code('injected_save_failure'));assert.equal(h.vault.catalog.frameRevisions.length,0);assert.equal(h.vault.catalog.publishSessions[0].status,'open');});
test('[MODEL] source mismatch fails before creating SID',async()=>{const h=harness(),file=await resolve(h),p=payload(),b=body(file,[p.f]);b.source={kind:'figma-file',fileKey:'Another'};await assert.rejects(h.service.prepare(h.req,b),code('invalid_source'));assert.equal(h.vault.catalog.publishSessions.length,0);});

test('[MODEL/HTTP-HANDLER] committed published state is explicit in public counts and directory',async()=>{
  const h=harness(),routes=[],ctx={...h,permissions:{...h.permissions,requireRead(){},project:()=>({canRead:true})},route(method,re,handler){routes.push({method,re,handler});}};
  const service=installAssets(ctx);try {const x=await published(h);assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,1);const route=routes.find(r=>r.method==='GET' && r.re.test('/api/inspector/projects/p/directory'));const dto=await route.handler(h.req,{}, {params:{projectId:'p'},url:new URL('http://synthetic.invalid/api/inspector/projects/p/directory')});assert.equal(dto.frames.length,1);assert.equal(dto.frames[0].revisionId,x.result.frames[0].revisionId);await h.vault.transact(d=>d.patch('frames',dto.frames[0].frameId,{state:undefined}));const hidden=await route.handler(h.req,{}, {params:{projectId:'p'},url:new URL('http://synthetic.invalid/api/inspector/projects/p/directory')});assert.equal(hidden.frames.length,0);}finally{await service.close();}
});

test('[MODEL] raw multiline layer names and explicitly unknown transforms preserve original bytes',async()=>{const h=harness(),p=payload({docMutate:d=>{d.frame.children[0].name='Raw text\nwith another line';d.frame.absoluteTransform=null;d.frame.fieldStates={absoluteTransform:{state:'unknown'}};}});p.f.transform=null;const x=await published(h,p),asset=h.vault.catalog.assets.find(a=>a.sha256===p.f.layerDocSha256);assert.deepEqual(await h.vault.readOriginal(asset),p.assets.get(p.f.layerDocSha256).data);const revision=h.vault.catalog.frameRevisions.find(r=>r.id===x.result.frames[0].revisionId);assert.equal(revision.assetHash,fingerprint(p.f));assert.equal(revision.transform,null);});
test('[MODEL] expiry during physical promotion rejects without partial publish or unlocking session',async()=>{const h=harness(),{r,p,file}=await prepared(h);await upload(h,r,p);h.vault.afterRead=async()=>h.advance(7_200_001);await assert.rejects(h.service.commit(h.req,r.sessionId),code('session_expired'));assert.equal(h.vault.catalog.publishSessions[0].status,'open');assert.equal(h.vault.catalog.frameRevisions.length,0);assert.equal(h.vault.catalog.frames.filter(f=>f.state==='published').length,0);await assert.rejects(h.service.prepare(h.req,body(file,[p.f])),code('publish_session_active'));});
test('[MODEL] stage GC failure never rolls back a committed abort terminal state',async()=>{const h=harness(),{r,p}=await prepared(h);await upload(h,r,p);h.vault.discardStaged=async()=>{throw problem(500,'own_injected_gc_failure');};assert.equal((await h.service.abort(h.req,r.sessionId)).status,'aborted');assert.equal((await h.service.query(h.req,r.sessionId)).status,'aborted');await assert.rejects(h.service.commit(h.req,r.sessionId),code('session_closed'));});

test('[MODEL] destination group must belong to the project and is stamped on commit',async()=>{
  const h=harness();
  await h.vault.transact(d=>{d.add('projects',{id:'other',name:'Other'});d.add('frameGroups',{id:'g1',projectId:'p',name:'A'});d.add('frameGroups',{id:'g2',projectId:'other',name:'B'});});
  const p=payload(),file=await resolve(h);
  await assert.rejects(h.service.prepare(h.req,{...body(file,[p.f]),groupId:'g2'}),e=>e.status===404);
  const r=await h.service.prepare(h.req,{...body(file,[p.f]),groupId:'g1'});await upload(h,r,p);const result=await h.service.commit(h.req,r.sessionId);
  assert.equal(h.vault.catalog.frames[0].groupId,'g1');assert.equal(result.frames[0].status,'new');
  const p2=payload({base:result.frames[0].revisionId}),file2=await resolve(h),r2=await h.service.prepare(h.req,body(file2,[p2.f]));await upload(h,r2,p2);await h.service.commit(h.req,r2.sessionId);
  assert.equal(h.vault.catalog.frames[0].groupId,'g1','publishing without a group must not silently ungroup frames');
});

test('[REAL-VAULT/REALFS] original upload, committed mapping and reopening persistence',async t=>{
  let openVault;try {({openVault}=await import('../平台/仓库.mjs'));}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('new Vault owner not yet ready; not a persistence PASS');return;}throw e;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'independent-publish-'));const canonical=await realpath(directory);let vault;
  t.after(async()=>{await vault?.close();assert.equal(await realpath(directory),canonical);assert.equal((await lstat(directory)).uid,process.getuid());await rm(canonical,{recursive:true,force:false});});
  vault=await openVault({dataDir:directory});await vault.transact(d=>{d.add('users',{id:'u',username:'own-fixture',role:'designer',status:'active',passwordHash:'a'.repeat(128),salt:'b'.repeat(32),sessionVersion:0,createdAt:'2026-10-15T00:00:00.000Z'});d.add('projects',{id:'p',name:'Own fixture',ownerId:'u',createdByUserId:'u',createdAt:'2026-10-15T00:00:00.000Z'});});const h=harness(vault);const x=await published(h);const first=x.result.frames[0];assert.ok(first.revisionId);assert.equal(vault.catalog.frames[0].currentRevisionId,first.revisionId);assert.equal(vault.catalog.frames.filter(f=>f.state==='published').length,1);
  const asset=vault.catalog.assets[0];assert.equal(sha256(await vault.readOriginal(asset)),asset.sha256);await vault.close();vault=await openVault({dataDir:directory});assert.equal(vault.catalog.frames[0].currentRevisionId,first.revisionId);assert.equal(vault.catalog.frames.filter(f=>f.state==='published').length,1);assert.equal(vault.catalog.publishSessions[0].commitResult.frames[0].revisionId,first.revisionId);
});
