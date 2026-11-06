import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeProceduralPng, samplePixel, digest, createFixtureCatalog } from '../宿主/synthetic-fixtures.mjs';
import { createImageStore } from '../宿主/image-store.mjs';
import { createBrowserAdapter } from '../宿主/browser-adapter.mjs';
import { startHost, decodeSmallPNG, sampleLargePNG } from './宿主测试工具.mjs';

function description(key, width = 16, height = 16) { return { key, width, height, native: { width, height }, offsetX: 0, offsetY: 0, seed: 0, mode: 'original' }; }
test('1100 metadata entries, stable duplicate names, history and geometry fixtures are independent', () => {
  const catalog = createFixtureCatalog(); assert.equal(catalog.frames.length, 1100);
  assert.equal(catalog.frames[0].name, catalog.frames[1].name); assert.notEqual(catalog.frames[0].frameId, catalog.frames[1].frameId);
  assert.deepEqual(catalog.assetSize(catalog.frames[2]), { width: 24532, height: 2282 });
  const doc = catalog.document('frame-0', 'revision-0-current'), old = catalog.document('frame-0', 'revision-0-old');
  assert.ok(doc.frame.absoluteBoundingBox.x < 0); assert.notEqual(doc.frame.children[0].name, old.frame.children[0].name);
  assert.ok(doc.frame.children.some(n => n.visible === false)); assert.ok(doc.frame.children.some(n => n.isMask)); assert.ok(doc.frame.children.some(n => n.children?.length && n.clipsContent));
  assert.ok(doc.frame.children.some(n => n.type === 'TEXT' && n.mixed.fontSize && n.runs.length === 2)); assert.ok(doc.frame.children.some(n => n.absoluteTransform[0][0] < 0));
});
test('PNG immutable row optimization preserves RGBA formula including strict boundaries and alpha', async () => {
  const width = 701, height = 401, seed = 4, bytes = await makeProceduralPng(width, height, { seed });
  const decoded = decodeSmallPNG(bytes);
  const ys = new Set([0, 31, 32, height - 1, ...[.08,.17,.32,.39,.62,.71,.84,.92].flatMap(n=>[Math.floor(n*height),Math.ceil(n*height)])]);
  for (const y of ys) for (const x of [0,31,32,Math.floor(width*.035),Math.ceil(width*.035),55,301,342,631,width-1]) assert.deepEqual(decoded.pixel(x,y),samplePixel(x,y,width,height,seed));
});
test('Native 512 tile source offsets and edge dimensions match real procedural source pixels', async t => {
  const { request, app } = await startHost(t, { count: 3 });
  for (const [x,y,w,h] of [[1,0,512,512],[2,1,177,288],[0,0,512,512]]) {
    const response = await request('/api/fixture-images/frame-0/revision-0-current/tile/' + x + '_' + y);
    assert.equal(response.status,200); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')),bytes.length); assert.equal(response.headers.get('content-type'),'image/png');
    const decoded = decodeSmallPNG(bytes); assert.equal(decoded.width,w); assert.equal(decoded.height,h);
    for(const [px,py] of [[0,0],[w-1,h-1],[Math.floor(w/2),Math.floor(h/2)]]) assert.deepEqual(decoded.pixel(px,py),samplePixel(x*512+px,y*512+py,1201,800,0));
  }
  assert.equal(app.statistics.imageGetsActive,0); assert.equal(app.statistics.generationPeak,1); assert.equal(app.statistics.originalDataWrites,0);
});
test('24k original PNG is complete 24532x2282 with true SHA/length and no full client raster allocation', async t => {
  const { request, app } = await startHost(t, { count: 3 });
  const coordinates = [[0,0],[31,31],[32,32],[900,185],[2000,400],[13000,550],[16000,1200],[23000,2050],[24531,2281]];
  const response = await request('/api/assets/frame-2.revision-2-current'), bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200); assert.equal(Number(response.headers.get('content-length')),bytes.length); assert.equal(response.headers.get('x-fixture-sha256'),digest(bytes));
  const sampled = await sampleLargePNG(bytes,coordinates); assert.equal(sampled.width,24532); assert.equal(sampled.height,2282);
  coordinates.forEach(([x,y],i)=>assert.deepEqual(sampled.pixels[i],samplePixel(x,y,24532,2282,2)));
  const before = app.statistics.imagesGenerated;
  const head = await request('/api/assets/frame-2.revision-2-current',{method:'HEAD'}); assert.equal(Number(head.headers.get('content-length')),bytes.length); assert.equal(app.statistics.imagesGenerated,before);
  assert.ok(app.statistics.encodedBytesPeak <= 80*1024*1024);
});
test('History source image does not silently use current revision source bytes', async t => {
  const { request } = await startHost(t, { count: 1 });
  const current = Buffer.from(await (await request('/api/fixture-images/frame-0/revision-0-current/preview/64')).arrayBuffer());
  const old = Buffer.from(await (await request('/api/fixture-images/frame-0/revision-0-old/preview/64')).arrayBuffer());
  assert.notEqual(digest(current),digest(old));
});
test('Two real simultaneous HTTP image GETs meter physical finish/close and preserve source generation single lane', async t => {
  let release, started; const began = new Promise(r=>started=r), gate = new Promise(r=>release=r);
  const { request, app } = await startHost(t,{count:1,imageGenerator:async(w,h,o)=>{started();await gate;return makeProceduralPng(w,h,o);}});
  const first=request('/api/fixture-images/frame-0/revision-0-current/preview/64'); await began;
  const two = new Promise(resolve=>app.server.on('request',function listener(req){ if(req.url.endsWith('/64')) { app.server.off('request',listener);resolve(); } }));
  const second=request('/api/fixture-images/frame-0/revision-0-current/preview/64');
  await two; assert.equal(app.statistics.imageGetsActive,2); assert.equal(app.statistics.imageGetsPeak,2); release();
  const responses=await Promise.all([first,second]); await Promise.all(responses.map(r=>r.arrayBuffer()));
  assert.equal(app.statistics.imageGetsActive,0); assert.equal(app.statistics.imageGetsFinished,2); assert.equal(app.statistics.generationPeak,1);
});
test('Generation SingleFlight bounds queue at16, keeps physical slot until promise settles', async () => {
  const statistics={imagesGenerated:0}; let release;
  const gate=new Promise(r=>release=r);
  const store=createImageStore({statistics,generate:async()=>{await gate;return Buffer.alloc(8);}});
  const original=store.get(description('same')); assert.equal(store.get(description('same')),original);
  const queued=Array.from({length:16},(_,i)=>store.get(description('queued'+i)));
  await assert.rejects(store.get(description('overflow')),e=>e.httpStatus===429);
  assert.equal(statistics.generationActive,1); assert.equal(statistics.generationWaiting,16);
  release(); await Promise.all([original,...queued]); assert.equal(statistics.imagesGenerated,17); assert.equal(statistics.generationWaitingPeak,16); assert.equal(statistics.generationPeak,1);
  await store.close(); assert.equal(statistics.cacheBytes,0);
});
test('HTTP cancellation does not logically free a still-running generation slot; close waits physical promise', async t => {
  let release, began; const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);
  const {request,app}=await startHost(t,{count:1,imageGenerator:async(w,h,o)=>{began();await gate;return makeProceduralPng(w,h,o);}});
  let closed; const physicallyClosed=new Promise(r=>closed=r);
  app.server.once('request',(req,res)=>res.once('close',closed));
  const controller=new AbortController(),pending=request('/api/fixture-images/frame-0/revision-0-current/preview/64',{signal:controller.signal}); await started; controller.abort();
  await assert.rejects(pending); await physicallyClosed;
  assert.equal(app.statistics.imageGetsActive,0); assert.equal(app.statistics.imageGetsClosed,1); assert.equal(app.statistics.generationActive,1);
  let done=false;const closing=app.close().then(()=>done=true); await Promise.resolve();assert.equal(done,false);
  release(); await closing; assert.equal(app.statistics.generationActive,0);
});
test('HTTP timeout clears physical response only, not executing process promise slot', async t => {
  let release, began;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);
  const {request,app}=await startHost(t,{count:1,resourceTimeoutMs:40,imageGenerator:async(w,h,o)=>{began();await gate;return makeProceduralPng(w,h,o);}});
  const pending=request('/api/fixture-images/frame-0/revision-0-current/preview/64');await started;
  assert.equal((await pending).status,504);assert.equal(app.statistics.generationActive,1);assert.equal(app.statistics.imageGetsActive,0);
  release();await app.close();assert.equal(app.statistics.generationActive,0);
});
test('Encoded cache plus reservation is bounded, including eviction and generator failure', async () => {
  const statistics={imagesGenerated:0};
  const store=createImageStore({statistics,encodedLimit:64,generate:async(w,h,o)=>{o.onEncodedBytes(20);return Buffer.alloc(20);}});
  await store.get(description('one'));await store.get(description('two'));await store.get(description('three')); assert.ok(statistics.encodedBytesPeak<=64);await store.close();
  const small=createImageStore({statistics:{imagesGenerated:0},encodedLimit:16,generate:async(w,h,o)=>{o.onEncodedBytes(100);return Buffer.alloc(100);}});
  await assert.rejects(small.get(description('huge')),e=>e.httpStatus===507);await small.close();
});
test('Browser adapter methods are real promises with actual HEAD dimensions/length and exact identity', async t => {
  const {base,app,token}=await startHost(t,{count:3});const calls=[];
  const adapter=createBrowserAdapter({baseUrl:base,fetchImpl:async(url,opts)=>{calls.push({url,method:opts.method});return fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+token}});}});
  const framesPromise=adapter.listFrames({});assert.ok(framesPromise instanceof Promise);assert.equal((await framesPromise).length,3);
  const revisions=await adapter.listRevisions('frame-2',{});assert.equal(revisions.length,2);
  const doc=await adapter.loadRevision('frame-2','revision-2-current',{});assert.equal(doc.identity.figmaNodeId,'2:101');assert.equal(doc.assets[0].width,24532);assert.ok(doc.assets[0].byteLength>0);
  const context={frameId:'frame-2',revisionId:'revision-2-current'};
  const preview=await adapter.getPreview(doc.assets[0].assetId,{...context,maxDimension:256});assert.equal(preview.width,256);assert.equal(preview.mime,'image/jpeg');
  const edge=await adapter.getNativeTile(doc.assets[0].assetId,{...context,x:47,y:4,tileSize:512});assert.equal(edge.width,468);assert.equal(edge.height,234);
  const original=await adapter.loadAsset(doc.assets[0].assetId,context);assert.equal(original.byteLength,doc.assets[0].byteLength);
  const zip=await adapter.getSliceDownloadUrl('frame-2','revision-2-current',{kind:'zip'});assert.equal(zip.mime,'application/zip');assert.match(zip.filename,/frame-2/);assert.ok(zip.byteLength>0);
  assert.equal(app.statistics.imageGetsPeak,0);assert.ok(calls.filter(c=>c.url.includes('fixture-images')||c.url.includes('/assets/')).every(c=>c.method==='HEAD'));
  await assert.rejects(adapter.getNativeTile(doc.assets[0].assetId,{...context,x:512,y:0,tileSize:512}));
  await assert.rejects(adapter.loadRevision('frame-0','revision-2-current',{}));
});
test('Browser adapter rejects malformed cross-origin or missing image metadata without inventing values', async () => {
  assert.throws(()=>createBrowserAdapter({baseUrl:'https://a.example/path'}));
  const adapter=createBrowserAdapter({baseUrl:'https://a.example',fetchImpl:async()=>new Response(null,{status:200,headers:{'Content-Type':'image/png','Content-Length':'0'}})});
  await assert.rejects(adapter.getPreview('frame-0.revision-0-current',{frameId:'frame-0',revisionId:'revision-0-current',maxDimension:64}));
});
test('ZIP HEAD preparation and GET preserve original PNG/SVG bytes, valid independent CRC and SHA index, no original-source regeneration', async t => {
  const {request,app}=await startHost(t,{count:2});const route='/api/demo/zip?frame=frame-0&revision=revision-0-old';
  const heads=await Promise.all([request(route,{method:'HEAD'}),request(route,{method:'HEAD'})]);assert.equal(heads[0].status,200);assert.equal(app.statistics.zipPreparations,1);assert.equal(app.statistics.imagesGenerated,1);
  const get=await request(route),bytes=Buffer.from(await get.arrayBuffer());assert.equal(bytes.length,Number(heads[0].headers.get('content-length')));assert.equal(app.statistics.imagesGenerated,1);
  const result=spawnSync('python3',['-c',"import sys,io,zipfile,json,hashlib,zlib\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.namelist()==['owned-slice.svg','owned-slice.png','index.json']; idx=json.loads(z.read('index.json')); assert idx['frameId']=='frame-0' and idx['revisionId']=='revision-0-old';\nfor e in idx['entries']:\n b=z.read(e['filename']); assert len(b)==e['byteLength'] and hashlib.sha256(b).hexdigest()==e['sha256'] and zlib.crc32(b)==e['crc32']; assert z.getinfo(e['filename']).compress_type==0\nprint('OK')"],{input:bytes,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'OK');
  for(const [name,sliceId] of [['owned-slice.svg','slice-owned-svg'],['owned-slice.png','slice-owned-png']]) {
    const source=Buffer.from(await(await request('/api/demo/slice?frame=frame-0&revision=revision-0-old&sliceId='+sliceId)).arrayBuffer());
    const extracted=spawnSync('python3',['-c',"import sys,io,zipfile,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(hashlib.sha256(z.read(sys.argv[1])).hexdigest())",name],{input:bytes,encoding:'utf8'});assert.equal(extracted.status,0,extracted.stderr);assert.equal(extracted.stdout.trim(),digest(source));
  }
  // Native slice download GETs are also honestly counted as image traffic.
  assert.equal(app.statistics.imageGetsPeak,1);assert.equal(app.statistics.originalDataWrites,0);
});
