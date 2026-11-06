// MODEL-SDK and local HTTP/Vault only; no real Figma or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';
import { startProductionPlugin } from '../插件/main.mjs';
import { createProductionSession } from '../插件/production-session.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { createProductionHTTP, validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function awaitBarrier(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic barrier timed out')), 7000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, { designerOwner = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heron-two-windows-'));
  const dataDir = path.join(dir, 'data');
  const secret = randomBytes(48), password = `Fixture-${randomBytes(24).toString('hex')}`;
  let app;
  t.after(async () => { await app?.close(); t.diagnostic(`Retained isolated fixture: ${dir}`); });
  const seed = await createPlatform({ dataDir, host: '127.0.0.1', secret, bootstrapAdmin: { username: 'admin', password }, logger: { error() {} } });
  await seed.listen(0); await seed.close();
  const backing = await openVault({ dataDir });
  const vault = { ...backing, get catalog() { return backing.catalog; }, get readVersion() { return backing.readVersion; }, async discardStaged() { return { removed: false, reason: 'fixture_retains_data' }; } };
  app = await createPlatform({ dataDir, vault, host: '127.0.0.1', secret, logger: { error() {} } });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  const arrivals = deferred(), responses = deferred(), events = [];
  let claims = 0, settledClaims = 0, armed = false, lostResponse = null, afterSnapshot = null;
  const fetchAPI = async (url, options = {}) => {
    const pathname = new URL(url).pathname, method = options.method || 'GET';
    const event = { pathname, method }; events.push(event);
    if (armed && pathname === '/api/publish/operations' && method === 'POST') {
      if (++claims === 2) arrivals.resolve();
      await awaitBarrier(arrivals.promise);
      try {
        const response = await fetch(url, options); event.status = response.status;
        return response;
      } finally {
        if (++settledClaims === 2) responses.resolve();
        await awaitBarrier(responses.promise);
      }
    }
    const response = await fetch(url, options); event.status = response.status;
    if (afterSnapshot && method === 'GET' && /^\/api\/inspector\/frames\/[^/]+\/revisions\/[^/]+$/.test(pathname)) {
      const hook = afterSnapshot; afterSnapshot = null; await hook();
    }
    if (lostResponse && method === lostResponse.method && (lostResponse.pathname instanceof RegExp ? lostResponse.pathname.test(pathname) : pathname === lostResponse.pathname) && ++lostResponse.seen === lostResponse.at) {
      await response.arrayBuffer(); throw new TypeError('synthetic lost response after server processing');
    }
    return response;
  };
  const makeClient = () => createProductionHTTP({ origin, allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto, responseLimit: 4 * 1024 * 1024, timeoutMs: 10000 });
  const first = makeClient(), second = makeClient(), admin = makeClient();
  const adminLogin = await admin.login({ username: 'admin', password });
  let username = 'admin', ownerPassword = password, ownerId = adminLogin.user.id;
  if (designerOwner) {
    username = `fixture_${randomBytes(12).toString('hex')}`;
    ownerPassword = `Fixture-${randomBytes(24).toString('hex')}`;
    const response = await fetch(`${origin}/api/admin/users`, { method: 'POST', headers: { authorization: `Bearer ${adminLogin.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: ownerPassword, role: 'designer' }) });
    assert.equal(response.status, 201); ownerId = (await response.json()).user.id;
  }
  const login = await first.login({ username, password: ownerPassword }); await second.login({ username, password: ownerPassword });
  const project = await first.createProject('Synthetic coordination project');
  const group = await first.createFrameGroup(project.id, 'Synthetic target group');
  return { dir, app, origin, token: login.token, project, group, first, second, admin, ownerId, events, arm() { armed = true; }, get claims() { return claims; },
    loseResponse(method, pathname, at = 1) { lostResponse = { method, pathname, at, seen: 0 }; }, clearFault() { lostResponse = null; },
    afterSnapshot(hook) { afterSnapshot = hook; } };
}

function sharedStorage() {
  const values = new Map();
  return {
    values,
    async keysAsync() { return [...values.keys()]; },
    async getAsync(key) { return structuredClone(values.get(key)); },
    async setAsync(key, value) { values.set(key, structuredClone(value)); },
    async deleteAsync(key) { values.delete(key); }
  };
}

function sdkModel(storage, png, frameCount = 1) {
  const frames = Array.from({ length: frameCount }, (_, i) => ({ id: `2:${i + 1}`, type: 'FRAME', name: `Synthetic frame ${i + 1}`, width: 2, height: 3, absoluteBoundingBox: { x: i * 10 + 1, y: 2, width: 2, height: 3 }, children: [], exportAsync: async () => png }));
  const page = { id: '1:1', name: 'Synthetic page', children: frames, selection: frames.slice() };
  return { editorType: 'figma', fileKey: 'SyntheticFile123', root: { name: 'Synthetic document', children: [page] }, currentPage: page, clientStorage: storage };
}

async function windowPair(t, storage, png, client, origin, { frameCount = 1 } = {}) {
  const sdk = sdkModel(storage, png, frameCount), listeners = new Set(); let ui, serial = 0;
  const namespace = `src_window_${randomBytes(16).toString('hex')}`;
  sdk.showUI = () => {}; sdk.closePlugin = () => {};
  sdk.ui = { on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); }, resize() {}, postMessage(message) { queueMicrotask(() => void ui.receive(message, { main: true })); } };
  const main = startProductionPlugin(sdk, '<html>synthetic</html>', { production: { serviceOrigins: [origin], allowLocalhost: true } });
  ui = createBridge({ channel: CHANNEL, send(message) { queueMicrotask(() => { for (const fn of listeners) fn(message, { origin: 'null', officialUI: true }); }); }, subscribe: () => () => {}, trustedPeer: peer => peer.main === true, makeRequestId: () => `test-${namespace}-${++serial}`, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult,
    handlers: {
      async digest(payload) { return { digest: new Uint8Array(await webcrypto.subtle.digest('SHA-256', payload.bytes)) }; },
      notice() { return { accepted: true }; },
      async 'production-network'(payload, context) {
        try { return { ok: true, value: await client[payload.method](...payload.args, context) }; }
        catch (error) { return { ok: false, error: { code: error.code || 'HTTP_FAILED', status: error.status || null, dispatched: error.dispatched ?? true } }; }
      }
    }
  });
  let disposed = false;
  const dispose = async () => { if (disposed) return; disposed = true; await main.dispose(); await ui.close(); };
  t.after(dispose);
  const command = (action, payload = {}) => ui.request('production-control', { action, ...payload });
  await ui.request('hello', {});
  await command('connect', { service: { origin, allowLocalhost: true }, namespace });
  return { namespace, main, command, dispose };
}

test('two stale windows compete at the real server claim and only one publishes', { timeout: 30000 }, async t => {
  const h = await fixture(t), storage = sharedStorage(), png = await makeProceduralPng(2, 3);
  const [a, b] = await Promise.all([windowPair(t, storage, png, h.first, h.origin), windowPair(t, storage, png, h.second, h.origin)]);
  assert.notEqual(a.namespace, b.namespace);
  h.arm();
  const payload = { projectId: h.project.id, groupId: h.group.id, scope: 'selection', scale: 1, includeSlices: false, chunkCapacity: 16 };
  const results = await Promise.allSettled([a.command('publish', payload), b.command('publish', payload)]);
  assert.equal(h.claims, 2, 'both windows must actually reach claim HTTP');
  const claims = h.events.filter(e => e.pathname === '/api/publish/operations' && e.method === 'POST');
  // Baseline required exactly one 2xx and one 409. C34 conflict, pending product decision:
  // a second window is an explicit new publish with `replacePrevious`, so it may also claim
  // 2xx and cancel the older operation. The retained invariant is that exactly one task
  // completes and the other is cancelled without replay; both claims remain 2xx/409 only.
  assert.equal(claims.length, 2); assert.ok(claims.every(e => e.status >= 200 && e.status < 300 || e.status === 409)); assert.ok(claims.some(e => e.status >= 200 && e.status < 300));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const winner = results.find(r => r.status === 'fulfilled').value;
  assert.equal(winner.state.verified, true);
  const rejected = results.find(r => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'HTTP_FAILED');
  const loser = results[0].status === 'rejected' ? a : b;
  // C34 conflict with the retired invariant: the losing window no longer keeps a local
  // `unknownClaim` lock. The server cancelled its operation and the client records a
  // terminal failure; a later explicit publish is a new operation, never a replay.
  assert.equal(loser.main.status().publisher.phase, 'failed');
  assert.equal(loser.main.status().publisher.httpStatus, 409);
  assert.equal(loser.main.status().publisher.locked, false);
  assert.equal(loser.main.status().publisher.verified, false);
  const writesAfterRace = h.events.filter(e => ['POST', 'PUT'].includes(e.method)).length;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.events.filter(e => ['POST', 'PUT'].includes(e.method)).length, writesAfterRace, 'no automatic replay follows the competing publish');
  const catalog = h.app.vault.catalog;
  assert.equal(catalog.publishOperations.length, 2); assert.equal(catalog.publishOperations.filter(operation => operation.status === 'completed').length, 1); assert.equal(catalog.publishOperations.filter(operation => operation.status === 'cancelled').length, 1); assert.equal(catalog.publishSessions.length, 1);
  assert.equal(catalog.publishSessions[0].status, 'committed'); assert.equal(catalog.frameRevisions.length, 1);
  assert.equal(catalog.frames.filter(f => f.state === 'published').length, 1);
  assert.equal(catalog.frames[0].groupId, h.group.id);
  const count = (method, pattern) => h.events.filter(e => e.method === method && pattern.test(e.pathname)).length;
  assert.equal(count('POST', /^\/api\/publish\/sessions$/), 1);
  assert.equal(count('POST', /\/commit$/), 1);
  const puts = h.events.filter(e => e.method === 'PUT' && /\/assets\//.test(e.pathname));
  assert.ok(puts.length > 0); assert.equal(new Set(puts.map(e => e.pathname)).size, puts.length);
  assert.equal(puts.length, catalog.assets.length);
  assert.deepEqual(new Set(puts.map(e => e.pathname.split('/').at(-1))), new Set(catalog.assets.map(asset => asset.sha256)));
  const sha = createHash('sha256').update(png).digest('hex'), asset = catalog.assets.find(row => row.sha256 === sha);
  assert.ok(asset); assert.deepEqual(await h.app.vault.readOriginal(asset), Buffer.from(png));
  const reader = async endpoint => { const response = await fetch(`${h.origin}${endpoint}`, { headers: { authorization: `Bearer ${h.token}` } }); assert.equal(response.status, 200); return response.json(); };
  const directory = await reader(`/api/inspector/projects/${h.project.id}/directory`);
  assert.equal(directory.frames.length, 1); assert.equal(directory.frames[0].groupId, h.group.id);
  assert.equal(directory.frames[0].revisionId, catalog.frameRevisions[0].id);
  assert.ok(h.events.some(e => e.method === 'GET' && e.pathname === `/api/projects/${h.project.id}/canvas`));
  assert.ok(h.events.some(e => e.method === 'GET' && e.pathname === `/api/inspector/projects/${h.project.id}/directory`));
  assert.ok(h.events.some(e => e.method === 'GET' && e.pathname === `/api/inspector/frames/${catalog.frames[0].id}/revisions/${catalog.frameRevisions[0].id}`));
});

test('real layout change after snapshot makes finish fail closed without replay', { timeout: 30000 }, async t => {
  const h = await fixture(t), storage = sharedStorage(), png = await makeProceduralPng(2, 3);
  const first = await windowPair(t, storage, png, h.first, h.origin);
  let patched = false;
  h.afterSnapshot(async () => {
    const frame = h.app.vault.catalog.frames[0]; assert.ok(frame);
    const response = await fetch(`${h.origin}/api/projects/${h.project.id}/layout`, {
      method: 'PATCH', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ positions: [{ frameId: frame.id, x: 101, y: 201, expectedLayoutVersion: 0 }] })
    });
    assert.equal(response.status, 200); await response.arrayBuffer(); patched = true;
  });
  const payload = { projectId: h.project.id, groupId: h.group.id, scope: 'selection', scale: 1, includeSlices: false, chunkCapacity: 1 };
  await assert.rejects(first.command('publish', payload));
  assert.equal(patched, true);
  const finish = h.events.filter(e => e.method === 'POST' && e.pathname.endsWith('/finish'));
  assert.equal(finish.length, 1); assert.equal(finish[0].status, 409);
  const state = first.main.status().publisher;
  assert.equal(state.phase, 'unknownFinish'); assert.equal(state.verified, false);
  assert.equal(h.app.vault.catalog.publishSessions.filter(s => s.status === 'committed').length, 1);
  assert.equal(h.app.vault.catalog.frameRevisions.length, 1);
  const writes = h.events.filter(e => ['POST', 'PUT'].includes(e.method)).length;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.events.filter(e => ['POST', 'PUT'].includes(e.method)).length, writes, 'unknown finish is not replayed automatically');
  assert.equal(h.events.filter(e => e.method === 'POST' && e.pathname === '/api/publish/sessions').length, 1);
  assert.equal(h.events.filter(e => e.method === 'POST' && e.pathname.endsWith('/commit')).length, 1);
});

test('C34 startup retires local journals without server recovery; explicit new publish supersedes the old operation', { timeout: 30000 }, async t => {
  const h = await fixture(t), storage = sharedStorage(), png = await makeProceduralPng(2, 3);
  const priorIntent = await h.first.intent(h.project.id);
  const prior = await h.first.claim({ operationId: priorIntent.operationId, projectId: h.project.id, frameIds: ['2:1'], groupId: h.group.id, replacePrevious: true });
  assert.equal(prior.status, 'open');
  const baseKey = 'independent-inspector.publish.pending.v1', pendingKey = `${baseKey}.production`;
  const refreshKey = `${pendingKey}-refresh`, retiredSid = 'retired-synthetic-session';
  const journalA = `${pendingKey}.journal.${`src_window_${'1'.repeat(32)}`}`;
  const journalB = `${pendingKey}.journal.${`src_window_${'2'.repeat(32)}`}`;
  storage.values.set(baseKey, { phase: 'unknownCommit', sessionId: retiredSid });
  storage.values.set(pendingKey, { phase: 'unknownPrepare', operationId: prior.operationId, sessionId: retiredSid, locked: true });
  storage.values.set(journalA, { phase: 'unknownPrepare', operationId: prior.operationId, sessionId: retiredSid });
  storage.values.set(journalB, { phase: 'unknownCommit', operationId: prior.operationId, sessionId: retiredSid });
  storage.values.set(refreshKey, { origin: h.origin, allowLocalhost: true, username: 'admin', refreshToken: 'synthetic-refresh', refreshExpiresAt: Date.now() + 86400000 });
  storage.values.set('another-plugin', { keep: true });
  const start = h.events.length;
  const reopened = await windowPair(t, storage, png, h.second, h.origin);
  assert.deepEqual([...storage.values.keys()].sort(), [refreshKey, 'another-plugin'].sort());
  assert.equal(storage.values.get(refreshKey).refreshToken, 'synthetic-refresh');
  assert.equal(reopened.main.status().publisher.phase, 'idle');
  assert.equal(reopened.main.status().publisher.locked, false);
  assert.equal(h.events.length, start, 'startup must not query, receipt, or abort the old server operation');
  assert.equal(h.app.vault.catalog.publishOperations.find(operation => operation.id === prior.operationId).status, 'open');

  const payload = { projectId: h.project.id, groupId: h.group.id, scope: 'selection', scale: 1, includeSlices: false, chunkCapacity: 16 };
  const published = await reopened.command('publish', payload);
  assert.equal(published.state.verified, true);
  const operations = h.app.vault.catalog.publishOperations;
  assert.equal(operations.length, 2);
  assert.equal(operations.find(operation => operation.id === prior.operationId).status, 'cancelled');
  assert.equal(operations.filter(operation => operation.status === 'completed').length, 1);
  assert.equal(h.app.vault.catalog.publishSessions.filter(session => session.status === 'committed').length, 1);
  assert.equal(h.app.vault.catalog.frameRevisions.length, 1);
  const oldOperationPaths = h.events.slice(start).filter(event => event.pathname === `/api/publish/operations/${prior.operationId}` || event.pathname.startsWith(`/api/publish/operations/${prior.operationId}/`) || event.pathname.includes(retiredSid));
  assert.deepEqual(oldOperationPaths, [], 'only the explicit new publish may supersede; no stale receipt/query/abort is sent');
  assert.deepEqual([...storage.values.keys()].sort(), [refreshKey, 'another-plugin'].sort());
});

function restoredSession(adapter, saved) {
  const sdk = { root: {}, currentPage: {} };
  const session = createProductionSession({ sdk, adapter, namespace: `src_window_${'1'.repeat(32)}`, cryptoAPI: webcrypto, exporter: { queue: { snapshot: () => ({ pending: 0 }) }, exportFrames: async () => { throw new Error('read-only recovery must not export'); } } });
  session.restore(saved);
  return session;
}
const recoveryPolicy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 25 * 1024 * 1024 };

test('recovery cancellation requires the original actor and current publish permission', { timeout: 30000 }, async t => {
  const h = await fixture(t, { designerOwner: true });
  const intent = await h.first.intent(h.project.id);
  const operationId = intent.operationId;
  assert.equal((await h.first.claim({ operationId, projectId: h.project.id, frameIds: ['2:1'], groupId: h.group.id })).status, 'open');
  const operation = () => h.app.vault.catalog.publishOperations.find(row => row.id === operationId);
  const audits = () => h.app.vault.catalog.auditLogs.filter(row => row.action === 'publish.recover_cancel' && row.target === operationId).length;
  await assert.rejects(h.admin.recoverCancel(operationId, h.project.id), error => error.status === 404, 'another actor cannot cancel an operation it does not own');
  assert.equal(operation().status, 'open'); assert.equal(audits(), 0);
  await h.app.vault.transact(d => d.patch('users', h.ownerId, { role: 'developer' }));
  await assert.rejects(h.first.recoverCancel(operationId, h.project.id), error => error.status === 403, 'owner must still hold publish permission at cancellation time');
  assert.equal(operation().status, 'open'); assert.equal(audits(), 0);
  await h.app.vault.transact(d => d.patch('users', h.ownerId, { role: 'designer' }));
  const cancelled = await h.first.recoverCancel(operationId, h.project.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.operationId, operationId);
  assert.equal(operation().status, 'cancelled'); assert.equal(audits(), 1);
  assert.equal(h.app.vault.catalog.publishSessions.length, 0);
});

test('reopened unknown commit is read-only: only the journaled SID and its result are read, never replayed', { timeout: 30000 }, async t => {
  const namespace = `src_window_${'1'.repeat(32)}`, operationId = `op_${'a'.repeat(32)}_${'b'.repeat(64)}`, sessionId = 'sid-original', requestHash = 'c'.repeat(64);
  const prepared = { sessionId, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex: 0, requestHash, designFileId: 'file-1', maxUploadBytes: 1024 * 1024, uploadPolicy: recoveryPolicy, missingAssetSha256: [], frames: [{ figmaNodeId: '2:1', frameId: 'frame-1', status: 'new', missingAssetSha256: [] }] };
  const operation = { operationId, projectId: 'p', createdBy: 'u', status: 'open', frameIds: ['2:1', '2:2'], groupId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [{ sessionId, operationId, batchIndex: 0, requestHash, status: 'open', expiresAt: null, automaticExpiry: false, uploaded: [], uploadPolicy: recoveryPolicy, frames: [{ figmaNodeId: '2:1', frameId: 'frame-1', status: 'new' }], prepareResult: prepared }], committedFrames: [], remainingFrameIds: ['2:1', '2:2'] };
  const calls = [];
  const adapter = {
    async queryOperation(op) { calls.push(['operation', op]); assert.equal(op, operationId); return structuredClone(operation); },
    async query(sid) { calls.push(['query', sid]); assert.equal(sid, sessionId); return { sessionId, status: 'committed', expiresAt: null, automaticExpiry: false, operationId, batchIndex: 0, requestHash, uploaded: [], uploadPolicy: recoveryPolicy, frames: [{ figmaNodeId: '2:1', frameId: 'frame-1', status: 'committed' }] }; },
    async queryCommitResult(sid) { calls.push(['result', sid]); assert.equal(sid, sessionId); return { sessionId, status: 'committed', frames: [{ figmaNodeId: '2:1', frameId: 'frame-1', revisionId: 'rev-1', status: 'new' }] }; }
  };
  for (const name of ['projects', 'intent', 'claim', 'finish', 'publishSource', 'prepare', 'upload', 'commit', 'abort', 'recoverCancel']) adapter[name] ??= async () => { calls.push([name]); throw new Error('recovery replay is forbidden'); };
  const session = restoredSession(adapter, { phase: 'unknownCommit', sessionId, operationId, projectId: 'p', source: { kind: 'plugin-launch', namespace }, preparedFrames: [{ figmaNodeId: '2:1', frameId: 'frame-1' }], expectedFrameIds: ['2:1', '2:2'], total: 2, done: 0, completed: [], batchIndex: 0, requestHash, batchFrameIds: ['2:1'], groupId: null, mappingAvailable: false, locked: true });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_COMMIT' });
  assert.deepEqual(calls, [], 'an unresolved task must not dispatch anything automatically');
  const queried = await session.query();
  assert.equal(queried.result.sessionId, sessionId); assert.equal(session.status().locked, true);
  const recovered = await session.recoverCommit();
  assert.equal(recovered.result.sessionId, sessionId); assert.equal(recovered.result.frames[0].revisionId, 'rev-1');
  assert.equal(recovered.state.mappingAvailable, true); assert.equal(recovered.state.phase, 'partial', 'a mapping without full task visibility stays incomplete');
  assert.deepEqual(calls.map(call => call[0]), ['operation', 'query', 'result']);
  assert.equal(calls.some(call => ['prepare', 'upload', 'commit', 'abort', 'recoverCancel'].includes(call[0])), false, 'recovery must not replay a write');
});

test('reopened unknown prepare stays locked and only the explicit recover-cancel writes', { timeout: 30000 }, async t => {
  const namespace = `src_window_${'1'.repeat(32)}`, operationId = `op_${'d'.repeat(32)}_${'e'.repeat(64)}`, requestHash = 'f'.repeat(64);
  const calls = [];
  const cancelled = { operationId, projectId: 'p', createdBy: 'u', status: 'cancelled', frameIds: ['2:1'], groupId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: ['2:1'] };
  const adapter = {
    async queryOperation(op) { calls.push(['operation', op]); assert.equal(op, operationId); return { operationId, projectId: 'p', createdBy: 'u', status: 'open', frameIds: ['2:1'], groupId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: ['2:1'] }; },
    async recoverCancel(op, projectId) { calls.push(['recoverCancel', op, projectId]); assert.equal(op, operationId); assert.equal(projectId, 'p'); return structuredClone(cancelled); }
  };
  for (const name of ['projects', 'intent', 'claim', 'finish', 'publishSource', 'prepare', 'upload', 'commit', 'query', 'abort', 'queryCommitResult']) adapter[name] ??= async () => { calls.push([name]); throw new Error('recovery replay is forbidden'); };
  const session = restoredSession(adapter, { phase: 'unknownPrepare', sessionId: null, operationId, projectId: 'p', source: { kind: 'plugin-launch', namespace }, preparedFrames: [], expectedFrameIds: ['2:1'], total: 1, done: 0, completed: [], batchIndex: 0, requestHash, batchFrameIds: ['2:1'], groupId: null, mappingAvailable: false, locked: true });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'UNKNOWN_PREPARE' });
  const queried = await session.query();
  assert.equal(queried.result.operationId, operationId); assert.equal(session.status().locked, true);
  assert.deepEqual(calls.map(call => call[0]), ['operation'], 'a reopened unknown prepare may only read the operation');
  const aborted = await session.abort();
  assert.equal(aborted.result.status, 'cancelled'); assert.equal(aborted.state.phase, 'aborted');
  assert.deepEqual(calls.map(call => call[0]), ['operation', 'recoverCancel']);
  assert.equal(calls.some(call => ['prepare', 'upload', 'commit', 'abort'].includes(call[0])), false);
});
