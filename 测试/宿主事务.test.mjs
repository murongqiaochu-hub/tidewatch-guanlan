import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticPublisher } from '../宿主/synthetic-publish.mjs';
import { digest, makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';
import { startHost } from './宿主测试工具.mjs';

const actor = () => ({ actorId: 'own-actor', projectId: 'project-owned', role: 'developer', enabled: true });
async function fixture({ frameId = 'published-frame', figmaNodeId = '401:5', expectedRevisionId = null, docId = figmaNodeId, width = 16.5 } = {}) {
  const box={x:-18.125,y:32.5,width,height:8.25};
  const layerDoc={contractVersion:1,frame:{id:docId,type:'FRAME',name:'自造SDK边界',absoluteBoundingBox:box,children:[]},styles:{TEXT:[],FILL:[],EFFECT:[],GRID:[]},components:[]};
  const json=Buffer.from(JSON.stringify(layerDoc)),png=await makeProceduralPng(17,8,{seed:4});
  const layer={sha256:digest(json),byteLength:json.length,mime:'application/json',role:'layerDoc',fileName:'frame.json'};
  const preview={sha256:digest(png),byteLength:png.length,mime:'image/png',nodeId:figmaNodeId,role:'preview',format:'PNG',fileName:'preview.png',scale:1,target:{width:17,height:8},settings:{format:'PNG'}};
  const exports=[];const transform=[[1,0,box.x],[0,1,box.y]];
  const frame={identity:{projectId:'project-owned',designFileId:'own-design',pageId:'own-page',frameId,revisionId:'pending-revision',figmaNodeId},expectedRevisionId,layerDoc:layer,preview,exports,absoluteBoundingBox:box,transform,contentHash:digest(Buffer.from(JSON.stringify([layer.sha256,preview.sha256,exports,transform])))};
  const manifest={contractVersion:1,frames:[frame],assets:[layer,preview],sourceBytes:json.length+png.length+1024};
  return {manifest,bytes:new Map([[layer.sha256,json],[preview.sha256,png]])};
}
async function preparedUploaded(publisher,data,user=actor()) {
  const result=await publisher.prepare(data.manifest,user);
  for(const d of data.manifest.assets) if(result.missing.includes(d.sha256)) await publisher.upload(result.sessionId,d,data.bytes.get(d.sha256),user);
  return result;
}
test('RAM transaction prepares, hashes original uploads, atomically commits complete identity, and is idempotent',async()=>{
  const p=createSyntheticPublisher(),data=await fixture(),user=actor();
  const prepared=await p.prepare(data.manifest,user);assert.equal(prepared.state,'prepared');assert.equal(prepared.missing.length,2);
  await assert.rejects(p.commit(prepared.sessionId,user),e=>e.httpStatus===409);assert.equal(p.metrics.committed,0);
  for(const d of data.manifest.assets) { const result=await p.upload(prepared.sessionId,d,data.bytes.get(d.sha256),user);assert.equal(result.state,'uploaded'); }
  const committed=await p.commit(prepared.sessionId,user);assert.equal(committed.state,'committed');assert.equal(committed.revisions.length,1);assert.equal(committed.revisions[0].figmaNodeId,'401:5');assert.notEqual(committed.revisions[0].frameId,committed.revisions[0].figmaNodeId);
  assert.deepEqual(await p.commit(prepared.sessionId,user),committed);assert.deepEqual(await p.query(prepared.sessionId,user),committed);assert.deepEqual(await p.abort(prepared.sessionId,user),committed);
  assert.equal(p.metrics.committed,1);assert.equal(p.openSessions,0);assert.equal(p.metrics.originalDataWrites,0);p.close();
});
test('SHA/type/length dedup is original-byte based; subsequent prepare requests no auto reupload',async()=>{
  const p=createSyntheticPublisher(),data=await fixture(),user=actor();const first=await preparedUploaded(p,data,user);const committed=await p.commit(first.sessionId,user);
  const next=structuredClone(data.manifest);next.frames[0].expectedRevisionId=committed.revisions[0].revisionId;
  const second=await p.prepare(next,user);assert.deepEqual(second.missing,[]);assert.equal(p.metrics.uploaded,2);await p.commit(second.sessionId,user);assert.equal(p.metrics.uploaded,2);
  const invalid=structuredClone(next);invalid.assets[1].mime='image/jpeg';invalid.frames[0].exports=[];
  await assert.rejects(p.prepare(invalid,user),e=>[400,409].includes(e.httpStatus));p.close();
});
test('Expected revision CAS conflict rejects entire batch with no partial revision visibility',async()=>{
  const p=createSyntheticPublisher(),user=actor(),first=await fixture({frameId:'a'}),second=await fixture({frameId:'b',figmaNodeId:'402:5'});
  const prepared=await preparedUploaded(p,first,user),committed=await p.commit(prepared.sessionId,user);
  const both={manifest:{contractVersion:1,frames:[first.manifest.frames[0],second.manifest.frames[0]],assets:[...first.manifest.assets,...second.manifest.assets.filter(a=>!first.manifest.assets.some(b=>b.sha256===a.sha256))],sourceBytes:4096},bytes:new Map([...first.bytes,...second.bytes])};
  const pending=await preparedUploaded(p,both,user);await assert.rejects(p.commit(pending.sessionId,user),e=>e.httpStatus===409);
  assert.equal(p.metrics.committed,1);assert.equal(p.getRevision('independent-revision-2',user),null);assert.equal(p.getRevision(committed.revisions[0].revisionId,user).identity.frameId,'a');
  await p.abort(pending.sessionId,user);assert.equal(p.openSessions,0);p.close();
});
test('Unknown commit session remains query-only unknown, never creates prepare/reupload state',async()=>{
  const p=createSyntheticPublisher(),user=actor();
  assert.deepEqual(await p.commit('unknown-synthetic-session',user),{sessionId:'unknown-synthetic-session',state:'unknown'});
  assert.equal((await p.query('unknown-synthetic-session',user)).state,'unknown');assert.equal(p.metrics.prepared,0);assert.equal(p.metrics.uploaded,0);p.close();
});
test('Expiry, abort and physical close resolve every open RAM session',async()=>{
  let clock=100;const p=createSyntheticPublisher({ttlMs:50,now:()=>clock}),data=await fixture(),user=actor();
  const a=await preparedUploaded(p,data,user),b=await p.prepare(data.manifest,user);clock=151;
  assert.equal((await p.query(a.sessionId,user)).state,'expired');assert.equal((await p.abort(b.sessionId,user)).state,'expired');assert.equal(p.metrics.retainedBytes,0);assert.equal(p.openSessions,0);
  const c=await p.prepare(data.manifest,user);assert.equal((await p.abort(c.sessionId,user)).state,'aborted');assert.equal((await p.abort(c.sessionId,user)).state,'aborted');
  await p.prepare(data.manifest,user);p.close();assert.equal(p.openSessions,0);assert.equal(p.metrics.retainedBytes,0);
});
test('RAM transaction authorization checks actor, project, roles, and immediate disable changes',async()=>{
  const p=createSyntheticPublisher(),data=await fixture(),user=actor(),prepared=await p.prepare(data.manifest,user);
  await assert.rejects(p.query(prepared.sessionId,{...user,actorId:'other'}),e=>e.httpStatus===403);
  await assert.rejects(p.query(prepared.sessionId,{...user,projectId:'project-other'}),e=>e.httpStatus===403);
  await assert.rejects(p.prepare(data.manifest,{...user,projectId:'project-other'}),e=>e.httpStatus===403);
  await assert.rejects(p.prepare(data.manifest,{...user,role:'viewer'}),e=>e.httpStatus===403);
  user.enabled=false;await assert.rejects(p.commit(prepared.sessionId,user),e=>e.httpStatus===401);p.close();
});
test('Tampered hash, LayerDoc identity/dimensions and manifest content hash cannot commit',async()=>{
  const p=createSyntheticPublisher(),user=actor(),data=await fixture();const prepared=await p.prepare(data.manifest,user),d=data.manifest.assets[0];
  await assert.rejects(p.upload(prepared.sessionId,d,Buffer.alloc(d.byteLength),user),e=>e.httpStatus===400);
  const bad=structuredClone(data.manifest);bad.frames[0].contentHash='0'.repeat(64);await assert.rejects(p.prepare(bad,user),e=>e.httpStatus===400);
  const identity=await fixture({docId:'other:1'});const wrong=await preparedUploaded(p,identity,user);await assert.rejects(p.commit(wrong.sessionId,user),e=>e.httpStatus===400);
  const dimensions=await fixture();dimensions.manifest.frames[0].absoluteBoundingBox.width=99;const dim=await preparedUploaded(p,dimensions,user);await assert.rejects(p.commit(dim.sessionId,user),e=>e.httpStatus===400);
  assert.equal(p.metrics.committed,0);p.close();
});
test('Bounded RAM sessions refuse overflow, and abort releases retained uploads',async()=>{
  const p=createSyntheticPublisher({maxOpen:1}),data=await fixture(),user=actor(),prepared=await preparedUploaded(p,data,user);assert.ok(p.metrics.retainedBytes>0);
  await assert.rejects(p.prepare(data.manifest,user),e=>e.httpStatus===429);await p.abort(prepared.sessionId,user);assert.equal(p.metrics.retainedBytes,0);await p.prepare(data.manifest,user);p.close();
});
test('Formal publish HTTP API uses request-id envelope, raw bytes headers and synthetic explicit bearer only',async t=>{
  const {request,token,app,base}=await startHost(t,{count:1}),data=await fixture();
  async function rpc(action,body,id='request-'+action) {
    const response=await request('/api/independent-publish/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Independent-Request-Id':id},body:JSON.stringify(body)});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/json');const envelope=await response.json();assert.deepEqual(Object.keys(envelope).sort(),['requestId','result']);assert.equal(envelope.requestId,id);return envelope.result;
  }
  const prepared=await rpc('prepare',{manifest:data.manifest});
  for(const descriptor of data.manifest.assets) {
    const id='upload-'+descriptor.sha256.slice(0,8);
    const response=await fetch(base+'/api/independent-publish/upload',{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':descriptor.mime,'X-Independent-Request-Id':id,'X-Independent-Session-Id':prepared.sessionId,'X-Independent-Descriptor':encodeURIComponent(JSON.stringify(descriptor))},body:data.bytes.get(descriptor.sha256)});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{requestId:id,result:{sessionId:prepared.sessionId,state:'uploaded',sha256:descriptor.sha256}});
  }
  const committed=await rpc('commit',{sessionId:prepared.sessionId});assert.equal(committed.state,'committed');assert.deepEqual(await rpc('query',{sessionId:prepared.sessionId}),committed);assert.equal(app.statistics.originalDataWrites,0);
});
test('HTTP upload rejects descriptor header ambiguity, wrong MIME/hash/body and read-only bearer',async t=>{
  const {request,app}=await startHost(t,{count:1}),data=await fixture();
  const prepare=await request('/api/independent-publish/prepare',{method:'POST',headers:{'Content-Type':'application/json','X-Independent-Request-Id':'prepare'},body:JSON.stringify({manifest:data.manifest})});const sid=(await prepare.json()).result.sessionId,d=data.manifest.assets[0];
  const headers={'Content-Type':d.mime,'X-Independent-Request-Id':'upload','X-Independent-Session-Id':sid,'X-Independent-Descriptor':encodeURIComponent(JSON.stringify(d))};
  assert.equal((await request('/api/independent-publish/upload',{method:'POST',headers:{...headers,'Content-Type':'image/jpeg'},body:data.bytes.get(d.sha256)})).status,400);
  assert.equal((await request('/api/independent-publish/upload',{method:'POST',headers:{...headers,'X-Independent-Descriptor':'%ZZ'},body:data.bytes.get(d.sha256)})).status,400);
  assert.equal((await request('/api/independent-publish/upload',{method:'POST',headers,body:Buffer.alloc(d.byteLength)})).status,400);
  assert.equal((await request('/api/independent-publish/upload',{method:'POST',headers,body:Buffer.alloc(d.byteLength+1)})).status,413);
  const viewer=app.createSession('viewer');assert.equal((await request('/api/independent-publish/commit',{method:'POST',headers:{'Content-Type':'application/json','X-Independent-Request-Id':'commit',Authorization:'Bearer '+viewer},body:JSON.stringify({sessionId:sid})})).status,403);
});

async function actualFakePublication() {
  // Real new module public entry calls; synthetic official-API-shaped SDK only.
  // This is explicitly NOT_REAL_FIGMA and has no upstream/plugin-source reads.
  const exporterModule=await import('../插件/exporter.mjs'),publisherModule=await import('../插件/publisher.mjs');
  const {webcrypto}=await import('node:crypto');
  const frame={id:'1:1',type:'FRAME',name:'独立 fake SDK frame',width:3.2,height:4.3,visible:true,opacity:1,absoluteBoundingBox:{x:-4.5,y:8.25,width:3.2,height:4.3},absoluteTransform:[[1,0,-4.5],[0,1,8.25]],children:[],fills:[],strokes:[],effects:[],exportSettings:[],async exportAsync(settings){const scale=settings.constraint?.type==='SCALE'?settings.constraint.value:1;return new Uint8Array(await makeProceduralPng(Math.max(1,Math.round(3.2*scale)),Math.max(1,Math.round(4.3*scale))));}};
  const sdk={editorType:'figma',mixed:Symbol('mixed'),skipInvisibleInstanceChildren:false,currentPage:{id:'1:0',selection:[frame],children:[frame]}};
  const exported=await exporterModule.createExporter(sdk,{cryptoAPI:webcrypto}).exportFrames([frame],{scale:1,includeSlices:true});
  assert.equal(exported.frames.length,1);assert.equal(exported.frames[0].layerDoc.frame.absoluteBoundingBox.width,3.2);
  const identity={projectId:'project-owned',designFileId:'sdk-design',pageId:'1:0',frameId:'platform-frame-one',revisionId:'pending-revision',figmaNodeId:'1:1'};
  const buildPublication=publisherModule.buildPublication||exporterModule.buildPublication;
  const publication=await buildPublication(exported,new Map([['1:1',{identity,expectedRevisionId:null}]]),{cryptoAPI:webcrypto});
  return {publication,publisherModule};
}
test('NOT_REAL_FIGMA: actual new exporter/publication/HTTP adapter/publisher commits original synthetic PNG through real RAM host',async t=>{
  const {app,base,token}=await startHost(t,{count:1}),{publication,publisherModule}=await actualFakePublication();
  const adapter=publisherModule.createHTTPAdapter({origin:base,fetchAPI:fetch,allowLocalhost:true,authorization:'Bearer '+token});
  const publisher=publisherModule.createPublisher(adapter);
  await publisher.publish(publication,{});await publisher.drain();
  assert.equal(app.publisher.metrics.committed,1);assert.equal(app.publisher.openSessions,0);assert.equal(app.publisher.metrics.originalDataWrites,0);
  assert.equal(app.publisher.metrics.uploaded,publication.assets.size);
});
test('NOT_REAL_FIGMA: unknown commit response queries the same session without auto prepare or asset reupload',async t=>{
  const {app,base,token}=await startHost(t,{count:1}),{publication,publisherModule}=await actualFakePublication();
  const http=publisherModule.createHTTPAdapter({origin:base,fetchAPI:fetch,allowLocalhost:true,authorization:'Bearer '+token});
  let prepares=0,uploads=0,commits=0,unknownSession;
  const adapter={...http,async prepare(...args){prepares++;return http.prepare(...args);},async upload(...args){uploads++;return http.upload(...args);},async commit(...args){commits++;const result=await http.commit(...args);unknownSession=result.sessionId;return {sessionId:result.sessionId,state:'unknown'};}};
  const publisher=publisherModule.createPublisher(adapter);
  try { await publisher.publish(publication,{}); } catch(error) { assert.match(error.code||error.message,/UNKNOWN|COMMIT/i); }
  assert.equal(app.publisher.metrics.committed,1);assert.equal(prepares,1);assert.equal(commits,1);const count=uploads;
  // Await the owner's physical queue drain, not merely logical unknown.
  await publisher.drain();await publisher.query({});await publisher.drain();
  assert.equal(prepares,1);assert.equal(uploads,count);assert.equal(commits,1);assert.ok(unknownSession);assert.equal(app.publisher.openSessions,0);
});
