process.env.HANDOFF_PUBLIC_ORIGIN ||= 'https://service.example.test:49156';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { createProductionHTTP, validateSource, validateProjects, validatePrepareResult, validateCommitResult, validateSessionResult, validateRememberedLogin, validateProductionOperation, PRODUCTION_BODY_LIMIT } from '../插件/production-protocol.mjs';
import { jsonBytes, sha256 } from '../插件/core.mjs';
const expiresAt = '2099-01-01T00:00:00.000Z';
const source = { kind: 'figma-file', fileKey: 'ActualFigmaFileKey' };
const answer = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fixture(t, handler) {
  const seen = []; const server = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks); seen.push({ method: req.method, url: req.url, headers: req.headers, bytes }); try { await handler(req, res, bytes, seen); } catch { answer(res, { error: 'fixture' }, 500); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { seen, client: createProductionHTTP({ origin, allowLocalhost: true, cryptoAPI: webcrypto }), origin };
}
const authenticated = client => { client.setToken('twoSegment.hmacSignature'); return client; };
const operationId = `op_${'a'.repeat(32)}_${'b'.repeat(64)}`;
const claimDTO = input => ({ operationId: input.operationId, projectId: input.projectId, createdBy: 'fixture-user', status: 'open', frameIds: input.frameIds, groupId: input.groupId, createdAt: expiresAt, updatedAt: expiresAt, finishedAt: null, lockScope: 'service', automaticExpiry: false, batches: [], committedFrames: [], remainingFrameIds: input.frameIds });
function intentClaimRoutes(req, res, bytes) {
  if (req.method === 'GET' && req.url.startsWith('/api/publish/intent?')) { const projectId = new URL(req.url, 'http://fixture.test').searchParams.get('projectId'); return answer(res, { operationId, projectId }); }
  if (req.method === 'POST' && req.url === '/api/publish/operations') return answer(res, claimDTO(JSON.parse(bytes)));
  return false;
}
async function claimWriter(client, projectId, frameIds) {
  const intent = await client.intent(projectId);
  assert.equal(intent.operationId, operationId);
  const claimed = await client.claim({ operationId: intent.operationId, projectId, frameIds, groupId: null });
  assert.equal(claimed.operationId, intent.operationId);
  return intent.operationId;
}

// Regression inputs below are sanitized deployed wire shapes supplied by Parent,
// not observations of the production implementation or the AGPL QA fixture.
test('project group endpoints are project-scoped and reject malformed groups',async t=>{
  let bad=false;const {client,seen}=await fixture(t,(req,res,body)=>{
    if(req.url==='/api/projects/projectA/groups'&&req.method==='GET')return answer(res,{groups:bad?[{id:'groupA',projectId:'other',name:'游戏项目'}]:[{id:'groupA',projectId:'projectA',name:'游戏项目',frameCount:3}]});
    if(req.url==='/api/projects/projectA/groups'&&req.method==='POST')return answer(res,{group:{id:'groupB',projectId:'projectA',name:'新分组'}},201);
    if(req.url==='/api/projects'&&req.method==='POST')return answer(res,{id:'projectA',name:'新项目'},201);
    answer(res,{error:'unexpected'},404);
  });authenticated(client);
  assert.deepEqual(await client.frameGroups('projectA'),[{id:'groupA',projectId:'projectA',name:'游戏项目',frameCount:3}]);
  assert.equal((await client.createFrameGroup('projectA','新分组')).id,'groupB');
  assert.equal((await client.createProject('新项目')).id,'projectA');
  assert.equal(JSON.parse(seen.at(-1).bytes).name,'新项目');
  assert.equal(JSON.parse(seen.find(r=>r.url.endsWith('/groups')&&r.method==='POST').bytes).name,'新分组');
  await assert.rejects(client.createFrameGroup('projectA','bad\nname'),{code:'BAD_SCHEMA'});
  await assert.rejects(client.frameGroups('bad/id'),{code:'BAD_ID'});
  bad=true;await assert.rejects(client.frameGroups('projectA'),{code:'HTTP_RESPONSE_INVALID'});
});
test('deployed numeric remember expiry survives login, fixed refresh and SDK-storage schema without coercion', async t => {
  const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const { client, origin, seen } = await fixture(t, (req, res) => answer(res, { token: 'numeric.hmac', user: { id: 'u', username: 'user', role: 'designer' }, refreshExpiresAt, ...(req.url.endsWith('/login') ? { refreshToken: 'numeric-device' } : {}) }));
  const login = await client.login({ username: 'user', password: 'synthetic-password', rememberLogin: true });
  assert.equal(typeof login.refreshExpiresAt, 'number'); assert.equal(login.refreshExpiresAt, refreshExpiresAt);
  const stored = structuredClone({ origin, allowLocalhost: true, username: 'user', refreshToken: login.refreshToken, refreshExpiresAt: login.refreshExpiresAt });
  assert.equal(validateRememberedLogin(stored), stored); validateProductionOperation('production-control', { action: 'remember-write', remembered: stored });
  const refreshed = await client.refresh(stored.refreshToken); assert.equal(typeof refreshed.refreshExpiresAt, 'number'); assert.equal(refreshed.refreshExpiresAt, refreshExpiresAt); assert.equal(stored.refreshExpiresAt, refreshExpiresAt);
  assert.deepEqual(seen.map(r => r.url), ['/api/auth/login', '/api/auth/refresh']); assert.deepEqual(JSON.parse(seen[1].bytes), { refreshToken: 'numeric-device' });
});
test('remember expiry rejects unsafe/overflow/nonpositive/fractional values; session expiry remains ISO-only', async t => {
  const base = { origin: 'https://service.example', allowLocalhost: false, username: 'user', refreshToken: 'device' };
  for (const refreshExpiresAt of [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, 8640000000000001, Infinity, NaN, -1, 0, 1.5, null, true, 'not-a-date']) assert.throws(() => validateRememberedLogin({ ...base, refreshExpiresAt }));
  const { client } = await fixture(t, (_req, res) => answer(res, { token: 'must-not-accept.hmac', user: { id: 'u' }, refreshExpiresAt: Number.MAX_SAFE_INTEGER }));
  await assert.rejects(client.refresh('device'), { code: 'HTTP_RESPONSE_INVALID' }); assert.equal(client.status().authenticated, false);
  assert.throws(() => validateSessionResult({ sessionId: 'sid', status: 'open', expiresAt: Date.now() + 1000, uploaded: [], uploadPolicy: {}, frames: [] }, 'sid'));
});
test('prepare permits per-frame duplicate declared SHA, while top-level duplicates/extra/wrong-frame hashes still reject', () => {
  const docHash = 'a'.repeat(64); const pngHash = 'b'.repeat(64); const otherFrameHash = 'c'.repeat(64); const outside = 'd'.repeat(64);
  const body = { designFile: { designFileId: 'file' }, frames: [{ figmaNodeId: '2:1', layerDocSha256: docHash, previewSha256: pngHash, exports: [{ sha256: pngHash }] }, { figmaNodeId: '2:2', layerDocSha256: otherFrameHash, exports: [] }] };
  const value = { sessionId: 'sid', status: 'open', expiresAt, designFileId: 'file', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: {}, missingAssetSha256: [docHash, pngHash, otherFrameHash], frames: [{ figmaNodeId: '2:1', frameId: 'platform1', status: 'new', missingAssetSha256: [docHash, pngHash, pngHash] }, { figmaNodeId: '2:2', frameId: 'platform2', status: 'new', missingAssetSha256: [otherFrameHash] }] };
  assert.equal(validatePrepareResult(value, body), value); assert.deepEqual(value.frames[0].missingAssetSha256, [docHash, pngHash, pngHash]);
  const reject = mutate => { const candidate = structuredClone(value); mutate(candidate); assert.throws(() => validatePrepareResult(candidate, body)); };
  reject(r => r.missingAssetSha256.push(pngHash)); reject(r => r.missingAssetSha256.push(outside)); reject(r => r.frames[0].missingAssetSha256.push(outside)); reject(r => r.frames[0].missingAssetSha256.push(otherFrameHash)); reject(r => r.frames[0].missingAssetSha256.push('not-a-sha')); reject(r => { r.missingAssetSha256 = [docHash, otherFrameHash]; });
});
test('commit optional idempotent is strictly boolean and retains exact original mapping/sid', () => {
  const frames = [{ figmaNodeId: '2:1', frameId: 'platform-frame', revisionId: 'original-revision', previousRevisionId: null, status: 'new' }];
  const value = { sessionId: 'original-sid', status: 'committed', idempotent: true, frames };
  assert.equal(validateCommitResult(value, 'original-sid', frames), value); assert.equal(validateCommitResult({ ...value, idempotent: false }, 'original-sid', frames).idempotent, false);
  for (const idempotent of ['true', 1, null, {}, undefined]) assert.throws(() => validateCommitResult({ ...value, idempotent }, 'original-sid', frames));
  assert.throws(() => validateCommitResult({ ...value, extra: true }, 'original-sid', frames)); assert.throws(() => validateCommitResult(value, 'different-sid', frames));
});

test('production actual local HTTP login uses bare payload, optional remember and no cookies/custom CORS headers', async t => {
  const { client, seen } = await fixture(t, (req, res) => answer(res, { token: 'twoSegment.hmacSignature', user: { id: 'user1', role: 'developer' }, refreshToken: 'device-token', refreshExpiresAt: expiresAt }));
  const result = await client.login({ username: 'synthetic-user', password: 'synthetic-password', rememberLogin: true });
  assert.equal(result.user.role, 'developer'); assert.deepEqual(JSON.parse(seen[0].bytes), { username: 'synthetic-user', password: 'synthetic-password', rememberLogin: true });
  assert.equal(seen[0].url, '/api/auth/login'); assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].headers.cookie, undefined); assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(Object.keys(seen[0].headers).some(k => k.startsWith('x-independent-')), false);
});
test('login false does not send rememberLogin:false; subsequent me is bearer GET', async t => {
  const { client, seen } = await fixture(t, (req, res) => answer(res, req.url.endsWith('/login') ? { token: 'opaque.hmac', user: { id: 'u' } } : { id: 'u', username: 'user', role: 'developer' }));
  await client.login({ username: 'user', password: 'password' }); await client.me();
  assert.deepEqual(JSON.parse(seen[0].bytes), { username: 'user', password: 'password' }); assert.equal(seen[1].method, 'GET'); assert.equal(seen[1].headers.authorization, 'Bearer opaque.hmac'); assert.equal(seen[1].bytes.length, 0);
});
test('projects accepts only array or projects wrapper; permissions remain authoritative', async t => {
  const { client } = await fixture(t, (req, res) => answer(res, { projects: [{ id: 'p', name: 'Read only', permissions: { canPublish: false } }] }));
  const projects = await authenticated(client).projects(); assert.equal(projects[0].permissions.canPublish, false);
  assert.deepEqual(validateProjects(projects), projects); assert.throws(() => validateProjects({ data: projects })); assert.throws(() => validateProjects([{ id: 'p', name: 'P', permissions: {} }]));
});
test('publish-source uses actual Figma IDs after intent/claim and verifies exact source/file/bases', async t => {
  const { client, seen } = await fixture(t, (req, res, bytes) => {
    if (intentClaimRoutes(req, res, bytes) !== false) return;
    if (req.url === '/api/projects/p/publish-source' && req.method === 'POST') { const body = JSON.parse(bytes); return answer(res, { projectId: 'p', designFileId: 'platform-file', source: body.source, baseRevisions: { '2:1': null, '2:2': 'old-revision' } }); }
    answer(res, { error: 'unexpected' }, 404);
  });
  authenticated(client);
  const frames = ['2:1', '2:2']; const opId = await claimWriter(client, 'p', frames);
  const claimRequest = JSON.parse(seen.find(r => r.url === '/api/publish/operations' && r.method === 'POST').bytes);
  assert.match(claimRequest.writerSecret, /^[A-Za-z0-9_-]{43}$/);
  const body = { source, name: 'display only', frameIds: frames };
  const result = await client.publishSource('p', body, opId);
  assert.equal(result.designFileId, 'platform-file'); assert.equal(seen.at(-1).url, '/api/projects/p/publish-source');
  const publishRequest = JSON.parse(seen.at(-1).bytes);
  assert.deepEqual(publishRequest, { ...body, operationId: opId, writerSecret: claimRequest.writerSecret });
  assert.equal(Object.hasOwn(result, 'writerSecret'), false);
  const requestCount = seen.length;
  await assert.rejects(client.publishSource('p', { source, frameIds: ['2:1', '2:1'] }, opId)); assert.equal(seen.length, requestCount);
});
test('source is strict; no root name, synthetic identity or malformed namespace', () => {
  assert.throws(() => validateSource({ kind: 'figma-file', fileKey: 'File', name: 'Root' })); assert.throws(() => validateSource({ kind: 'plugin-launch', namespace: 'root-name' }));
  assert.deepEqual(validateSource({ kind: 'plugin-launch', namespace: `src_launch_${'a'.repeat(32)}` }), { kind: 'plugin-launch', namespace: `src_launch_${'a'.repeat(32)}` });
});
test('operation upload PUT scopes writer bytes and preserves original SHA/data/MIME', async t => {
  const data = new Uint8Array([137, 80, 78, 71, 1, 9]); const hash = await sha256(data, webcrypto);
  const { client, seen } = await fixture(t, (req, res, bytes) => {
    if (intentClaimRoutes(req, res, bytes) !== false) return;
    answer(res, { ok: true, sha256: hash, bytes: data.length, mime: req.headers['x-asset-mime'] });
  });
  authenticated(client); const opId = await claimWriter(client, 'projectA', ['frameA']);
  const claimRequest = JSON.parse(seen[1].bytes), secret = Buffer.from(claimRequest.writerSecret, 'base64url');
  await client.upload('original-sid', { sha256: hash, bytes: data.length, mime: 'image/png', data }, opId);
  const upload = seen[2]; assert.equal(upload.method, 'PUT'); assert.equal(upload.url, `/api/publish/sessions/original-sid/assets/${hash}`);
  assert.deepEqual([...upload.bytes.subarray(0, 4)], [71, 76, 80, 49]); assert.deepEqual(upload.bytes.subarray(4, 36), secret); assert.deepEqual(upload.bytes.subarray(36), Buffer.from(data));
  assert.equal(upload.headers['content-type'], 'application/octet-stream'); assert.equal(upload.headers['x-asset-mime'], 'image/png');
  await assert.rejects(client.upload('original-sid', { sha256: hash, bytes: data.length, mime: 'image/png', data: new Uint8Array(data.length) }, opId)); assert.equal(seen.length, 3);
});
test('commit/query/abort use intent/claim writer capability and the same sid', async t => {
  const { client, seen } = await fixture(t, (req, res, bytes) => {
    if (intentClaimRoutes(req, res, bytes) !== false) return;
    answer(res, req.url.endsWith('/commit') ? { sessionId: 'sid', status: 'committed', frames: [] } : req.url.endsWith('/abort') ? { sessionId: 'sid', status: 'aborted' } : { sessionId: 'sid', status: 'open', expiresAt, uploaded: [], uploadPolicy: {}, frames: [] });
  });
  authenticated(client);
  await assert.rejects(client.commit('sid'), { code: 'BAD_ID' }); await assert.rejects(client.abort('sid'), { code: 'BAD_ID' }); assert.equal(seen.length, 0);
  const opId = await claimWriter(client, 'projectA', ['frameA']);
  validateCommitResult(await client.commit('sid', opId), 'sid'); await client.query('sid'); await client.abort('sid', opId);
  assert.deepEqual(seen.map(r => [r.method, r.url]), [['GET', `/api/publish/intent?projectId=projectA`], ['POST', '/api/publish/operations'], ['POST', '/api/publish/sessions/sid/commit'], ['GET', '/api/publish/sessions/sid'], ['POST', '/api/publish/sessions/sid/abort']]);
  const claimRequest = JSON.parse(seen[1].bytes); assert.deepEqual(Object.keys(claimRequest).sort(), ['frameIds', 'groupId', 'operationId', 'projectId', 'writerSecret'].sort()); assert.equal(claimRequest.operationId, opId); assert.equal(claimRequest.projectId, 'projectA'); assert.deepEqual(claimRequest.frameIds, ['frameA']); assert.equal(claimRequest.groupId, null); assert.match(claimRequest.writerSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(JSON.parse(seen[2].bytes), { writerSecret: claimRequest.writerSecret }); assert.deepEqual(JSON.parse(seen[4].bytes), { writerSecret: claimRequest.writerSecret }); assert.equal(seen[3].bytes.length, 0);
  assert.equal(claimRequest.writerSecret === opId, false);
});
test('prepare 200 conflict still exposes sid before deeper validation', () => {
  const journal = []; const body = { designFile: { designFileId: 'file' }, frames: [{ figmaNodeId: '1:1' }] };
  const result = validatePrepareResult({ sessionId: 'conflict-sid', status: 'open', expiresAt, designFileId: 'file', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: {}, missingAssetSha256: [], frames: [{ figmaNodeId: '1:1', frameId: 'platform-frame', status: 'conflict', missingAssetSha256: [] }] }, body, sid => journal.push(sid));
  assert.equal(result.frames[0].status, 'conflict'); assert.deepEqual(journal, ['conflict-sid']);
  assert.throws(() => validatePrepareResult({ sessionId: 'received-before-invalid' }, body, sid => journal.push(sid))); assert.equal(journal[1], 'received-before-invalid');
});
test('401 clears access and preserves explicit status; no fake authorization', async t => {
  const { client } = await fixture(t, (req, res) => answer(res, { error: 'denied' }, 401)); authenticated(client);
  await assert.rejects(client.projects(), e => e.status === 401 && e.dispatched === true); assert.equal(client.status().authenticated, false); await assert.rejects(client.projects(), e => e.status === 401 && e.dispatched === false);
});
test('HTTP pins credentials omit, redirect error, same service origin and response cap', async () => {
  let options; const client = createProductionHTTP({ origin: 'https://service.example', fetchAPI: async (_url, init) => { options = init; return new Response(JSON.stringify({ id: 'u', username: 'user', role: 'developer' }), { headers: { 'content-type': 'application/json' } }); } }); authenticated(client); await client.me();
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(Object.keys(options.headers).some(k => k.startsWith('X-Independent-')), false);
  assert.throws(() => createProductionHTTP({ origin: 'https://service.example/path' })); assert.throws(() => createProductionHTTP({ origin: 'http://service.example', allowLocalhost: true })); assert.throws(() => createProductionHTTP({ origin: 'https://service.example', responseLimit: 4 * 1024 * 1024 + 1 }));
});
test('request lock survives abort until fetch AND body cancellation physically finish', async () => {
  let resolveFetch; let finishCancel; let cancelled = false;
  const fetchAPI = () => new Promise(resolve => { resolveFetch = resolve; });
  const client = authenticated(createProductionHTTP({ origin: 'https://service.example', fetchAPI })); const controller = new AbortController();
  const work = client.me({ signal: controller.signal }); controller.abort(); await assert.rejects(client.me(), { code: 'BUSY' }); assert.equal(client.status().active, true);
  resolveFetch({ ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json', 'content-length': '9999999' }), body: { getReader: () => ({ cancel: () => { cancelled = true; return new Promise(resolve => { finishCancel = resolve; }); }, releaseLock() {} }) } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true); assert.equal(client.status().active, true); finishCancel(); await assert.rejects(work); assert.equal(client.status().active, false);
});
test('stream response limit is enforced even without Content-Length', async () => {
  const client = authenticated(createProductionHTTP({ origin: 'https://service.example', responseLimit: 10, fetchAPI: async () => new Response('01234567890', { headers: { 'content-type': 'application/json' } }) }));
  await assert.rejects(client.me(), { code: 'HTTP_BODY_TOO_LARGE' }); assert.equal(client.status().active, false);
});
test('refresh uses single credential, never rotates/slides or resends publish calls', async t => {
  const { client, seen } = await fixture(t, (req, res) => answer(res, req.url.endsWith('/refresh') ? { token: 'new.hmac', user: { id: 'u' }, refreshExpiresAt: expiresAt } : { ok: true }));
  await client.refresh('synthetic-device'); await client.rememberedLogout('synthetic-device');
  assert.deepEqual(seen.map(s => s.url), ['/api/auth/refresh', '/api/auth/remembered-logout']); seen.forEach(s => assert.deepEqual(JSON.parse(s.bytes), { refreshToken: 'synthetic-device' })); assert.equal(client.status().authenticated, false);
});
