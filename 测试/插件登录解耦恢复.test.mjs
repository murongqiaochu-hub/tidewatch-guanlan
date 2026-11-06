// Synthetic SDK/bridge/clientStorage only: no real Figma, HTTP, service or data deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProductionPlugin } from '../插件/main.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';
import { validateProductionOperation, validateProductionOperationResult } from '../插件/production-protocol.mjs';

const namespace = `src_window_${'1'.repeat(32)}`;
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
