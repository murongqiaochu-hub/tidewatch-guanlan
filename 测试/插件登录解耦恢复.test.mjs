// Synthetic SDK/bridge/clientStorage only: no real Figma, HTTP, service or data deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProductionPlugin } from '../插件/main.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';

const namespace = `src_window_${'1'.repeat(32)}`;
// C34 conflict, pending product decision: the baseline kept per-writer journals, mapped
// multiple records and reconciled receipts before releasing anything. Current code retires
// every local journal at startup and forgets an operation that may still be open on the
// server; the compensating behaviour is that an explicit new publish supersedes it and the
// server still refuses a foreign writer/actor (covered by 双窗口服务端协调).
test('C34 main/iframe handshake retires old journals without receipt or publish traffic', async () => {
  const baseKey = 'independent-inspector.publish.pending.v1';
  const pendingKey = `${baseKey}.production`;
  const refreshKey = `${pendingKey}-refresh`;
  const rootKey = `${pendingKey}.journal.${namespace}`;
  const copyKey = `${pendingKey}.journal.src_window_${'2'.repeat(32)}`;
  const values = new Map([
    [baseKey, { phase: 'unknownCommit' }],
    [pendingKey, { phase: 'unknownPrepare' }],
    [rootKey, { phase: 'unknownCommit', operationId: 'retired-operation' }],
    [copyKey, { phase: 'unknownCommit', operationId: 'conflicting-operation' }],
    [refreshKey, { refreshToken: 'synthetic-refresh' }],
    ['another-plugin', { keep: true }]
  ]);
  const storage = {
    async keysAsync() { return [...values.keys()]; },
    async getAsync(key) { return structuredClone(values.get(key)); },
    async setAsync(key, value) { values.set(key, structuredClone(value)); },
    async deleteAsync(key) { values.delete(key); }
  };
  const listeners = new Set();
  const networkCalls = [];
  let ui;
  const page = { id: '1:1', name: 'Synthetic page', children: [], selection: [] };
  const sdk = {
    editorType: 'figma', root: { children: [page] }, currentPage: page, clientStorage: storage,
    showUI() {}, closePlugin() {},
    ui: {
      on(_event, listener) { listeners.add(listener); },
      off(_event, listener) { listeners.delete(listener); },
      resize() {},
      postMessage(message) { queueMicrotask(() => { void ui.receive(message, { main: true }); }); }
    }
  };
  const main = startProductionPlugin(sdk, '<html>synthetic</html>');
  ui = createBridge({
    channel: CHANNEL,
    send(message) { queueMicrotask(() => { for (const listener of listeners) listener(message, { origin: 'null', officialUI: true }); }); },
    subscribe: () => () => {},
    trustedPeer: peer => peer?.main === true,
    validateRequest: validateProductionOperation,
    validateResult: validateProductionOperationResult,
    makeRequestId: (() => { let n = 0; return () => `test-ui-${++n}`; })(),
    handlers: {
      async 'production-network'(payload) { networkCalls.push(payload.method); throw Object.assign(new Error('unexpected recovery/network request'), { code: 'HTTP_FAILED' }); }
    }
  });
  try {
    const hello = await ui.request('hello', {});
    assert.equal(hello.state.production, true);
    assert.equal(hello.state.phase, 'idle');
    assert.equal(hello.state.locked, false);
    const connected = await ui.request('production-control', {
      action: 'connect', service: { origin: 'https://one.example', allowLocalhost: false }, namespace
    });
    assert.equal(connected.state.phase, 'idle');
    assert.equal(main.status().publisher.phase, 'idle');
    assert.deepEqual([...values.keys()].sort(), [refreshKey, 'another-plugin'].sort());
    assert.equal(values.get(refreshKey).refreshToken, 'synthetic-refresh');
    assert.deepEqual(networkCalls, []);
    await assert.rejects(ui.request('production-control', { action: 'reconcile' }), { code: 'BAD_SCHEMA' });
    assert.deepEqual(networkCalls, []);
  } finally {
    await main.dispose();
    await ui.close();
  }
});

function syntheticWindow(values, networkCalls) {
  const baseKey = 'independent-inspector.publish.pending.v1';
  const storage = {
    async keysAsync() { return [...values.keys()]; },
    async getAsync(key) { return structuredClone(values.get(key)); },
    async setAsync(key, value) { values.set(key, structuredClone(value)); },
    async deleteAsync(key) { values.delete(key); }
  };
  const listeners = new Set();
  let ui;
  const page = { id: '1:1', name: 'Synthetic page', children: [], selection: [] };
  const sdk = {
    editorType: 'figma', root: { children: [page] }, currentPage: page, clientStorage: storage,
    showUI() {}, closePlugin() {},
    ui: {
      on(_event, listener) { listeners.add(listener); },
      off(_event, listener) { listeners.delete(listener); },
      resize() {},
      postMessage(message) { queueMicrotask(() => { void ui.receive(message, { main: true }); }); }
    }
  };
  const main = startProductionPlugin(sdk, '<html>synthetic</html>');
  ui = createBridge({
    channel: CHANNEL,
    send(message) { queueMicrotask(() => { for (const listener of listeners) listener(message, { origin: 'null', officialUI: true }); }); },
    subscribe: () => () => {},
    trustedPeer: peer => peer?.main === true,
    validateRequest: validateProductionOperation,
    validateResult: validateProductionOperationResult,
    makeRequestId: (() => { let n = 0; return () => `test-ui-${++n}`; })(),
    handlers: { async 'production-network'(payload) { networkCalls.push(payload.method); throw Object.assign(new Error('unexpected retired-journal traffic'), { code: 'HTTP_FAILED' }); } }
  });
  return { main, ui, storage, baseKey };
}

for (const scenario of ['terminal', 'pending', 'invalid', 'denied']) test(`retired old journal (${scenario}) never replicates, locks or rewrites storage on reconnect`, async t => {
  const baseKey = 'independent-inspector.publish.pending.v1', pendingKey = `${baseKey}.production`, refreshKey = `${pendingKey}-refresh`;
  const values = new Map([
    [baseKey, { phase: 'unknownCommit' }],
    [pendingKey, scenario === 'invalid' ? { phase: 'not-a-phase', locked: true } : { phase: scenario === 'terminal' ? 'committed' : 'unknownPrepare', operationId: 'retired-operation', sessionId: 'retired-sid', locked: true }],
    [`${pendingKey}.journal.${namespace}`, scenario === 'invalid' ? 'not-an-object' : { phase: 'unknownCommit', operationId: 'retired-journal' }],
    [refreshKey, { origin: 'https://one.example', allowLocalhost: false, username: 'tester', refreshToken: 'synthetic-refresh' }],
    ['another-plugin', { keep: true }]
  ]);
  const networkCalls = [];
  const { main, ui } = syntheticWindow(values, networkCalls);
  try {
    const hello = await ui.request('hello', {});
    assert.equal(hello.state.phase, 'idle'); assert.equal(hello.state.locked, false);
    await ui.request('production-control', { action: 'connect', service: { origin: 'https://one.example', allowLocalhost: false }, namespace });
    assert.deepEqual([...values.keys()].sort(), [refreshKey, 'another-plugin'].sort(), 'only retired publication keys may be deleted');
    assert.equal(values.get(refreshKey).refreshToken, 'synthetic-refresh');
    assert.deepEqual(values.get('another-plugin'), { keep: true });
    assert.deepEqual(networkCalls, [], 'login must not query, receipt or replay any retired operation');
  } finally { await main.dispose(); await ui.close(); }
});

test('malformed multi-journal snapshots cannot block a fresh window or leak into another plugin', async t => {
  const baseKey = 'independent-inspector.publish.pending.v1', pendingKey = `${baseKey}.production`, refreshKey = `${pendingKey}-refresh`;
  const values = new Map([
    [`${pendingKey}.journal.src_window_${'a'.repeat(32)}`, { phase: 'unknownCommit', operationId: 'a', locked: true }],
    [`${pendingKey}.journal.src_window_${'b'.repeat(32)}`, { phase: 'unknownPrepare', operationId: 'b' }],
    [`${pendingKey}.journal.src_window_${'c'.repeat(32)}`, { phase: 'failed', completed: 'invalid' }],
    [pendingKey, { phase: 'unknownCommit', operationId: 'root', sessionId: 'root-sid', locked: true }],
    [refreshKey, { refreshToken: 'kept' }]
  ]);
  const networkCalls = [];
  const { main, ui } = syntheticWindow(values, networkCalls);
  try {
    const hello = await ui.request('hello', {});
    assert.equal(hello.state.phase, 'idle'); assert.deepEqual([...values.keys()].sort(), [refreshKey].sort());
    await ui.request('production-control', { action: 'connect', service: { origin: 'https://one.example', allowLocalhost: false }, namespace });
    assert.deepEqual(networkCalls, []);
  } finally { await main.dispose(); await ui.close(); }
});
