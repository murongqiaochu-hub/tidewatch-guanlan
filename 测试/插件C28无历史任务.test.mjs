// Synthetic SDK/bridge/clientStorage only: no real Figma, HTTP, service or data deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { startProductionPlugin } from '../插件/main.mjs';
import { productionPrepareHash } from '../插件/production-session.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';
import { compileESM } from '../构建/esm-compiler.mjs';
import { pluginFiles } from '../构建/build.mjs';

const legacyKey = 'independent-inspector.publish.pending.v1.production';
const service = { origin: 'https://one.example', allowLocalhost: false };
const anotherService = { origin: 'https://two.example', allowLocalhost: false };
const namespace = n => `src_window_${n.toString(16).padStart(32, '0')}`;
const ownKey = n => `${legacyKey}.journal.${namespace(n)}`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function memoryStorage() {
  const values = new Map(), writes = [];
  return { values, writes,
    async deleteAsync(key) { values.delete(key); },
    async keysAsync() { return [...values.keys()]; },
    async getAsync(key) { return structuredClone(values.get(key)); },
    async setAsync(key, value) { writes.push([key, structuredClone(value)]); values.set(key, structuredClone(value)); }
  };
}
function sdkModel(storage) {
  const png = new Uint8Array(33); png.set([137,80,78,71,13,10,26,10]); const view = new DataView(png.buffer); view.setUint32(8,13); png.set([73,72,68,82],12); view.setUint32(16,2); view.setUint32(20,3);
  const frame = { id: '2:1', type: 'FRAME', name: 'Synthetic', width: 2, height: 3, absoluteBoundingBox: { x: 1, y: 2, width: 2, height: 3 }, children: [], exportAsync: async () => png };
  const page = { id: '1:1', name: 'Synthetic', children: [frame], selection: [frame] };
  return { editorType: 'figma', fileKey: 'SyntheticFile123', root: { name: 'Synthetic', children: [page] }, currentPage: page, clientStorage: storage };
}
function networkModel({ onPrepare, onCommit } = {}) {
  // Deliberately unsafe synthetic server: distinct operations may overlap. Only
  // the other localhost integration tests exercise the real server-side lock.
  const calls = [], sessions = new Map(), operations = new Map(); let serial = 0, intentSerial = 0;
  const version = `${'a'.repeat(32)}:1`, policy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 25 * 1024 * 1024 };
  const adapter = {
    async projects() { calls.push(['projects']); return [{ id: 'p', name: 'P', permissions: { canPublish: true } }]; },
    async intent(projectId) { const operationId = `op_${(++intentSerial).toString(16).padStart(32, '0')}_${'a'.repeat(64)}`; calls.push(['intent', operationId]); return { operationId, projectId }; },
    async claim(input) { calls.push(['claim', input.operationId]); assert.equal(input.replacePrevious, true); const operation = { ...structuredClone(input), status: 'open' }; operations.set(input.operationId, operation); return { ...operation }; },
    async queryOperation(operationId) {
      calls.push(['operation', operationId]); const operation = operations.get(operationId); assert.ok(operation);
      const batches = [...sessions.entries()].filter(([, s]) => s.operationId === operationId).map(([sid, s]) => ({ ...sessionView(sid, s), prepareResult: s.prepareResult, ...(s.commitResult ? { commitResult: s.commitResult } : {}) }));
      const committedFrames = batches.flatMap(b => b.commitResult?.frames || []);
      return { ...operation, lockScope: 'service', automaticExpiry: false, batches, committedFrames, remainingFrameIds: operation.frameIds.filter(fid => !committedFrames.some(f => f.figmaNodeId === fid)) };
    },
    async finish(operationId, readVersion) { calls.push(['finish', operationId]); assert.equal(readVersion, version); const operation = operations.get(operationId); assert.ok(operation); operation.status = 'completed'; return { ...operation, remainingFrameIds: [] }; },
    async publishSource(projectId, body) { calls.push(['source', projectId]); return { projectId, designFileId: 'file', source: body.source, baseRevisions: Object.fromEntries(body.frameIds.map(fid => [fid, null])), ...(body.coordinates ? { coordinateMode: 'project-xy' } : {}) }; },
    async prepare(body, operationId, batchIndex) {
      const sid = `sid-${++serial}`; calls.push(['prepare', sid]); assert.ok(operations.has(operationId));
      const frames = body.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: `frame-${f.figmaNodeId}`, status: 'new', missingAssetSha256: [] }));
      const requestHash = await productionPrepareHash(body, operationId, batchIndex, webcrypto);
      const prepareResult = { sessionId: sid, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex, requestHash, designFileId: 'file', maxUploadBytes: 25 * 1024 * 1024, uploadPolicy: policy, missingAssetSha256: [], frames };
      sessions.set(sid, { operationId, batchIndex, requestHash, frames, prepareResult, status: 'open', commitResult: null });
      if (onPrepare) await onPrepare(sid);
      return prepareResult;
    },
    async upload() { assert.fail('no synthetic missing assets'); },
    async commit(sid, operationId) {
      calls.push(['commit', sid]); const session = sessions.get(sid); assert.ok(session); assert.equal(operationId, session.operationId);
      const result = { sessionId: sid, status: 'committed', frames: session.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: 'rev-1', status: 'new' })) };
      session.commitResult = result; session.status = 'committed'; operations.get(operationId).status = 'partial';
      if (onCommit) await onCommit(sid); return result;
    },
    async query(sid) { calls.push(['query', sid]); const session = sessions.get(sid); assert.ok(session); return sessionView(sid, session); },
    async queryCommitResult(sid) { calls.push(['result', sid]); return sessions.get(sid)?.commitResult || { sessionId: sid, status: 'committed', frames: [{ figmaNodeId: '2:1', frameId: 'frame-2:1', revisionId: 'rev-1', status: 'new' }] }; },
    async abort(sid) { calls.push(['abort', sid]); return { sessionId: sid, status: 'aborted' }; },
    async verifyPublication(projectId, groupId, frames) { calls.push(['verify', projectId]); assert.equal(projectId, 'p'); for (const frame of frames) assert.ok([...sessions.values()].some(s => s.commitResult?.frames.some(f => f.figmaNodeId === frame.figmaNodeId && f.frameId === frame.frameId && f.revisionId === frame.revisionId))); return { projectId, groupId, frameCount: frames.length, catalogReadVersion: version }; }
  };
  function sessionView(sid, session) { return { sessionId: sid, status: session.status, expiresAt: null, automaticExpiry: false, operationId: session.operationId, batchIndex: session.batchIndex, requestHash: session.requestHash, uploaded: [], uploadPolicy: policy, frames: session.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: session.status === 'committed' ? 'committed' : 'new' })) }; }
  return { adapter, calls, sessions, operations };
}
async function pair(t, storage, writer, network) {
  const sdk = sdkModel(storage), listeners = new Set(); let ui; let serial = 0;
  sdk.showUI = () => {}; sdk.closePlugin = () => {};
  sdk.ui = { on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); }, resize() {}, postMessage(message) { queueMicrotask(() => void ui.receive(message, { main: true })); } };
  const main = startProductionPlugin(sdk, '<html>synthetic</html>', { production: { serviceOrigins: [service.origin, anotherService.origin] } });
  ui = createBridge({ channel: CHANNEL, send(message) { queueMicrotask(() => { for (const fn of listeners) fn(message, { origin: 'null' }); }); }, subscribe: () => () => {}, trustedPeer: p => p.main === true, makeRequestId: () => `test-ui-${writer}-${++serial}`, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult,
    handlers: { async digest(payload) { return { digest: new Uint8Array(await webcrypto.subtle.digest('SHA-256', payload.bytes)) }; }, notice() { return { accepted: true }; }, async 'production-network'(payload, context) { try { return { ok: true, value: await network.adapter[payload.method](...payload.args, context) }; } catch (e) { return { ok: false, error: { code: e.code || 'HTTP_FAILED', status: e.status || null, dispatched: true } }; } } }
  });
  t.after(async () => { await main.dispose(); await ui.close(); });
  const command = (action, payload = {}) => ui.request('production-control', { action, ...payload });
  return { main, ui, sdk, hello: () => ui.request('hello', {}), command, connect: (target = service) => command('connect-account', { service: target, namespace: namespace(writer) }) };
}
const payload = { projectId: 'p', scope: 'selection', scale: 1, includeSlices: false, chunkCapacity: 16 };
test('C28 removes only retired publication keys and ignores malformed history without network recovery', async t => {
  const storage=memoryStorage(), network=networkModel();
  storage.values.set(legacyKey,{phase:'unknownCommit'}); storage.values.set(ownKey(91),{invalid:true});
  storage.values.set(`${legacyKey}-refresh`,{private:'preserve'}); storage.values.set('another-plugin',{keep:true});
  const a=await pair(t,storage,1,network); assert.equal((await a.hello()).state.locked,false); await a.connect();
  assert.equal(storage.values.has(legacyKey),false); assert.equal(storage.values.has(ownKey(91)),false);
  assert.equal(storage.values.has(`${legacyKey}-refresh`),true); assert.equal(storage.values.has('another-plugin'),true);
  assert.equal(network.calls.length,0); assert.equal((await a.command('publish',payload)).state.verified,true);
  assert.equal(storage.writes.length,0); assert.deepEqual([...storage.values.keys()],[`${legacyKey}-refresh`,'another-plugin']);
  await assert.rejects(a.command('reconcile'),{code:'BAD_SCHEMA'});
});
test('C28 lost acknowledgement never replays; next explicit upload starts a fresh operation', async t=>{
  const storage=memoryStorage(), network=networkModel(), original=network.adapter.commit;
  network.adapter.commit=async(...args)=>{await original(...args);throw Object.assign(new Error('lost'),{code:'HTTP_FAILED'});};
  const a=await pair(t,storage,1,network); await a.connect(); await assert.rejects(a.command('publish',payload));
  assert.equal(a.main.status().publisher.locked,false); assert.equal(storage.writes.length,0); assert.equal(network.calls.filter(c=>c[0]==='commit').length,1);
  network.adapter.commit=original; assert.equal((await a.command('publish',payload)).state.verified,true);
  assert.equal(new Set(network.calls.filter(c=>c[0]==='claim').map(c=>c[1])).size,2); assert.equal(network.calls.filter(c=>c[0]==='commit').length,2);
  assert.equal(network.calls.some(c=>['query','operation','result'].includes(c[0])),false);
});
test('C28 still rejects concurrent publish while the current run is physically active',async t=>{
  const waiting=deferred(), entered=deferred(), network=networkModel({onPrepare:async()=>{entered.resolve();await waiting.promise;}});
  const a=await pair(t,memoryStorage(),1,network); await a.connect(); const first=a.command('publish',payload); await entered.promise;
  try { await assert.rejects(a.command('publish',payload),{code:'BUSY'}); } finally { waiting.resolve(); }
  assert.equal((await first).state.verified,true); assert.equal(network.calls.filter(c=>c[0]==='claim').length,1);
});
test('C28 upload progress advances only after asset acknowledgement, not after export',async t=>{
  const network=networkModel(), prepare=network.adapter.prepare, snapshots=[]; let a;
  network.adapter.prepare=async(...args)=>{
    const result=await prepare(...args), frame=args[0].frames[0];
    result.missingAssetSha256=[frame.layerDocSha256,frame.previewSha256];
    result.frames[0].missingAssetSha256=[...result.missingAssetSha256]; return result;
  };
  network.adapter.upload=async(sid,asset)=>{snapshots.push({...a.main.status().publisher});return {ok:true,sha256:asset.sha256,bytes:asset.bytes,mime:asset.mime};};
  a=await pair(t,memoryStorage(),1,network);await a.connect();const result=await a.command('publish',payload);
  assert.equal(snapshots.length,2);assert.deepEqual(snapshots.map(s=>s.uploadDone),[0,1]);assert.equal(snapshots[0].uploadedBytes,0);
  assert.equal(snapshots[0].exportDone,1);assert.equal(snapshots[0].uploadTotal,2);assert.ok(snapshots[1].uploadedBytes>0);
  assert.equal(result.state.uploadDone,2);assert.equal(result.state.uploadedBytes,result.state.uploadTotalBytes);
});
test('C28 unavailable history storage does not prevent login or publication',async t=>{
  const storage=memoryStorage(); storage.keysAsync=async()=>{throw Error('storage');}; storage.deleteAsync=async()=>{throw Error('storage');};
  const a=await pair(t,storage,1,networkModel()); await a.hello();await a.connect();assert.equal((await a.command('publish',payload)).state.verified,true);
});
