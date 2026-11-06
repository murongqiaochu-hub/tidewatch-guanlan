// MODEL-SDK + MODEL-DOM; actual independent createPlatform TCP / Vault FS is separately named.
// No real Figma/browser/device, credentials, upstream QA or production data are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { parsePublicFigmaSource, validateSourceBinding, CHANNEL } from '../插件/protocol.mjs';
import { createProductionSession, readProductionSource, productionPrepareHash } from '../插件/production-session.mjs';
import { createProductionHTTP, validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';
import { startProductionPlugin } from '../插件/main.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { createExporter } from '../插件/exporter.mjs';
import { jsonBytes, sha256 } from '../插件/core.mjs';
import { compileESM } from '../构建/esm-compiler.mjs';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';

const namespace = `src_window_${'a'.repeat(32)}`;
const otherNamespace = `src_window_${'b'.repeat(32)}`;
const key = 'UserConfirmedAbC123';
const binding = (projectId = 'p', fileKey = key) => ({ projectId, inputType: 'key', input: fileKey, confirmedCurrentFile: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Real PNG bytes created solely for this model fixture; not an export from Figma.
function fixturePNG() {
  const chunk = (name, bytes) => { const type = Buffer.from(name); const covered = Buffer.concat([type, bytes]); let crc = 0xffffffff; for (const byte of covered) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); covered.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 255, 255]))), chunk('IEND', Buffer.alloc(0))]));
}
const originalPNG = fixturePNG();
function modelSDK({ fileKey = null, throwing = false, nodeId = '2:1', x = -12.25, y = 5.75 } = {}) {
  const frame = { id: nodeId, type: 'FRAME', name: 'Float frame', width: 1.2, height: 1.1, absoluteBoundingBox: { x, y, width: 1.2, height: 1.1 }, absoluteTransform: [[-1, 0, x], [0, 1, y]], relativeTransform: [[-1, 0, x], [0, 1, y]], children: [], exportSettings: [{ format: 'PNG' }], async exportAsync() { return originalPNG; } };
  const page = { id: '1:1', name: 'Page', children: [frame], selection: [frame] };
  const sdk = { editorType: 'figma', root: { id: 'notAFileKey', name: 'Not a file identity', children: [page] }, currentPage: page, mixed: Symbol('MODEL-SDK') };
  Object.defineProperty(sdk, 'fileKey', { configurable: true, get() { if (throwing) throw new Error('public getter unavailable'); return fileKey; } });
  for (const object of [sdk, sdk.root, page, frame]) for (const method of ['setPluginData', 'setSharedPluginData', 'getPluginData', 'getSharedPluginData', 'setRelaunchData', 'createFrame', 'createPage']) Object.defineProperty(object, method, { get() { assert.fail(`write/derived identity API accessed: ${method}`); } });
  return { sdk, frame, page };
}
function memoryAdapter(overrides = {}) {
  const calls = []; let count = 0, intents = 0, operation = null; const sessions = new Map(), batches = new Map();
  const adapter = {
    async projects() { return [{ id: 'p', name: 'P', permissions: { canPublish: true } }]; },
    async intent(projectId) { return { projectId, operationId: `op_${(++intents).toString(16).padStart(32, '0')}_${'a'.repeat(64)}` }; },
    async claim(input) { operation = { ...input, status: 'open' }; return operation; },
    async queryOperation(op) { return { ...operation, operationId: op, status: 'open', batches: [...batches.values()] }; },
    async finish() { return { ...operation, status: 'completed', remainingFrameIds: [] }; },
    async cancelOperation() { return { ...operation, status: 'cancelled', lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: operation.frameIds }; },
    async publishSource(projectId, body) { calls.push(['source', structuredClone(body)]); return { projectId, source: body.source, designFileId: 'server-file', baseRevisions: Object.fromEntries(body.frameIds.map(id => [id, null])) }; },
    async prepare(body, operationId, batchIndex) { calls.push(['prepare', structuredClone(body)]); const sessionId = `sid-${++count}`; const frames = body.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: 'server-frame', status: 'new', missingAssetSha256: [] })); sessions.set(sessionId, frames); const requestHash = await productionPrepareHash(body, operationId, batchIndex, webcrypto); const prepareResult = { sessionId, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex, requestHash, designFileId: 'server-file', maxUploadBytes: 1024 * 1024, uploadPolicy: { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 25 * 1024 * 1024 }, missingAssetSha256: [], frames }; batches.set(sessionId, { sessionId, operationId, batchIndex, requestHash, prepareResult }); return prepareResult; },
    async upload(_sid, asset) { calls.push(['upload', asset]); return { ok: true, sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime }; },
    async commit(sessionId) { calls.push(['commit', sessionId]); return { sessionId, status: 'committed', frames: sessions.get(sessionId).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: 'server-revision', status: 'new' })) }; },
    async queryCommitResult(sessionId) { calls.push(['result', sessionId]); return { sessionId, status: 'committed', frames: sessions.get(sessionId).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: 'server-revision', status: 'new' })) }; },
    async query(sessionId) { calls.push(['query', sessionId]); const meta = batches.get(sessionId); return { sessionId, status: 'open', expiresAt: meta ? null : '2099-01-01T00:00:00.000Z', ...(meta ? { operationId: meta.operationId, batchIndex: meta.batchIndex, requestHash: meta.requestHash, automaticExpiry: false } : {}), uploaded: [], uploadPolicy: meta ? { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 25 * 1024 * 1024 } : {}, frames: (sessions.get(sessionId) || []).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, status: f.status })) }; },
    async abort(sessionId) { calls.push(['abort', sessionId]); return { sessionId, status: 'aborted' }; },
    // Model receipt only; the compiled local platform test exercises real GETs.
    async verifyPublication(projectId, groupId, frames) {
      calls.push(['verify', projectId, groupId, structuredClone(frames)]); assert.equal(projectId, 'p');
      for (const frame of frames) {
        assert.ok([...sessions.values()].flat().some(f => f.figmaNodeId === frame.figmaNodeId && f.frameId === frame.frameId));
        assert.equal(frame.revisionId, 'server-revision');
      }
      return { projectId, groupId, frameCount: frames.length, catalogReadVersion: `${'a'.repeat(32)}:1` };
    }, ...overrides
  };
  return { adapter, calls };
}
const sessionFor = (sdk, adapter, extra = {}) => createProductionSession({ sdk, adapter, namespace, cryptoAPI: webcrypto, ...extra });

test('MODEL pure parse: exact public file/design links and explicit alnum key preserve case', () => {
  for (const link of [`https://figma.com/file/${key}`, `https://www.figma.com/design/${key}/%E4%B8%AD?node-id=2-1#view`, `https://figma.com/design/${key}/`]) assert.deepEqual(parsePublicFigmaSource(link, 'url'), { kind: 'figma-file', fileKey: key });
  for (const raw of ['A', 'a'.repeat(128), 'AbC0123']) assert.equal(parsePublicFigmaSource(raw, 'key').fileKey, raw);
  assert.equal(parsePublicFigmaSource('aBc', 'key').fileKey, 'aBc');
});
test('MODEL pure parse: reject userinfo, nonHTTPS, evil suffix, fake platform IDs, controls and invalid encoding', () => {
  const badLinks = ['http://figma.com/design/AbC', 'https://figma.com.evil/design/AbC', 'https://evilfigma.com/file/AbC', 'https://figma.com@evil.example/file/AbC', 'https://user@figma.com/file/AbC', 'https://figma.com:443/file/AbC', 'https://www.figma.com/files/AbC', 'https://figma.com/proto/AbC', 'https://figma.com/design/Ab%43', 'https://figma.com/design/AbC/%', 'https://figma.com/design/AbC/%C0%AF', 'https://figma.com/design/AbC/%0A', 'https://figma.com/design/AbC/%5c', 'https://figma.com/design/AbC\n', ' https://figma.com/design/AbC', 'https://figma.com//design/AbC', 'https://figma.com/design/AbC/../../design/Other', 'https://figma.com/design/AbC/%2e%2e/Other', 'https://figma.com/design/AbC/./Title', 'https://figma.com/design/AbC/%3f/../../design/Other', 'https://figma.com/design/' + 'a'.repeat(129), 'https://figma.com/design/a_b', 'https://figma.com/design/a-b'];
  for (const link of badLinks) assert.throws(() => parsePublicFigmaSource(link, 'url'), { code: 'BAD_SCHEMA' }, link);
  for (const raw of ['', 'a'.repeat(129), 'platform-uuid', '550e8400-e29b-41d4-a716-446655440000', '2:1', 'a_b', 'Ab C', 'a\u0000', 'a\u0085', '%41', 'https://figma.com/file/A']) assert.throws(() => parsePublicFigmaSource(raw, 'key'), { code: 'BAD_SCHEMA' });
  assert.throws(() => parsePublicFigmaSource(key, 'auto')); assert.throws(() => parsePublicFigmaSource({}, 'key'));
});
test('MODEL strict binding RPC schema refuses missing checkbox, bad types, project IDs and extra identity/auth fields', () => {
  assert.deepEqual(validateSourceBinding(binding()), { kind: 'figma-file', fileKey: key });
  for (const operation of ['production-source-binding', 'production-source-recovery']) {
    validateProductionOperation(operation, binding());
    for (const value of [{ ...binding(), confirmedCurrentFile: false }, { ...binding(), confirmedCurrentFile: 'true' }, { ...binding(), projectId: '../p' }, { ...binding(), fileKey: key }, { ...binding(), token: 'not-auth' }, { ...binding(), input: 123 }, { projectId: 'p', inputType: 'key', input: key }]) assert.throws(() => validateProductionOperation(operation, value));
    assert.throws(() => validateProductionOperationResult(operation, { state: {}, extra: true }));
  }
});
test('MODEL-SDK public getter missing/throwing safely falls back; real SDK source is compatible and manual cannot override it', async () => {
  for (const throwing of [false, true]) { const { sdk } = modelSDK({ throwing }); assert.deepEqual(readProductionSource(sdk, namespace), { kind: 'plugin-launch', namespace }); }
  const missing = modelSDK().sdk; delete missing.fileKey; assert.equal(missing.fileKey, undefined); assert.deepEqual(readProductionSource(missing, namespace), { kind: 'plugin-launch', namespace });
  const { sdk } = modelSDK({ fileKey: 'SDK_Compatible-Key' }); const { adapter, calls } = memoryAdapter(); const session = sessionFor(sdk, adapter);
  assert.deepEqual(session.source, { kind: 'figma-file', fileKey: 'SDK_Compatible-Key' });
  await assert.rejects(session.bindSource(binding()), { code: 'BAD_SCHEMA' }); await session.publish({ projectId: 'p' });
  assert.equal(calls.find(c => c[0] === 'source')[1].source.fileKey, 'SDK_Compatible-Key'); assert.equal(session.status().sourceBinding.manualAvailable, false);
  Object.defineProperty(sdk, 'fileKey', { get() { throw new Error('temporarily unavailable after trusted capture'); } });
  assert.equal(session.status().sourceBinding.manualAvailable, false); await assert.rejects(session.bindSource(binding()), { code: 'BAD_SCHEMA' }); await session.publish({ projectId: 'p' });
  assert.equal(calls.filter(c => c[0] === 'source').at(-1)[1].source.fileKey, 'SDK_Compatible-Key');
});
test('MODEL-SDK explicit RAM binding is stable across tasks, no write APIs, and another launch does not remember it', async () => {
  const { sdk, frame } = modelSDK({ throwing: true }); const before = JSON.stringify(frame); const { adapter, calls } = memoryAdapter(); let journalCalls = 0;
  const session = sessionFor(sdk, adapter, { journal: async () => { journalCalls++; } }); await session.bindSource(binding()); assert.equal(journalCalls, 0);
  await session.publish({ projectId: 'p' }); await session.publish({ projectId: 'p' }); assert.equal(JSON.stringify(frame), before);
  assert.deepEqual(calls.filter(c => c[0] === 'source').map(c => c[1].source), [{ kind: 'figma-file', fileKey: key }, { kind: 'figma-file', fileKey: key }]);
  const fresh = sessionFor(modelSDK().sdk, adapter, { namespace: otherNamespace }); assert.deepEqual(fresh.source, { kind: 'plugin-launch', namespace: otherNamespace });
  await assert.rejects(session.publish({ projectId: 'another-project' }), { code: 'DOCUMENT_CHANGED' });
});
test('MODEL state lock rejects all unsettled/unknown source changes and preserves source through physical cancellation', async () => {
  for (const phase of ['authorizing', 'resolvingSource', 'exporting', 'preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare']) {
    const { adapter } = memoryAdapter(); const s = sessionFor(modelSDK().sdk, adapter); s.restore({ phase, sessionId: phase === 'unknownPrepare' ? null : 'original-sid', source: { kind: 'plugin-launch', namespace }, projectId: 'p', preparedFrames: [] });
    await assert.rejects(s.bindSource(binding())); assert.deepEqual(s.source, { kind: 'plugin-launch', namespace });
  }
  const { adapter } = memoryAdapter(); const entered = deferred(); const release = deferred(); const controller = new AbortController();
  const s = sessionFor(modelSDK().sdk, adapter, { exporter: { async exportFrames() { entered.resolve(); await release.promise; throw Object.assign(new Error(), { code: 'CANCELLED' }); } } });
  await s.bindSource(binding()); const task = s.publish({ projectId: 'p' }, { signal: controller.signal }); const done = assert.rejects(task, { code: 'CANCELLED' }); await entered.promise; controller.abort();
  await assert.rejects(s.bindSource(binding('p', 'OtherKey')), { code: 'BUSY' }); assert.equal(s.status().busy, true); release.resolve(); await done; await assert.rejects(s.bindSource(binding('p', 'OtherKey')), { code: 'UNKNOWN_COMMIT' }); await s.abort(); await s.bindSource(binding('p', 'OtherKey')); assert.equal(s.source.fileKey, 'OtherKey');
});
test('MODEL recovery preserves original normalized source, rejects forged source and known SDK document mismatch on commit mapping', async () => {
  const { adapter } = memoryAdapter(); const sdk = modelSDK({ fileKey: 'CurrentSDKKey' }).sdk; const s = sessionFor(sdk, adapter);
  s.restore({ phase: 'committing', sessionId: 'original-sid', source: { kind: 'figma-file', fileKey: 'OriginalKey' }, projectId: 'p', preparedFrames: [] });
  assert.equal(s.status().phase, 'unknownCommit'); assert.equal(s.source.fileKey, 'OriginalKey'); await assert.rejects(s.bindSource(binding()));
  const restored = sessionFor(sdk, adapter); restored.restore({ phase: 'committed', sessionId: 'original-sid', source: { kind: 'figma-file', fileKey: 'OriginalKey' }, projectId: 'p', preparedFrames: [] });
  await assert.rejects(restored.recoverCommit(), { code: 'DOCUMENT_CHANGED' });
  for (const source of [{ kind: 'figma-file', fileKey: '../bad' }, { kind: 'figma-file', fileKey: 'x', projectId: 'forged' }, { kind: 'plugin-launch', namespace: 'name-derived' }]) assert.throws(() => sessionFor(modelSDK().sdk, adapter).restore({ phase: 'unknownCommit', sessionId: 'sid', source }));
});

async function rpcPair(t, { sdk = modelSDK().sdk, adapter = memoryAdapter().adapter, stored = new Map(), writer = namespace } = {}) {
  const listeners = new Set(); let ui; let count = 0; let shown = 0; const writes = [];
  sdk.showUI = () => { shown++; }; sdk.closePlugin = () => {};
  sdk.clientStorage = { async keysAsync() { return [...stored.keys()]; }, async getAsync(k) { return structuredClone(stored.get(k)); }, async setAsync(k, v) { writes.push(structuredClone(v)); stored.set(k, structuredClone(v)); }, async deleteAsync(k) { stored.delete(k); } };
  sdk.ui = { on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); }, resize() {}, postMessage(message) { queueMicrotask(() => { void ui.receive(message, { main: true }); }); } };
  const main = startProductionPlugin(sdk, '<html>MODEL</html>', { production: { serviceOrigin: 'https://service.example' } });
  ui = createBridge({ channel: CHANNEL, send(message) { queueMicrotask(() => { for (const fn of listeners) fn(message, { origin: 'null' }); }); }, subscribe: () => () => {}, trustedPeer: peer => peer.main === true, makeRequestId: () => `public-ui-${++count}`, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult,
    handlers: { async digest(p) { return { digest: new Uint8Array(await webcrypto.subtle.digest('SHA-256', p.bytes)) }; }, notice() { return { accepted: true }; }, async 'production-network'(p, c) { try { return { ok: true, value: await adapter[p.method](...p.args, c) }; } catch (e) { return { ok: false, error: { code: e.code || 'HTTP_FAILED', status: e.status || null, dispatched: true } }; } } }
  });
  t.after(async () => { await main.dispose(); await ui.close(); });
  const command = (action, payload = {}) => ui.request('production-control', { action, ...payload });
  await ui.request('hello', {});
  await command('connect', { service: { origin: 'https://service.example', allowLocalhost: false }, namespace: writer });
  return { main, ui, command, stored, writes, shown: () => shown };
}
test('C34 main RPC keeps manual file key/URL in RAM and never auto-recovers an unknown finish after restart', async t => {
  const { adapter, calls } = memoryAdapter({ async commit(sid) { calls.push(['commit-lost', sid]); throw Object.assign(new Error(), { code: 'HTTP_FAILED' }); }, async recoverCancel(op, project) { calls.push(['recover-cancel-denied', op, project]); throw Object.assign(new Error(), { code: 'HTTP_FAILED', status: 403 }); } });
  const pair = await rpcPair(t, { adapter }); const url = `https://figma.com/design/${key}/OwnFile`;
  assert.equal(await pair.main.bridge.receive({ v: 1, channel: CHANNEL, kind: 'request', requestId: 7, operation: 'production-source-binding', payload: binding() }, { officialUI: true, origin: 'null' }), false);
  assert.throws(() => pair.ui.request('production-source-binding', binding(), { requestId: '../bad' }));
  await pair.ui.request('production-source-binding', { ...binding(), inputType: 'url', input: url });
  assert.equal(pair.writes.length, 0);
  await assert.rejects(pair.command('publish', { projectId: 'p', scope: 'selection', scale: 1, includeSlices: true, chunkCapacity: 16 }), { code: 'UNKNOWN_COMMIT' });
  const inMemory = pair.main.status().publisher;
  assert.equal(inMemory.phase, 'unknownCommit'); assert.equal(inMemory.locked, false, 'C34 releases only the local lock after physical completion; restart still retires history without server recovery');
  const serialized = JSON.stringify([...pair.stored]); assert.equal(serialized.includes(key), false); assert.equal(serialized.includes(url), false); assert.equal(pair.writes.length, 0);
  const beforeRestart = calls.length;
  const reopened = await rpcPair(t, { adapter, stored: pair.stored, sdk: modelSDK({ throwing: true }).sdk, writer: otherNamespace });
  const fresh = (await reopened.command('status')).state;
  assert.equal(fresh.phase, 'idle'); assert.equal(fresh.locked, false); assert.equal(fresh.sourceBinding.mode, 'launch');
  assert.equal(JSON.stringify([...reopened.stored]).includes(key), false); assert.equal(JSON.stringify([...reopened.stored]).includes(url), false);
  assert.equal(calls.length, beforeRestart, 'startup must not query, abort, or replay the unknown operation');
  assert.equal(calls.some(call => ['query', 'abort', 'recover-cancel-denied'].includes(call[0])), false);
  assert.equal(reopened.writes.length, 0);
});
test('MODEL old journal without operation identity remains read-only and cannot infer cancellation', async () => {
  const { adapter, calls } = memoryAdapter(); const s = sessionFor(modelSDK().sdk, adapter); s.restore({ phase: 'committing', sessionId: 'old-sid', projectId: 'p', preparedFrames: [] });
  assert.equal(s.source, null); await assert.rejects(s.confirmRecoverySource(binding()), { code: 'BAD_SCHEMA' }); await assert.rejects(s.bindSource(binding()));
  await s.query(); assert.equal(s.status().locked, true); assert.equal(s.source, null); await assert.rejects(s.abort(), { code: 'UNKNOWN_COMMIT' }); await assert.rejects(s.bindSource(binding())); assert.equal(calls.filter(c => c[0] === 'prepare').length, 0); assert.equal(calls.some(c => c[0] === 'abort'), false);
});

// Minimal DOM event model, not Chromium and not a visual acceptance claim.
class ModelElement {
  constructor(doc, name = '', tag = 'div') { this.doc = doc; this.id = name; this.tagName = tag.toUpperCase(); this.nodeType = tag.toLowerCase() === 'fragment' ? 11 : 1; this.children = []; this.parentNode = null; this.events = new Map(); this.attributes = new Map(); this.dataset = {}; const properties = new Map(); this.style = { setProperty(name, value) { properties.set(name, String(value)); }, getPropertyValue(name) { return properties.get(name) || ''; } }; this._hidden = false; this._disabled = false; this._text = ''; this.value = ''; this.checked = false; }
  set textContent(v) { this._text = String(v); this.doc.changed(); } get textContent() { return this._text; }
  set hidden(v) { this._hidden = Boolean(v); this.doc.changed(); } get hidden() { return this._hidden; }
  set disabled(v) { this._disabled = Boolean(v); this.doc.changed(); } get disabled() { return this._disabled; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); } getAttribute(k) { return this.attributes.get(k); }
  addEventListener(type, fn) { const list = this.events.get(type) || []; list.push(fn); this.events.set(type, list); }
  removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(f => f !== fn)); }
  dispatch(type, extra = {}) { const event = { isTrusted: true, preventDefault() {}, stopPropagation() { this.stopped = true; }, target: this, ...extra }; for (let node = this; node && !event.stopped; node = node.parentNode || (node === this.doc ? null : this.doc)) { event.currentTarget = node; for (const fn of node.events.get(type) || []) fn(event); } }
  focus() { this.doc.activeElement = this; } contains(other) { return this === other || this.children.some(child => child.contains?.(other)); }
  removeChild(node) { const index = this.children.indexOf(node); if (index < 0) throw new Error('Node is not a child'); this.children.splice(index, 1); if (node.parentNode === this) node.parentNode = null; this.doc.changed(); return node; }
  insertBefore(node, referenceNode = null) { if (referenceNode !== null && referenceNode.parentNode !== this) throw new Error('Reference node is not a child'); if (node === referenceNode) return node; if (node.nodeType === 11) { for (const child of [...node.children]) this.insertBefore(child, referenceNode); return node; } node.parentNode?.removeChild(node); const index = referenceNode === null ? this.children.length : this.children.indexOf(referenceNode); if (index < 0) throw new Error('Reference node is not a child'); this.children.splice(index, 0, node); node.parentNode = this; this.doc.changed(); return node; }
  before(...nodes) { const parent = this.parentNode; if (!parent) return; for (const node of nodes) parent.insertBefore(node, this); }
  append(...items) { for (const item of items) this.insertBefore(item, null); if (this.tagName === 'SELECT' && !this.value) this.value = items[0]?.value || ''; }
  replaceChildren(...items) { for (const child of [...this.children]) this.removeChild(child); this._text = ''; this.append(...items); if (this.tagName === 'SELECT') this.value = items[0]?.value || ''; }
}
function verifyInsertionSemantics(makeNode) { const parent = makeNode('section'), oldParent = makeNode('aside'), first = Object.assign(makeNode('i'), { label: 'first' }), reference = Object.assign(makeNode('b'), { label: 'reference' }), tail = Object.assign(makeNode('i'), { label: 'tail' }), moved = Object.assign(makeNode('button'), { label: 'moved' }), other = Object.assign(makeNode('span'), { label: 'other' }); parent.append(first, reference, tail); oldParent.append(moved, other); parent.insertBefore(moved, reference); assert.deepEqual(parent.children.map(node => node.label), ['first', 'moved', 'reference', 'tail']); assert.deepEqual(oldParent.children.map(node => node.label), ['other']); assert.equal(moved.parentNode, parent); parent.insertBefore(tail, first); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'reference']); parent.insertBefore(reference, reference); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'reference']); oldParent.append(moved); reference.before(moved, other); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'other', 'reference']); assert.deepEqual(oldParent.children, []); assert.equal(moved.parentNode, parent); assert.equal(other.parentNode, parent); const last = Object.assign(makeNode('i'), { label: 'last' }); parent.insertBefore(last, null); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'other', 'reference', 'last']); }
test('MODEL DOM fixture: insertBefore/before preserve order and reparent nodes', () => verifyInsertionSemantics(tag => new ModelElement({ changed() {} }, '', tag)));
class ModelDocument {
  constructor(html) {
    this.nodes = new Map(); this.watchers = new Set(); this.events = new Map();
    const stack = []; const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
    for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
      const tag = match[1].toLowerCase();
      if (match[0].startsWith('</')) { while (stack.length && stack.pop().tagName !== tag.toUpperCase()) {} continue; }
      const id = /\bid="([^"]+)"/.exec(match[0])?.[1] || '';
      const element = new ModelElement(this, id, tag); element._hidden = /(?:\s|^)hidden(?:\s|>|=)/.test(match[0]);
      if (id) this.nodes.set(id, element);
      if (stack.length) { element.parentNode = stack.at(-1); stack.at(-1).children.push(element); }
      if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(element);
    }
    this.getElementById('scope').value = 'selection'; this.getElementById('scale').value = '1'; this.getElementById('slices').checked = true;
  }
  changed() { queueMicrotask(() => { for (const fn of [...this.watchers]) fn(); }); }
  addEventListener(type, fn) { const list = this.events.get(type) || []; list.push(fn); this.events.set(type, list); }
  removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(listener => listener !== fn)); }
  getElementById(id) { const node = this.nodes.get(id); assert.ok(node, `MODEL DOM missing ${id}`); return node; }
  createElement(tag) { return new ModelElement(this, '', tag); }
  createElementNS(namespace, tag) { const node = this.createElement(tag); node.namespaceURI = namespace; return node; }
  querySelector(query) { if (query.includes('figma-parent-origin')) return { content: 'https://www.figma.com' }; if (query.includes('independent-production')) return { content: 'enabled' }; return null; }
  querySelectorAll() { return []; }
  until(predicate, label = 'MODEL DOM action', timeoutMs = 8000) { return new Promise((resolve, reject) => { const check = () => { try { if (!predicate()) return; clearTimeout(timer); this.watchers.delete(check); resolve(); } catch (error) { clearTimeout(timer); this.watchers.delete(check); reject(error); } }; const timer = setTimeout(() => { this.watchers.delete(check); reject(new Error(`timeout: ${label}; status=${this.getElementById('status').textContent}`)); }, timeoutMs); this.watchers.add(check); check(); }); }
}
function assertQuotaPlacement(doc) { const page = doc.getElementById('production-project-page'), searchParent = doc.getElementById('production-project-search').parentNode, pageIndex = page.children.indexOf(searchParent), error = doc.getElementById('production-create-error'), errorIndex = error.parentNode.children.indexOf(error); assert.ok(searchParent && pageIndex > 0); assert.equal(page.children[pageIndex - 1].dataset.accountQuota, 'true'); assert.ok(error.parentNode && errorIndex > 0); assert.equal(error.parentNode.children[errorIndex - 1].dataset.accountQuota, 'true'); }
function wireClone(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(wireClone);
  if (value && typeof value === 'object') { const output = Object.create(null); for (const [k, v] of Object.entries(value)) output[k] = wireClone(v); return output; }
  return value;
}
const root = fileURLToPath(new URL('..', import.meta.url));
async function compiledPair(t, { origin, storage = new Map(), sources, html, requests = [], noSubtle = false, nodeId = '2:1', x = -12.25, y = 5.75 }) {
  const doc = new ModelDocument(html); const listeners = new Set(); const windowListeners = new Set(); let shown = 0;
  const { sdk, frame } = modelSDK({ throwing: true, nodeId, x, y });
  for (const name of ['absoluteBoundingBox']) frame[name] = wireClone(frame[name]);
  sdk.showUI = () => { shown++; }; sdk.closePlugin = () => {};
  sdk.clientStorage = { async keysAsync() { return [...storage.keys()]; }, async getAsync(k) { return wireClone(storage.get(k)); }, async setAsync(k, v) { storage.set(k, wireClone(v)); } };
  const parent = { postMessage(data, target) { assert.equal(target, '*'); queueMicrotask(() => { for (const fn of listeners) fn(wireClone(data.pluginMessage), { origin: 'null' }); }); } };
  sdk.ui = { on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); }, resize() {}, postMessage(message, options) { assert.equal(options.origin, '*'); queueMicrotask(() => { const event = { source: parent, origin: 'https://www.figma.com', data: wireClone({ pluginMessage: message }) }; for (const fn of windowListeners) fn(event); }); } };
  const fetchAPI = async (url, options) => {
    const response = await fetch(url, options); const pathname = new URL(url).pathname;
    if (/publish-source|\/api\/publish\/(?:sessions|operations|intent)/.test(pathname)) {
      let recorded = {};
      if (options.headers['Content-Type'] === 'application/json') {
        const { writerSecret: _redacted, ...safe } = JSON.parse(typeof options.body === 'string' ? options.body : new TextDecoder().decode(options.body));
        recorded = { body: safe };
      } else if (options.body instanceof Uint8Array) {
        const framed = options.body.length >= 36 && [71, 76, 80, 49].every((byte, index) => options.body[index] === byte);
        const asset = framed ? options.body.subarray(36) : options.body;
        recorded = { rawSHA: hash(asset), rawBytes: asset.length, mime: options.headers['X-Asset-Mime'] };
      }
      const entry = { method: options.method, pathname, status: response.status, ...recorded };
      if (!response.ok) { const error = await response.clone().json(); entry.errorCode = error.error?.code; t.diagnostic(`REAL-HTTP failure ${entry.method} ${pathname} ${entry.status} ${entry.errorCode}`); }
      if (response.ok && pathname.endsWith('/publish-source')) entry.response = await response.clone().json();
      requests.push(entry);
    }
    return response;
  };
  const win = { parent, crypto: noSubtle ? {getRandomValues:webcrypto.getRandomValues.bind(webcrypto)} : webcrypto, AbortController, URL, TextEncoder, TextDecoder, fetch: fetchAPI, setTimeout, clearTimeout, addEventListener(event, fn) { if (event === 'message') windowListeners.add(fn); }, removeEventListener(_event, fn) { windowListeners.delete(fn); } };
  const mainContext = vm.createContext({ Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout, console });
  const uiContext = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, URL, AbortController, btoa, setTimeout, clearTimeout, console });
  const mainExports = vm.runInContext(compileESM(sources, '插件/main.mjs').code, mainContext, { timeout: 2000 });
  const uiExports = vm.runInContext(compileESM(sources, '插件/ui.mjs').code, uiContext, { timeout: 2000 });
  const main = mainExports.startProductionPlugin(sdk, html, { production: { serviceOrigin: origin, allowLocalhost: true } });
  const ui = uiExports.mountPluginUI(win, doc); t.after(async () => { await ui.dispose(); await main.dispose(); }); await ui.ready;
  assertQuotaPlacement(doc);
  assert.equal(shown, 1); assert.equal(listeners.size, 1); assert.equal(windowListeners.size, 1); assert.equal(vm.runInContext('typeof URL + ":" + typeof TextEncoder + ":" + typeof crypto', mainContext), 'undefined:undefined:undefined');
  return { doc, main, ui, sdk, frame, storage, requests, shown: () => shown };
}
async function ownedPlatform(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'independent-public-source-')); await fs.chmod(directory, 0o700);
  const canonical = await fs.realpath(directory); const nonce = randomBytes(16).toString('hex'); const marker = { kind: 'MODEL-REAL-HTTP-FS-public-source-test', canonical, uid: process.getuid(), nonce };
  await fs.writeFile(path.join(canonical, 'OWNED.json'), JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  const password = `Synthetic-${randomBytes(18).toString('hex')}`, secret = randomBytes(48);
  const seed = await createPlatform({ dataDir: canonical, secret, bootstrapAdmin: { username: 'admin', password }, logger: { error() {} } });
  await seed.listen(0); await seed.close();
  const backing = await openVault({ dataDir: canonical });
  const vault = { ...backing, get catalog() { return backing.catalog; }, get readVersion() { return backing.readVersion; },
    async discardStaged() { return { removed: false, reason: 'fixture_retains_data' }; } };
  const app = await createPlatform({ dataDir: canonical, vault, secret, logger: { error() {} } });
  const address = await app.listen(0); const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    const resolved = await fs.realpath(canonical); const actual = JSON.parse(await fs.readFile(path.join(resolved, 'OWNED.json'), 'utf8')); const stat = await fs.lstat(resolved);
    assert.equal(resolved, canonical); assert.equal(stat.uid, process.getuid()); assert.equal(stat.isSymbolicLink(), false); assert.deepEqual(actual, marker); assert.ok(path.basename(resolved).startsWith('independent-public-source-')); assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    t.diagnostic(`Retained isolated test directory: ${resolved}`);
  });
  const client = createProductionHTTP({ origin, allowLocalhost: true, cryptoAPI: webcrypto }); const login = await client.login({ username: 'admin', password });
  const response = await fetch(origin + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic explicit-source project' }) }); assert.equal(response.status, 201); const project = await response.json();
  return { app, client, origin, password, project, canonical };
}
for (const noSubtle of [false, true]) test(`MODEL-SDK + MODEL-DOM compiled main/UI clicks -> REAL-HTTP/FS: launch sources share project xy despite distinct node IDs; 1px differs; exact historical assets; missing crypto.subtle=${noSubtle}`, async t => {
  const real = await ownedPlatform(t); const names = ['core', 'portable-sha256', 'exporter', 'publisher', 'bridge', 'protocol', 'resize', 'publication-visibility', 'publication-snapshot', 'production-protocol', 'production-session', 'pending-journal', 'main', 'ui'];
  const sources = new Map(await Promise.all(names.map(async n => [`插件/${n}.mjs`, await fs.readFile(path.join(root, `插件/${n}.mjs`), 'utf8')]))); const html = await fs.readFile(path.join(root, '插件/ui.html'), 'utf8');
  const storage = new Map();
  const loginUI = async pair => {
    const $ = id => pair.doc.getElementById(id); $('production-username').value = 'admin'; $('production-password').value = real.password; $('production-login-form').dispatch('submit');
    await pair.doc.until(() => $('production-login-form').hidden && (pair.main.status().publisher.phase === 'verificationPending' || !$('publish').disabled), 'real login and restored task state');
    if (pair.main.status().publisher.phase === 'verificationPending') {
      assert.equal($('publish').disabled, true); assert.equal(pair.main.status().publisher.verified, false);
      await pair.doc.until(() => !$('query').disabled, 'original session query available after login');
      const before = pair.requests.filter(r => ['POST', 'PUT'].includes(r.method)).length;
      $('query').dispatch('click');
      await pair.doc.until(() => pair.main.status().publisher.phase === 'committed' && pair.main.status().publisher.verified === true && !$('publish').disabled, 'explicit read-only re-verification');
      assert.equal(pair.requests.filter(r => ['POST', 'PUT'].includes(r.method)).length, before);
    }
    assert.equal($('publish').disabled, false); assert.equal($('production-password').value, ''); return $;
  };
  const publish = async (pair, $, label) => { assert.equal($('publish').disabled, false); $('publish').dispatch('click', { isTrusted: false }); assert.equal(pair.requests.filter(r => r.pathname.endsWith('/publish-source')).length, 0, 'synthetic click cannot publish'); $('publish').dispatch('click'); try { await pair.doc.until(() => pair.main.status().publisher.phase === 'committed' && !$('publish').disabled, label); } catch (error) { const s = pair.main.status().publisher; t.diagnostic(`MODEL failure phase=${s.phase} code=${s.error} http=${s.httpStatus} requests=${JSON.stringify(pair.requests.map(({method, pathname, status}) => ({method, pathname, status})))}`); throw error; } return pair.main.status().publisher; };
  const first = await compiledPair(t, { origin: real.origin, storage, sources, html, noSubtle }); const $ = await loginUI(first);
  for (const removed of ['production-source-binding', 'production-raw-source', 'production-source-url', 'production-source-key', 'production-bind-source', 'production-bind-key']) assert.equal(first.doc.nodes.has(removed), false, `removed UI control ${removed}`);
  const frameBefore = JSON.stringify(first.frame); const beforeExport = await createExporter(modelSDK().sdk, { cryptoAPI: webcrypto }).exportSelection();
  const firstState = await publish(first, $, 'first launch-source HTTP commit'); assert.equal(JSON.stringify(first.frame), frameBefore);
  assert.equal($('progress-ring').style.getPropertyValue('--progress-angle'), '360deg');
  const firstFrame = firstState.completed[0].frames[0]; const catalog = real.app.vault.catalog;
  assert.equal(catalog.designFiles.length, 1); const firstFileId = catalog.designFiles[0].id; assert.equal(catalog.designFiles[0].figmaFileKey ?? null, null); assert.equal(firstState.designFileId, firstFileId);
  const firstSession = catalog.publishSessions.find(s => s.id === firstState.sessionId); assert.equal(firstSession.projectId, real.project.id); assert.equal(firstSession.designFileId, firstFileId); assert.equal(firstSession.coordinateMode, 'project-xy');
  const firstSourceWire = first.requests.find(r => r.pathname.endsWith('/publish-source')); const firstPrepareWire = first.requests.find(r => r.method === 'POST' && r.pathname === '/api/publish/sessions');
  assert.equal(firstSourceWire.status, 200); assert.equal(firstSourceWire.body.source.kind, 'plugin-launch'); assert.match(firstSourceWire.body.source.namespace, /^src_window_[a-f0-9]{32}$/); assert.equal(firstSourceWire.body.source.fileKey, undefined);
  assert.deepEqual(firstSourceWire.body.frameIds, ['2:1']); assert.deepEqual(firstSourceWire.body.coordinates, [{ frameId: '2:1', x: -12.25, y: 5.75 }]); assert.equal(firstSourceWire.response.coordinateMode, 'project-xy'); assert.equal(firstSourceWire.response.baseRevisions['2:1'], null);
  assert.deepEqual(firstPrepareWire.body.source, firstSourceWire.body.source); assert.equal(firstPrepareWire.body.coordinateMode, 'project-xy'); assert.equal(firstPrepareWire.body.projectId, real.project.id); assert.equal(firstPrepareWire.body.designFile.designFileId, firstFileId);
  const firstManifest = firstSession.items[0].manifest; assert.equal(firstManifest.baseRevisionId, null); assert.deepEqual([firstManifest.x, firstManifest.y, firstManifest.width, firstManifest.height], [-12.25, 5.75, 1.2, 1.1]);
  const docAsset = catalog.assets.find(a => a.sha256 === firstManifest.layerDocSha256); const pngAsset = catalog.assets.find(a => a.sha256 === firstManifest.previewSha256);
  const rawDoc = await real.app.vault.readOriginal(docAsset); const rawPNG = await real.app.vault.readOriginal(pngAsset);
  assert.equal(hash(rawDoc), firstManifest.layerDocSha256); assert.equal(hash(rawPNG), hash(originalPNG)); assert.deepEqual([...rawPNG], [...originalPNG]);
  assert.deepEqual([...rawDoc], [...beforeExport.frames[0].bytes]); assert.equal(firstManifest.layerDocSha256, beforeExport.frames[0].sha256);
  assert.deepEqual(JSON.parse(rawDoc).frame.absoluteBoundingBox, { x: -12.25, y: 5.75, width: 1.2, height: 1.1 });
  // clientStorage may retain the launch namespace for exact original-session recovery;
  // no source was manually entered, and protected Figma nodes expose only fail-closed write guards.
  const journal = JSON.stringify([...storage]); assert.equal(journal.includes(key), false); assert.equal(journal.includes(`figma.com/design/${key}`), false);
  for (const node of [first.sdk.root, first.frame]) for (const method of ['setPluginData', 'setSharedPluginData', 'setRelaunchData']) {
    const descriptor = Object.getOwnPropertyDescriptor(node, method); assert.equal(typeof descriptor?.get, 'function'); assert.equal(descriptor.set, undefined);
  }
  const second = await compiledPair(t, { origin: real.origin, storage, sources, html, noSubtle, nodeId: '7:9' }); const $2 = await loginUI(second);
  // A second Figma node at identical absolute xy changes its SDK read value only; no pluginData or manual source binding.
  second.frame.opacity = 0.625; const secondBefore = JSON.stringify(second.frame); const secondExport = await createExporter(modelSDK({ nodeId: '7:9' }).sdk, { cryptoAPI: webcrypto }).exportSelection();
  const secondState = await publish(second, $2, 'second independent launch HTTP commit'); assert.equal(JSON.stringify(second.frame), secondBefore);
  const secondFrame = secondState.completed[0].frames[0]; const c2 = real.app.vault.catalog;
  assert.equal(c2.designFiles.length, 2); assert.notEqual(secondState.designFileId, firstFileId); assert.equal(secondFrame.frameId, firstFrame.frameId); assert.notEqual(secondFrame.revisionId, firstFrame.revisionId); assert.equal(c2.frames.length, 1); assert.equal(c2.frameRevisions.length, 2);
  const secondSession = c2.publishSessions.find(s => s.id === secondState.sessionId); assert.equal(secondSession.coordinateMode, 'project-xy'); assert.equal(secondSession.items[0].manifest.baseRevisionId, firstFrame.revisionId);
  const secondSourceWire = second.requests.find(r => r.pathname.endsWith('/publish-source')); const secondPrepareWire = second.requests.find(r => r.method === 'POST' && r.pathname === '/api/publish/sessions');
  assert.equal(secondSourceWire.body.source.kind, 'plugin-launch'); assert.notEqual(secondSourceWire.body.source.namespace, firstSourceWire.body.source.namespace);
  assert.deepEqual(secondSourceWire.body.frameIds, ['7:9']); assert.deepEqual(secondSourceWire.body.coordinates, [{ frameId: '7:9', x: -12.25, y: 5.75 }]); assert.equal(secondSourceWire.response.coordinateMode, 'project-xy'); assert.equal(secondSourceWire.response.baseRevisions['7:9'], firstFrame.revisionId);
  assert.equal(secondPrepareWire.body.coordinateMode, 'project-xy'); assert.deepEqual(secondPrepareWire.body.source, secondSourceWire.body.source); assert.equal(secondPrepareWire.body.designFile.designFileId, secondState.designFileId); assert.equal(secondPrepareWire.body.frames[0].baseRevisionId, firstFrame.revisionId);
  const secondManifest = secondSession.items[0].manifest; const secondDocAsset = c2.assets.find(a => a.sha256 === secondManifest.layerDocSha256); const secondPngAsset = c2.assets.find(a => a.sha256 === secondManifest.previewSha256); const secondRawDoc = await real.app.vault.readOriginal(secondDocAsset);
  assert.equal(hash(secondRawDoc), secondManifest.layerDocSha256); assert.equal(JSON.parse(secondRawDoc).frame.id, '7:9'); assert.notEqual(hash(secondRawDoc), hash(rawDoc)); assert.notDeepEqual([...secondRawDoc], [...secondExport.frames[0].bytes]);
  assert.equal(secondManifest.previewSha256, hash(originalPNG)); assert.deepEqual([...await real.app.vault.readOriginal(secondPngAsset)], [...originalPNG]);
  const third = await compiledPair(t, { origin: real.origin, storage, sources, html, noSubtle, nodeId: '8:10', x: -11.25 }); const $3 = await loginUI(third);
  const thirdBefore = JSON.stringify(third.frame); const thirdState = await publish(third, $3, 'third launch one pixel away HTTP commit'); assert.equal(JSON.stringify(third.frame), thirdBefore);
  const thirdFrame = thirdState.completed[0].frames[0]; const c3 = real.app.vault.catalog; assert.notEqual(thirdFrame.frameId, firstFrame.frameId); assert.equal(c3.frames.length, 2); assert.equal(c3.frameRevisions.length, 3);
  const thirdSourceWire = third.requests.find(r => r.pathname.endsWith('/publish-source')); const thirdPrepareWire = third.requests.find(r => r.method === 'POST' && r.pathname === '/api/publish/sessions');
  assert.deepEqual(thirdSourceWire.body.coordinates, [{ frameId: '8:10', x: -11.25, y: 5.75 }]); assert.equal(thirdSourceWire.response.coordinateMode, 'project-xy'); assert.equal(thirdSourceWire.response.baseRevisions['8:10'], null); assert.equal(thirdPrepareWire.body.coordinateMode, 'project-xy'); assert.equal(thirdPrepareWire.body.frames[0].baseRevisionId, null);
  assert.equal(first.requests.filter(r => r.method === 'PUT' && r.rawSHA === hash(originalPNG)).length, 1); for (const pair of [first, second, third]) assert.equal(pair.requests.filter(r => r.pathname.endsWith('/commit')).length, 1);
  assert.deepEqual([...await real.app.vault.readOriginal(pngAsset)], [...rawPNG]); assert.deepEqual([...await real.app.vault.readOriginal(docAsset)], [...rawDoc]); assert.deepEqual([...await real.app.vault.readOriginal(secondDocAsset)], [...secondRawDoc]);
  const checkModes = async directory => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, entry.name); const stat = await fs.lstat(filename); assert.equal(stat.uid, process.getuid()); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.mode & 0o777, entry.isDirectory() ? 0o700 : 0o600); if (entry.isDirectory()) await checkModes(filename); } };
  await checkModes(real.canonical); assert.equal((await fs.stat(real.canonical)).mode & 0o777, 0o700);
  assert.equal(firstState.sourceProof, null); // Automatic plugin-launch source has no manual binding proof.
});

test('MODEL restored source confirmation requires the exact proof, project and current document identity before any write', async () => {
  const operationId = `op_${'a'.repeat(32)}_${'b'.repeat(64)}`, proof = await sha256(jsonBytes({ kind: 'figma-file', fileKey: key }), webcrypto);
  const saved = { phase: 'unknownCommit', sessionId: 'original-sid', operationId, projectId: 'p', source: { kind: 'figma-file', fileKey: key }, sourceProof: proof, preparedFrames: [] };
  const { adapter, calls } = memoryAdapter();
  const session = sessionFor(modelSDK().sdk, adapter); session.restore(saved);
  assert.equal(session.status().sourceBinding.mode, 'recovery');
  await assert.rejects(session.confirmRecoverySource(binding('wrong-project')), { code: 'BAD_SCHEMA' });
  await assert.rejects(session.confirmRecoverySource(binding('p', 'WrongKey')), { code: 'DOCUMENT_CHANGED' });
  assert.deepEqual(calls, [], 'source confirmation is RAM-only');
  const confirmed = await session.confirmRecoverySource(binding());
  assert.equal(confirmed.state.source.fileKey, key);
  const mismatch = sessionFor(modelSDK({ fileKey: 'CurrentSDKKey' }).sdk, adapter); mismatch.restore(saved);
  await assert.rejects(mismatch.confirmRecoverySource(binding()), { code: 'DOCUMENT_CHANGED' });
});

test('MODEL denied recovery cancellation keeps the original task locked and never reprepares or recommits', async () => {
  const operationId = `op_${'c'.repeat(32)}_${'d'.repeat(64)}`;
  let cancels = 0, prepares = 0, commits = 0;
  const { adapter } = memoryAdapter({
    recoverCancel: async (op, projectId) => { cancels++; assert.equal(op, operationId); assert.equal(projectId, 'p'); throw Object.assign(new Error('denied'), { code: 'HTTP_FAILED', status: 403 }); },
    prepare: async () => { prepares++; throw new Error('must not re-prepare'); },
    commit: async () => { commits++; throw new Error('must not re-commit'); }
  });
  const session = sessionFor(modelSDK().sdk, adapter);
  session.restore({ phase: 'unknownCommit', sessionId: 'original-sid', operationId, projectId: 'p', source: { kind: 'figma-file', fileKey: key }, preparedFrames: [], expectedFrameIds: ['2:1'], total: 1, done: 0, completed: [] });
  await assert.rejects(session.abort(), error => error.status === 403);
  assert.equal(session.status().locked, true); assert.equal(session.status().phase, 'unknownCommit'); assert.equal(session.status().httpStatus, 403);
  assert.deepEqual([cancels, prepares, commits], [1, 0, 0]);
});

test('C34 main RPC exposes no legacy source recovery entry and never journals a recovery attempt', async t => {
  const pair = await rpcPair(t, {});
  await assert.rejects(pair.ui.request('production-source-recovery', binding()), { code: 'BAD_SCHEMA' });
  const bound = await pair.ui.request('production-source-binding', binding());
  assert.equal(bound.state.projectId, 'p');
  assert.deepEqual([...pair.stored.keys()], []);
  assert.deepEqual(pair.writes, [], 'RAM-only binding must never invoke the persistence journal');
});
