process.env.HANDOFF_PUBLIC_ORIGIN ||= 'https://service.example.test:49156';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { createProductionSession, readProductionSource, listProductionFrames, translateProductionFrames, productionPrepareHash } from '../插件/production-session.mjs';
import { createProductionHTTP, PRODUCTION_BODY_LIMIT } from '../插件/production-protocol.mjs';
import { createExporter } from '../插件/exporter.mjs';
import { startPlugin } from '../插件/main.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';
import { TaskBudget, sha256, jsonBytes } from '../插件/core.mjs';
const expiry = '2000-01-01T00:00:00.000Z'; // Deliberately past: never infer server expiry from this.
const namespace = `src_launch_${'a'.repeat(32)}`;
function png() { const a = new Uint8Array(33); a.set([137,80,78,71,13,10,26,10]); const v = new DataView(a.buffer); v.setUint32(8,13); a.set([73,72,68,82],12); v.setUint32(16,2); v.setUint32(20,3); return a; }
const syntheticReadVersion = `${'a'.repeat(32)}:1`;
function syntheticSnapshot(frameId, revisionId, doc) {
  const asset = { assetId: 'fixture-asset', projectId: 'p', designFileId: 'platform-file', frameId, revisionId, byteLength: png().length, mime: 'image/png', url: '/api/assets/fixture-asset' };
  return { catalogReadVersion: syntheticReadVersion, identity: { projectId: 'p', designFileId: 'platform-file', pageId: 'page-1', frameId, revisionId, figmaNodeId: '2:1' }, context: { projectId: 'p', designFileId: 'platform-file' }, frameId, revisionId, frame: { frameId, revisionId, figmaNodeId: '2:1', groupId: null }, layerDoc: doc, assets: [{ ...asset, role: 'preview' }], slices: [{ ...asset, role: 'export', id: 'fixture-slice' }] };
}
function sdkModel(n = 1, fileKey = 'actualFileKey') {
  let exports = 0; const page = { id: '1:1', name: 'Page', children: [], selection: [] }; const root = { name: 'Display only', children: [page] };
  page.children = Array.from({ length: n }, (_, i) => ({ id: `2:${i+1}`, type: 'FRAME', name: 'Same name', width: 2.2, height: 3.1, absoluteBoundingBox: { x: -12.25-i, y: 5.75, width: 2.2, height: 3.1 }, absoluteTransform: [[-1,0,-12.25-i],[0,1,5.75]], children: [], exportSettings: [{ format: 'PNG' }], exportAsync: async () => { exports++; return png(); } })); page.selection = page.children.slice();
  return { sdk: { editorType: 'figma', root, currentPage: page, fileKey }, exports: () => exports };
}
function memoryAdapter(overrides = {}) {
  const calls = []; const sessions = new Map(); const batchMetadata = new Map(); const commits = new Map(); let count = 0, intents = 0; let operation = null;
  const adapter = {
    async intent(projectId) { return { projectId, operationId: `op_${(++intents).toString(16).padStart(32,'0')}_${'a'.repeat(64)}` }; },
    async claim(input) { operation = { ...input, status: 'open' }; return operation; },
    async queryOperation() { return operation; },
    async finish() { return { ...operation, status: 'completed', remainingFrameIds: [] }; },
    async cancelOperation() { const batches = [...sessions].map(([sid, frames]) => ({ sessionId: sid, operationId: operation.operationId, ...batchMetadata.get(sid), status: commits.has(sid) ? 'committed' : 'aborted', frames: frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: commits.has(sid) ? 'committed' : 'aborted' })), ...(commits.has(sid) ? { commitResult: commits.get(sid) } : {}) })); const committedFrames = [...commits.values()].flatMap(c => c.frames); return { ...operation, status: 'cancelled', lockScope: 'service', automaticExpiry: false, batches, committedFrames, remainingFrameIds: operation.frameIds.filter(id => !committedFrames.some(f => f.figmaNodeId === id)) }; },
    projects: async () => [{ id: 'p', name: 'P', permissions: { canPublish: true } }],
    async publishSource(projectId, body) { calls.push(['source', body]); return { projectId, designFileId: 'platform-file', source: body.source, baseRevisions: Object.fromEntries(body.frameIds.map(fid => [fid, `base-${fid}`])) }; },
    async prepare(body, operationId, batchIndex) { const sid = `sid-${++count}`; calls.push(['prepare', body]); const frames = body.frames.map((f,i) => ({ figmaNodeId: f.figmaNodeId, frameId: `platform-${f.figmaNodeId}`, status: 'new', missingAssetSha256: [...new Set([f.layerDocSha256, ...(f.previewSha256 ? [f.previewSha256] : []), ...f.exports.map(e => e.sha256)])] })); const missing = [...new Set(frames.flatMap(f => f.missingAssetSha256))]; sessions.set(sid, frames); const requestHash = await productionPrepareHash(body, operationId, batchIndex, webcrypto); batchMetadata.set(sid, { batchIndex, requestHash }); return { sessionId: sid, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex, requestHash, designFileId: 'platform-file', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, missingAssetSha256: missing, frames }; },
    async upload(sid, asset) { calls.push(['upload', sid, asset]); return { ok: true, sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime }; },
    async commit(sid) { calls.push(['commit', sid]); const result = { sessionId: sid, status: 'committed', frames: sessions.get(sid).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: `server-rev-${f.figmaNodeId}`, status: 'new' })) }; commits.set(sid, result); return result; },
    async queryCommitResult(sid) { calls.push(['result', sid]); return { sessionId: sid, status: 'committed', frames: sessions.get(sid).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: `server-rev-${f.figmaNodeId}`, status: 'new' })) }; },
    async query(sid) { calls.push(['query', sid]); return { sessionId: sid, status: 'open', expiresAt: null, operationId: operation.operationId, ...batchMetadata.get(sid), automaticExpiry: false, uploaded: [], uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, frames: (sessions.get(sid)||[]).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: 'new' })) }; },
    async abort(sid) { calls.push(['abort', sid]); return { sessionId: sid, status: 'aborted' }; },
    // Model receipt only: real reader paths are covered by the localhost tests below.
    async verifyPublication(projectId, groupId, frames, { signal } = {}) {
      calls.push(['verify', projectId, groupId, structuredClone(frames)]);
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      assert.equal(projectId, 'p');
      for (const frame of frames) {
        assert.ok([...sessions.values()].flat().some(f => f.figmaNodeId === frame.figmaNodeId && f.frameId === frame.frameId));
        assert.equal(frame.revisionId, `server-rev-${frame.figmaNodeId}`);
      }
      return { projectId, groupId, frameCount: frames.length, catalogReadVersion: syntheticReadVersion };
    },
    ...overrides
  }; return { adapter, calls, sessions };
}
const sessionFor = (sdk, adapter, extras = {}) => createProductionSession({ sdk, adapter, namespace, cryptoAPI: webcrypto, ...extras });

test('production SDK model translates raw bytes/hash/geometry and accepts server platform IDs only', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const session = sessionFor(sdk, adapter); const result = await session.publish({ projectId: 'p' });
  const body = calls.find(c => c[0] === 'prepare')[1]; const f = body.frames[0]; assert.equal(body.requireBaseRevision, true); assert.deepEqual(body.designFile, { designFileId: 'platform-file' }); assert.deepEqual([f.x,f.y,f.width,f.height], [-12.25,5.75,2.2,3.1]); assert.deepEqual(f.transform, [[-1,0,-12.25],[0,1,5.75]]); assert.equal(f.baseRevisionId, 'base-2:1');
  assert.equal(f.hash, await sha256(jsonBytes([f.layerDocSha256, f.previewSha256, f.exports, f.transform]), webcrypto)); assert.equal(f.exports[0].exportNodeId, '2:1'); assert.equal(result.results[0].frames[0].revisionId, 'server-rev-2:1');
  assert.equal(result.results[0].frames[0].frameId, 'platform-2:1'); assert.equal(session.status().locked, false);
});
test('plugin launch source is stable only inside launch and never writes pluginData', () => {
  const { sdk } = sdkModel(1, undefined); delete sdk.fileKey; Object.defineProperty(sdk.root, 'setPluginData', { get() { throw new Error('must not touch'); } });
  assert.deepEqual(readProductionSource(sdk, namespace), { kind: 'plugin-launch', namespace }); const other = `src_other_${'b'.repeat(32)}`; assert.notDeepEqual(readProductionSource(sdk, other), readProductionSource(sdk, namespace));
  Object.defineProperty(sdk, 'fileKey', { get() { throw new Error('not enabled'); } }); assert.equal(readProductionSource(sdk, namespace).kind, 'plugin-launch');
});
test('production selection is actual current-page top-level FRAME only', () => {
  const { sdk } = sdkModel(); const nested = { id: '3:1', type: 'FRAME' }; sdk.currentPage.selection.push(nested); const result = listProductionFrames(sdk, 'selection'); assert.equal(result.frames.length, 1); assert.equal(result.excluded[0].reason, 'not-top-level-frame');
});
test('developer/read-only permission rejects before source resolution or SDK export', async () => {
  const model = sdkModel(); const { adapter, calls } = memoryAdapter({ projects: async () => [{ id: 'p', name: 'P', permissions: { canPublish: false } }] }); const session = sessionFor(model.sdk, adapter);
  await assert.rejects(session.publish({ projectId: 'p' }), e => e.status === 403); assert.equal(model.exports(), 0); assert.equal(calls.length, 0); assert.equal(session.status().httpStatus, 403);
});
test('successive tasks in one window use independent operation IDs', async () => {
  const { sdk } = sdkModel(); const { adapter } = memoryAdapter(); const ids = []; const claim = adapter.claim;
  adapter.claim = async input => { ids.push(input.operationId); return claim(input); };
  const session = sessionFor(sdk, adapter); await session.publish({ projectId: 'p' }); await session.publish({ projectId: 'p' }); assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
});

test('more than 1000 bases are all fetched before first export and mismatched file aborts safely', async () => {
  const { sdk } = sdkModel(1001); const { adapter, calls } = memoryAdapter(); let exported = false;
  const session = sessionFor(sdk, adapter, { exporter: { exportFrames: async () => { exported = true; assert.equal(calls.filter(c => c[0] === 'source').length, 2); assert.deepEqual(calls.map(c => c[1].frameIds.length), [1000,1]); throw Object.assign(new Error(), { code: 'SDK_EXPORT_FAILED' }); } } });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'SDK_EXPORT_FAILED' }); assert.equal(exported, true);
  let sources = 0; const mismatch = sessionFor(sdk, { ...adapter, publishSource: async (p,b) => ({ ...(await adapter.publishSource(p,b)), designFileId: ++sources === 1 ? 'a' : 'b' }) }, { exporter: { exportFrames: async () => { assert.fail('must not export'); } } });
  await assert.rejects(mismatch.publish({ projectId: 'p' }), { code: 'HTTP_RESPONSE_INVALID' });
});
test('more than 10000 nodes fail before any claim or source write', async () => {
  const { sdk } = sdkModel(10001); const { adapter, calls } = memoryAdapter(); let claims = 0;
  adapter.claim = async () => { claims++; throw new Error('unexpected claim'); };
  const session = sessionFor(sdk, adapter, { exporter: { exportFrames: async () => { assert.fail('must not export'); } } });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'BUDGET_EXCEEDED' }); assert.equal(claims, 0); assert.equal(calls.length, 0);
});
test('all rounds retain frozen initial bases and never CAS-rebase latest', async () => {
  const { sdk } = sdkModel(3); const { adapter, calls } = memoryAdapter(); const session = sessionFor(sdk, adapter); await session.publish({ projectId: 'p', chunkCapacity: 1 });
  assert.equal(calls.filter(c => c[0] === 'source').length, 1); assert.deepEqual(calls.filter(c => c[0] === 'prepare').map(c => c[1].frames[0].baseRevisionId), ['base-2:1','base-2:2','base-2:3']); assert.equal(session.status().completed.length, 3);
});
test('200 prepare conflict journals sid BEFORE explicit abort; never uploads/commits/reprepares', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const original = adapter.prepare; const events = [];
  adapter.prepare = async (...args) => { const r = await original(...args); r.frames[0].status = 'conflict'; return r; }; const abort = adapter.abort; adapter.abort = async sid => { events.push(`abort:${sid}`); return abort(sid); };
  const session = sessionFor(sdk, adapter, { journal: async s => { if (s.sessionId) events.push(`journal:${s.sessionId}`); } });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'CONFLICT' });
  assert.ok(events.includes('journal:sid-1')); assert.equal(events.includes('abort:sid-1'), false);
  assert.equal(session.status().locked, true); assert.equal(session.status().phase, 'unknownCommit');
  await session.abort(); assert.ok(events.indexOf('journal:sid-1') < events.indexOf('abort:sid-1'));
  assert.equal(calls.filter(c => c[0] === 'prepare').length, 1); assert.equal(calls.some(c => ['upload','commit'].includes(c[0])), false); assert.equal(session.status().phase, 'aborted');
});
test('unknownPrepare response loss locks indefinitely without sid, no query/automatic retry', async () => {
  const { sdk } = sdkModel(); let attempts = 0; const { adapter } = memoryAdapter({ prepare: async () => { attempts++; throw new Error('transport response lost'); } }); const session = sessionFor(sdk, adapter);
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_PREPARE' }); await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_PREPARE' }); await session.query(); assert.equal(session.status().locked, true); assert.equal(attempts, 1); assert.equal(session.status().locked, true);
});
test('unknownCommit only queries original sid; open/404/401/network never unlock, even past expiresAt', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter({ commit: async sid => { calls.push(['commit-lost',sid]); throw new Error('lost'); } }); const session = sessionFor(sdk, adapter); await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_COMMIT' });
  await session.query(); assert.equal(session.status().locked, true); const query = adapter.query;
  for (const status of [404,401,403,null]) { adapter.query = async sid => { calls.push(['query-failed',sid]); throw Object.assign(new Error('safe'), { code: 'HTTP_FAILED', status }); }; await assert.rejects(session.query()); assert.equal(session.status().locked, true); }
  adapter.query = query; await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_COMMIT' }); assert.equal(calls.filter(c => c[0] === 'prepare').length, 1); assert.equal(calls.filter(c => c[0].startsWith('query')).every(c => c[1] === 'sid-1'), true);
});
test('GET committed confirms terminal WITHOUT inventing revisions; explicit same-sid commit recovers mapping', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const commit = adapter.commit; adapter.commit = async () => { throw new Error('lost'); }; const session = sessionFor(sdk, adapter); await assert.rejects(session.publish({ projectId: 'p' }));
  const query = adapter.query; adapter.query = async sid => ({ ...(await query(sid)), status: 'committed' }); await session.query(); assert.equal(session.status().phase, 'committed'); assert.equal(session.status().mappingAvailable, false); assert.equal(session.status().locked, true); assert.equal(session.status().verified, false); assert.equal(session.status().commitResult, null);
  adapter.commit = commit; const result = await session.recoverCommit(); assert.equal(result.state.mappingAvailable, true); assert.equal(result.result.frames[0].revisionId, 'server-rev-2:1'); assert.equal(result.state.verified, true);
  assert.deepEqual(calls.filter(c => c[0] === 'result').map(c => c[1]), ['sid-1']); assert.deepEqual(calls.filter(c => c[0] === 'commit'), []);
});
test('late cancel after physical commit retains mapping but does not claim success before verification', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const commit = adapter.commit; const controller = new AbortController(); adapter.commit = async sid => { const r = await commit(sid); controller.abort(); return r; }; const session = sessionFor(sdk, adapter);
  await assert.rejects(session.publish({ projectId: 'p' }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(session.status().phase, 'verificationPending'); assert.equal(session.status().mappingAvailable, true); assert.equal(session.status().verified, false); assert.equal(session.status().locked, true);
  await session.query(); assert.equal(session.status().phase, 'committed'); assert.equal(session.status().verified, true); assert.equal(session.status().mappingAvailable, true);
  assert.equal(calls.filter(c => c[0] === 'prepare').length, 1); assert.equal(calls.filter(c => c[0] === 'commit').length, 1); assert.equal(calls.some(c => c[0] === 'abort'), false);
});
test('physical SDK cancellation retains coordinator work slot until actual completion', async () => {
  const { sdk } = sdkModel(); const { adapter } = memoryAdapter(); let finish; let started; const atExport = new Promise(resolve => { started = resolve; }); const exporter = { exportFrames: async () => { started(); await new Promise(resolve => { finish = resolve; }); throw Object.assign(new Error(), { code: 'CANCELLED' }); } }; const controller = new AbortController(); const session = sessionFor(sdk, adapter, { exporter });
  const task = session.publish({ projectId: 'p' }, { signal: controller.signal }); await atExport; controller.abort(); assert.equal(session.status().busy, true); await assert.rejects(session.publish({ projectId: 'p' }), { code: 'BUSY' }); finish(); await assert.rejects(task, { code: 'CANCELLED' }); assert.equal(session.status().busy, false);
});
test('root object replacement after export prevents prepare and no pluginData marker is written', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const original = createExporter(sdk, { cryptoAPI: webcrypto }); const session = sessionFor(sdk, adapter, { exporter: { exportFrames: async (...args) => { const r = await original.exportFrames(...args); sdk.root = { name: 'new file' }; return r; } } });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'DOCUMENT_CHANGED' }); assert.equal(calls.some(c => c[0] === 'prepare'), false);
});
test('translation rejects PDF, non-subtree exports, raw mismatch and zero dimensions instead of rewriting', async () => {
  const { sdk } = sdkModel(); const result = await createExporter(sdk, { cryptoAPI: webcrypto }).exportSelection(); const options = { projectId: 'p', designFileId: 'file', source: { kind: 'figma-file', fileKey: 'actualFileKey' }, page: sdk.currentPage, bases: new Map([['2:1',null]]), cryptoAPI: webcrypto };
  const original = result.frames[0].exports[0]; result.frames[0].exports[0] = { ...original, nodeId: 'outside-node' }; await assert.rejects(translateProductionFrames(result, options)); result.frames[0].exports[0] = original;
  const asset = result.frames[0].assets[1]; const prior = asset.descriptor; asset.descriptor = { ...prior, mime: 'application/pdf', format: 'PDF' }; await assert.rejects(translateProductionFrames(result, options), { code: 'BAD_FORMAT' }); asset.descriptor = prior;
  result.frames[0].layerDoc.frame.absoluteBoundingBox.width = 0; await assert.rejects(translateProductionFrames(result, options), { code: 'BAD_BYTES' });
});
async function productionRPC(t, { sdk = sdkModel().sdk, adapter = memoryAdapter().adapter, initial = new Map(), production = { serviceOrigin: 'https://service.example' } } = {}) {
  const listeners = new Set(); const notices = []; let ui; let shown = 0; let serial = 0;
  sdk.showUI = () => { shown++; }; sdk.closePlugin = () => {};
  sdk.clientStorage = { keysAsync: async () => [...initial.keys()], getAsync: async key => initial.get(key), setAsync: async (key,value) => { initial.set(key, structuredClone(value)); }, deleteAsync: async key => { initial.delete(key); } };
  sdk.ui = { on: (_event, fn) => listeners.add(fn), off: (_event, fn) => listeners.delete(fn), resize() {}, postMessage(message) { queueMicrotask(() => { void ui.receive(message, { main: true }); }); } };
  const main = startPlugin(sdk, '<html>synthetic UI</html>', { production });
  ui = createBridge({ channel: CHANNEL, send(message) { queueMicrotask(() => { for (const fn of listeners) fn(message, { origin: 'null' }); }); }, subscribe: () => () => {}, trustedPeer: p => p.main === true, makeRequestId: () => `rpc-ui-${++serial}`, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult,
    handlers: { async digest(payload) { return { digest: new Uint8Array(await webcrypto.subtle.digest('SHA-256', payload.bytes)) }; }, notice(payload) { notices.push(payload.state); return { accepted: true }; }, async 'production-network'(payload, {signal}) { assert.equal(payload.service.origin, 'https://service.example'); try { return { ok:true, value:await adapter[payload.method](...payload.args,{signal}) }; } catch(error) { return {ok:false,error:{code:error.code || 'HTTP_FAILED',status:error.status || null,dispatched:true}}; } } }
  });
  t.after(async () => { await main.dispose(); await ui.close(); });
  const command = (action,payload={},context={}) => ui.request('production-control',{action,...payload},context);
  return { sdk, main, ui, command, notices, storage:initial, shown:()=>shown, connect:()=>command('connect',{service:{origin:'https://service.example',allowLocalhost:false},namespace}) };
}

test('explicit production main/RPC starts once, uses real source/platform IDs and no main TextEncoder/WebCrypto/URL', async t => {
  const { adapter,calls }=memoryAdapter(); const pair=await productionRPC(t,{adapter}); const hello=await pair.ui.request('hello',{}); assert.equal(pair.shown(),1); assert.equal(hello.state.production,true);
  const descriptors = Object.fromEntries(['TextEncoder','crypto','URL'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try { for(const k of Object.keys(descriptors))Object.defineProperty(globalThis,k,{value:undefined,configurable:true}); await pair.connect(); const result=await pair.command('publish',{projectId:'p',scope:'selection',scale:1,includeSlices:true,chunkCapacity:16}); assert.equal(result.results[0].frames[0].revisionId,'server-rev-2:1'); }
  finally { for(const [k,d]of Object.entries(descriptors))if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]; }
  assert.equal(calls.some(c=>c[0]==='prepare'),true);const state=pair.main.status().publisher;assert.equal(state.mappingAvailable,true);assert.equal(state.service.origin,'https://service.example');
});
test('production strict wrapper rejects demo publish/network and secret-bearing remember extras', async t => {
  const pair=await productionRPC(t);await pair.connect();
  assert.throws(()=>validateProductionOperation('publish',{bindings:[]}));assert.throws(()=>validateProductionOperation('network',{}));
  await assert.rejects(async()=>pair.command('remember-write',{remembered:{origin:'https://service.example',allowLocalhost:false,username:'u',refreshToken:'device-credential',refreshExpiresAt:'2099-01-01T00:00:00Z',password:'must-not-store'}}));
  await pair.command('remember-write',{remembered:{origin:'https://service.example',allowLocalhost:false,username:'u',refreshToken:'device-credential',refreshExpiresAt:'2099-01-01T00:00:00Z'}});const stored=await pair.command('remember-read');assert.equal(stored.remembered.refreshToken,'device-credential');assert.equal(Object.hasOwn(stored.remembered,'token'),false);await pair.command('remember-clear');assert.equal((await pair.command('remember-read')).remembered,null);
});
test('C34 custom-https blocks a second publish after unknown prepare without querying or re-preparing', async t => {
  let preparations=0;const {adapter,calls}=memoryAdapter({prepare:async()=>{preparations++;throw new Error('lost');}});const pair=await productionRPC(t,{adapter,production:{serviceMode:'custom-https'}});await pair.connect();
  // C34 conflict, pending product decision: the baseline locally locked until the server
  // confirmed an unknown prepare. Current `discardHistory` releases the local lock after
  // physical completion; the unknown phase plus the custom-https gate are what still
  // reject a second publish without querying or re-preparing.
  const payload={projectId:'p',scope:'selection',scale:1,includeSlices:true,chunkCapacity:16};await assert.rejects(pair.command('publish',payload),{code:'UNKNOWN_PREPARE'});assert.equal(preparations,1);const unknown=(await pair.command('status')).state;assert.equal(unknown.phase,'unknownPrepare');assert.equal(unknown.locked,false,'C34 releases only the local lock after physical completion');const before=calls.length;await assert.rejects(pair.command('publish',payload),{code:'UNKNOWN_COMMIT'});assert.equal(preparations,1);assert.equal(calls.length,before);assert.equal(calls.some(c=>c[0]==='queryOperation'),false);await assert.rejects(pair.command('connect',{service:{origin:'https://elsewhere.example',allowLocalhost:false},namespace}),{code:'UNKNOWN_COMMIT'});
});
test('partial multi-round cancellation retains confirmed mapping and explicitly reports incomplete task', async () => {
  const {sdk}=sdkModel(2);const {adapter}=memoryAdapter();const commit=adapter.commit;const controller=new AbortController();adapter.commit=async sid=>{const result=await commit(sid);controller.abort();return result;};const session=sessionFor(sdk,adapter);
  await assert.rejects(session.publish({projectId:'p',chunkCapacity:1},{signal:controller.signal}),{code:'CANCELLED'});assert.equal(session.status().phase,'partial');assert.equal(session.status().completed.length,1);assert.equal(session.status().error,'CANCELLED');assert.equal(session.status().locked,true);assert.equal(session.status().verified,false);assert.deepEqual([session.status().done,session.status().total],[1,2]);
});

// These are independent localhost fixtures of the newly supplied deployed shapes,
// not the actual createApp/AGPL platform acceptance run (which Parent owns).
async function deployedShapeHTTP(t, { denyPNG = false, loseFirstCommit = false } = {}) {
  const { sdk } = sdkModel(); const requests = [], assetBodies = new Map(); let prepared = null; let preparedResult = null; let preparedHash = null; let committed = null; let operation = null; let writerSecret = null; let serverFailure = null; let dropped = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks); requests.push({ method: req.method, url: req.url, bytes, mime: req.headers['x-asset-mime'] });
    const send = (value, status = 200) => { const body = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length }); res.end(body); };
    try {
      if (req.url === '/api/publish/intent?projectId=p') return send({ projectId: 'p', operationId: `op_${'1'.repeat(32)}_${'a'.repeat(64)}` });
      if (req.url === '/api/projects') return send({ projects: [{ id: 'p', name: 'P', ownerId: 'u', designFileCount: 1, permissions: { canManage: true, canPublish: true, canShare: true, canEditLayout: true, canDelete: true } }] });
      if (req.url === '/api/publish/operations' && req.method === 'POST') { const body = JSON.parse(bytes); writerSecret = body.writerSecret; operation = { operationId: body.operationId, projectId: body.projectId, frameIds: body.frameIds, groupId: body.groupId, status: 'open', createdBy: 'u', createdAt: expiry, updatedAt: expiry, finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: body.frameIds }; return send(operation); }
      if (req.url === `/api/publish/operations/${operation?.operationId}/finish`) return send({ ...operation, status: 'completed', remainingFrameIds: [] });
      if (req.url === `/api/publish/operations/${operation?.operationId}/cancel`) return send({ ...operation, status: 'cancelled', batches: [{ sessionId: 'deployed-shape-sid', operationId: operation.operationId, batchIndex: 0, requestHash: preparedHash, status: 'aborted', expiresAt: null, automaticExpiry: false, uploaded: [], uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, prepareResult: preparedResult, frames: prepared.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: 'deployed-frame', status: 'aborted' })) }] });
      if (req.url === '/api/projects/p/publish-source') { const body = JSON.parse(bytes); assert.equal(body.writerSecret, writerSecret); return send({ projectId: 'p', designFileId: 'platform-file', source: body.source, baseRevisions: Object.fromEntries(body.frameIds.map(fid => [fid, null])) }); }
      if (req.method === 'POST' && req.url === '/api/publish/sessions') {
        prepared = JSON.parse(bytes); const { writerSecret: ignoredSecret, operationId: operationKey, batchIndex: batch, ...prepareBody } = prepared; const actualHash = preparedHash = await productionPrepareHash(prepareBody, operationKey, batch, webcrypto); const f = prepared.frames[0]; const perFrame = [f.layerDocSha256, f.previewSha256, ...f.exports.map(e => e.sha256)];
        preparedResult = { sessionId: 'deployed-shape-sid', status: 'open', expiresAt: null, automaticExpiry: false, operationId: prepared.operationId, batchIndex: prepared.batchIndex, requestHash: actualHash, designFileId: 'platform-file', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, missingAssetSha256: [...new Set(perFrame)], frames: [{ figmaNodeId: f.figmaNodeId, frameId: 'deployed-frame', status: 'new', missingAssetSha256: perFrame }] }; return send(preparedResult);
      }
      if (req.method === 'PUT') {
        const sha = req.url.split('/').pop(); assert.equal(bytes.subarray(0,4).toString(), 'GLP1'); assert.deepEqual(bytes.subarray(4,36), Buffer.from(writerSecret, 'base64url')); const raw = bytes.subarray(36); assert.equal(await sha256(raw, webcrypto), sha); assetBodies.set(sha, raw);
        if (denyPNG && req.headers['x-asset-mime'] === 'image/png') return send({ error: 'denied' }, 403);
        return send({ ok: true, sha256: sha, bytes: raw.length, mime: req.headers['x-asset-mime'] });
      }
      if (req.url === '/api/publish/sessions/deployed-shape-sid/commit') {
        if (committed) return send({ ...committed, idempotent: true });
        committed = { sessionId: 'deployed-shape-sid', status: 'committed', frames: [{ figmaNodeId: '2:1', frameId: 'deployed-frame', revisionId: 'original-server-revision', previousRevisionId: null, status: 'new' }] }; return send(committed);
      }
      if (req.method === 'GET' && req.url === '/api/publish/sessions/deployed-shape-sid') return send({ sessionId: 'deployed-shape-sid', status: committed ? 'committed' : 'open', expiresAt: null, operationId: operation.operationId, batchIndex: 0, requestHash: preparedHash, automaticExpiry: false, uploaded: [], uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, frames: [{ figmaNodeId: '2:1', frameId: 'deployed-frame', status: 'new' }] });
      if (req.method === 'GET' && req.url === '/api/publish/sessions/deployed-shape-sid/result') return committed ? send(committed) : send({ error: 'not committed' }, 409);
      if (req.method === 'GET' && req.url === '/api/projects/p/canvas') {
        const frames = committed ? [{ id: 'deployed-frame', currentRevisionId: 'original-server-revision', groupId: null, x: -12.25, y: 5.75, width: 2.2, height: 3.1 }] : [];
        return send({ catalogReadVersion: `${'a'.repeat(32)}:1`, id: 'p', groups: [], files: [{ pages: [{ frames }] }] });
      }
      if (req.method === 'GET' && req.url === '/api/inspector/projects/p/directory') {
        const frames = committed ? [{ frameId: 'deployed-frame', projectId: 'p', designFileId: 'platform-file', pageId: 'page-1', revisionId: 'original-server-revision', currentRevisionId: 'original-server-revision', figmaNodeId: '2:1', groupId: null }] : [];
        return send({ catalogReadVersion: `${'a'.repeat(32)}:1`, projectId: 'p', groups: [], frames });
      }
      if (req.method === 'GET' && req.url === '/api/frames/deployed-frame/revisions') return send({ catalogReadVersion: syntheticReadVersion, frameId: 'deployed-frame', currentRevisionId: 'original-server-revision', revisions: [{ id: 'original-server-revision' }] });
      if (req.method === 'GET' && req.url === '/api/inspector/frames/deployed-frame/revisions/original-server-revision') return send(syntheticSnapshot('deployed-frame', 'original-server-revision', JSON.parse(assetBodies.get(prepared.frames[0].layerDocSha256))));
      if (req.url === '/api/publish/sessions/deployed-shape-sid/abort') return send({ sessionId: 'deployed-shape-sid', status: 'aborted' });
      return send({ error: 'unexpected route' }, 404);
    } catch (error) { serverFailure = error; send({ error: 'fixture assertion failed' }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchAPI = async (url, options) => {
    const response = await fetch(url, options);
    if (loseFirstCommit && !dropped && url.endsWith('/commit')) { dropped = true; await response.arrayBuffer(); throw new TypeError('synthetic acknowledgement loss after physical response'); }
    return response;
  };
  const adapter = createProductionHTTP({ origin, allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); adapter.setToken('deployed-shape.hmac');
  return { session: sessionFor(sdk, adapter), requests, prepared: () => prepared, serverFailure: () => serverFailure };
}

test('deployed numeric remembered expiry is actually stored and read unchanged through main SDK clientStorage RPC', async t => {
  const pair = await productionRPC(t); const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const remembered = { origin: 'https://service.example', allowLocalhost: false, username: 'user', refreshToken: 'synthetic-numeric-device', refreshExpiresAt };
  await pair.command('remember-write', { remembered });
  const stored = [...pair.storage.values()].find(value => value?.refreshToken === remembered.refreshToken); assert.equal(typeof stored.refreshExpiresAt, 'number'); assert.equal(stored.refreshExpiresAt, refreshExpiresAt);
  const restored = await pair.command('remember-read'); assert.equal(restored.remembered.refreshExpiresAt, refreshExpiresAt); assert.equal(typeof restored.remembered.refreshExpiresAt, 'number');
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, 8640000000000001, 0, 1.5]) await assert.rejects(async () => pair.command('remember-write', { remembered: { ...remembered, refreshExpiresAt: bad } }));
  assert.equal((await pair.command('remember-read')).remembered.refreshExpiresAt, refreshExpiresAt); assert.equal(Object.hasOwn(stored, 'password'), false); assert.equal(Object.hasOwn(stored, 'token'), false);
});

test('deployed same-PNG per-frame duplicate missing list sends exactly one original PNG PUT', async t => {
  const run = await deployedShapeHTTP(t); const result = await run.session.publish({ projectId: 'p' }); const frame = run.prepared().frames[0];
  assert.equal(frame.previewSha256, frame.exports[0].sha256); const puts = run.requests.filter(r => r.method === 'PUT'); const pngPuts = puts.filter(r => r.mime === 'image/png');
  assert.equal(puts.length, 2); assert.equal(pngPuts.length, 1); assert.deepEqual([...pngPuts[0].bytes.subarray(36)], [...png()]); assert.equal(await sha256(pngPuts[0].bytes.subarray(36), webcrypto), frame.previewSha256);
  assert.equal(result.results[0].frames[0].revisionId, 'original-server-revision'); assert.equal(run.serverFailure(), null);
});
test('deployed known-committed same-sid result GET recovers original mapping without latest/reprepare', async t => {
  const run = await deployedShapeHTTP(t, { loseFirstCommit: true }); await assert.rejects(run.session.publish({ projectId: 'p' }), { code: 'UNKNOWN_COMMIT' });
  const queried = await run.session.query(); assert.equal(queried.state.phase, 'committed'); assert.equal(queried.state.mappingAvailable, false); assert.equal(queried.state.commitResult, null); assert.equal(Object.hasOwn(queried.result.frames[0], 'revisionId'), false);
  const before = run.requests.filter(r => r.method === 'POST' || r.method === 'PUT').length;
  const recovered = await run.session.recoverCommit(); assert.equal(recovered.result.sessionId, 'deployed-shape-sid'); assert.equal(recovered.result.status, 'committed'); assert.equal(recovered.result.frames[0].revisionId, 'original-server-revision'); assert.equal(recovered.state.mappingAvailable, true);
  assert.equal(run.requests.filter(r => r.method === 'POST' && r.url === '/api/publish/sessions').length, 1);
  assert.deepEqual(run.requests.filter(r => r.url.endsWith('/commit')).map(r => r.url), ['/api/publish/sessions/deployed-shape-sid/commit']);
  assert.deepEqual(run.requests.filter(r => r.url.endsWith('/result')).map(r => [r.method,r.url]), [['GET','/api/publish/sessions/deployed-shape-sid/result']]);
  assert.equal(run.requests.filter(r => r.method === 'POST' || r.method === 'PUT').length, before + 1); assert.equal(run.requests.filter(r => r.url.endsWith('/finish')).length, 1); assert.equal(run.requests.some(r => /latest/.test(r.url)), false); assert.equal(run.serverFailure(), null);
});
test('deployed duplicate frame hashes reach actual PNG PUT 403 rather than a false early validator failure', async t => {
  const run = await deployedShapeHTTP(t, { denyPNG: true }); await assert.rejects(run.session.publish({ projectId: 'p' }), e => e.code === 'HTTP_FAILED' && e.status === 403);
  const pngPuts = run.requests.filter(r => r.method === 'PUT' && r.mime === 'image/png'); assert.equal(pngPuts.length, 1); assert.deepEqual([...pngPuts[0].bytes.subarray(36)], [...png()]);
  assert.equal(run.requests.some(r => r.url.endsWith('/commit')), false); assert.equal(run.session.status().locked, true); assert.equal(run.session.status().phase, 'unknownCommit'); assert.equal(run.requests.filter(r => r.method === 'POST' && r.url.endsWith('/abort')).length, 0);
  await run.session.abort(); assert.equal(run.session.status().locked, false); assert.equal(run.session.status().phase, 'aborted'); assert.equal(run.requests.filter(r => r.method === 'POST' && r.url.endsWith('/abort')).length, 1); assert.equal(run.serverFailure(), null);
});

test('SDK coordinator -> actual localhost HTTP production contract, with original assets and server mapping', async t => {
  const { sdk } = sdkModel(); sdk.currentPage.children[0].name = '设计正文 writerSecret 原样保留'; const routes = []; let prepared, operation, writerSecret; const assets = new Map();
  const server = http.createServer(async (req,res) => { const chunks=[]; for await (const c of req) chunks.push(c); const bytes = Buffer.concat(chunks); routes.push([req.method,req.url]); const send = value => { const body = Buffer.from(JSON.stringify(value)); res.writeHead(200, { 'content-type':'application/json', 'content-length': body.length }); res.end(body); };
    if (req.url === '/api/publish/intent?projectId=p') return send({projectId:'p',operationId:`op_${'2'.repeat(32)}_${'a'.repeat(64)}`});
    if (req.url === '/api/projects') return send({ projects:[{ id:'p', name:'P', permissions:{ canPublish:true } }] });
    if (req.url === '/api/publish/operations') { const b=JSON.parse(bytes); writerSecret=b.writerSecret; operation={operationId:b.operationId,projectId:b.projectId,frameIds:b.frameIds,groupId:b.groupId,status:'open',createdBy:'u',createdAt:expiry,updatedAt:expiry,finishedAt:null,lockScope:'service',automaticExpiry:false,batches:[],committedFrames:[],remainingFrameIds:b.frameIds}; return send(operation); }
    if (req.url === `/api/publish/operations/${operation?.operationId}/finish`) return send({...operation,status:'completed',remainingFrameIds:[]});
    if (req.url === '/api/projects/p/publish-source') { const b=JSON.parse(bytes); assert.equal(b.writerSecret,writerSecret); return send({ projectId:'p', designFileId:'platform-file', source:b.source, baseRevisions:Object.fromEntries(b.frameIds.map(fid => [fid,null])) }); }
    if (req.url === '/api/publish/sessions') { prepared=JSON.parse(bytes); const {writerSecret:ignoredSecret,operationId:operationKey,batchIndex:batch,...prepareBody}=prepared; const actualHash=await productionPrepareHash(prepareBody,operationKey,batch,webcrypto); const f=prepared.frames[0]; return send({ sessionId:'http-sid',status:'open',expiresAt:null,automaticExpiry:false,operationId:prepared.operationId,batchIndex:prepared.batchIndex,requestHash:actualHash,designFileId:'platform-file',maxUploadBytes:PRODUCTION_BODY_LIMIT,uploadPolicy:{version:1,mode:'adaptive',maxConcurrentUploads:1,maxInFlightBytes:PRODUCTION_BODY_LIMIT},missingAssetSha256:[...new Set([f.layerDocSha256,f.previewSha256,...f.exports.map(e=>e.sha256)])],frames:[{figmaNodeId:f.figmaNodeId,frameId:'actual-platform-frame',status:'new',missingAssetSha256:[]}] }); }
    if (req.method === 'PUT') { const hash=req.url.split('/').pop(); assert.equal(bytes.subarray(0,4).toString(),'GLP1'); assert.deepEqual(bytes.subarray(4,36),Buffer.from(writerSecret,'base64url')); const raw=bytes.subarray(36); assets.set(hash,raw); return send({ok:true,sha256:hash,bytes:raw.length,mime:req.headers['x-asset-mime']}); }
    if (req.url.endsWith('/commit')) return send({sessionId:'http-sid',status:'committed',frames:[{figmaNodeId:'2:1',frameId:'actual-platform-frame',revisionId:'actual-server-revision',status:'new'}]});
    if (req.method === 'GET' && req.url === '/api/projects/p/canvas') return send({catalogReadVersion:`${'a'.repeat(32)}:1`,id:'p',groups:[],files:[{pages:[{frames:[{id:'actual-platform-frame',currentRevisionId:'actual-server-revision',groupId:null,x:-12.25,y:5.75,width:2.2,height:3.1}]}]}]});
    if (req.method === 'GET' && req.url === '/api/inspector/projects/p/directory') return send({catalogReadVersion:`${'a'.repeat(32)}:1`,projectId:'p',groups:[],frames:[{frameId:'actual-platform-frame',projectId:'p',designFileId:'platform-file',pageId:'page-1',revisionId:'actual-server-revision',currentRevisionId:'actual-server-revision',figmaNodeId:'2:1',groupId:null}]});
    if (req.method === 'GET' && req.url === '/api/frames/actual-platform-frame/revisions') return send({catalogReadVersion:syntheticReadVersion,frameId:'actual-platform-frame',currentRevisionId:'actual-server-revision',revisions:[{id:'actual-server-revision'}]});
    if (req.method === 'GET' && req.url === '/api/inspector/frames/actual-platform-frame/revisions/actual-server-revision') return send(syntheticSnapshot('actual-platform-frame','actual-server-revision',JSON.parse(assets.get(prepared.frames[0].layerDocSha256))));
    res.writeHead(404);res.end();
  }); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const adapter=createProductionHTTP({origin:`http://127.0.0.1:${server.address().port}`,allowLocalhost:true,cryptoAPI:webcrypto});adapter.setToken('fixture.hmac');const session=sessionFor(sdk,adapter);const result=await session.publish({projectId:'p'});
  assert.equal(result.results[0].frames[0].revisionId,'actual-server-revision');assert.equal(assets.size,2);for(const [hash,bytes]of assets)assert.equal(await sha256(bytes,webcrypto),hash);assert.equal(routes.some(r=>r[1].includes('independent-publish')),false);assert.equal(prepared.frames[0].figmaNodeId,'2:1');assert.equal(JSON.parse(assets.get(prepared.frames[0].layerDocSha256)).frame.name,'设计正文 writerSecret 原样保留');
  assert.deepEqual(routes.filter(r => r[0] === 'GET' && (r[1].endsWith('/canvas') || r[1].endsWith('/directory'))), [['GET','/api/projects/p/canvas'], ['GET','/api/inspector/projects/p/directory']]); assert.equal(result.state.verified,true);
});

test('production task keeps SDK export count separate from confirmed commits, including partial SDK failure and reset', async () => {
  const { sdk } = sdkModel(2); const { adapter, calls } = memoryAdapter(); const saved = [];
  let failExport = false;
  const original = createExporter(sdk, { cryptoAPI: webcrypto });
  const exporter = { exportFrames: async (frames, options) => {
    if (!failExport) return original.exportFrames(frames, options);
    options.onProgress({ done: 1, total: 2, sourceBytes: 1024 });
    throw Object.assign(new Error('private device message must not be journalled'), { code: 'SDK_EXPORT_FAILED' });
  } };
  const session = sessionFor(sdk, adapter, { exporter, journal: async state => saved.push(structuredClone(state)) });
  await session.publish({ projectId: 'p' });
  assert.deepEqual([session.status().done, session.status().total, session.status().exportDone, session.status().exportTotal], [2, 2, 2, 2]);
  failExport = true;
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'SDK_EXPORT_FAILED' });
  const state = session.status();
  assert.deepEqual([state.phase, state.done, state.total, state.exportDone, state.exportTotal, state.failureStage, state.error], ['failed', 0, 2, 1, 2, 'exporting', 'SDK_EXPORT_FAILED']);
  assert.equal(state.httpStatus, null);
  assert.equal(state.locked, true); // The claimed operation remains fenced until explicitly cancelled.
  assert.equal(calls.filter(c => c[0] === 'prepare').length, 1);
  assert.equal(saved.at(-1).exportDone, 1);
  assert.equal(JSON.stringify(saved).includes('private device message'), false);
  assert.deepEqual([saved.at(-2).done, saved.at(-1).done], [0, 0]);
});

test('source failure records safe stage/status without claiming an SDK export or creating publish sessions', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter({ publishSource: async () => { throw Object.assign(new Error('private server response'), { code: 'HTTP_FAILED', status: 403 }); } });
  const saved = []; const session = sessionFor(sdk, adapter, { journal: async state => saved.push(structuredClone(state)) });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'HTTP_FAILED', status: 403 });
  assert.deepEqual([session.status().phase, session.status().failureStage, session.status().httpStatus, session.status().exportDone, session.status().exportTotal, session.status().done], ['failed', 'resolvingSource', 403, 0, 1, 0]);
  assert.equal(calls.some(c => ['prepare', 'upload', 'commit'].includes(c[0])), false);
  assert.equal(JSON.stringify(saved).includes('private server response'), false);
});

test('second batch lost prepare response recovers only the journaled exact SID', async () => {
  const { sdk } = sdkModel(2); const { adapter, calls } = memoryAdapter(); let operation, lost, lastJournal; const order = [];
  const claim = adapter.claim; adapter.claim = async input => { operation = input; return claim(input); };
  const prepare = adapter.prepare; adapter.prepare = async (...args) => { const result = await prepare(...args); if (args[2] === 1) { lost = result; throw new Error('lost prepare'); } return result; };
  adapter.queryOperation = async op => { order.push('get-operation'); assert.equal(op, operation.operationId); return { ...operation, status: 'partial', batches: [{ sessionId: lost.sessionId, operationId: op, batchIndex: 1, requestHash: lost.requestHash, prepareResult: lost }] }; };
  adapter.query = async sid => { order.push('get-sid'); assert.equal(lastJournal.sessionId, sid); assert.equal(sid, lost.sessionId); return { sessionId: sid, status: 'open', expiresAt: null, automaticExpiry: false, operationId: operation.operationId, batchIndex: 1, requestHash: lost.requestHash, uploaded: [], uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, frames: lost.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: 'new' })) }; };
  const session = sessionFor(sdk, adapter, { journal: async state => { lastJournal = structuredClone(state); if (state.sessionId === lost?.sessionId) order.push('journal-sid'); } });
  await assert.rejects(session.publish({ projectId: 'p', chunkCapacity: 1 }), { code: 'UNKNOWN_PREPARE' });
  assert.equal(lastJournal.batchIndex, 1); assert.deepEqual(lastJournal.batchFrameIds, ['2:2']); assert.equal(lastJournal.requestHash, lost.requestHash);
  const writes = calls.length; await session.query(); assert.equal(session.status().sessionId, lost.sessionId); assert.equal(session.status().locked, true); assert.equal(calls.length, writes); assert.deepEqual(order.slice(0, 3), ['get-operation', 'journal-sid', 'get-sid']);
});

for (const mode of ['unknown-sid', 'known-sid']) test(`16+11 partial cancellation keeps committed revisions (${mode})`, async () => {
  const { sdk } = sdkModel(27); const { adapter, calls } = memoryAdapter(); const prepare = adapter.prepare, upload = adapter.upload; let secondSid;
  adapter.prepare = async (...args) => { const result = await prepare(...args); if (args[2] === 1) { secondSid = result.sessionId; if (mode === 'unknown-sid') throw new Error('lost prepare response'); } return result; };
  adapter.upload = async (sid, ...args) => { if (mode === 'known-sid' && sid === secondSid) throw Object.assign(new Error('failed'), { code: 'HTTP_FAILED', status: 403 }); return upload(sid, ...args); };
  const session = sessionFor(sdk, adapter); await assert.rejects(session.publish({ projectId: 'p', chunkCapacity: 16 }));
  assert.equal(session.status().done, 16); assert.equal(session.status().sessionId, mode === 'unknown-sid' ? null : secondSid);
  const before = calls.length; await session.abort(); assert.equal(session.status().phase, 'partial'); assert.equal(session.status().locked, true); assert.equal(session.status().done, 16); assert.equal(session.status().completed[0].frames.length, 16); assert.equal(calls.slice(before).some(c => c[0] === 'abort'), false);
});

test('C34 startup retires old publish journals without replaying their operations', async t => {
  const baseKey='independent-inspector.publish.pending.v1',pendingKey=`${baseKey}.production`,refreshKey=`${pendingKey}-refresh`,rootKey=`${pendingKey}.journal.src_root_${'1'.repeat(32)}`,copyKey=`${pendingKey}.journal.src_copy_${'2'.repeat(32)}`;
  const initial=new Map([[baseKey,{phase:'unknownCommit'}],[pendingKey,{phase:'unknownPrepare'}],[rootKey,{phase:'unknownCommit',operationId:`op_${'1'.repeat(32)}_${'a'.repeat(64)}`}],[copyKey,{phase:'unknownCommit',sessionId:'conflicting-sid'}],[refreshKey,{refreshToken:'preserved'}],['another-plugin',{keep:true}]]);
  const {adapter,calls}=memoryAdapter();const pair=await productionRPC(t,{adapter,initial});const hello=await pair.ui.request('hello',{});
  assert.equal(hello.state.phase,'idle');assert.equal(hello.state.locked,false);await pair.connect();assert.equal(pair.main.status().publisher.phase,'idle');assert.deepEqual([...initial.keys()],[refreshKey,'another-plugin']);assert.equal(calls.length,0);
});

test('operation wire prefix is charged to the task budget before upload', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const inner = createExporter(sdk, { cryptoAPI: webcrypto }); let envelope;
  const exporter = { exportFrames: async (frames, options) => { const add = options.budget.add.bind(options.budget); options.budget.add = (key, bytes) => { if (key === 'operation-envelope') { envelope = bytes; options.budget.set('synthetic-budget-fill', options.budget.limit - options.budget.used - 1); } return add(key, bytes); }; return inner.exportFrames(frames, options); } };
  const session = sessionFor(sdk, adapter, { exporter }); await assert.rejects(session.publish({ projectId: 'p' }), { code: 'BUDGET_EXCEEDED' }); assert.equal(envelope, 36); assert.equal(calls.some(c => c[0] === 'upload'), false); assert.equal(session.status().locked, true);
});

test('cancellation before prepare dispatch never journals an unlocked claimed operation', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); const controller = new AbortController(), states = [];
  const session = sessionFor(sdk, adapter, { journal: async state => { states.push(structuredClone(state)); if (state.phase === 'preparing') controller.abort(); } });
  await assert.rejects(session.publish({ projectId: 'p' }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls.some(c => c[0] === 'prepare'), false); assert.equal(session.status().locked, true); assert.ok(states.filter(s => s.operationId).every(s => s.locked));
});

test('reader catalog race rejects finish and never re-posts it', async () => {
  const { sdk } = sdkModel(); const { adapter } = memoryAdapter(); let finishes = 0, observed;
  adapter.finish = async (_op, version) => { finishes++; observed = version; throw Object.assign(new Error('catalog changed'), { code: 'HTTP_FAILED', status: 409 }); };
  const session = sessionFor(sdk, adapter); await assert.rejects(session.publish({ projectId: 'p' }), { code: 'HTTP_FAILED', status: 409 });
  assert.equal(observed, syntheticReadVersion); assert.equal(finishes, 1); assert.equal(session.status().phase, 'unknownFinish'); assert.equal(session.status().verified, false); assert.equal(session.status().locked, true);
  await assert.rejects(session.publish({ projectId: 'p' })); assert.equal(finishes, 1);
});

test('lost finish acknowledgement remains locked and only reads original operation', async () => {
  const { sdk } = sdkModel(); const { adapter, calls } = memoryAdapter(); let original, prepared, committed, finishes = 0, reads = 0;
  const claim = adapter.claim; adapter.claim = async input => { original = input; return claim(input); };
  const prepare = adapter.prepare; adapter.prepare = async (...args) => (prepared = await prepare(...args));
  const commit = adapter.commit; adapter.commit = async (...args) => (committed = await commit(...args));
  adapter.finish = async () => { finishes++; throw new Error('finish response lost'); };
  adapter.queryOperation = async op => { reads++; assert.equal(op, original.operationId); return { ...original, status: 'completed', lockScope: 'service', automaticExpiry: false, remainingFrameIds: [], committedFrames: committed.frames, batches: [{ sessionId: prepared.sessionId, status: 'committed', expiresAt: null, automaticExpiry: false, operationId: op, batchIndex: 0, requestHash: prepared.requestHash, uploaded: [], uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT }, frames: prepared.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: 'committed' })), prepareResult: prepared, commitResult: committed }] }; };
  const session = sessionFor(sdk, adapter); await assert.rejects(session.publish({ projectId: 'p' })); assert.equal(session.status().phase, 'unknownFinish'); assert.equal(session.status().locked, true);
  const saved = structuredClone(session.status()); const reopened = sessionFor(sdk, adapter); reopened.restore(saved);
  const before = calls.length; await session.query(); assert.equal(session.status().locked, false); assert.equal(session.status().verified, true); assert.equal(finishes, 1); assert.equal(reads, 1); assert.deepEqual(calls.slice(before).map(c => c[0]), ['verify']);
  const beforeReopen = calls.length; await reopened.query(); assert.equal(reopened.status().verified, true); assert.equal(finishes, 1); assert.equal(reads, 2); assert.deepEqual(calls.slice(beforeReopen).map(c => c[0]), ['verify']);
});

test('multiround success preserves full physical export progress and incrementally confirmed commits', async () => {
  const { sdk } = sdkModel(3); const { adapter } = memoryAdapter();
  const states = []; const session = sessionFor(sdk, adapter, { journal: async state => states.push(structuredClone(state)) });
  await session.publish({ projectId: 'p', chunkCapacity: 1 });
  assert.deepEqual([session.status().exportDone, session.status().exportTotal, session.status().done, session.status().total], [3, 3, 3, 3]);
  assert.deepEqual(states.filter(s => s.phase === 'committing' && s.mappingAvailable).map(s => [s.exportDone, s.done]), [[3, 1], [3, 2], [3, 3]]);
  assert.deepEqual(states.filter(s => s.phase === 'committed').map(s => [s.exportDone, s.done, s.verified]), [[3, 3, true]]);
});

test('unknown prepare and unknown commit preserve export counts and block repeated publish', async () => {
  for (const method of ['prepare', 'commit']) {
    const { sdk } = sdkModel(); let attempts = 0; const { adapter } = memoryAdapter({ [method]: async () => { attempts++; throw new Error('lost response'); } });
    const session = sessionFor(sdk, adapter);
    const code = method === 'prepare' ? 'UNKNOWN_PREPARE' : 'UNKNOWN_COMMIT';
    await assert.rejects(session.publish({ projectId: 'p' }), { code });
    await assert.rejects(session.publish({ projectId: 'p' }), { code });
    assert.deepEqual([session.status().locked, session.status().exportDone, session.status().exportTotal, session.status().done, attempts], [true, 1, 1, 0, 1]);
    assert.equal(session.status().failureStage, method === 'prepare' ? 'preparing' : 'committing');
  }
});

for (const variant of ['sid', 'batch', 'hash', 'group-presence', 'source-proof']) test(`restored task conflict (${variant}) fails closed without unlocking, reprepare or overwrite`, async () => {
  const operationId = `op_${'1'.repeat(32)}_${'a'.repeat(64)}`, sessionId = 'sid-1', requestHash = 'b'.repeat(64), frameId = 'platform-2:1', policy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT };
  const saved = { phase: 'unknownCommit', locked: true, verified: false, operationId, projectId: 'p', sessionId, batchIndex: 0, requestHash, batchFrameIds: ['2:1'], expectedFrameIds: ['2:1'], preparedFrames: [{ figmaNodeId: '2:1', frameId }], groupId: null, completed: [], done: 0, total: 1, mappingAvailable: false, source: variant === 'source-proof' ? { kind: 'figma-file', fileKey: 'OriginalKey' } : { kind: 'plugin-launch', namespace } };
  const server = { sessionId: variant === 'sid' ? 'sid-other' : sessionId, batchIndex: variant === 'batch' ? 1 : 0, requestHash: variant === 'hash' ? 'c'.repeat(64) : requestHash, groupId: variant === 'group-presence' ? undefined : null };
  const prepared = { sessionId, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex: 0, requestHash, designFileId: 'file-1', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: policy, missingAssetSha256: [], frames: [{ figmaNodeId: '2:1', frameId, status: 'new', missingAssetSha256: [] }] };
  const operation = { operationId, projectId: 'p', createdBy: 'u', status: 'open', frameIds: ['2:1'], groupId: server.groupId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [{ sessionId, operationId, batchIndex: server.batchIndex, requestHash: server.requestHash, status: 'open', expiresAt: null, automaticExpiry: false, uploaded: [], uploadPolicy: policy, frames: [{ figmaNodeId: '2:1', frameId, status: 'new' }], prepareResult: prepared }], committedFrames: [], remainingFrameIds: ['2:1'] };
  const calls = [];
  const { adapter } = memoryAdapter({
    queryOperation: async op => { calls.push(['operation', op]); return structuredClone(operation); },
    query: async sid => { calls.push(['query', sid]); return { sessionId: server.sessionId, status: 'committed', expiresAt: null, automaticExpiry: false, operationId, batchIndex: server.batchIndex, requestHash: server.requestHash, uploaded: [], uploadPolicy: policy, frames: [{ figmaNodeId: '2:1', frameId, status: 'committed' }] }; },
    queryCommitResult: async sid => { calls.push(['result', sid]); return { sessionId: server.sessionId, status: 'committed', frames: [{ figmaNodeId: '2:1', frameId, revisionId: 'rev-1', status: 'new' }] }; }
  });
  const session = sessionFor(sdkModel().sdk, adapter); session.restore(saved);
  if (variant === 'source-proof') {
    // A terminal query first establishes the mapping phase; the original source proof is
    // still compared against the live SDK document before the result is accepted.
    await session.query();
    await assert.rejects(session.recoverCommit(), error => error.code === 'DOCUMENT_CHANGED');
  } else await assert.rejects(session.query(), error => error.code === 'HTTP_RESPONSE_INVALID');
  assert.equal(session.status().locked, true, 'a conflicting restored task must stay fenced');
  assert.equal(session.status().verified, false); assert.equal(session.status().mappingAvailable, false);
  assert.equal(calls.some(call => ['prepare', 'upload', 'commit', 'abort'].includes(call[0])), false, 'conflict resolution must never replay a write');
  assert.equal(calls.every(call => ['operation', 'query', 'result'].includes(call[0])), true);
});
