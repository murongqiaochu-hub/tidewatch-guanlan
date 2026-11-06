// Synthetic SDK/bridge/clientStorage only; no real Figma, HTTP, service or data deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { startProductionPlugin } from '../插件/main.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { createProductionHTTP, validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';
import { compileESM } from '../构建/esm-compiler.mjs';
import { pluginFiles } from '../构建/build.mjs';

const storageKey = 'independent-inspector.publish.pending.v1';
const pendingKey = `${storageKey}.production`;
const refreshKey = `${pendingKey}-refresh`;
const service = { origin: 'https://one.example', allowLocalhost: false };
const namespace = n => `src_window_${n.toString(16).padStart(32, '0')}`;

function memoryStorage() {
  const values = new Map(), writes = [];
  return {
    values, writes,
    async keysAsync() { return [...values.keys()]; },
    async getAsync(key) { return structuredClone(values.get(key)); },
    async setAsync(key, value) { writes.push([key, structuredClone(value)]); values.set(key, structuredClone(value)); },
    async deleteAsync(key) { values.delete(key); }
  };
}

function sdkModel(storage) {
  const frame = { id: '2:1', type: 'FRAME', name: 'Synthetic', width: 2, height: 3, absoluteBoundingBox: { x: 1, y: 2, width: 2, height: 3 }, children: [], exportAsync: async () => new Uint8Array() };
  const page = { id: '1:1', name: 'Synthetic', children: [frame], selection: [frame] };
  return { editorType: 'figma', fileKey: 'SyntheticFile123', root: { name: 'Synthetic', children: [page] }, currentPage: page, clientStorage: storage };
}

async function pair(t, storage, writer, networkCalls) {
  const sdk = sdkModel(storage), listeners = new Set(); let ui; let serial = 0;
  sdk.showUI = () => {}; sdk.closePlugin = () => {};
  sdk.ui = { on(_event, fn) { listeners.add(fn); }, off(_event, fn) { listeners.delete(fn); }, resize() {}, postMessage(message) { queueMicrotask(() => { void ui.receive(message, { main: true }); }); } };
  const main = startProductionPlugin(sdk, '<html>synthetic</html>', { production: { serviceOrigins: [service.origin] } });
  ui = createBridge({
    channel: CHANNEL,
    send(message) { queueMicrotask(() => { for (const fn of listeners) fn(message, { origin: 'null', officialUI: true }); }); },
    subscribe: () => () => {}, trustedPeer: peer => peer.main === true,
    makeRequestId: () => `test-ui-${writer}-${++serial}`,
    validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult,
    handlers: { async 'production-network'(payload) { networkCalls.push(payload.method); throw Object.assign(new Error('unexpected startup network request'), { code: 'HTTP_FAILED' }); } }
  });
  t.after(async () => { await main.dispose(); await ui.close(); });
  const command = (action, payload = {}) => ui.request('production-control', { action, ...payload });
  return {
    main, hello: () => ui.request('hello', {}),
    command,
    connect: () => command('connect', { service, namespace: namespace(writer) })
  };
}

// C34 conflict, pending product decision: the baseline used per-writer journals as a
// discoverable cross-window lock. Current code discovers and deletes them at startup and
// relies on the server operation/writer capability for isolation; the tests below forbid
// resurrecting a journal, pinning a namespace, and replacing a live writer key.
test('C34 windows retire old journals independently without local pending locks or recovery traffic', async t => {
  const storage = memoryStorage(), networkCalls = [];
  storage.values.set(storageKey, { phase: 'unknownCommit', sessionId: 'retired-sid' });
  storage.values.set(pendingKey, { phase: 'unknownPrepare', operationId: 'retired-operation', sessionId: 'retired-sid', locked: true });
  storage.values.set(`${pendingKey}.journal.${namespace(1)}`, { phase: 'unknownCommit', operationId: 'retired-a' });
  storage.values.set(`${pendingKey}.journal.${namespace(2)}`, { phase: 'unknownPrepare', operationId: 'retired-b' });
  storage.values.set(refreshKey, { origin: service.origin, allowLocalhost: false, username: 'tester', refreshToken: 'synthetic-refresh', refreshExpiresAt: Date.now() + 86400000 });
  storage.values.set('another-plugin', { keep: true });

  const [a, b] = await Promise.all([pair(t, storage, 1, networkCalls), pair(t, storage, 2, networkCalls)]);
  const [helloA, helloB] = await Promise.all([a.hello(), b.hello()]);
  assert.equal(helloA.state.phase, 'idle'); assert.equal(helloB.state.phase, 'idle');
  assert.equal(helloA.state.locked, false); assert.equal(helloB.state.locked, false);
  assert.deepEqual([...storage.values.keys()].sort(), [refreshKey, 'another-plugin'].sort());
  assert.equal(storage.values.get(refreshKey).refreshToken, 'synthetic-refresh');
  await Promise.all([a.connect(), b.connect()]);
  assert.equal(a.main.status().publisher.phase, 'idle'); assert.equal(b.main.status().publisher.phase, 'idle');
  assert.deepEqual(networkCalls, []); assert.deepEqual(storage.writes, []);
});

test('retired pending-journal module is not included in the compiled production main graph', async () => {
  const root = new URL('../', import.meta.url);
  const modules = new Map(await Promise.all(pluginFiles.filter(name => name.endsWith('.mjs')).map(async name => [name, await fs.readFile(new URL(name, root), 'utf8')])));
  const output = compileESM(modules, '插件/main.mjs');
  assert.ok(!output.order.includes('插件/pending-journal.mjs'));
  assert.doesNotThrow(() => new vm.Script(output.code));
});

test('a connected window pins its writer namespace; a second identity fails closed before any traffic', async t => {
  const storage = memoryStorage(), networkCalls = [];
  const p = await pair(t, storage, 1, networkCalls);
  await p.connect();
  await assert.rejects(p.command('connect', { service, namespace: namespace(2) }), { code: 'BAD_SCHEMA' });
  assert.equal(p.main.status().publisher.phase, 'idle');
  assert.deepEqual(networkCalls, []); assert.deepEqual(storage.writes, []);
  await p.connect();
  assert.deepEqual(networkCalls, []);
});

test('a window without storage deletion capability still never treats a retired journal as a live lock', async t => {
  const storage = memoryStorage(); delete storage.deleteAsync;
  storage.values.set(pendingKey, { phase: 'unknownCommit', operationId: 'retired-operation', sessionId: 'retired-sid', locked: true });
  const networkCalls = [];
  const p = await pair(t, storage, 3, networkCalls);
  const hello = await p.hello();
  assert.equal(hello.state.phase, 'idle'); assert.equal(hello.state.locked, false, 'legacy history is never a cross-window lock');
  await p.connect();
  assert.equal(p.main.status().publisher.phase, 'idle'); assert.deepEqual(networkCalls, []);
});

test('writer-key collision inside one UI client is rejected before a second claim request', async () => {
  const operationId = `op_${'a'.repeat(32)}_${'b'.repeat(64)}`, requests = [];
  const dto = { operationId, projectId: 'p', createdBy: 'usr_1', status: 'open', frameIds: ['2:1'], groupId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: ['2:1'] };
  const adapter = createProductionHTTP({ origin: 'http://127.0.0.1:4318', allowLocalhost: true, cryptoAPI: webcrypto, fetchAPI: async (url, options) => { requests.push([options.method, new URL(url).pathname]); return new Response(JSON.stringify(dto), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  adapter.setToken('synthetic.hmac');
  const input = { operationId, projectId: 'p', frameIds: ['2:1'], groupId: null };
  assert.equal((await adapter.claim(input)).operationId, operationId);
  await assert.rejects(adapter.claim(input), { code: 'BAD_SCHEMA' }, 'a second writer secret for the same operation must never replace the first');
  assert.deepEqual(requests, [['POST', '/api/publish/operations']]);
});
