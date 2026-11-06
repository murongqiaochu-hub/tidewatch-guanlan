// Isolated in-memory clientStorage model only; no Figma, production data or deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingJournalStore } from '../插件/pending-journal.mjs';

function storage() {
  const values = new Map();
  return { values, async keysAsync() { return [...values.keys()]; }, async getAsync(k) { return structuredClone(values.get(k)); }, async setAsync(k, v) { values.set(k, structuredClone(v)); } };
}
const legacy = 'independent-inspector.publish.pending.v1.production';
const writer = n => `src_window_${String(n).padStart(32, '0')}`;

test('two concurrent writers retain discoverable independent SIDs without a shared index', async () => {
  const mem = storage(), a = createPendingJournalStore(mem, legacy, writer(1)), b = createPendingJournalStore(mem, legacy, writer(2));
  await Promise.all([a.write({ phase: 'unknownCommit', sessionId: 'sid-a' }), b.write({ phase: 'unknownCommit', sessionId: 'sid-b' })]);
  const entries = await a.list();
  assert.deepEqual(new Set(entries.map(e => e.value.sessionId)), new Set(['sid-a', 'sid-b']));
  await a.write({ phase: 'unknownCommit', sessionId: 'sid-a', locked: true });
  assert.equal((await mem.getAsync(b.ownKey)).sessionId, 'sid-b');
  const reopened = createPendingJournalStore(mem, legacy, writer(3));
  assert.equal((await reopened.list()).length, 2);
});

test('legacy and more than 64 unresolved records are never truncated or cleared', async () => {
  const mem = storage(); mem.values.set(legacy, { phase: 'unknownPrepare', sessionId: null });
  for (let i = 0; i < 80; i++) await createPendingJournalStore(mem, legacy, writer(i + 1)).write({ phase: 'unknownCommit', sessionId: `sid-${i}` });
  const entries = await createPendingJournalStore(mem, legacy, writer(999)).list();
  assert.equal(entries.length, 81); assert.deepEqual(await mem.getAsync(legacy), { phase: 'unknownPrepare', sessionId: null });
  assert.equal(entries.filter(e => !e.legacy).length, 80);
});

test('a lost acknowledgement after a durable write keeps the original SID discoverable', async () => {
  const mem = storage();
  const ambiguous = { ...mem, async setAsync(k, v) { mem.values.set(k, structuredClone(v)); throw new Error('synthetic lost acknowledgement'); } };
  const failed = createPendingJournalStore(ambiguous, legacy, writer(10));
  await assert.rejects(failed.write({ phase: 'unknownCommit', sessionId: 'original-sid', service: { origin: 'https://one.example' } }), { code: 'SDK_READ_FAILED' });
  const recovered = await createPendingJournalStore(mem, legacy, writer(11)).list();
  assert.equal(recovered.length, 1); assert.equal(recovered[0].value.sessionId, 'original-sid');
  assert.equal(recovered[0].value.service.origin, 'https://one.example');
});

test('enumeration reads only journal keys and never unrelated stored values', async () => {
  const mem = storage();
  const a = createPendingJournalStore(mem, legacy, writer(1));
  await a.write({ phase: 'unknownCommit', sessionId: 'sid-a' });
  mem.values.set('independent-inspector.publish.pending.v1.production-refresh', { opaque: true });
  const checked = { ...mem, async getAsync(k) { assert.ok(k === legacy || k.startsWith(`${legacy}.journal.`)); return mem.getAsync(k); } };
  assert.equal((await createPendingJournalStore(checked, legacy, writer(2)).list()).length, 1);
});

test('storage without enumeration, vanished records, failed writes, and writer collision fail closed', async () => {
  const mem = storage(), a = createPendingJournalStore(mem, legacy, writer(1));
  await a.write({ phase: 'unknownCommit', sessionId: 'sid-a' });
  await assert.rejects(createPendingJournalStore(mem, legacy, writer(1)).write({ phase: 'unknownCommit', sessionId: 'sid-b' }), { code: 'BUSY' });
  assert.equal((await mem.getAsync(a.ownKey)).sessionId, 'sid-a');
  await assert.rejects(createPendingJournalStore({ getAsync: mem.getAsync, setAsync: mem.setAsync }, legacy, writer(2)).list(), { code: 'SDK_CAPABILITY_MISSING' });
  const vanished = { ...mem, async keysAsync() { return [a.ownKey]; }, async getAsync() { return undefined; } };
  await assert.rejects(createPendingJournalStore(vanished, legacy, writer(3)).list(), { code: 'SDK_READ_FAILED' });
  const broken = { ...mem, async setAsync() { throw new Error('synthetic write failure'); } };
  await assert.rejects(createPendingJournalStore(broken, legacy, writer(4)).write({ phase: 'preparing' }), { code: 'SDK_READ_FAILED' });
});
