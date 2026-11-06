import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createProductionHTTP } from '../插件/production-protocol.mjs';
import { sha256 } from '../插件/core.mjs';
import { createProductionSession } from '../插件/production-session.mjs';

test('writer capability stays in network UI and frames only operation assets', async () => {
  const calls = []; let secret;
  const asset = new Uint8Array([1, 2, 3]); const hash = await sha256(asset, webcrypto);
  const fetchAPI = async (url, init) => {
    const body = init.body instanceof Uint8Array && init.method === 'PUT' ? init.body : init.body ? JSON.parse(new TextDecoder().decode(init.body)) : null;
    calls.push({ url, method: init.method, body, headers: init.headers });
    let value;
    if (url.endsWith('/api/publish/operations')) { secret = body.writerSecret; value = { operationId: body.operationId, projectId: body.projectId, frameIds: body.frameIds, groupId: body.groupId, createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: body.frameIds, status: 'open' }; }
    else if (init.method === 'PUT') value = { ok: true, sha256: hash, bytes: asset.length, mime: 'image/png' };
    else value = { sessionId: 'sid', status: 'committed', frames: [] };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:1234', allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); client.setToken('token');
  const claim = await client.claim({ operationId: 'op_1', projectId: 'p', frameIds: ['n'], groupId: null });
  assert.equal(Object.hasOwn(claim, 'writerSecret'), false); assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  await client.upload('sid', { sha256: hash, bytes: asset.length, mime: 'image/png', data: asset }, 'op_1');
  const put = calls[1]; assert.deepEqual([...put.body.slice(0, 4)], [71,76,80,49]); assert.deepEqual([...put.body.slice(4,36)], [...Buffer.from(secret, 'base64url')]); assert.deepEqual([...put.body.slice(36)], [...asset]); assert.equal(put.headers['X-Asset-Mime'], 'image/png');
  await client.commit('sid', 'op_1'); assert.deepEqual(calls[2].body, { writerSecret: secret });
  await assert.rejects(client.commit('sid', 'other'));
  client.setToken('different-account-token'); await assert.rejects(client.commit('sid', 'op_1'));
});

test('finish sends reader version with writer secret and preserves 409 without retry', async () => {
  let secret, posts = 0; const version = `${'a'.repeat(32)}:1`;
  const fetchAPI = async (url, init) => { const body = JSON.parse(new TextDecoder().decode(init.body)); if (url.endsWith('/finish')) { posts++; assert.deepEqual(body, { writerSecret: secret, catalogReadVersion: version }); return new Response('{}', { status: 409, headers: { 'content-type': 'application/json' } }); } secret = body.writerSecret; return Response.json({ operationId: body.operationId, projectId: body.projectId, frameIds: body.frameIds, groupId: body.groupId, createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: body.frameIds, status: 'open' }); };
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:1234', allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); client.setToken('token'); await client.claim({ operationId: 'op_1', projectId: 'p', frameIds: ['n'], groupId: null }); await assert.rejects(client.finish('op_1', version), { status: 409 }); assert.equal(posts, 1);
});

test('operation DTO rejects unknown extension even if it embeds the writer capability', async () => {
  const fetchAPI = async (_url, init) => { const body = JSON.parse(new TextDecoder().decode(init.body)); const value = { operationId: body.operationId, projectId: body.projectId, frameIds: body.frameIds, groupId: body.groupId, createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: body.frameIds, status: 'open', extra: `prefix-${body.writerSecret}` }; return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); };
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:1234', allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); client.setToken('token'); await assert.rejects(client.claim({ operationId: 'op_1', projectId: 'p', frameIds: ['n'], groupId: null }));
});

test('journal precedes claim and mismatched claim never resolves source', async () => {
  const frame = { id: 'n', type: 'FRAME', name: 'frame' }; const page = { id: 'page', children: [frame], selection: [frame] }; const sdk = { root: { children: [page] }, currentPage: page, fileKey: 'file' }; const events = [];
  const adapter = { intent: async projectId => ({ projectId, operationId: `op_${'1'.repeat(32)}_${'a'.repeat(64)}` }), projects: async () => [{ id: 'p', name: 'p', permissions: { canPublish: true } }], claim: async input => { events.push(['claim', input.operationId]); return { ...input, projectId: 'other', status: 'open' }; }, queryOperation: async op => ({ operationId: op, projectId: 'p', frameIds: ['n'], groupId: null }), finish: async () => { throw Error('unexpected'); }, publishSource: async () => { events.push(['source']); throw Error('unexpected'); }, prepare: async () => {}, upload: async () => {}, commit: async () => {}, query: async () => {}, abort: async () => {} };
  const session = createProductionSession({ sdk, adapter, namespace: `src_window_${'a'.repeat(32)}`, cryptoAPI: webcrypto, journal: async s => events.push(['journal', s.phase, s.operationId]) });
  await assert.rejects(session.publish({ projectId: 'p' }), { code: 'HTTP_RESPONSE_INVALID' });
  const claim = events.findIndex(e => e[0] === 'claim'); assert.ok(claim > 0); assert.deepEqual(events[claim - 1], ['journal', 'claiming', events[claim][1]]); assert.equal(events.some(e => e[0] === 'source'), false); assert.equal(session.status().locked, true); await session.query(); assert.equal(session.status().locked, true);
});

test('reader snapshot above 65 MiB is rejected from header before buffering', async () => {
  const version = `${'a'.repeat(32)}:1`; let reads = 0;
  const fetchAPI = async url => {
    if (url.includes('/inspector/frames/')) return { ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json', 'content-length': String(65 * 1024 * 1024 + 1) }), body: { getReader: () => ({ closed: new Promise(() => {}), read: async () => { reads++; return { done: true }; }, cancel: async () => {}, releaseLock() {} }) } };
    let value;
    if (url.endsWith('/canvas')) value = { catalogReadVersion: version, id: 'p', groups: [], frames: [{ id: 'f', currentRevisionId: 'r', groupId: null, x: 0, y: 0, width: 1, height: 1 }] };
    else if (url.endsWith('/directory')) value = { catalogReadVersion: version, projectId: 'p', groups: [], frames: [{ frameId: 'f', projectId: 'p', designFileId: 'd', pageId: 'page', revisionId: 'r', currentRevisionId: 'r', figmaNodeId: 'n', groupId: null }] };
    else value = { catalogReadVersion: version, frameId: 'f', currentRevisionId: 'r', revisions: [{ id: 'r' }] };
    const bytes = new TextEncoder().encode(JSON.stringify(value)); return new Response(bytes, { headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
  };
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:1234', allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); client.setToken('token');
  await assert.rejects(client.verifyPublication('p', null, [{ figmaNodeId: 'n', frameId: 'f', revisionId: 'r' }]), { code: 'HTTP_BODY_TOO_LARGE' }); assert.equal(reads, 0);
});

test('oversized operation GET stream stays locked without any repeated writes', async () => {
  const frame = { id: 'n', type: 'FRAME' }; const page = { id: 'page', children: [frame], selection: [frame] }; const sdk = { root: { children: [page] }, currentPage: page, fileKey: 'file' }; const calls = []; let emitted = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const fetchAPI = async (url, init) => { calls.push([init.method, url]); return new Response(new ReadableStream({ pull(controller) { if (emitted++ < 66) controller.enqueue(chunk); else controller.close(); } }), { headers: { 'content-type': 'application/json' } }); };
  const http = createProductionHTTP({ origin: 'http://127.0.0.1:1234', allowLocalhost: true, fetchAPI, cryptoAPI: webcrypto }); http.setToken('token');
  const never = async () => { throw new Error('unexpected write'); };
  const adapter = { intent: never, projects: never, claim: never, finish: never, publishSource: never, prepare: never, upload: never, commit: never, abort: never, query: never, queryOperation: http.queryOperation };
  const session = createProductionSession({ sdk, adapter, namespace: `src_window_${'c'.repeat(32)}`, cryptoAPI: webcrypto }); session.restore({ phase: 'unknownFinish', operationId: 'op_1', sessionId: null, projectId: 'p', groupId: null, expectedFrameIds: ['n'] });
  await assert.rejects(session.query(), { code: 'HTTP_BODY_TOO_LARGE' }); assert.equal(session.status().locked, true); assert.equal(session.status().verified, false); assert.equal(calls.length, 1); assert.deepEqual(calls.map(c => c[0]), ['GET']); assert.ok(emitted >= 66);
});

test('explicit recovery of signed unclaimed intent accepts only empty tombstone', async () => {
  const operationId = `op_${'a'.repeat(32)}_${'b'.repeat(64)}`; const frame = { id: 'n', type: 'FRAME' }, page = { id: 'page', children: [frame], selection: [frame] }, sdk = { root: { children: [page] }, currentPage: page, fileKey: 'file' }; let cancels = 0; const writes = [];
  const dto = { operationId, projectId: 'p', status: 'cancelled', cancelTombstone: true, frameIds: [], lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: [] };
  const never = async () => { writes.push('unexpected'); throw Error('unexpected'); };
  const adapter = { intent: never, projects: never, claim: never, finish: never, publishSource: never, prepare: never, upload: never, commit: never, abort: never, query: never, queryOperation: async () => dto, recoverCancel: async (op, project) => { cancels++; assert.equal(op, operationId); assert.equal(project, 'p'); return dto; } };
  const make = () => createProductionSession({ sdk, adapter, namespace: `src_window_${'b'.repeat(32)}`, cryptoAPI: webcrypto });
  const session = make(); session.restore({ phase: 'unknownClaim', operationId, sessionId: null, projectId: 'p', groupId: null, expectedFrameIds: ['n'], completed: [], done: 0 }); await session.abort(); assert.equal(session.status().phase, 'aborted'); await session.query(); assert.equal(cancels, 1); assert.deepEqual(writes, []);
  const inconsistent = make(); inconsistent.restore({ phase: 'unknownPrepare', operationId, sessionId: null, projectId: 'p', groupId: null, expectedFrameIds: ['n'], batchIndex: 0, requestHash: 'c'.repeat(64), batchFrameIds: ['n'] }); await assert.rejects(inconsistent.abort()); assert.equal(inconsistent.status().locked, true);
});

test('legacy journal and reopened completed or unknown-finish operation remain read-only', async () => {
  const frame = { id: 'n', type: 'FRAME' }; const page = { id: 'page', children: [frame], selection: [frame] }; const sdk = { root: { children: [page] }, currentPage: page, fileKey: 'file' }; const calls = [];
  const forbidden = name => async () => { calls.push(name); throw Error('unexpected write'); };
  const adapter = { intent: forbidden('intent'), projects: forbidden('projects'), claim: forbidden('claim'), finish: forbidden('finish'), publishSource: forbidden('source'), prepare: forbidden('prepare'), upload: forbidden('upload'), commit: forbidden('commit'), abort: forbidden('abort'), query: forbidden('sid'), queryOperation: async op => { calls.push('get'); return { operationId: op, projectId: 'p', frameIds: ['n'], groupId: null, status: 'open' }; } };
  const make = () => createProductionSession({ sdk, adapter, namespace: `src_window_${'b'.repeat(32)}`, cryptoAPI: webcrypto });
  const legacy = make(); legacy.restore({ phase: 'authorizing', sessionId: null, projectId: 'p' }); assert.equal(legacy.status().locked, true); await assert.rejects(legacy.publish({ projectId: 'p' }));
  for (const phase of ['unknownClaim', 'unknownFinish', 'committed']) {
    const restored = make(); restored.restore({ phase, operationId: 'op_1', sessionId: null, projectId: 'p', groupId: null, expectedFrameIds: ['n'] });
    await restored.query(); assert.equal(restored.status().locked, true); await assert.rejects(restored.abort());
  }
  assert.deepEqual(calls, ['get', 'get', 'get']);
});
