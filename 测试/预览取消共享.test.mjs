// Controlled-codec + real temporary filesystem regressions. Not native-codec/browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreviewStore } from '../平台/预览.mjs';
import { nativeBudget, problem, sha256 } from '../平台/下载.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
const request = Object.freeze({ mode: 'native', x: 0, y: 0 });
const closedRequest = () => problem(499, 'request_closed');
const isClosedRequest = cause => cause.status === 499 && cause.code === 'request_closed';
async function barrier(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled preview barrier not reached')), 3000); })]); }
  finally { clearTimeout(timer); }
}
function controlledCodec() {
  const calls = [], waiting = new Map(); let active = 0, peak = 0;
  return {
    identity: 'test-only-cancelled-owner-shared-flight', exactNativeRGBA: true, calls,
    get active() { return active; }, get peak() { return peak; },
    entered(index) {
      if (calls[index]) return Promise.resolve(calls[index]);
      if (!waiting.has(index)) waiting.set(index, deferred());
      return barrier(waiting.get(index).promise);
    },
    async render(job) {
      const index = calls.length, call = { job, done: deferred(), closed: false };
      calls.push(call); active++; peak = Math.max(peak, active); waiting.get(index)?.resolve(call);
      try {
        const failure = await call.done.promise;
        if (failure) throw failure;
        assert.equal(job.mode, 'native'); assert.equal(job.x, 0); assert.equal(job.y, 0);
        assert.equal(job.width, job.sourceWidth); assert.equal(job.height, job.sourceHeight);
        await writeFile(job.outputPath, await readFile('/proc/self/fd/' + job.sourceFd), { mode: 0o600 });
      } finally { call.closed = true; active--; }
    },
    async close() { for (const call of calls) if (!call.closed) call.done.resolve(problem(503, 'test_codec_closed')); }
  };
}
async function setup(t, { holdFirstSourceClose = false } = {}) {
  const parent = await realpath(os.tmpdir()), dir = await mkdtemp(path.join(parent, 'owned-preview-cancel-'));
  assert.equal(await realpath(dir), dir);
  const bytes = await makeProceduralPng(64, 64), hash = sha256(bytes), assetsDir = path.join(dir, 'assets');
  const asset = Object.freeze({ id: 'source', mime: 'image/png', bytes: bytes.length, sha256: hash, relativePath: hash.slice(0, 2) + '/' + hash + '.png' });
  const sourcePath = path.join(assetsDir, asset.relativePath);
  await mkdir(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  const handles = [], tasks = [], codec = controlledCodec(); let cleaning = false;
  const vault = {
    assetsDir, dataDir: dir,
    async openOriginal(descriptor) {
      assert.equal(descriptor.sha256, asset.sha256); assert.equal(descriptor.relativePath, asset.relativePath);
      const handle = await open(sourcePath, 'r'), entry = { handle, closed: false, closing: deferred(), allowClose: deferred(), closeTask: null };
      handles.push(entry);
      if (!holdFirstSourceClose || handles.length !== 1 || cleaning) entry.allowClose.resolve();
      return { handle, close() {
        return entry.closeTask ??= (async () => { entry.closing.resolve(); await entry.allowClose.promise; await handle.close(); entry.closed = true; })();
      } };
    }
  };
  const store = createPreviewStore({ vault, codec, maxWorkPixels: 4096 });
  const get = options => { const task = store.get(asset, request, options); task.catch(() => {}); tasks.push(task); return task; };
  t.after(async () => {
    cleaning = true;
    const closing = store.close();
    for (const call of codec.calls) call.done.resolve(problem(503, 'test_cleanup'));
    for (const entry of handles) entry.allowClose.resolve();
    await Promise.allSettled(tasks); await closing;
    assert.ok(handles.every(entry => entry.closed), 'all original descriptors physically closed');
    assert.equal(store.diagnostics().workPixels, 0); assert.equal(store.diagnostics().inFlight, 0); assert.equal(nativeBudget.diagnostics().active, 0);
    assert.equal(sha256(await readFile(sourcePath)), hash, 'the original bytes must never be modified');
    assert.equal(await realpath(dir), dir); assert.equal(path.dirname(dir), parent); assert.match(path.basename(dir), /^owned-preview-cancel-/);
    await rm(dir, { recursive: true, force: false });
  });
  return { store, codec, handles, get, asset, bytes };
}

// Deliberately hold source FD close AFTER the cancelled codec has physically settled.
// No retry may start until that close, temporary cleanup and both leases have completed.
test('PREVIEW SHARED CANCEL: live peer retries once only after cancelled owner worker, source FD and leases fully close', async t => {
  const f = await setup(t, { holdFirstSourceClose: true }), owner = new AbortController(), peer = new AbortController();
  const first = f.get({ signal: owner.signal }), old = await f.codec.entered(0);
  let checks = 0; const second = f.get({ signal: peer.signal, reauthorize: () => { checks++; } });
  owner.abort(); await tick();
  assert.equal(f.codec.calls.length, 1); assert.equal(f.codec.active, 1); assert.equal(nativeBudget.diagnostics().active, 1); assert.equal(f.store.diagnostics().workPixels, 4096);
  old.done.resolve(closedRequest()); await barrier(f.handles[0].closing.promise); await tick();
  assert.equal(old.closed, true); assert.equal(f.handles[0].closed, false); assert.equal(f.codec.calls.length, 1, 'source close is still pending: no fresh worker');
  assert.equal(nativeBudget.diagnostics().active, 1); assert.equal(f.store.diagnostics().workPixels, 4096); assert.equal(f.store.diagnostics().inFlight, 1);
  f.handles[0].allowClose.resolve(); const fresh = await f.codec.entered(1);
  assert.equal(f.handles[0].closed, true); await assert.rejects(lstat(path.dirname(old.job.outputPath)), { code: 'ENOENT' });
  assert.equal(f.codec.peak, 1); assert.equal(nativeBudget.diagnostics().active, 1); assert.equal(f.store.diagnostics().workPixels, 4096);
  assert.equal(fresh.job.sourceSha256, f.asset.sha256); assert.equal(fresh.job.signal, peer.signal);
  fresh.done.resolve(); await assert.rejects(first, isClosedRequest); const record = await second;
  assert.equal(record.sourceSha256, f.asset.sha256); assert.equal(record.sha256, sha256(f.bytes)); assert.ok(checks >= 3, 'peer reauthorizes before share, before retry and after the result');
  assert.equal(f.codec.calls.length, 2); assert.equal(f.store.diagnostics().inFlight, 0);
});

test('PREVIEW SHARED CANCEL: already-aborted caller never creates or joins physical work', async t => {
  const f = await setup(t), caller = new AbortController(); caller.abort();
  await assert.rejects(f.get({ signal: caller.signal }), isClosedRequest);
  assert.equal(f.codec.calls.length, 0); assert.equal(f.handles.length, 0); assert.equal(f.store.diagnostics().inFlight, 0);
});

test('PREVIEW SHARED CANCEL: caller own abort never retries even when another owner also aborted', async t => {
  const f = await setup(t), owner = new AbortController(), peer = new AbortController();
  const first = f.get({ signal: owner.signal }), old = await f.codec.entered(0), second = f.get({ signal: peer.signal });
  owner.abort(); peer.abort(); old.done.resolve(closedRequest());
  await assert.rejects(first, isClosedRequest); await assert.rejects(second, isClosedRequest);
  assert.equal(f.codec.calls.length, 1); assert.equal(f.store.diagnostics().cacheBytes, 0);
});

for (const [status, code, abortOwner] of [[401, 'authentication_required', true], [403, 'revoked', true], [409, 'asset_integrity', true], [422, 'codec_failed', true], [499, 'different_failure', true], [499, 'request_closed', false]]) {
  test(`PREVIEW SHARED CANCEL: status ${status}/${code}, ownerAbort=${abortOwner} is not retried`, async t => {
    const f = await setup(t), owner = new AbortController(), peer = new AbortController(), first = f.get({ signal: owner.signal });
    const old = await f.codec.entered(0), second = f.get({ signal: peer.signal });
    if (abortOwner) owner.abort(); old.done.resolve(problem(status, code));
    const expected = cause => cause.status === status && cause.code === code;
    await assert.rejects(first, expected); await assert.rejects(second, expected);
    assert.equal(f.codec.calls.length, 1); assert.equal(f.store.diagnostics().cacheBytes, 0);
  });
}

test('PREVIEW SHARED CANCEL: live peers coalesce onto exactly one fresh flight and authorize independently', async t => {
  const f = await setup(t), owner = new AbortController(), first = f.get({ signal: owner.signal });
  const old = await f.codec.entered(0), counts = [0, 0, 0], peers = counts.map((_, i) => f.get({ signal: new AbortController().signal, reauthorize: () => { counts[i]++; } }));
  owner.abort(); old.done.resolve(closedRequest()); const fresh = await f.codec.entered(1); await tick();
  assert.equal(f.codec.calls.length, 2); assert.equal(f.codec.peak, 1); assert.equal(f.store.diagnostics().inFlight, 1);
  fresh.done.resolve(); await assert.rejects(first, isClosedRequest); const records = await Promise.all(peers);
  assert.ok(records.every(record => record === records[0])); assert.ok(counts.every(count => count >= 3)); assert.equal(f.codec.calls.length, 2); assert.equal(f.store.diagnostics().inFlight, 0);
});

test('PREVIEW SHARED CANCEL: second cancelled shared owner cannot cause a third attempt for the same waiting callers', async t => {
  const f = await setup(t), owner = new AbortController(), a = new AbortController(), b = new AbortController();
  const first = f.get({ signal: owner.signal }), old = await f.codec.entered(0), one = f.get({ signal: a.signal }), two = f.get({ signal: b.signal });
  owner.abort(); old.done.resolve(closedRequest()); const fresh = await f.codec.entered(1);
  assert.equal(fresh.job.signal, a.signal); a.abort(); fresh.done.resolve(closedRequest());
  await assert.rejects(first, isClosedRequest); await assert.rejects(one, isClosedRequest); await assert.rejects(two, isClosedRequest);
  assert.equal(b.signal.aborted, false); assert.equal(f.codec.calls.length, 2); assert.equal(f.codec.peak, 1); assert.equal(f.store.diagnostics().inFlight, 0);
});

test('PREVIEW SHARED CANCEL: peer permission revoked before retry starts no new worker or cached result', async t => {
  const f = await setup(t), owner = new AbortController(); let allowed = true, checks = 0;
  const first = f.get({ signal: owner.signal }), old = await f.codec.entered(0);
  const second = f.get({ signal: new AbortController().signal, reauthorize: () => { checks++; if (!allowed) throw problem(403, 'peer_revoked'); } });
  owner.abort(); allowed = false; old.done.resolve(closedRequest());
  await assert.rejects(first, isClosedRequest); await assert.rejects(second, cause => cause.status === 403 && cause.code === 'peer_revoked');
  assert.equal(checks, 2); assert.equal(f.codec.calls.length, 1); assert.equal(f.store.diagnostics().cacheBytes, 0);
});

test('PREVIEW SHARED CANCEL: post-result authorization failure is not treated as a rejected shared flight', async t => {
  const f = await setup(t), owner = new AbortController(), first = f.get({ signal: owner.signal }), old = await f.codec.entered(0);
  let checks = 0;
  const second = f.get({ signal: new AbortController().signal, reauthorize: () => { if (++checks === 2) { owner.abort(); throw closedRequest(); } } });
  old.done.resolve(); await first; await assert.rejects(second, isClosedRequest);
  assert.equal(checks, 2); assert.equal(f.codec.calls.length, 1); assert.equal(f.handles.length, 2, 'no extra original FD opened for a fulfilled flight');
});

test('PREVIEW SHARED CANCEL: closing store does not restart cancelled work or finish before physical cleanup', async t => {
  const f = await setup(t, { holdFirstSourceClose: true }), owner = new AbortController();
  const first = f.get({ signal: owner.signal }), old = await f.codec.entered(0), second = f.get({ signal: new AbortController().signal });
  owner.abort(); let closed = false; const closing = f.store.close().then(() => { closed = true; });
  old.done.resolve(closedRequest()); await barrier(f.handles[0].closing.promise); await tick();
  assert.equal(closed, false); assert.equal(f.codec.calls.length, 1); assert.equal(f.store.diagnostics().workPixels, 4096); assert.equal(nativeBudget.diagnostics().active, 1);
  f.handles[0].allowClose.resolve(); await assert.rejects(first, isClosedRequest); await assert.rejects(second, isClosedRequest); await closing;
  assert.equal(closed, true); assert.equal(f.codec.calls.length, 1); assert.equal(f.store.diagnostics().inFlight, 0);
});
