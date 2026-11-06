import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from './宿主测试工具.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';

test('Complete lightweight directory exposes preview identity with explicitly unknown original length until authorized HEAD; equal own pixels SingleFlight share bytes',async t=>{
  const {request,app}=await startHost(t);
  const frames=(await(await request('/api/frames')).json()).frames;assert.equal(frames.length,1100);assert.equal(app.statistics.documentsLoaded,0);
  for(const index of [0,13,1099]) { const frame=frames[index];assert.equal(frame.previewAsset.assetId,frame.frameId+'.'+frame.revisionId);assert.equal(frame.previewAsset.mime,'image/png');assert.equal(frame.previewAsset.byteLength,0);assert.match(frame.previewAsset.byteLengthStatus,/unknown/); }
  const heads=await Promise.all([0,13].map(index=>request('/api/fixture-images/frame-'+index+'/revision-'+index+'-current/preview/64',{method:'HEAD'})));
  assert.equal(heads[0].status,200);assert.equal(heads[1].status,200);assert.ok(Number(heads[0].headers.get('content-length'))>0);
  assert.equal(heads[0].headers.get('x-fixture-sha256'),heads[1].headers.get('x-fixture-sha256'));assert.equal(app.statistics.imagesGenerated,1);assert.equal(app.statistics.documentsLoaded,0);
  const statResponse=await request('/api/demo/statistics');assert.equal(statResponse.status,200);const stats=await statResponse.json();assert.equal(stats.statistics.imageGetsPeak,0);assert.equal(stats.statistics.originalDataWrites,0);assert.ok(stats.statistics.encodedRetainedAndReservedBytes<=80*1024*1024);
});
test('Permission disable while PNG is physically generating rejects the final response immediately without premature lane free',async t=>{
  let release,began;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);
  const {request,app,token}=await startHost(t,{count:1,imageGenerator:async(w,h,o)=>{began();await gate;return makeProceduralPng(w,h,o);}});
  const pending=request('/api/fixture-images/frame-0/revision-0-current/preview/64');await started;app.disableSession(token);assert.equal(app.statistics.generationActive,1);release();
  assert.equal((await pending).status,401);assert.equal(app.statistics.imageGetsActive,0);assert.equal(app.statistics.generationActive,0);
});
test('Demo session rejects null, array and business credential bodies; statistics requires developer project role',async t=>{
  const {base,app,request}=await startHost(t,{count:1});
  for(const body of ['null','[]','{"role":"admin"}','{"password":"not-a-secret-synthetic"}']) assert.equal((await fetch(base+'/api/demo/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body})).status,400);
  assert.equal((await fetch(base+'/api/demo/statistics')).status,401);
  const viewer=app.createSession('viewer');assert.equal((await request('/api/demo/statistics',{headers:{Authorization:'Bearer '+viewer}})).status,403);
});
