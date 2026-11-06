// 非 Figma / NON-FIGMA: synthetic read-only catalog + actual Heron DTO builders.
// Real HTTP is restricted to this test's 127.0.0.1 ephemeral server; other tests
// use in-process transport faults. No live service, SDK, deployment or deletion.
// Every test creates and retains a fresh directory, including failed test runs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { installProjectData } from '../平台/项目数据.mjs';
import { installAssets } from '../平台/资源.mjs';
import { createProductionHTTP, PRODUCTION_RESPONSE_LIMIT, PRODUCTION_VERIFICATION_LIMITS } from '../插件/production-protocol.mjs';
import { createProductionSession } from '../插件/production-session.mjs';
import { createBridge } from '../插件/bridge.mjs';

const MiB = 1024 * 1024;
const version = `${'a'.repeat(32)}:7`;
const target = { figmaNodeId: '2:1', frameId: 'target', revisionId: 'revision' };
const operationId = `op_${'b'.repeat(32)}_${'c'.repeat(64)}`, requestHash = 'd'.repeat(64);
const expectedReceipt = { projectId: 'project', groupId: 'group', frameCount: 1, catalogReadVersion: version };
const policy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: 25 * MiB };
// Fully synthetic completed operation evidence; reader DTOs still come from the
// actual local handlers and must independently pass every visibility check.
function completedOperation() {
  const committedFrame = { ...target, status: 'committed' };
  const prepareFrame = { figmaNodeId: target.figmaNodeId, frameId: target.frameId, status: 'new', missingAssetSha256: [] };
  const sessionFrame = { figmaNodeId: target.figmaNodeId, frameId: target.frameId, status: 'committed' };
  const prepareResult = { sessionId: 'session', status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex: 0, requestHash, designFileId: 'file', maxUploadBytes: 25 * MiB, uploadPolicy: policy, missingAssetSha256: [], frames: [prepareFrame] };
  const commitResult = { sessionId: 'session', status: 'committed', frames: [committedFrame] };
  const batch = { sessionId: 'session', status: 'committed', expiresAt: null, automaticExpiry: false, operationId, batchIndex: 0, requestHash, uploaded: [], uploadPolicy: policy, frames: [sessionFrame], prepareResult, commitResult };
  return { operationId, projectId: 'project', createdBy: 'user', status: 'completed', frameIds: [target.figmaNodeId], groupId: 'group', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', lockScope: 'service', automaticExpiry: false, batches: [batch], committedFrames: [committedFrame], remainingFrameIds: [] };
}
const routes = {
  canvas: '/api/projects/project/canvas',
  directory: '/api/inspector/projects/project/directory',
  revisions: '/api/frames/target/revisions',
  snapshot: '/api/inspector/frames/target/revisions/revision'
};
const ceilings = { canvas: 16 * MiB, directory: 8 * MiB, revisions: 8 * MiB, snapshot: 65 * MiB };
const encode = value => Buffer.from(JSON.stringify(value));
const verify = (client, context) => client.verifyPublication('project', 'group', [target], context);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function test(name, work) {
  nodeTest(`NON-FIGMA / 本地模拟: ${name}`, { timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heron-verification-budget-'));
    await fs.writeFile(path.join(directory, 'TEST-ONLY.txt'), `NON-FIGMA; no live network; retained, never deleted.\n${name}\n`, { flag: 'wx' });
    t.diagnostic(`保留临时目录: ${directory}`);
    await work(t, directory);
  });
}

// These are the actual route handlers, not reduced verification-only DTOs.
// The Vault/auth/permissions are explicitly local models. No writable Vault,
// publishing/staging, preview rendering, or cleanup path is ever invoked.
async function readerDTOs(directory, large = false) {
  const names = large ? '合成画板'.repeat(120) : '合成画板';
  const bounds = { x: 0, y: 0, width: 300, height: 200 };
  const layerDoc = { contractVersion: 1, frame: {
    id: target.figmaNodeId, type: 'FRAME', name: names, absoluteBoundingBox: bounds,
    children: large ? Array.from({ length: 1024 }, (_, i) => ({
      id: `3:${i}`, type: 'TEXT', name: `合成文本 ${i}`, characters: '文'.repeat(1600),
      absoluteBoundingBox: { x: 0, y: i, width: 200, height: 10 }
    })) : []
  } };
  const docBytes = encode(layerDoc), hash = createHash('sha256').update(docBytes).digest('hex');
  const asset = { id: 'doc-asset', mime: 'application/json', bytes: docBytes.length, sha256: hash };
  const catalog = {
    projects: [{ id: 'project', name: 'NON-FIGMA synthetic project', ownerId: 'user' }],
    designFiles: [{ id: 'file', projectId: 'project', name: 'Synthetic file', order: 0 }],
    pages: [{ id: 'page', designFileId: 'file', figmaPageId: '1:1', name: 'Synthetic page', order: 0 }],
    frameGroups: [{ id: 'group', projectId: 'project', name: 'Synthetic group' }],
    frames: [], frameRevisions: [], assets: [asset], revisionAssets: []
  };
  for (let i = 0; i < (large ? 3000 : 1); i++) {
    const selected = i === (large ? 2999 : 0), frameId = selected ? target.frameId : `frame-${i}`;
    const revisionId = selected ? target.revisionId : `revision-${i}`, figmaNodeId = selected ? target.figmaNodeId : `4:${i}`;
    const manifest = { name: names, figmaNodeId, ...bounds, x: selected ? 0 : (i + 1) * 400, exports: [] };
    catalog.frames.push({ id: frameId, projectId: 'project', designFileId: 'file', pageId: 'page', figmaNodeId, state: 'published', groupId: 'group', currentRevisionId: revisionId });
    catalog.frameRevisions.push({ id: revisionId, frameId, designFileId: 'file', pageId: 'page', manifest, hash,
      createdAt: '2026-01-02T00:00:00Z', ...(selected ? { layerDocAssetId: asset.id } : {}) });
  }
  if (large) for (let i = 0; i < 2700; i++) catalog.frameRevisions.push({
    id: `history-${i}`, frameId: target.frameId, name: names, ...bounds, hash, createdAt: '2026-01-01T00:00:00Z'
  });
  const registered = [], user = { id: 'user' };
  const ctx = {
    vault: { catalog, readVersion: version, dataDir: directory,
      async readOriginal(requested, { maxBytes, signal }) {
        assert.equal(requested, asset); assert.ok(docBytes.length <= maxBytes); assert.equal(signal.aborted, false);
        return docBytes;
      } },
    auth: { actor: () => user },
    permissions: {
      requireRead(actor, projectId) { assert.equal(actor, user); assert.equal(projectId, 'project'); },
      project: () => ({ canRead: true, canPublish: true, canEditLayout: true })
    },
    error: (status, code) => Object.assign(new Error(code), { status, code }),
    route: (method, pattern, handler) => registered.push({ method, pattern, handler })
  };
  installProjectData(ctx);
  const assets = installAssets(ctx), dtos = {};
  try {
    for (const [kind, pathname] of Object.entries(routes)) {
      const route = registered.find(row => row.method === 'GET' && row.pattern.test(pathname));
      assert.ok(route);
      dtos[kind] = await route.handler({}, {}, { params: route.pattern.exec(pathname).groups,
        url: new URL(pathname, 'http://127.0.0.1'), signal: new AbortController().signal });
    }
  } finally { await assets.close(); }
  return dtos;
}

function jsonResponse(dto) {
  const bytes = encode(dto);
  return new Response(bytes, { headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
}
function modelClient(dtos, intercept = () => undefined, options = {}) {
  const calls = []; let issuedWriter;
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:49123', allowLocalhost: true, cryptoAPI: webcrypto,
    responseLimit: PRODUCTION_RESPONSE_LIMIT, ...options,
    fetchAPI: async (url, request) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'http://127.0.0.1:49123');
      const kind = Object.keys(routes).find(key => routes[key] === parsed.pathname);
      calls.push({ path: parsed.pathname, method: request.method });
      if (parsed.pathname === '/api/publish/intent') {
        assert.equal(request.method, 'GET'); assert.equal(parsed.search, '?projectId=project');
        return jsonResponse({ operationId, projectId: 'project' });
      }
      assert.equal(parsed.search, '');
      if (parsed.pathname === '/api/publish/operations' && request.method === 'POST') {
        const body = JSON.parse(new TextDecoder().decode(request.body));
        assert.equal(body.operationId, operationId); assert.equal(body.projectId, 'project');
        assert.match(body.writerSecret, /^[A-Za-z0-9_-]{43}$/); issuedWriter = body.writerSecret;
        return jsonResponse({ ...completedOperation(), status: 'open', finishedAt: null, batches: [], committedFrames: [], remainingFrameIds: [target.figmaNodeId] });
      }
      if (parsed.pathname === '/api/publish/sessions/session/commit' && request.method === 'POST') {
        const body = JSON.parse(new TextDecoder().decode(request.body)); assert.ok(issuedWriter); assert.equal(body.writerSecret, issuedWriter);
      }
      const replacement = await intercept(kind, request, parsed.pathname);
      if (replacement !== undefined) return replacement;
      assert.ok(kind, `unexpected model request: ${parsed.pathname}`); assert.equal(request.method, 'GET');
      return jsonResponse(dtos[kind]);
    }
  });
  client.setToken('synthetic.nonfigma');
  return { client, calls };
}

// Lazy real byte stream: total counts bytes actually delivered by read(),
// independently of the advertised length. Repeated whitespace avoids allocating
// an extra 65 MiB fixture while testing the production reader's real allocation.
function byteStream(total, { declared = String(total), prefix = Buffer.alloc(0), onCancel, onEOF, faultAfter = Infinity } = {}) {
  const stats = { bytes: 0, reads: 0, cancels: 0 }, block = Buffer.alloc(64 * 1024, 32);
  const body = new ReadableStream({
    pull(controller) {
      stats.reads++;
      if (stats.bytes >= faultAfter) { controller.error(new Error('synthetic interrupted stream')); return; }
      if (stats.bytes === total) { onEOF?.(); controller.close(); return; }
      const data = stats.bytes < prefix.length ? prefix.subarray(stats.bytes, Math.min(prefix.length, total)) : block.subarray(0, Math.min(block.length, total - stats.bytes));
      stats.bytes += data.length; controller.enqueue(data);
    },
    cancel() { stats.cancels++; return onCancel?.(); }
  }, { highWaterMark: 0 });
  const headers = { 'content-type': 'application/json', ...(declared === null ? {} : { 'content-length': declared }) };
  return { response: new Response(body, { headers }), stats };
}

function restoredSession(client, { hasCompletedOperation = true } = {}) {
  const sdk = { root: {}, currentPage: {} }; // MODEL only; no Figma connection.
  // An explicit synthetic completed-operation proof precedes reader checks. It
  // is not a network/server integration test and never authorizes a finish POST.
  const adapter = { ...client, async queryOperation(id) { assert.equal(id, operationId); return completedOperation(); } };
  const session = createProductionSession({ sdk, adapter, namespace: `src_budget_${'b'.repeat(32)}`, cryptoAPI: webcrypto });
  session.restore({ phase: 'verificationPending', sessionId: 'session', ...(hasCompletedOperation ? { operationId } : {}), projectId: 'project', groupId: 'group',
    total: 1, done: 1, expectedFrameIds: [target.figmaNodeId], completed: [{ sessionId: 'session', status: 'committed', frames: [{ ...target, status: 'committed' }] }] });
  return session;
}
async function claimWriter(client) {
  assert.deepEqual(await client.intent('project'), { operationId, projectId: 'project' });
  const result = await client.claim({ operationId, projectId: 'project', frameIds: [target.figmaNodeId], groupId: 'group' });
  assert.equal(result.operationId, operationId); assert.equal(result.status, 'open');
}
function assertPending(session) {
  const state = session.status();
  assert.deepEqual([state.phase, state.verified, state.locked], ['verificationPending', false, true]);
}

test('没有已完成 operation 证明时，完整读取仍保持待确认', async (_t, directory) => {
  const dtos = await readerDTOs(directory), { client, calls } = modelClient(dtos);
  const session = restoredSession(client, { hasCompletedOperation: false });
  const result = await session.query();
  assert.deepEqual([result.state.phase, result.state.verified, result.state.locked], ['verificationPending', false, true]);
  assertPending(session);
  assert.deepEqual(calls.map(call => [call.method, call.path]), Object.values(routes).map(route => ['GET', route]));
});

test('四条真实 DTO 均超过 4 MiB，经本地 HTTP 完整读取后才标记成功', async (t, directory) => {
  assert.deepEqual(PRODUCTION_VERIFICATION_LIMITS, ceilings);
  assert.equal(PRODUCTION_RESPONSE_LIMIT, 4 * MiB);
  const dtos = await readerDTOs(directory, true), files = {}, sizes = {};
  for (const kind of Object.keys(routes)) {
    const bytes = encode(dtos[kind]);
    assert.ok(bytes.length > 4 * MiB && bytes.length < ceilings[kind], `${kind}: ${bytes.length}`);
    files[routes[kind]] = path.join(directory, `${kind}.json`); sizes[kind] = bytes.length;
    await fs.writeFile(files[routes[kind]], bytes, { flag: 'wx' });
  }
  const seen = [], serverErrors = []; let physical = 0, peak = 0;
  const server = http.createServer((req, res) => {
    seen.push([req.method, req.url]); physical++; peak = Math.max(peak, physical);
    res.once('close', () => { physical--; });
    const kind = Object.keys(routes).find(key => routes[key] === req.url);
    if (req.method !== 'GET' || !kind) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': sizes[kind] });
    const stream = createReadStream(files[req.url], { highWaterMark: 64 * 1024 });
    stream.on('error', error => { serverErrors.push(error); res.destroy(); }); stream.pipe(res);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createProductionHTTP({ origin, allowLocalhost: true, responseLimit: 4 * MiB,
    fetchAPI: (url, options) => { assert.equal(new URL(url).origin, origin); return fetch(url, options); } });
  client.setToken('synthetic.nonfigma');
  const session = restoredSession(client), result = await session.query();
  assert.deepEqual([result.state.phase, result.state.verified, result.state.locked], ['committed', true, false]);
  assert.deepEqual(seen, Object.values(routes).map(route => ['GET', route]));
  assert.equal(peak, 1); assert.equal(client.status().active, false); assert.deepEqual(serverErrors, []);
  await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ nonFigma: true, liveNetwork: false, sizes, requests: seen, peakPhysical: peak, verified: result.state.verified }, null, 2), { flag: 'wx' });
  t.diagnostic(`实际完整 DTO 字节数: ${JSON.stringify(sizes)}`);

  // A non-target frame from another group wins at the target's coordinates.
  // This late row is beyond 4 MiB; any target-only/first-N reduction is unsound.
  const rows = dtos.canvas.files[0].pages[0].frames;
  rows.push({ ...rows.at(-1), id: 'other-group-winner', groupId: null, publishedAt: '2026-02-01T00:00:00Z' });
  const model = modelClient(dtos);
  await assert.rejects(verify(model.client), { code: 'VISIBILITY_UNCONFIRMED' });
  assert.equal(model.calls.length, 2);
});

for (const kind of Object.keys(routes)) {
  test(`${kind}: 精确硬上限可读，实际流多 1 字节拒绝`, async (_t, directory) => {
    const dtos = await readerDTOs(directory), prefix = encode(dtos[kind]);
    const exact = byteStream(ceilings[kind], { prefix });
    const success = modelClient(dtos, key => key === kind ? exact.response : undefined);
    assert.deepEqual(await verify(success.client), expectedReceipt);
    assert.equal(exact.stats.bytes, ceilings[kind]);
    const excessive = byteStream(ceilings[kind] + 1, { declared: String(ceilings[kind]) });
    const failure = modelClient(dtos, key => key === kind ? excessive.response : undefined);
    await assert.rejects(verify(failure.client), { code: 'HTTP_BODY_TOO_LARGE' });
    assert.equal(excessive.stats.bytes, ceilings[kind] + 1); assert.equal(excessive.stats.cancels, 1);
    assert.equal(failure.calls.at(-1).path, routes[kind]); assert.equal(failure.client.status().active, false);
  });
  test(`${kind}: 声明超限在读取前拒绝`, async (_t, directory) => {
    const dtos = await readerDTOs(directory), stream = byteStream(2, { declared: String(ceilings[kind] + 1) });
    const { client } = modelClient(dtos, key => key === kind ? stream.response : undefined);
    await assert.rejects(verify(client), { code: 'HTTP_BODY_TOO_LARGE' });
    assert.equal(stream.stats.reads, 0); assert.equal(stream.stats.cancels, 1);
  });
  test(`${kind}: 截断、声明偏小和中途流错误均不报成功`, async (_t, directory) => {
    const dtos = await readerDTOs(directory), bytes = encode(dtos[kind]);
    for (const mode of ['truncated-json', 'short-valid-json', 'long-valid-json', 'stream-error']) {
      const stream = mode === 'truncated-json' ? byteStream(bytes.length - 1, { prefix: bytes, declared: String(bytes.length) })
        : mode === 'short-valid-json' ? byteStream(bytes.length, { prefix: bytes, declared: String(bytes.length + 1) })
        : mode === 'long-valid-json' ? byteStream(bytes.length, { prefix: bytes, declared: String(bytes.length - 1) })
        : byteStream(bytes.length, { prefix: bytes, faultAfter: bytes.length });
      const { client, calls } = modelClient(dtos, key => key === kind ? stream.response : undefined);
      const session = restoredSession(client);
      await assert.rejects(session.query(), { code: mode === 'stream-error' ? 'HTTP_FAILED' : 'HTTP_RESPONSE_INVALID' });
      assertPending(session); assert.equal(calls.at(-1).path, routes[kind]); assert.equal(client.status().active, false);
    }
  });
}

test('真实 session：四类物理超限、截断和取消后只允许读取核验，禁止重发', async (_t, directory) => {
  const dtos = await readerDTOs(directory);
  for (const kind of Object.keys(routes)) for (const mode of ['physical-overflow', 'truncated', 'cancelled']) {
    const controller = new AbortController(), streams = [];
    const { client, calls } = modelClient(dtos, key => {
      if (key !== kind) return;
      const bytes = encode(dtos[kind]);
      const stream = mode === 'physical-overflow'
        ? byteStream(ceilings[kind] + 1, { declared: String(ceilings[kind]) })
        : mode === 'truncated'
          ? byteStream(bytes.length - 1, { prefix: bytes, declared: String(bytes.length) })
          : byteStream(bytes.length, { prefix: bytes, onEOF: () => controller.abort() });
      streams.push(stream); return stream.response;
    });
    const session = restoredSession(client);
    const code = mode === 'physical-overflow' ? 'HTTP_BODY_TOO_LARGE' : mode === 'truncated' ? 'HTTP_RESPONSE_INVALID' : 'CANCELLED';
    await assert.rejects(session.query({ signal: controller.signal }), { code }, `${kind}/${mode}`);
    assertPending(session);
    if (mode === 'physical-overflow') {
      assert.equal(streams[0].stats.bytes, ceilings[kind] + 1);
      assert.equal(streams[0].stats.cancels, 1);
    }
    const count = calls.length;
    await assert.rejects(session.publish({ projectId: 'project' }), { code: 'UNKNOWN_COMMIT' });
    await assert.rejects(session.abort(), error => ['BAD_SCHEMA', 'UNKNOWN_COMMIT'].includes(error?.code));
    assert.equal(calls.length, count, `${kind}/${mode}: no publish or abort request`);
    assertPending(session);
    // Retrying verification is read-only and must not silently republish.
    await assert.rejects(session.query({ signal: controller.signal }), { code });
    assertPending(session);
    assert.ok(calls.every(call => call.method === 'GET' && Object.values(routes).includes(call.path)), `${kind}/${mode}: no prepare/upload/commit`);
    assert.equal(client.status().active, false);
  }
});

test('严格 Content-Length 数字、安全整数及必需头；canvas 无长度时仍有硬上限', async (_t, directory) => {
  const dtos = await readerDTOs(directory);
  for (const kind of Object.keys(routes)) {
    for (const declared of ['', '-1', '1.5', '+2', '1e3', '0x10', '2, 2', 'NaN', 'Infinity', '9007199254740993']) {
      const stream = byteStream(2, { declared });
      const { client } = modelClient(dtos, key => key === kind ? stream.response : undefined);
      await assert.rejects(verify(client), { code: 'HTTP_RESPONSE_INVALID' });
      assert.equal(stream.stats.reads, 0); assert.equal(stream.stats.cancels, 1);
    }
    for (const declared of [null, '0']) {
      const bytes = encode(dtos[kind]), stream = byteStream(bytes.length, { prefix: bytes, declared });
      const { client } = modelClient(dtos, key => key === kind ? stream.response : undefined);
      if (kind === 'canvas' && declared === null) assert.deepEqual(await verify(client), expectedReceipt);
      else await assert.rejects(verify(client), { code: 'HTTP_RESPONSE_INVALID' });
    }
  }
  const stream = byteStream(ceilings.canvas + 1, { declared: null });
  const { client } = modelClient(dtos, kind => kind === 'canvas' ? stream.response : undefined);
  await assert.rejects(verify(client), { code: 'HTTP_BODY_TOO_LARGE' });
  assert.equal(stream.stats.bytes, ceilings.canvas + 1);
});

test('HTTP 200 的错误归属、组、修订、全量目录和代次仍由既有校验拒绝', async (_t, directory) => {
  const baseline = await readerDTOs(directory);
  const faults = {
    'canvas-project': d => { d.canvas.id = 'wrong'; },
    'directory-project': d => { d.directory.projectId = 'wrong'; },
    'directory-row-project': d => { d.directory.frames[0].projectId = 'wrong'; },
    'directory-node': d => { d.directory.frames[0].figmaNodeId = '9:9'; },
    'directory-group': d => { d.directory.frames[0].groupId = null; },
    'canvas-group': d => { d.canvas.files[0].pages[0].frames[0].groupId = null; },
    'missing-selected-group': d => { d.directory.groups = []; },
    'old-canvas-revision': d => { d.canvas.files[0].pages[0].frames[0].currentRevisionId = 'old'; },
    'old-directory-revision': d => { d.directory.frames[0].revisionId = 'old'; },
    'invalid-unselected-row': d => { d.directory.frames.push({ frameId: 'unselected' }); },
    'duplicate-directory-row': d => { d.directory.frames.push({ ...d.directory.frames[0] }); },
    'history-frame': d => { d.revisions.frameId = 'wrong'; },
    'history-current': d => { d.revisions.currentRevisionId = 'old'; },
    'history-missing-current': d => { d.revisions.revisions = []; },
    'history-duplicate': d => { d.revisions.revisions.push({ ...d.revisions.revisions[0] }); },
    'history-row-frame': d => { d.revisions.revisions[0].frameId = 'wrong'; },
    'snapshot-group': d => { d.snapshot.frame.groupId = null; },
    'snapshot-layer-node': d => { d.snapshot.layerDoc.frame.id = '9:9'; },
    'snapshot-layer-missing': d => { d.snapshot.layerDoc = null; },
    'context-project': d => { d.snapshot.context.projectId = 'wrong'; },
    'context-file': d => { d.snapshot.context.designFileId = 'wrong'; }
  };
  for (const kind of ['directory', 'revisions', 'snapshot']) faults[`${kind}-generation`] = d => { d[kind].catalogReadVersion = `${'a'.repeat(32)}:8`; };
  for (const key of ['projectId', 'designFileId', 'pageId', 'frameId', 'revisionId', 'figmaNodeId']) faults[`identity-${key}`] = d => { d.snapshot.identity[key] = 'wrong'; };
  for (const list of ['assets', 'slices']) for (const key of ['projectId', 'designFileId', 'frameId', 'revisionId', 'byteLength']) faults[`${list}-${key}`] = d => {
    d.snapshot[list].push({ assetId: 'synthetic-asset', projectId: 'project', designFileId: 'file', frameId: 'target', revisionId: 'revision', byteLength: 10, [key]: key === 'byteLength' ? 0 : 'wrong' });
  };
  for (const [name, corrupt] of Object.entries(faults)) {
    const dtos = structuredClone(baseline); corrupt(dtos);
    const { client } = modelClient(dtos), session = restoredSession(client);
    await assert.rejects(session.query(), { code: 'VISIBILITY_UNCONFIRMED' }, name); assertPending(session);
  }
});

test('写响应仍为 4 MiB，context 不能提升预算，读取失败没有 HTTP 200 捷径', async (_t, directory) => {
  const dtos = await readerDTOs(directory);
  assert.throws(() => createProductionHTTP({ origin: 'http://127.0.0.1', allowLocalhost: true, responseLimit: 4 * MiB + 1 }), { code: 'BAD_SCHEMA' });
  for (const declared of [null, String(4 * MiB + 1)]) {
    const stream = byteStream(4 * MiB + 1, { declared });
    const { client } = modelClient(dtos, kind => kind === undefined ? stream.response : undefined);
    assert.deepEqual(await verify(client), expectedReceipt);
    await claimWriter(client);
    await assert.rejects(client.commit('session', operationId, { responseLimit: Infinity, verificationLimit: Infinity, strictLength: false }), { code: 'HTTP_BODY_TOO_LARGE' });
  }
  for (const status of [200, 401, 500]) {
    const { client } = modelClient(dtos, kind => kind === 'snapshot' ? new Response('{}', { status, headers: { 'content-type': 'application/json', 'content-length': '2' } }) : undefined);
    const session = restoredSession(client);
    await assert.rejects(session.query(), { code: status === 200 ? 'VISIBILITY_UNCONFIRMED' : 'HTTP_FAILED' }); assertPending(session);
    if (status === 401) assert.equal(client.status().authenticated, false);
  }
});

test('末次快照在取消后仍返回完整 DTO 时不可成功；commit 保留完整确认优先语义', async (_t, directory) => {
  const dtos = await readerDTOs(directory), aborter = new AbortController();
  const bytes = encode(dtos.snapshot), stream = byteStream(bytes.length, { prefix: bytes, onEOF: () => aborter.abort() });
  const { client, calls } = modelClient(dtos, kind => kind === 'snapshot' ? stream.response : undefined);
  const session = restoredSession(client);
  await assert.rejects(session.query({ signal: aborter.signal }), { code: 'CANCELLED' }); assertPending(session);
  assert.equal(calls.length, 4); assert.equal(client.status().active, false);
  const late = new AbortController(), ack = { sessionId: 'session', status: 'committed', frames: [] }, encoded = encode(ack);
  const write = byteStream(encoded.length, { prefix: encoded, onEOF: () => late.abort() });
  const ordinary = modelClient(dtos, () => write.response);
  await claimWriter(ordinary.client);
  assert.deepEqual(await ordinary.client.commit('session', operationId, { signal: late.signal }), ack);
});

test('取消和超时不能提前释放物理请求槽，fetch 忽略 abort 也不可误报成功', async (_t, directory) => {
  const dtos = await readerDTOs(directory);
  for (const timedOut of [false, true]) {
    const fetchGate = deferred(), started = deferred(), aborted = deferred(), controller = new AbortController();
    const { client, calls } = modelClient(dtos, async (kind, request) => {
      if (kind !== 'snapshot') return;
      request.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); started.resolve();
      await fetchGate.promise; return jsonResponse(dtos.snapshot); // Deliberately ignores abort.
    }, { timeoutMs: timedOut ? 100 : 120000 });
    const session = restoredSession(client), pending = session.query({ signal: controller.signal });
    const rejected = assert.rejects(pending, { code: timedOut ? 'REQUEST_TIMEOUT' : 'CANCELLED' });
    await started.promise; if (!timedOut) controller.abort(); await aborted.promise;
    assert.equal(client.status().active, true);
    await assert.rejects(verify(client), { code: 'BUSY' }); assert.equal(calls.length, 4);
    fetchGate.resolve(); await rejected; assertPending(session); assert.equal(client.status().active, false);
  }
});

test('等待 reader.cancel 真实完成期间保持 BUSY，完成后才能再请求', async (_t, directory) => {
  const dtos = await readerDTOs(directory), cancelGate = deferred(), cancelling = deferred();
  const stream = byteStream(2, { declared: String(ceilings.canvas + 1), onCancel: () => { cancelling.resolve(); return cancelGate.promise; } });
  let first = true;
  const { client, calls } = modelClient(dtos, () => { if (first) { first = false; return stream.response; } });
  const pending = verify(client), rejected = assert.rejects(pending, { code: 'HTTP_BODY_TOO_LARGE' });
  await cancelling.promise; assert.equal(client.status().active, true);
  await assert.rejects(verify(client), { code: 'BUSY' }); assert.equal(calls.length, 1);
  cancelGate.resolve(); await rejected; assert.equal(client.status().active, false);
  assert.deepEqual(await verify(client), expectedReceipt);
});

test('取消失败且物理结束未确认时不成功、不解锁、不发第二个请求', async (_t, directory) => {
  const dtos = await readerDTOs(directory), controller = new AbortController(), closed = deferred(), cancelling = deferred();
  let cancelCalls = 0, releaseCalls = 0;
  // Deliberately faulty transport model, NOT a conforming browser/Figma reader:
  // it ignores abort, rejects cancellation and never confirms physical closure.
  const response = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', 'content-length': '2' }),
    body: { getReader: () => ({ closed: closed.promise,
      async read() { controller.abort(); return { done: false, value: Buffer.from('{}') }; },
      async cancel() { cancelCalls++; cancelling.resolve(); throw new Error('synthetic cancellation failed'); },
      releaseLock() { releaseCalls++; }
    }) } };
  const { client, calls } = modelClient(dtos, kind => kind === 'snapshot' ? response : undefined);
  const session = restoredSession(client), pending = session.query({ signal: controller.signal });
  let terminal = false; void pending.then(() => { terminal = true; }, () => { terminal = true; });
  await cancelling.promise; await turn();
  assert.equal(terminal, false, 'no terminal RPC result without confirmed physical settlement');
  assert.equal(session.status().locked, true); assert.equal(session.status().verified, false);
  assert.equal(cancelCalls, 1); assert.equal(releaseCalls, 1); assert.equal(client.status().active, true);
  await assert.rejects(verify(client), { code: 'BUSY' }); assert.equal(calls.length, 4);
  // reader.closed after a rejected cancel is not independent proof of source cleanup.
  closed.resolve(); await turn(); assert.equal(terminal, false); assert.equal(client.status().active, true);
});

test('原生 ReadableStream.cancel 先关闭流再拒绝，不得当作底层取消成功', async (_t, directory) => {
  const dtos = await readerDTOs(directory), cancelGate = deferred(), cancelling = deferred();
  const stream = byteStream(2, { declared: String(ceilings.canvas + 1), onCancel: () => { cancelling.resolve(); return cancelGate.promise; } });
  const { client, calls } = modelClient(dtos, () => stream.response), session = restoredSession(client);
  const pending = session.query(); let terminal = false;
  void pending.then(() => { terminal = true; }, () => { terminal = true; });
  await cancelling.promise; await turn();
  assert.equal(client.status().active, true);
  cancelGate.reject(new Error('synthetic underlying cancellation failure'));
  await turn(); assert.equal(terminal, false);
  assert.equal(session.status().locked, true); assert.equal(session.status().verified, false);
  assert.equal(client.status().active, true);
  await assert.rejects(verify(client), { code: 'BUSY' }); assert.equal(calls.length, 1);
});

test('真实 bridge 不在取消失败且物理未结束时发 terminalAck 或完成 close', async (_t, directory) => {
  const dtos = await readerDTOs(directory), cancelling = deferred(), closed = deferred(), sent = [];
  const response = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', 'content-length': String(ceilings.canvas + 1) }),
    body: { getReader: () => ({ closed: closed.promise, async read() { return { done: false, value: Buffer.from('{}') }; },
      async cancel() { cancelling.resolve(); throw new Error('synthetic cancel rejected'); }, releaseLock() {} }) } };
  const { client } = modelClient(dtos, kind => kind === 'canvas' ? response : undefined);
  const bridge = createBridge({ channel: 'budget-check', send: message => sent.push(message), subscribe: () => () => {}, trustedPeer: () => true,
    handlers: { verification: (_payload, { signal }) => verify(client, { signal }) } });
  let received = false, closedBridge = false;
  void bridge.receive({ v: 1, channel: 'budget-check', kind: 'request', requestId: 'request-1', operation: 'verification', payload: {} }, {}).then(() => { received = true; });
  await cancelling.promise; await turn();
  void bridge.close().then(() => { closedBridge = true; });
  closed.resolve(); await turn();
  assert.equal(received, false); assert.equal(closedBridge, false);
  assert.equal(sent.some(message => message.kind === 'terminalAck'), false);
  assert.equal(bridge.snapshot().incoming, 1); assert.equal(client.status().active, true);
});

test('真实本地 HTTP 快照连接在部分数据后中断，不接受 200 或释放前并发', async (t, directory) => {
  const dtos = await readerDTOs(directory), seen = [], snapshotStarted = deferred(), cutConnection = deferred();
  const server = http.createServer(async (req, res) => {
    seen.push(req.url);
    const kind = Object.keys(routes).find(key => routes[key] === req.url);
    if (req.method !== 'GET' || !kind) { res.writeHead(404); res.end(); return; }
    const bytes = encode(dtos[kind]);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    if (kind !== 'snapshot') { res.end(bytes); return; }
    res.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => snapshotStarted.resolve());
    await cutConnection.promise; res.destroy();
  });
  t.after(async () => { cutConnection.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createProductionHTTP({ origin, allowLocalhost: true,
    fetchAPI: (url, options) => { assert.equal(new URL(url).origin, origin); return fetch(url, options); } });
  client.setToken('synthetic.nonfigma');
  const session = restoredSession(client), pending = session.query();
  const rejected = assert.rejects(pending, error => error.code === 'HTTP_FAILED' && error.status === 200);
  await snapshotStarted.promise; assert.equal(client.status().active, true);
  await assert.rejects(verify(client), { code: 'BUSY' }); assert.equal(seen.length, 4);
  cutConnection.resolve(); await rejected; assertPending(session); assert.equal(client.status().active, false);
  await fs.writeFile(path.join(directory, 'interrupted-http.json'), JSON.stringify({ nonFigma: true, seen, verified: session.status().verified }), { flag: 'wx' });
});
