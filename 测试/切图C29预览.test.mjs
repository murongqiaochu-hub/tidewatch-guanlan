import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { createPreviewStore, previewPlan, installPreviews } from '../平台/预览.mjs';
import { sha256, crc32 } from '../平台/下载.mjs';

// Real encoded RGBA fixture; the test codec is explicit, not a native-codec claim.
function png() {
  const chunk=(type,data)=>{const tag=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);tag.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([tag,data])),out.length-4);return out;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(3);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,91,33,22,0,120,60,30,128,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function pixels(bytes) {
  const data=[];for(let at=8;at<bytes.length;){const size=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT')data.push(bytes.subarray(at+8,at+8+size));at+=size+12;}
  return [...inflateSync(Buffer.concat(data)).subarray(1)];
}
async function fixture(t) {
  const parent=await realpath(os.tmpdir()),directory=await mkdtemp(path.join(parent,'heron-c29-owned-')),assetsDir=path.join(directory,'assets'),bytes=png(),hash=sha256(bytes),relativePath=hash.slice(0,2)+'/'+hash+'.png';
  await mkdir(path.join(assetsDir,hash.slice(0,2)),{recursive:true,mode:0o700});await writeFile(path.join(assetsDir,relativePath),bytes,{mode:0o600});
  t.after(async()=>{assert.equal(await realpath(directory),directory);assert.equal(path.dirname(directory),parent);await rm(directory,{recursive:true});});
  const calls=[];const codec={identity:'c29-test-copy-rgba-no-resize',sliceAlphaPNG:true,async render(job){calls.push(job);assert.equal(job.variant,'slice-alpha');assert.equal(job.mime,'image/png');assert.equal(job.width,3);assert.equal(job.height,1);await writeFile(job.outputPath,await readFile('/proc/self/fd/'+job.sourceFd),{mode:0o600});}};
  return {vault:{dataDir:directory,assetsDir},asset:{id:'own_slice',mime:'image/png',bytes:bytes.length,sha256:hash,relativePath},bytes,codec,calls};
}

test('C29 separate PNG plan preserves legacy JPEG cover plan and bounded levels',()=>{
  for(const level of [64,256,1024,2048]){
    const original=previewPlan({width:8000,height:4000},{mode:'lod',level}),alpha=previewPlan({width:8000,height:4000},{mode:'lod',level,variant:'slice-alpha'});
    assert.equal(original.mime,'image/jpeg');assert.equal(original.variant,undefined);assert.equal(alpha.mime,'image/png');assert.equal(alpha.variant,'slice-alpha');assert.equal(alpha.width,level);assert.equal(alpha.height,level/2);
  }
  assert.throws(()=>previewPlan({width:3,height:1},{mode:'lod',level:512,variant:'slice-alpha'}));
  assert.throws(()=>previewPlan({width:3,height:1},{mode:'lod',level:256,variant:'unrecognized'}));
});
test('C29 real transparent/partial/opaque-white pixels and immutable source bytes survive derived cache [TEST CODEC]',async t=>{
  const f=await fixture(t),store=createPreviewStore({vault:f.vault,codec:f.codec});t.after(()=>store.close());let checks=0;
  const request={mode:'lod',level:256,variant:'slice-alpha'};
  const a=await store.get(f.asset,request,{reauthorize:()=>checks++}),b=await store.get(f.asset,request,{reauthorize:()=>checks++});
  assert.equal(a.id,b.id);assert.equal(f.calls.length,1);assert.ok(checks>=6);assert.match(a.relativePath,/\.png$/);assert.equal(a.mime,'image/png');
  const file=await store.open(a);let derived;try{derived=await file.file.readFile();}finally{await file.file.close();}
  assert.deepEqual(pixels(derived),[91,33,22,0,120,60,30,128,255,255,255,255]);
  assert.deepEqual(await readFile(path.join(f.vault.assetsDir,f.asset.relativePath)),f.bytes);
  assert.equal(a.sourceSha256,sha256(f.bytes));assert.equal(store.diagnostics().workPixels,0);
});
test('C29 no silent white JPEG fallback; pixel/byte limits and authorization remain enforced',async t=>{
  const f=await fixture(t),request={mode:'lod',level:256,variant:'slice-alpha'};
  for(const [options,code] of [[{codec:{...f.codec,sliceAlphaPNG:false}},'SLICE_ALPHA_NOT_CONFIGURED'],[{codec:f.codec,maxWorkPixels:2},'preview_pixel_budget'],[{codec:f.codec,maxEncodedBytes:1},'invalid_codec_output']]){
    const store=createPreviewStore({vault:f.vault,...options});try{await assert.rejects(store.get(f.asset,request),e=>e.code===code);assert.equal(store.diagnostics().workPixels,0);}finally{await store.close();}
  }
  const store=createPreviewStore({vault:f.vault,codec:f.codec});try{await assert.rejects(store.get(f.asset,request,{reauthorize:()=>{throw Object.assign(new Error('denied'),{status:403});}}),e=>e.status===403);}finally{await store.close();}
  assert.deepEqual(await readFile(path.join(f.vault.assetsDir,f.asset.relativePath)),f.bytes);
});
test('C29 slice HEAD route reports actual PNG length/dimensions, private cache and same auth guard',async t=>{
  const f=await fixture(t),routes=[];let allowed=true,checks=0;
  const store=installPreviews({vault:f.vault,codec:f.codec,route(method,re,handler){routes.push({method,re,handler});}},{authorizeAsset(){checks++;if(!allowed)throw Object.assign(new Error('denied'),{status:403});return {user:{id:'own'},asset:f.asset};}});t.after(()=>store.close());
  const url=new URL('http://own.invalid/api/previews/own_slice/slice/256.png'),route=routes.find(r=>r.method==='HEAD'&&r.re.test(url.pathname));assert.ok(route);assert.ok(routes.some(r=>r.method==='GET'&&r.re.test(url.pathname)));
  const params=url.pathname.match(route.re).groups,res={writeHead(status,headers){this.status=status;this.headers=headers;},end(){}};
  await route.handler({method:'HEAD'},res,{params,url});assert.equal(res.status,200);assert.equal(res.headers['Content-Type'],'image/png');assert.equal(res.headers['Content-Length'],f.bytes.length);assert.equal(res.headers['X-Heron-Preview-Width'],3);assert.equal(res.headers['X-Heron-Preview-Height'],1);assert.equal(res.headers['Cache-Control'],'private, no-store');assert.ok(checks>1);
  allowed=false;await assert.rejects(route.handler({method:'HEAD'},res,{params,url}),e=>e.status===403);assert.equal(f.calls.length,1);
});
test('C29 checkerboards are slice-scoped in both CSS files; inspector opts in only for slices',async()=>{
  const inspector=await readFile(new URL('../查看器/inspector.css',import.meta.url),'utf8'),base=await readFile(new URL('../界面/base.css',import.meta.url),'utf8'),viewer=await readFile(new URL('../查看器/index.mjs',import.meta.url),'utf8');
  for(const [css,selector] of [[inspector,'.ii-slice-preview'],[base,'.slice-card .card-thumb']]){
    const rule=css.split('\n').find(line=>line.startsWith(selector+'{')||line.startsWith(selector+' {'));
    assert.match(rule,/background-color:#21262b/);assert.match(rule,/repeating-conic-gradient\(#30363d/);assert.match(rule,/background-size:12px 12px/);assert.doesNotMatch(rule,/filter:|mix-blend-mode:/);
  }
  assert.match(viewer,/plan.kind === 'slice-preview' \? \{ variant: 'slice-alpha' \} : \{\}/);
  assert.match(inspector,/\.ii-slice-preview-status\[data-state=error\]/);assert.match(inspector,/\.ii-slice-card\[data-selected=true\]>\.ii-slice-preview/);
});
