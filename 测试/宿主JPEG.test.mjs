import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codecDependency, codecDiagnostics, jpegDimensions } from '../宿主/raster-codec.mjs';
import { digest } from '../宿主/synthetic-fixtures.mjs';
import { startHost, testRoot } from './宿主测试工具.mjs';

for(const frameId of ['frame-0','frame-2']) for(const level of [256,1024,2048]) {
  test('Real external NOT_BUNDLED synthetic JPEG '+frameId+' level'+level+' has actual SOF width/height and exact HEAD/GET SHA/length',async t=>{
    const {request,app}=await startHost(t,{count:3}),frame=app.catalog.frames.find(f=>f.frameId===frameId),native=app.catalog.assetSize(frame);
    const route='/api/fixture-images/'+frameId+'/'+frame.revisionId+'/preview/'+level;
    const head=await request(route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'image/jpeg');assert.equal(app.statistics.imagesGenerated,1);
    const response=await request(route),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);assert.equal(bytes[0],255);assert.equal(bytes[1],216);assert.equal(bytes.at(-2),255);assert.equal(bytes.at(-1),217);
    const actual=jpegDimensions(bytes),scale=Math.min(1,level/Math.max(native.width,native.height));
    assert.equal(actual.width,Math.max(1,Math.round(native.width*scale)));assert.equal(actual.height,Math.max(1,Math.round(native.height*scale)));
    assert.equal(Number(head.headers.get('x-fixture-width')),actual.width);assert.equal(Number(head.headers.get('x-fixture-height')),actual.height);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal(response.headers.get('x-fixture-sha256'),digest(bytes));assert.equal(app.statistics.imagesGenerated,1);assert.equal(app.statistics.generationActive,0);assert.equal(app.statistics.generationPeak,1);assert.ok(app.statistics.encodedRetainedAndReservedBytes<=80*1024*1024);
  });
}
test('Synthetic JPEG conversion leaves native/original PNG intact, no temporary fixtures or vendor codec bundled',async t=>{
  const {request,app}=await startHost(t,{count:3});
  const source='/api/assets/frame-0.revision-0-current',before=await request(source,{method:'HEAD'}),sha=before.headers.get('x-fixture-sha256');
  await request('/api/fixture-images/frame-0/revision-0-current/preview/1024',{method:'HEAD'});
  const after=await request(source,{method:'HEAD'});assert.equal(after.headers.get('content-type'),'image/png');assert.equal(after.headers.get('x-fixture-sha256'),sha);
  const low=await request('/api/fixture-images/frame-0/revision-0-current/preview/64',{method:'HEAD'});assert.equal(low.headers.get('content-type'),'image/png');
  const stat=await(await request('/api/demo/statistics')).json();assert.equal(stat.codecDependency.binary,'/usr/bin/vips');assert.equal(stat.codecDependency.verifiedVersion,'8.14.1');assert.equal(stat.codecDependency.bundled,false);assert.equal(stat.codecDependency.commercialLicenseCleared,false);
  await app.close();
  const temporary=path.resolve(testRoot,'../宿主/.合成编解码');assert.equal((await fs.stat(temporary)).mode&0o777,0o700);assert.equal(codecDiagnostics.temporaryDirectoriesActive,0);assert.equal(codecDiagnostics.temporaryDirectoriesCreated,codecDiagnostics.temporaryDirectoriesRemoved);assert.equal(codecDiagnostics.activeChildren,0);assert.equal(codecDiagnostics.childrenPeak,1);
  assert.equal(codecDependency.bundled,false);assert.equal(app.statistics.originalDataWrites,0);
});
