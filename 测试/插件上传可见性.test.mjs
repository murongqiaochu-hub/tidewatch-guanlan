// MODEL-SDK fixtures against a nonce-owned local server and Vault only.
// Reader corruption/401/timeout are synthetic transport faults, not Figma/device or live-site tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, webcrypto } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';
import { createProductionSession } from '../插件/production-session.mjs';
import { createProductionHTTP, PRODUCTION_VERIFICATION_LIMITS } from '../插件/production-protocol.mjs';

const namespace = `src_visibility_${'a'.repeat(32)}`;
const delayAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('synthetic timeout'));
  signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
});

async function localFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heron-visibility-test-'));
  const canonical = await fs.realpath(dir);
  const nonce = randomBytes(24).toString('hex');
  const marker = path.join(canonical, 'TEST-OWNER.json');
  await fs.writeFile(marker, JSON.stringify({ canonical, nonce, uid: process.getuid() }), { flag: 'wx', mode: 0o600 });
  const secret = randomBytes(48), password = `Fixture-${randomBytes(18).toString('hex')}`;
  let app, client, token, origin, projectIdForRace, seeded = false; const events = []; let fault = null; let loseCommit = null;
  const fetchAPI = async (url, options) => {
    const pathname = new URL(url).pathname, method = options.method;
    const entry = { pathname, method };
    if (pathname === '/api/publish/sessions' && method === 'POST') { const { writerSecret: _redacted, ...safeBody } = JSON.parse(new TextDecoder().decode(options.body)); entry.body = safeBody; entry.frameCount = entry.body.frames.length; }
    events.push(entry);
    const canvas = pathname.endsWith('/canvas'), directory = pathname.endsWith('/directory');
    const history = /^\/api\/frames\/[^/]+\/revisions$/.test(pathname);
    const snapshot = /^\/api\/inspector\/frames\/[^/]+\/revisions\/[^/]+$/.test(pathname);
    if ((canvas || directory) && fault === 'timeout') return delayAbort(options.signal);
    if ((canvas && fault === '401') || (pathname.endsWith('/result') && fault === 'result-401')) return new Response(JSON.stringify({ error: 'synthetic' }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (snapshot && fault === 'snapshot-oversize') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(PRODUCTION_VERIFICATION_LIMITS.snapshot + 1) } });
    const response = await fetch(url, options);
    if (loseCommit && pathname.endsWith('/commit') && ++loseCommit.seen === loseCommit.at) {
      await response.arrayBuffer();
      throw new TypeError('synthetic lost acknowledgement after actual response');
    }
    if (canvas && fault === 'live-catalog-change' && response.ok) {
      // Intentionally mutate only this test's own local Vault between the real GETs.
      const change = await fetch(`${origin}/api/projects/${projectIdForRace}/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Concurrent synthetic group' }) });
      assert.equal(change.status, 201); await change.arrayBuffer();
      events.push({ pathname: `/api/projects/${projectIdForRace}/groups`, method: 'POST', testRace: true });
    }
    if (!response.ok || !fault || !(canvas || directory || history || snapshot)) return response;
    const body = await response.json();
    const canvasFrames = () => body.files.flatMap(file => file.pages.flatMap(page => page.frames));
    if (fault === 'empty-directory' && directory) body.frames = [];
    if (fault === 'empty-canvas' && canvas) for (const file of body.files) for (const page of file.pages) page.frames = [];
    if (fault === 'wrong-canvas-project' && canvas) body.id = 'other-project';
    if (fault === 'missing-selected-group' && directory) body.groups = [];
    if (fault === 'group-name-mismatch' && directory) body.groups[0].name = '不同的合成分组';
    if (fault === 'group-duplicate' && canvas) body.groups.push({ ...body.groups[0] });
    if (fault === 'missing-one' && directory) body.frames.pop();
    if (fault === 'wrong-project' && directory) body.projectId = 'other-project';
    if (fault === 'wrong-row-project' && directory) body.frames[0].projectId = 'other-project';
    if (fault === 'wrong-group-directory' && directory) body.frames[0].groupId = 'other-group';
    if (fault === 'wrong-group-canvas' && canvas) canvasFrames()[0].groupId = 'other-group';
    if (fault === 'old-revision-directory' && directory) body.frames[0].revisionId = 'stale-revision';
    if (fault === 'old-revision-canvas' && canvas) canvasFrames()[0].currentRevisionId = 'stale-revision';
    if (fault === 'wrong-node' && directory) body.frames[0].figmaNodeId = '9:999';
    if (fault === 'catalog-generation-mismatch' && directory) body.catalogReadVersion = `${'a'.repeat(32)}:999`;
    if (fault === 'catalog-version-malformed' && directory) body.catalogReadVersion = 'invalid';
    if (fault === 'invalid-extra-directory-row' && directory) body.frames.push({});
    if (fault === 'history-old-current' && history) body.currentRevisionId = 'stale-revision';
    if (fault === 'history-missing-current' && history) body.revisions = [];
    if (fault === 'snapshot-wrong-identity' && snapshot) body.identity.projectId = 'other-project';
    if (fault === 'snapshot-wrong-file' && snapshot) body.identity.designFileId = 'other-file';
    if (fault === 'snapshot-wrong-page' && snapshot) body.identity.pageId = 'other-page';
    if (fault === 'snapshot-wrong-context-project' && snapshot) body.context.projectId = 'other-project';
    if (fault === 'snapshot-wrong-context-file' && snapshot) body.context.designFileId = 'other-file';
    if (fault === 'snapshot-asset-wrong-project' && snapshot) { assert.ok(body.assets.length); body.assets[0].projectId = 'other-project'; }
    if (fault === 'snapshot-asset-wrong-file' && snapshot) { assert.ok(body.assets.length); body.assets[0].designFileId = 'other-file'; }
    if (fault === 'snapshot-asset-wrong-frame' && snapshot) { assert.ok(body.assets.length); body.assets[0].frameId = 'other-frame'; }
    if (fault === 'snapshot-asset-wrong-revision' && snapshot) { assert.ok(body.assets.length); body.assets[0].revisionId = 'stale-revision'; }
    if (fault === 'snapshot-no-layerdoc' && snapshot) body.layerDoc = null;
    if (fault === 'snapshot-bad-contract' && snapshot) body.layerDoc.contractVersion = 2;
    if (fault === 'snapshot-bad-type' && snapshot) body.layerDoc.frame.type = 'GROUP';
    if (fault === 'snapshot-bad-children' && snapshot) body.layerDoc.frame.children = null;
    if (fault === 'snapshot-null-child' && snapshot) body.layerDoc.frame.children = [null];
    if (fault === 'snapshot-preview-wrong-frame' && snapshot) body.previewAsset = { ...(body.previewAsset || {}), frameId: 'other-frame', revisionId: body.identity.revisionId };
    if (fault === 'snapshot-wrong-node' && snapshot) body.layerDoc.frame.id = '9:999';
    if (fault === 'snapshot-generation-mismatch' && snapshot) body.catalogReadVersion = `${'a'.repeat(32)}:999`;
    if (fault === 'canvas-dedup' && canvas) {
      const firstPage = body.files[0].pages[0], first = firstPage.frames[0];
      firstPage.frames.push({ ...first, id: 'other-frame', publishedAt: '9999-01-01T00:00:00.000Z' });
    }
    const encoded = Buffer.from(JSON.stringify(body));
    return new Response(encoded, { status: response.status, headers: { 'content-type': 'application/json', 'content-length': String(encoded.length) } });
  };
  async function start() {
    const dataDir = path.join(canonical, 'data');
    if (!seeded) {
      // Bootstrap only this synthetic vault, then reopen it with cleanup disabled.
      const seed = await createPlatform({ dataDir, host: '127.0.0.1', secret, bootstrapAdmin: { username: 'admin', password }, logger: { error() {} } });
      await seed.listen(0); await seed.close(); seeded = true;
    }
    const backing = await openVault({ dataDir });
    const vault = { ...backing, get catalog() { return backing.catalog; }, get readVersion() { return backing.readVersion; },
      async discardStaged() { return { removed: false, reason: 'fixture_retains_data' }; } };
    app = await createPlatform({ dataDir, vault, host: '127.0.0.1', secret, logger: { error() {} } });
    const address = await app.listen(0); origin = `http://127.0.0.1:${address.port}`;
    client = createProductionHTTP({ origin, allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto, responseLimit: 4 * 1024 * 1024, timeoutMs: 500 });
    token = (await client.login({ username: 'admin', password })).token;
  }
  t.after(async () => {
    await app?.close();
    const actual = await fs.realpath(dir), stat = await fs.lstat(actual);
    assert.equal(actual, canonical); assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('heron-visibility-test-')); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.uid, process.getuid());
    assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { canonical, nonce, uid: process.getuid() });
    t.diagnostic(`Retained isolated test directory: ${actual}`);
  });
  await start();
  const project = await client.createProject('Synthetic visibility project'); projectIdForRace = project.id;
  const group = await client.createFrameGroup(project.id, 'Synthetic group');
  return {
    events, project, group, get client() { return client; }, get app() { return app; },
    setFault(value) { fault = value; }, setLostCommit(at) { loseCommit = at ? { at, seen: 0 } : null; },
    authenticate() { client.setToken(token); },
    async legacyPost(pathname, body) { const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); },
    async restart() { await app.close(); await start(); }
  };
}

async function sdk27() {
  const png = await makeProceduralPng(2, 3);
  const page = { id: '1:1', name: 'Synthetic page', children: [], selection: [] };
  page.children = Array.from({ length: 27 }, (_, i) => ({
    id: `2:${i + 1}`, type: 'FRAME', name: `Synthetic ${i + 1}`, width: 2, height: 3,
    absoluteBoundingBox: { x: i * 10, y: 5, width: 2, height: 3 }, children: [],
    exportAsync: async () => png
  }));
  page.selection = page.children.slice();
  return { editorType: 'figma', fileKey: 'FixtureFile123', root: { name: 'Synthetic document', children: [page] }, currentPage: page };
}
function sessionFor(sdk, adapter, states) {
  return createProductionSession({ sdk, adapter, namespace, cryptoAPI: webcrypto, journal: async state => states.push(structuredClone(state)) });
}
const publishOptions = h => ({ projectId: h.project.id, groupId: h.group.id, coordinateMode: 'project-xy', chunkCapacity: 16, includeSlices: false });
// Include coordination writes as well as session uploads/commit so recovery
// cannot hide a repeated claim, finish or cancel behind an incomplete filter.
const writes = h => h.events.filter(e => ['POST', 'PUT'].includes(e.method) && /\/api\/publish\/(?:sessions|operations)(?:\/|$)/.test(e.pathname));
const counts = h => ({ prepare: h.events.filter(e => e.method === 'POST' && e.pathname === '/api/publish/sessions').length, commit: h.events.filter(e => e.method === 'POST' && e.pathname.endsWith('/commit')).length, abort: h.events.filter(e => e.method === 'POST' && e.pathname.endsWith('/abort')).length, upload: h.events.filter(e => e.method === 'PUT').length });

// 27 actual persisted synthetic frames, two batches; injected reader faults touch only test responses.
test('27 synthetic frames: dual reader identity checks fail closed and resume after local Vault restart', async t => {
  const h = await localFixture(t), sdk = await sdk27(), states = [];
  h.setFault('empty-directory');
  let session = sessionFor(sdk, h.client, states);
  await assert.rejects(session.publish(publishOptions(h)), { code: 'VISIBILITY_UNCONFIRMED' });
  const initial = session.status(), originalWrites = structuredClone(writes(h));
  assert.deepEqual([initial.phase, initial.locked, initial.verified, initial.done, initial.total], ['verificationPending', true, false, 27, 27]);
  assert.deepEqual(h.events.filter(e => e.pathname === '/api/publish/sessions').map(e => e.frameCount), [16, 11]);
  assert.deepEqual(initial.completed.map(x => x.frames.length), [16, 11]);
  assert.equal(h.app.vault.catalog.publishSessions.filter(s => s.status === 'committed').length, 2);
  assert.equal(h.app.vault.catalog.frames.filter(f => f.state === 'published').length, 27);
  for (const fault of ['missing-one', 'empty-canvas', 'wrong-project', 'wrong-canvas-project', 'wrong-row-project', 'missing-selected-group', 'group-name-mismatch', 'group-duplicate', 'wrong-group-directory', 'wrong-group-canvas', 'old-revision-directory', 'old-revision-canvas', 'wrong-node', 'canvas-dedup', 'catalog-generation-mismatch', 'catalog-version-malformed', 'invalid-extra-directory-row', 'live-catalog-change', 'history-old-current', 'history-missing-current', 'snapshot-wrong-identity', 'snapshot-wrong-file', 'snapshot-wrong-page', 'snapshot-wrong-context-project', 'snapshot-wrong-context-file', 'snapshot-asset-wrong-project', 'snapshot-asset-wrong-file', 'snapshot-asset-wrong-frame', 'snapshot-asset-wrong-revision', 'snapshot-no-layerdoc', 'snapshot-bad-contract', 'snapshot-bad-type', 'snapshot-bad-children', 'snapshot-null-child', 'snapshot-preview-wrong-frame', 'snapshot-wrong-node', 'snapshot-generation-mismatch']) {
    h.setFault(fault);
    await assert.rejects(session.query(), { code: 'VISIBILITY_UNCONFIRMED' }, fault);
    assert.deepEqual([session.status().phase, session.status().locked, session.status().verified], ['verificationPending', true, false], fault);
    await assert.rejects(session.publish(publishOptions(h)), { code: 'UNKNOWN_COMMIT' });
    await assert.rejects(session.abort(), { code: 'BAD_SCHEMA' });
    assert.deepEqual(writes(h), originalWrites, fault);
  }
  assert.equal(h.events.filter(e => e.testRace).length, 1, 'a real local catalog transaction must interleave between the two reader GETs');
  h.setFault('snapshot-oversize'); await assert.rejects(session.query(), { code: 'HTTP_BODY_TOO_LARGE' });
  assert.deepEqual([session.status().phase, session.status().locked, session.status().verified], ['verificationPending', true, false]); assert.deepEqual(writes(h), originalWrites);
  h.setFault('401'); await assert.rejects(session.query(), e => e.code === 'HTTP_FAILED' && e.status === 401);
  assert.equal(session.status().httpStatus, 401); assert.equal(h.client.status().authenticated, false); h.authenticate();
  h.setFault('timeout'); await assert.rejects(session.query(), { code: 'REQUEST_TIMEOUT' });
  assert.deepEqual([session.status().phase, session.status().locked, session.status().verified], ['verificationPending', true, false]);
  assert.deepEqual(writes(h), originalWrites);
  const saved = structuredClone(states.at(-1));
  h.setFault(null); await h.restart();
  session = sessionFor(sdk, h.client, []); session.restore(saved);
  assert.deepEqual([session.status().phase, session.status().locked, session.status().verified], ['verificationPending', true, false]);
  const recovered = await session.query();
  assert.deepEqual([recovered.state.phase, recovered.state.locked, recovered.state.verified, recovered.state.done, recovered.state.total], ['committed', true, false, 27, 27]);
  assert.equal(recovered.result.status, 'committed'); assert.equal(recovered.result.sessionId, saved.sessionId);
  const mapping = await session.recoverCommit(); assert.deepEqual([mapping.state.phase, mapping.state.locked, mapping.state.verified], ['unknownFinish', true, false]);
  assert.deepEqual(writes(h), originalWrites);
  assert.deepEqual(counts(h), { prepare: 2, commit: 2, abort: 0, upload: originalWrites.filter(e => e.method === 'PUT').length });
  assert.ok(h.events.some(e => e.pathname === `/api/projects/${h.project.id}/canvas`));
  assert.ok(h.events.some(e => e.pathname === `/api/inspector/projects/${h.project.id}/directory`));
  for (const item of recovered.state.completed.flatMap(result => result.frames)) {
    assert.ok(h.events.some(e => e.method === 'GET' && e.pathname === `/api/frames/${item.frameId}/revisions`));
    assert.ok(h.events.some(e => e.method === 'GET' && e.pathname === `/api/inspector/frames/${item.frameId}/revisions/${item.revisionId}`));
  }
});

test('27 synthetic frames: cancel after batch 16 is partial and never auto-prepares, uploads, or aborts', async t => {
  const h = await localFixture(t), sdk = await sdk27(), states = [], controller = new AbortController();
  const client = h.client;
  const adapter = { ...client, async commit(sid, operationId, context) { const result = await client.commit(sid, operationId, context); controller.abort(); return result; } };
  let session = sessionFor(sdk, adapter, states);
  await assert.rejects(session.publish(publishOptions(h), { signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual([session.status().phase, session.status().locked, session.status().verified, session.status().done, session.status().total], ['partial', true, false, 16, 27]);
  assert.equal(session.status().completed[0].frames.length, 16);
  const originalWrites = structuredClone(writes(h));
  await assert.rejects(session.publish(publishOptions(h)), { code: 'UNKNOWN_COMMIT' });
  assert.deepEqual(writes(h), originalWrites, 'no implicit cancellation');
  await session.abort(); assert.deepEqual([session.status().phase, session.status().locked, session.status().done], ['partial', true, 16]);
  const afterCancel = structuredClone(writes(h)); assert.equal(afterCancel.length, originalWrites.length + 1); assert.ok(afterCancel.at(-1).pathname.endsWith('/cancel'));
  session = sessionFor(sdk, h.client, []); session.restore(states.at(-1)); await session.query();
  assert.deepEqual([session.status().phase, session.status().locked, session.status().verified, session.status().done], ['partial', true, false, 16]);
  assert.deepEqual(writes(h), afterCancel); assert.equal(counts(h).prepare, 1); assert.equal(counts(h).commit, 1); assert.equal(counts(h).abort, 0);
});

test('local publication: explicit null clears old group while omitted group preserves legacy assignment', async t => {
  const h = await localFixture(t), sdk = await sdk27(); sdk.currentPage.selection = [sdk.currentPage.children[0]];
  const session = sessionFor(sdk, h.client, []);
  const grouped = await session.publish(publishOptions(h));
  const frameId = grouped.results[0].frames[0].frameId;
  const frame = () => h.app.vault.catalog.frames.find(item => item.id === frameId);
  assert.equal(grouped.state.verified, true); assert.equal(frame().groupId, h.group.id);
  const ungrouped = await session.publish({ ...publishOptions(h), groupId: null });
  const explicitBody = h.events.filter(e => e.method === 'POST' && e.pathname === '/api/publish/sessions').at(-1).body;
  assert.equal(Object.hasOwn(explicitBody, 'groupId'), true); assert.equal(explicitBody.groupId, null); assert.equal(explicitBody.groupAssignment, 'set');
  assert.equal(ungrouped.state.verified, true); assert.equal(frame().groupId ?? null, null);
  const groupedAgain = await session.publish(publishOptions(h));
  assert.equal(groupedAgain.state.verified, true); assert.equal(frame().groupId, h.group.id);
  const legacyBody = structuredClone(h.events.filter(e => e.method === 'POST' && e.pathname === '/api/publish/sessions').at(-1).body);
  delete legacyBody.groupId; delete legacyBody.groupAssignment; delete legacyBody.operationId; delete legacyBody.batchIndex; legacyBody.frames[0].baseRevisionId = groupedAgain.results[0].frames[0].revisionId;
  const prepared = await h.legacyPost('/api/publish/sessions', legacyBody);
  assert.deepEqual(prepared.missingAssetSha256, []); assert.equal(prepared.frames[0].frameId, frameId);
  const committed = await h.legacyPost(`/api/publish/sessions/${prepared.sessionId}/commit`, {});
  assert.equal(committed.status, 'committed'); assert.equal(committed.frames[0].frameId, frameId);
  assert.equal(frame().groupId, h.group.id);
});

test('27 synthetic frames: lost second commit acknowledgement recovers original SID by GET after Vault restart', async t => {
  const h = await localFixture(t), sdk = await sdk27(), states = []; h.setLostCommit(2);
  let session = sessionFor(sdk, h.client, states);
  await assert.rejects(session.publish(publishOptions(h)), { code: 'UNKNOWN_COMMIT' });
  const unknown = session.status(), sid = unknown.sessionId, initialWrites = structuredClone(writes(h));
  const originalResult = structuredClone(h.app.vault.catalog.publishSessions.find(s => s.id === sid).commitResult);
  assert.deepEqual([unknown.phase, unknown.locked, unknown.verified, unknown.done, unknown.total], ['unknownCommit', true, false, 16, 27]);
  assert.equal(h.app.vault.catalog.publishSessions.filter(s => s.status === 'committed').length, 2);
  assert.deepEqual(h.events.filter(e => e.pathname === '/api/publish/sessions').map(e => e.frameCount), [16, 11]);
  const saved = structuredClone(states.at(-1)); h.setLostCommit(null); await h.restart();
  session = sessionFor(sdk, h.client, []); session.restore(saved);
  const queried = await session.query(); assert.equal(queried.result.status, 'committed');
  assert.equal(queried.state.locked, true); assert.equal(queried.state.verified, false); assert.equal(queried.state.mappingAvailable, false);
  assert.equal(queried.result.sessionId, sid); assert.deepEqual(writes(h), initialWrites);
  h.setFault('result-401'); await assert.rejects(session.recoverCommit(), e => e.code === 'HTTP_FAILED' && e.status === 401);
  assert.deepEqual([session.status().locked, session.status().verified, session.status().mappingAvailable], [true, false, false]);
  assert.deepEqual(writes(h), initialWrites); h.authenticate(); h.setFault(null);
  const recovered = await session.recoverCommit();
  assert.equal(recovered.result.sessionId, sid); assert.deepEqual(recovered.result, originalResult);
  assert.deepEqual([recovered.state.phase, recovered.state.locked, recovered.state.verified, recovered.state.done, recovered.state.total], ['unknownFinish', true, false, 27, 27]);
  assert.deepEqual(recovered.state.completed.map(item => item.frames.length), [16, 11]);
  assert.deepEqual(writes(h), initialWrites); assert.equal(counts(h).prepare, 2); assert.equal(counts(h).commit, 2); assert.equal(counts(h).abort, 0);
  assert.deepEqual(h.events.filter(e => e.pathname.endsWith('/result')).map(e => [e.method, e.pathname]), [['GET', `/api/publish/sessions/${sid}/result`], ['GET', `/api/publish/sessions/${sid}/result`]]);
});
