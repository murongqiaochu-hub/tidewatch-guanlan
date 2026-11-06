// NOT_REAL_FIGMA: wholly synthetic public SDK objects and synthetic byte fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TaskBudget, createSerialQueue, sha256, safeFileName, targetPixels, safeError, utf8, cancellationController } from '../插件/core.mjs';
import { serializeFrame, createExporter, exportAsset, eligibleFrames, rasterDimensions, validateExportSettings } from '../插件/exporter.mjs';
import { dragHeightIntent, resizeKey, clampedHeight, bindResizeControls } from '../插件/resize.mjs';

const mixed = Symbol('synthetic SDK mixed');
// IHDR-only synthetic PNG bytes: for raw-byte/dimension tests, NOT a rendering/decoder acceptance test.
function fakePNG(width, height) {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6; return bytes;
}
function fakeJPG(width, height) { return new Uint8Array([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0,255,217]); }
function node(id, type = 'FRAME', extra = {}) {
  const values = { id, type, name: 'same name', width: 3.2, height: 4.3, absoluteBoundingBox: { x: -12.5, y: -7.25, width: 3.2, height: 4.3 }, absoluteTransform: [[-1, 0, -12.5], [0, 1, -7.25]], relativeTransform: [[1, 0, 0], [0, 1, 0]], opacity: 0.7, visible: true, children: [], exportSettings: [], ...extra };
  const result = Object.create({});
  for (const key of Object.keys(values)) Object.defineProperty(result, key, { get: () => values[key], enumerable: false });
  Object.defineProperty(result, 'exportAsync', { value: async settings => {
    const format = settings.format;
    if (format === 'SVG') return utf8('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"/>');
    if (format === 'PDF') return utf8('%PDF-1.7\nsynthetic NOT_REAL_FIGMA');
    const constraint = settings.constraint || { type: 'SCALE', value: 1 };
    const scale = constraint.type === 'SCALE' ? constraint.value : constraint.value / (constraint.type === 'WIDTH' ? values.width : values.height);
    const target = targetPixels(values.width, values.height, scale);
    return format === 'JPG' ? fakeJPG(target.width, target.height) : fakePNG(target.width, target.height);
  }, configurable: true });
  return result;
}
function sdk(frames = []) { return { mixed, skipInvisibleInstanceChildren: false, currentPage: { id: 'p:1', children: frames, selection: frames }, async getStyleByIdAsync() { return null; } }; }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejected = code => error => error.code === code;

test('NOT_REAL_FIGMA getter-based tree preserves negative float/flip/hidden/clip/mask', async () => {
  const child = node('1:2', 'BOOLEAN_OPERATION', { visible: false, isMask: true, clipsContent: true, booleanOperation: 'SUBTRACT', cornerRadius: mixed });
  const frame = node('1:1', 'FRAME', { children: [child] });
  const result = await serializeFrame(sdk(), frame);
  assert.equal(result.layerDoc.frame.name, 'same name');
  assert.deepEqual(result.layerDoc.frame.absoluteTransform, [[-1,0,-12.5],[0,1,-7.25]]);
  assert.equal(result.layerDoc.frame.children[0].visible, false);
  assert.equal(result.layerDoc.frame.children[0].isMask, true);
  assert.equal(result.layerDoc.frame.children[0].raw.booleanOperation, 'SUBTRACT');
  assert.deepEqual(result.layerDoc.frame.children[0].cornerRadius, { state: 'mixed' });
  assert.equal(await sha256(result.bytes), result.sha256);
  assert.ok(!JSON.stringify(result.layerDoc).includes('exportAsync'));
});
test('unreadable getter and missing bounds are explicit, not invented', async () => {
  const frame = node('2:1'); Object.defineProperty(frame, 'fills', { get() { throw new Error('private details'); } });
  const minimal = Object.create({ id: '2:2', type: 'FRAME', name: 'minimal', children: [] });
  const a = await serializeFrame(sdk(), frame); const b = await serializeFrame(sdk(), minimal);
  assert.deepEqual(a.layerDoc.frame.raw.fieldStates.fills, { state: 'unknown', reason: 'sdk-getter' });
  assert.deepEqual(b.layerDoc.frame.raw.fieldStates.absoluteBoundingBox, { state: 'missing' });
  assert.ok(!Object.hasOwn(b.layerDoc.frame, 'absoluteBoundingBox'));
});
test('mixed text uses full getStyledTextSegments with async categorized style lookups', async () => {
  const text = node('3:2', 'TEXT', { characters: 'a🙂', fontName: mixed, fontSize: mixed, textStyleId: mixed, fills: mixed });
  let callFields; Object.defineProperty(text, 'getStyledTextSegments', { value: fields => { callFields = fields; return [
    { characters:'a',start:0,end:1,fontName:{family:'Synthetic',style:'Regular'},fontSize:12,fontWeight:400,lineHeight:{unit:'AUTO'},letterSpacing:{unit:'PIXELS',value:0},textStyleId:'s:text',fillStyleId:'s:fill' },
    { characters:'🙂',start:1,end:3,fontName:{family:'Synthetic',style:'Bold'},fontSize:16,fontWeight:700,lineHeight:{unit:'PIXELS',value:20},letterSpacing:{unit:'PERCENT',value:10},textStyleId:'s:missing',fillStyleId:'s:fill' }
  ]; } });
  const calls = [];
  const api = sdk(); api.getStyleByIdAsync = async styleId => { calls.push(styleId); return styleId === 's:text' ? Object.create({ id:styleId,type:'TEXT',name:'Body',fontSize:12 }) : styleId === 's:fill' ? Object.create({ id:styleId,type:'PAINT',name:'Ink',paints:[{type:'SOLID',color:{r:0,g:0,b:0}}] }) : null; };
  const output = await serializeFrame(api, node('3:1','FRAME',{children:[text]}));
  const dto = output.layerDoc.frame.children[0]; assert.deepEqual(dto.fontName,{state:'mixed'}); assert.equal(dto.textRuns.length,2); assert.equal(dto.textRuns[1].end,3);
  assert.ok(callFields.includes('fontWeight')); assert.equal(output.layerDoc.styles.TEXT.length,1); assert.equal(output.layerDoc.styles.FILL.length,1); assert.equal(output.layerDoc.styles.TEXT[0].id,'s:text');
  assert.equal(dto.textRuns[1].styleReferences.textStyleId.state,'unknown'); assert.deepEqual(calls,['s:text','s:fill','s:missing']);
});
test('text segment gaps fail explicitly instead of dropping text', async () => {
  const text = node('4:2','TEXT',{characters:'abc'}); Object.defineProperty(text,'getStyledTextSegments',{value:()=>[{characters:'bc',start:1,end:3}]});
  await assert.rejects(serializeFrame(sdk(),node('4:1','FRAME',{children:[text]})),rejected('SDK_READ_FAILED'));
});
test('text SDK failure remains unknown and no font/style invented', async () => {
  const text = node('5:2','TEXT',{characters:'hello'}); Object.defineProperty(text,'getStyledTextSegments',{value:()=>{throw new Error('no');}});
  const a = await serializeFrame(sdk(),node('5:1','FRAME',{children:[text]})); assert.equal(a.layerDoc.frame.children[0].textRunsState.state,'unknown'); assert.deepEqual(a.layerDoc.styles,{TEXT:[],FILL:[],EFFECT:[],GRID:[]});
});
test('instances use async component API only, including unresolved references', async () => {
  const component = Object.create({id:'c:1',type:'COMPONENT',name:'Button',key:'synthetic-key',remote:true,variantProperties:{Size:'L'}});
  const a=node('6:2','INSTANCE'); const b=node('6:3','INSTANCE');
  Object.defineProperty(a,'mainComponent',{get(){throw new Error('forbidden sync read');}}); Object.defineProperty(a,'getMainComponentAsync',{value:async()=>component}); Object.defineProperty(b,'getMainComponentAsync',{value:async()=>null});
  const out=await serializeFrame(sdk(),node('6:1','FRAME',{children:[a,b]})); assert.equal(out.layerDoc.components.length,1); assert.equal(out.layerDoc.frame.children[0].componentReference.id,'c:1'); assert.equal(out.layerDoc.frame.children[1].componentReference.state,'unknown');
});
test('same names with different IDs remain two frames', async()=>{const out=await createExporter(sdk()).exportFrames([node('7:1'),node('7:2')],{includeSlices:false}); assert.equal(out.frames.length,2); assert.notEqual(out.frames[0].figmaNodeId,out.frames[1].figmaNodeId);});
test('selection qualification does not promote nested selection or merge names',()=>{const api=sdk([node('8:1'),node('8:2','RECTANGLE')]);const a=eligibleFrames(api,'page');assert.equal(a.frames.length,1);assert.equal(a.excluded.length,1);assert.equal(a.excluded[0].reason,'not-top-level-frame');});
test('full 1100 top-level FRAME export in explicit 16-frame chunk rounds, no count drop',async()=>{
  const all=Array.from({length:1100},(_,i)=>node(`large:${i}`));const api=sdk(all);const chunks=[];const out=await createExporter(api).exportSelection({scope:'page',includeSlices:false,chunkCapacity:16,onChunk:async chunk=>chunks.push(chunk.length)});
  assert.equal(out.frames.length,1100); assert.equal(out.eligibility.count,1100); assert.equal(chunks.length,69); assert.equal(chunks.reduce((a,b)=>a+b,0),1100); assert.equal(chunks.at(-1),12);
});
test('nearest pixel formula includes float/zero/tiny dimensions',()=>{assert.deepEqual(targetPixels(3.2,4.3,1),{width:3,height:4});assert.deepEqual(targetPixels(0,0.2,.5),{width:1,height:1});assert.throws(()=>targetPixels(2,2,0),rejected('BAD_SCHEMA'));});
test('PNG original object bytes and digest remain untouched',async()=>{const bytes=fakePNG(3,4);const f=node('9:1');Object.defineProperty(f,'exportAsync',{value:async()=>bytes});const a=await exportAsset(f,{format:'PNG'});assert.strictEqual(a.bytes,bytes);assert.equal(a.descriptor.sha256,await sha256(bytes));assert.equal(a.descriptor.mime,'image/png');assert.deepEqual(a.descriptor.target,{width:3,height:4});});
test('SDK incorrect raster dimensions fail without padding/cropping/re-encode',async()=>{const bytes=fakePNG(4,5);const f=node('10:1');Object.defineProperty(f,'exportAsync',{value:async()=>bytes});await assert.rejects(exportAsset(f,{format:'PNG'}),rejected('SDK_DIMENSION_MISMATCH'));assert.deepEqual(rasterDimensions(bytes,'PNG'),{width:4,height:5});});
test('rotated preview and absolute-bounds slice use raster box, keeping original local and manifest geometry',async()=>{
  const box={x:-12.5,y:7.25,width:50,height:100};
  const f=node('10:rotated','FRAME',{x:3,y:4,width:100,height:50,rotation:90,absoluteBoundingBox:box,exportSettings:[{format:'PNG',useAbsoluteBounds:true}]});
  const calls=[]; Object.defineProperty(f,'exportAsync',{value:async settings=>{calls.push({...settings});return fakePNG(50,100);}});
  const out=await createExporter(sdk()).exportFrames([f]);const frame=out.frames[0];
  assert.equal(calls.length,2);assert.equal(calls[0].useAbsoluteBounds,true);assert.equal(calls[1].useAbsoluteBounds,true);
  assert.deepEqual(frame.preview.target,{width:50,height:100});assert.deepEqual(frame.exports[0].target,{width:50,height:100});
  assert.equal(frame.layerDoc.frame.width,100);assert.equal(frame.layerDoc.frame.height,50);assert.deepEqual(frame.layerDoc.frame.absoluteBoundingBox,box);
  assert.equal(frame.preview.nodeId,'10:rotated');assert.equal(frame.exports[0].nodeId,'10:rotated');
  assert.deepEqual(frame.preview.settings,calls[0]);assert.deepEqual(frame.exports[0].settings,calls[1]);
  assert.strictEqual(frame.assets[0].bytes instanceof Uint8Array,true);
});
test('absolute box dimensions drive width/height constraints; incorrect bytes fail and no chunk prepares',async()=>{
  const f=node('10:wrong','FRAME',{width:100,height:50,absoluteBoundingBox:{x:-10.5,y:1.25,width:50,height:100}});
  let calls=0,prepared=0;Object.defineProperty(f,'exportAsync',{value:async()=>{calls++;return fakePNG(100,50);}});
  await assert.rejects(createExporter(sdk()).exportFrames([f],{onChunk:async()=>prepared++}),rejected('SDK_DIMENSION_MISMATCH'));
  assert.equal(calls,1);assert.equal(prepared,0);
  Object.defineProperty(f,'exportAsync',{value:async()=>fakePNG(100,200)});
  const scaled=await exportAsset(f,{format:'PNG',useAbsoluteBounds:true,constraint:{type:'WIDTH',value:100}});
  assert.equal(scaled.descriptor.scale,2);assert.deepEqual(scaled.descriptor.target,{width:100,height:200});
});
test('absolute geometry accepts negative fractional positions, rejects missing/invalid dimensions before SDK',async()=>{
  for(const box of [undefined,{x:0,y:0,width:-1,height:100},{x:0,y:0,width:NaN,height:100},{x:0,y:Infinity,width:50,height:100},{x:0,y:0,width:'50',height:100}]){
    const f=node('10:bad','FRAME',{width:100,height:50,absoluteBoundingBox:box});let invoked=false;
    Object.defineProperty(f,'exportAsync',{value:async()=>{invoked=true;return fakePNG(50,100);}});
    await assert.rejects(exportAsset(f,{format:'PNG',useAbsoluteBounds:true}),rejected('BAD_DIMENSIONS'));assert.equal(invoked,false);
  }
  const f=node('10:float','FRAME',{width:100,height:50,absoluteBoundingBox:{x:-12.5,y:-7.25,width:50.25,height:100.25}});
  Object.defineProperty(f,'exportAsync',{value:async()=>fakePNG(50,100)});
  assert.deepEqual((await exportAsset(f,{format:'PNG',useAbsoluteBounds:true})).descriptor.target,{width:50,height:100});
});
test('explicit contentsOnly crop retains bytes and bounded actual dimensions without guessing target',async()=>{
  const f=node('10:crop','FRAME',{width:100,height:50,absoluteBoundingBox:{x:-1.5,y:2.25,width:50,height:100}});
  Object.defineProperty(f,'exportAsync',{value:async()=>fakePNG(25,35)});
  const out=await exportAsset(f,{format:'PNG',useAbsoluteBounds:true,contentsOnly:true});assert.deepEqual(out.descriptor.target,{width:25,height:35});
  Object.defineProperty(f,'exportAsync',{value:async()=>fakePNG(9000,9000)});
  await assert.rejects(exportAsset(f,{format:'PNG',useAbsoluteBounds:true,contentsOnly:true}),rejected('BAD_DIMENSIONS'));
});
test('multiple actual slice formats retain format-specific bytes, no extra formats fabricated',async()=>{const f=node('11:1','FRAME',{exportSettings:[{format:'SVG'},{format:'JPG',constraint:{type:'SCALE',value:2}},{format:'PDF'}]});const out=await createExporter(sdk()).exportFrames([f]);assert.deepEqual(out.frames[0].exports.map(e=>e.format),['SVG','JPG','PDF']);assert.deepEqual(out.frames[0].assets.map(e=>e.descriptor.mime),['image/png','image/svg+xml','image/jpeg','application/pdf']);});
test('wrong MIME bytes are rejected',async()=>{const f=node('12:1');Object.defineProperty(f,'exportAsync',{value:async()=>utf8('<svg/>')});await assert.rejects(exportAsset(f,{format:'PNG'}),rejected('BAD_BYTES'));});
test('unsupported SDK format is explicit, not PNG fallback',async()=>{assert.throws(()=>validateExportSettings({format:'GIF'}),rejected('BAD_FORMAT'));await assert.rejects(createExporter(sdk()).exportFrames([node('13:1','FRAME',{exportSettings:[{format:'GIF'}]})]),rejected('BAD_FORMAT'));});
test('SDK export failure never falls back to DIY bytes',async()=>{const f=node('14:1');Object.defineProperty(f,'exportAsync',{value:async()=>{throw new Error('secret service details');}});await assert.rejects(exportAsset(f,{format:'PNG'}),rejected('SDK_EXPORT_FAILED'));});
test('single task budget includes all frames and errors instead of truncating',async()=>{const budget=new TaskBudget(900);await assert.rejects(createExporter(sdk()).exportFrames([node('15:1'),node('15:2')],{budget,includeSlices:false}),rejected('BUDGET_EXCEEDED'));assert.ok(budget.used<=budget.limit);});
test('source budget does not grant 64 MiB per asset',()=>{const budget=new TaskBudget(64);budget.set('a',40);assert.throws(()=>budget.set('b',25),rejected('BUDGET_EXCEEDED'));assert.equal(budget.used,40);budget.release('a');budget.set('b',25);assert.equal(budget.used,25);});
test('aborting physical export does not release SDK slot for next task',{timeout:10000},async()=>{
  const gate=deferred(),entered=deferred();let active=0,max=0,starts=0;const a=node('16:1');const b=node('16:2');
  Object.defineProperty(a,'exportAsync',{value:async()=>{starts++;active++;max=Math.max(max,active);entered.resolve();await gate.promise;active--;return fakePNG(3,4);}});
  Object.defineProperty(b,'exportAsync',{value:async()=>{starts++;active++;max=Math.max(max,active);active--;return fakePNG(3,4);}});
  const exporter=createExporter(sdk());const controller=new AbortController();const one=exporter.exportFrames([a],{signal:controller.signal,includeSlices:false});const rejection=assert.rejects(one,rejected('CANCELLED'));let two;
  try {
    // Observe actual SDK entry; ten setImmediate turns did not guarantee async SHA completion.
    await entered.promise;assert.equal(starts,1);controller.abort();two=exporter.exportFrames([b],{includeSlices:false});await tick();assert.equal(starts,1);assert.equal(exporter.queue.snapshot().active,1);
  } finally {controller.abort();gate.resolve();}
  await rejection;await two;await exporter.queue.drain();assert.equal(starts,2);assert.equal(max,1);
});
test('queue has explicit admission capacity; failures do not poison subsequent work',async()=>{const queue=createSerialQueue({capacity:1});const gate=deferred();const p=queue.run(()=>gate.promise);await assert.rejects(queue.run(()=>1),rejected('QUEUE_FULL'));gate.reject(new Error('failure'));await assert.rejects(p);await queue.drain();assert.equal(await queue.run(()=>7),7);});
test('already-cancelled request never invokes SDK',async()=>{const controller=new AbortController();controller.abort();let invoked=false;const f=node('17:1');Object.defineProperty(f,'exportAsync',{value:async()=>{invoked=true;return fakePNG(3,4);}});await assert.rejects(createExporter(sdk()).exportFrames([f],{signal:controller.signal}),rejected('CANCELLED'));assert.equal(invoked,false);});
test('invisible-instance skipping fails explicit rather than hiding descendants',async()=>{const api=sdk();api.skipInvisibleInstanceChildren=true;await assert.rejects(serializeFrame(api,node('18:1')),rejected('SDK_CAPABILITY_MISSING'));});
test('duplicate graph IDs fail without silent child loss',async()=>{await assert.rejects(serializeFrame(sdk(),node('19:1','FRAME',{children:[node('19:2'),node('19:2')]})),rejected('BAD_SCHEMA'));});
test('privacy-safe error strips arbitrary details',()=>{assert.deepEqual(safeError(new Error('token=private host cookie=secret')),{code:'OPERATION_FAILED'});assert.deepEqual(safeError({code:'SDK_EXPORT_FAILED',message:'secret'}),{code:'SDK_EXPORT_FAILED'});});
test('safe names block traversal, Windows reserved names and same-name collision',()=>{const a=safeFileName('../a\\b\u0000','20:1','png');assert.ok(!/[\\/\u0000]/.test(a));assert.ok(!a.startsWith('.'));assert.match(safeFileName('CON','20:2','svg'),/^frame-/);assert.notEqual(safeFileName('same','20:1','png'),safeFileName('same','20:2','png'));});
test('UTF-8 sandbox fallback matches native including invalid surrogate',()=>{const native=globalThis.TextEncoder;const expected=new native().encode('中🙂\ud800');try{globalThis.TextEncoder=undefined;assert.deepEqual(utf8('中🙂\ud800'),expected);}finally{globalThis.TextEncoder=native;}});
test('SDK sandbox cancellation fallback emits one event only',()=>{const native=globalThis.AbortController;try{globalThis.AbortController=undefined;const c=cancellationController();let calls=0;c.signal.addEventListener('abort',()=>calls++,{once:true});c.abort();c.abort();assert.equal(calls,1);assert.equal(c.signal.aborted,true);}finally{globalThis.AbortController=native;}});
test('official-shaped nested instance node IDs retain semicolon identity',async()=>{const child=node('I22:1;22:2','RECTANGLE');const result=await serializeFrame(sdk(),node('22:1','FRAME',{children:[child]}));assert.equal(result.layerDoc.frame.children[0].id,'I22:1;22:2');});
test('filename suffix is lossless across colon/underscore and Unicode name is byte-bounded',()=>{assert.notEqual(safeFileName('same','22:1','png'),safeFileName('same','22_1','png'));assert.ok(utf8(safeFileName('🙂'.repeat(300),'I22:1;22:2','png')).byteLength<=240);});
test('all direct asset calls share one physical SDK worker',async()=>{const started=deferred(),gate=deferred();let secondStarted=false;const a=node('21:1'),b=node('21:2');Object.defineProperty(a,'exportAsync',{value:async()=>{started.resolve();await gate.promise;return fakePNG(3,4);}});Object.defineProperty(b,'exportAsync',{value:async()=>{secondStarted=true;return fakePNG(3,4);}});const one=exportAsset(a,{format:'PNG'});await started.promise;const two=exportAsset(b,{format:'PNG'});await tick();assert.equal(secondStarted,false);gate.resolve();await one;await two;assert.equal(secondStarted,true);});
test('same SDK factory instances share task queue',()=>{const api=sdk();assert.strictEqual(createExporter(api).queue,createExporter(api).queue);});
test('height bounds and accessible keyboard intent',()=>{assert.equal(clampedHeight(1),480);assert.equal(clampedHeight(5000),1100);assert.equal(resizeKey(640,'ArrowUp'),680);assert.equal(resizeKey(640,'Home'),480);assert.equal(resizeKey(640,'End'),1100);assert.equal(resizeKey(640,'x'),null);});
test('trusted captured bottom-edge pointer drag changes bounded height, unrelated pointers do not',()=>{const down={pointerId:1,screenY:20,height:640};assert.equal(dragHeightIntent(down,{isTrusted:true,pointerId:1,isPrimary:true,screenY:30}),650);assert.equal(dragHeightIntent(down,{isTrusted:true,pointerId:2,isPrimary:true,screenY:60}),null);assert.equal(dragHeightIntent(down,{isTrusted:false,pointerId:1,isPrimary:true,screenY:60}),null);assert.equal(dragHeightIntent(down,{isTrusted:true,pointerId:1,isPrimary:true,screenY:10000}),1100);});

test('lost pointerup never leaves a stale drag; a button-less move stops resizing',async()=>{
  let height=640,calls=0;const listeners=new Map(),viewListeners=new Map();
  const edge={dataset:{},addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener(){},setPointerCapture(){},releasePointerCapture(){},hasPointerCapture(){return false}};
  const view={addEventListener:(type,fn)=>viewListeners.set(type,fn),removeEventListener(){},document:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}};
  const dispose=bindResizeControls({getElementById:()=>edge,defaultView:view},{getHeight:()=>height,resize:async next=>{height=next;calls++;}});
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
    listeners.get('pointerdown')({isTrusted:true,button:0,pointerId:1,screenY:100,isPrimary:true,preventDefault(){}});
    listeners.get('pointermove')({isTrusted:true,pointerId:1,screenY:140,buttons:1});
    await tick();assert.equal(height,680);assert.equal(edge.dataset.dragging,'true');
    listeners.get('pointermove')({isTrusted:true,pointerId:1,screenY:300,buttons:0});
    await tick();assert.equal(edge.dataset.dragging,'false');const settled=height,called=calls;
    listeners.get('pointermove')({isTrusted:true,pointerId:1,screenY:500,buttons:0});
    listeners.get('pointerup')({isTrusted:true,pointerId:1,screenY:500,buttons:0,preventDefault(){}});
    await tick();assert.equal(height,settled);assert.equal(calls,called);
  }finally{dispose();}
});
