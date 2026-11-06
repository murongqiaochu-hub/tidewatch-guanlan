import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createProductionSession, productionPrepareHash } from '../插件/production-session.mjs';
import { validateProductionOperation, validatePublishSourceBody, validatePrepareBody } from '../插件/production-protocol.mjs';

const namespace = `src_launch_${'a'.repeat(32)}`;
const point = (frameId, x, y) => ({ frameId, x, y });
function png() { const bytes = new Uint8Array(33); bytes.set([137,80,78,71,13,10,26,10]); const view = new DataView(bytes.buffer); view.setUint32(8,13); bytes.set([73,72,68,82],12); view.setUint32(16,2); view.setUint32(20,3); return bytes; }
function sdk(fileKey, x, y) {
  const frame = { id: '2:1', type: 'FRAME', name: 'Same design', width: 2, height: 3,
    absoluteBoundingBox: { x, y, width: 2, height: 3 }, children: [], exportSettings: [{ format: 'PNG' }], exportAsync: async () => png() };
  const page = { id: '1:1', name: 'Page', children: [frame], selection: [frame] };
  return { sdk: { fileKey, root: { name: 'File', children: [page] }, currentPage: page }, frame };
}
function server() {
  const slots = new Map(); const events = []; let next = 0, nextIntent = 0; const sessions = new Map(), operations = new Map();
  const version = `${'a'.repeat(32)}:1`, policy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 26214400 };
  return { events, adapter: {
    projects: async () => [{ id: 'p', name: 'Project', permissions: { canPublish: true } }],
    async intent(projectId) { return { projectId, operationId: `op_${(++nextIntent).toString(16).padStart(32, '0')}_${'a'.repeat(64)}` }; },
    async claim(input) { const operation = { ...structuredClone(input), status: 'open' }; operations.set(input.operationId, operation); return { ...operation }; },
    async queryOperation() { assert.fail('unexpected operation query'); },
    async finish(operationId, readVersion) { assert.equal(readVersion, version); const operation = operations.get(operationId); assert.ok(operation); return { ...operation, status: 'completed', remainingFrameIds: [] }; },
    async publishSource(projectId, body) {
      events.push(['source', structuredClone(body)]);
      const key = body.coordinates?.map(p => `${p.x},${p.y}`)[0]; const prior = slots.get(key);
      return { projectId, designFileId: 'destination', source: body.source, coordinateMode: 'project-xy', baseRevisions: { '2:1': prior?.revision || null } };
    },
    async prepare(body, operationId, batchIndex) {
      events.push(['prepare', structuredClone(body)]);
      const f = body.frames[0]; const key = `${f.x},${f.y}`; const prior = slots.get(key);
      assert.equal(body.coordinateMode, 'project-xy'); assert.equal(f.baseRevisionId, prior?.revision || null); assert.ok(operations.has(operationId));
      const sid = `sid-${++next}`; sessions.set(sid, { key, f, prior, operationId });
      const requestHash = await productionPrepareHash(body, operationId, batchIndex, webcrypto);
      return { sessionId: sid, status: 'open', designFileId: 'destination', expiresAt: null, automaticExpiry: false, operationId, batchIndex, requestHash, maxUploadBytes: 26214400, uploadPolicy: policy, missingAssetSha256: [], frames: [{ figmaNodeId: f.figmaNodeId, frameId: prior?.frameId || `platform-${next}`, status: prior ? 'changed' : 'new', missingAssetSha256: [] }] };
    },
    async upload() { assert.fail('no missing assets'); },
    async commit(sid, operationId) {
      events.push(['commit', sid]); const { key, f, prior, operationId: expectedOperation } = sessions.get(sid); assert.equal(operationId, expectedOperation); const revision = `rev-${sid}`;
      slots.set(key, { frameId: prior?.frameId || `platform-${sid.slice(4)}`, revision });
      return { sessionId: sid, status: 'committed', frames: [{ figmaNodeId: f.figmaNodeId, frameId: slots.get(key).frameId, revisionId: revision, previousRevisionId: prior?.revision || null, status: prior ? 'changed' : 'new' }] };
    },
    async queryCommitResult() { assert.fail('unexpected result query'); },
    async query() { assert.fail('unexpected query'); },
    async abort(sid) { events.push(['abort', sid]); return { sessionId: sid, status: 'aborted' }; },
    async verifyPublication(projectId, groupId, frames) {
      events.push(['verify', projectId, groupId, structuredClone(frames)]); assert.equal(projectId, 'p');
      for (const frame of frames) assert.ok([...slots.values()].some(s => s.frameId === frame.frameId && s.revision === frame.revisionId));
      return { projectId, groupId, frameCount: frames.length, catalogReadVersion: version };
    }
  } };
}
function session(model, adapter, exporter) { return createProductionSession({ sdk: model.sdk, adapter, namespace, cryptoAPI: webcrypto, ...(exporter ? { exporter } : {}) }); }
const publish = s => s.publish({ projectId: 'p', coordinateMode: 'project-xy', includeSlices: false });

test('project coordinates use actual SDK absoluteBoundingBox, distinct by 1px, cross-file identical content still creates another revision', async () => {
  const { adapter, events } = server();
  const first = await publish(session(sdk('fileA', -12.25, 5.75), adapter));
  const second = await publish(session(sdk('fileB', -12.25, 5.75), adapter));
  const neighbor = await publish(session(sdk('fileC', -11.25, 5.75), adapter));
  const sources = events.filter(e => e[0] === 'source').map(e => e[1]);
  assert.deepEqual(sources.map(s => s.coordinates), [[point('2:1', -12.25, 5.75)], [point('2:1', -12.25, 5.75)], [point('2:1', -11.25, 5.75)]]);
  assert.deepEqual(sources.map(s => s.source.fileKey), ['fileA', 'fileB', 'fileC']);
  const prepared = events.filter(e => e[0] === 'prepare').map(e => e[1]);
  assert.deepEqual(prepared.map(p => p.frames[0].baseRevisionId), [null, 'rev-sid-1', null]);
  assert.equal(prepared.every(p => p.coordinateMode === 'project-xy'), true);
  assert.equal(first.results[0].frames[0].frameId, second.results[0].frames[0].frameId);
  assert.notEqual(second.results[0].frames[0].revisionId, first.results[0].frames[0].revisionId);
  assert.notEqual(neighbor.results[0].frames[0].frameId, first.results[0].frames[0].frameId);
});

test('missing opt-in acknowledgement fails closed before SDK export and prepare', async () => {
  const model = sdk('fileA', 0, 0); const { adapter, events } = server();
  const original = adapter.publishSource; adapter.publishSource = async (...args) => { const response = await original(...args); delete response.coordinateMode; return response; };
  await assert.rejects(publish(session(model, adapter, { exportFrames: async () => assert.fail('must not export') })), { code: 'HTTP_RESPONSE_INVALID' });
  assert.equal(events.some(e => e[0] === 'prepare'), false);
});

test('SDK geometry changed between source resolution and export cannot silently rebind', async () => {
  const model = sdk('fileA', 1, 2); const { adapter, events } = server();
  const original = adapter.publishSource; adapter.publishSource = async (...args) => { const result = await original(...args); model.frame.absoluteBoundingBox.x = 2; return result; };
  await assert.rejects(publish(session(model, adapter)), { code: 'DOCUMENT_CHANGED' });
  assert.equal(events.some(e => e[0] === 'prepare'), false);
});

test('unknown coordinate prepare stays locked: no automatic retry or commit', async () => {
  const { adapter, events } = server(); let attempts = 0;
  adapter.prepare = async body => { events.push(['prepare', body]); attempts++; throw Error('response lost'); };
  const s = session(sdk('fileA', 0, 0), adapter);
  await assert.rejects(publish(s), { code: 'UNKNOWN_PREPARE' });
  await assert.rejects(publish(s), { code: 'UNKNOWN_PREPARE' });
  assert.equal(attempts, 1); assert.equal(s.status().locked, true); assert.equal(events.some(e => e[0] === 'commit'), false);
});

test('coordinate commit acknowledgement loss never resends prepare or commit', async () => {
  const { adapter, events } = server(); let commits = 0;
  adapter.commit = async sid => { events.push(['commit', sid]); commits++; throw Error('acknowledgement lost'); };
  const s = session(sdk('fileA', 7, 9), adapter);
  await assert.rejects(publish(s), { code: 'UNKNOWN_COMMIT' });
  await assert.rejects(publish(s), { code: 'UNKNOWN_COMMIT' });
  assert.equal(s.status().locked, true);
  assert.equal(events.filter(e => e[0] === 'prepare').length, 1);
  assert.equal(commits, 1);
});

test('coordinates and opt-in schema reject forged/ambiguous values, legacy remains unchanged', () => {
  const source = { kind: 'figma-file', fileKey: 'fileA' }; const frameIds = ['2:1', '2:2'];
  const valid = { source, frameIds, coordinates: [point('2:1', 0, 0), point('2:2', 1, 0)] };
  assert.equal(validatePublishSourceBody(valid), valid);
  for (const coordinates of [[point('2:2', 0, 0), point('2:1', 1, 0)], [point('2:1', 0, 0), point('2:2', 0, 0)], [point('2:1', NaN, 0), point('2:2', 1, 0)]]) assert.throws(() => validatePublishSourceBody({ source, frameIds, coordinates }));
  assert.doesNotThrow(() => validatePublishSourceBody({ source, frameIds }));
  const control = { action: 'publish', projectId: 'p', scope: 'selection', scale: 1, includeSlices: false, chunkCapacity: 16 };
  assert.doesNotThrow(() => validateProductionOperation('production-control', { ...control, coordinateMode: 'project-xy' }));
  assert.throws(() => validateProductionOperation('production-control', { ...control, coordinateMode: true }));
  assert.throws(() => validatePrepareBody({ projectId: 'p', designFile: { designFileId: 'd' }, source, requireBaseRevision: true, frames: [], coordinateMode: true }));
});
