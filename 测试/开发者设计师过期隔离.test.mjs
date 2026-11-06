// Synthetic isolated vault/HTTP only. No deployed data or credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';
import { accountExpiryCode } from '../平台/账户策略.mjs';
import { createAccountProjectService } from '../平台/账户项目.mjs';

const password = 'Synthetic-Expiry-Password-2026';
const salt = '00112233445566778899aabbccddeeff';
const credential = { salt, passwordHash: scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 33554432 }).toString('hex') };
const start = Date.parse('2026-11-04T00:00:00Z');
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
const denied = result => { assert.equal(result.status, 403, JSON.stringify(result.data)); };
async function fixture(t) {
  let now = start, afterRead, beforeTransaction;
  const root = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, 'heron-developer-expiry-'));
  const raw = await openVault({ dataDir: path.join(dir, 'data'), clock: () => now });
  const vault = new Proxy(Object.create(null), { get(_target, key) {
    const target = raw;
    if (key === 'readOriginal') return async (...args) => { const result = await target.readOriginal(...args); const hook = afterRead; afterRead = null; await hook?.(); return result; };
    if (key === 'transact') return async (...args) => { const hook = beforeTransaction; beforeTransaction = null; await hook?.(); return target.transact(...args); };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = await createPlatform({ dataDir: path.join(dir, 'data'), vault, secret: randomBytes(48), clock: () => now, logger: { error() {} } });
  t.after(async () => { await app.close(); assert.equal(await fs.realpath(dir), dir); assert.equal(path.dirname(dir), root); assert.match(path.basename(dir), /^heron-developer-expiry-/); await fs.rm(dir, { recursive: true }); });
  await vault.transact(d => {
    for (const [id, role, ownerId] of [['admin','admin',null], ['d1','designer',null], ['d2','designer',null], ['d3','designer',null], ['only','developer','d1'], ['multi','developer','d1'], ['member','developer',null], ['legacy','developer',null], ['owneronly','developer','d2'], ['adminowned','developer','admin']]) {
      d.add('users', { id, username: `expiry-${id}`, ...credential, role, ownerId, status: 'active', sessionVersion: 0, ...(id === 'd1' ? { expiresAt: new Date(start + 1000).toISOString() } : {}) });
    }
    for (const [id, ownerId] of [['p1','d1'], ['p2','d2'], ['p3','d3'], ['pa','admin'], ['pn',null]]) d.add('projects', { id, ownerId, name: `Synthetic ${id}` });
    for (const [userId, projectId] of [['only','p1'], ['multi','p1'], ['multi','p2'], ['member','p1']]) d.add('projectMembers', { userId, projectId, role: 'developer' });
  });
  const doc = Buffer.from(JSON.stringify({ contractVersion: 1, frame: { id: '1:1', type: 'FRAME', name: 'Synthetic frame', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } } }));
  const asset = await vault.putOriginal({ data: doc, bytes: doc.length, sha256: createHash('sha256').update(doc).digest('hex'), mime: 'application/json' });
  await vault.transact(d => {
    d.add('assets', asset);
    d.add('designFiles', { id: 'file1', projectId: 'p1', name: 'Synthetic file' });
    d.add('pages', { id: 'page1', designFileId: 'file1', name: 'Synthetic page' });
    d.add('frames', { id: 'frame1', designFileId: 'file1', pageId: 'page1', projectId: 'p1', state: 'published', currentRevisionId: 'rev1' });
    d.add('frameRevisions', { id: 'rev1', frameId: 'frame1', projectId: 'p1', layerDocAssetId: asset.id, figmaNodeId: '1:1', name: 'Synthetic frame' });
    d.add('revisionAssets', { id: 'slice1', revisionId: 'rev1', frameId: 'frame1', assetId: asset.id, role: 'export', exportNodeId: '1:1', fileName: 'synthetic.json' });
  });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const tokens = Object.fromEntries(vault.catalog.users.map(user => [user.id, app.auth.issueAccess(user)]));
  async function request(url, { who = 'multi', token = tokens[who], method = 'GET', body, cookie = false } = {}) {
    const response = await fetch(base + url, { method, headers: { ...(token ? cookie ? { Cookie: `hsauth=${token}` } : { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const bytes = Buffer.from(await response.arrayBuffer()); let data; try { data = JSON.parse(bytes); } catch { data = bytes; } return { status: response.status, data, headers: response.headers };
  }
  const login = (who, rememberLogin = false, suppliedPassword = password) => request('/api/auth/login', { token: null, method: 'POST', body: { username: `expiry-${who}`, password: suppliedPassword, rememberLogin } });
  const refresh = refreshToken => request('/api/auth/refresh', { token: null, method: 'POST', body: { refreshToken } });
  const actor = who => app.auth.actor(bearer(tokens[who]));
  return { app, vault, tokens, request, login, refresh, actor, asset, setTime(value) { now = value; }, afterRead(hook) { afterRead = hook; }, beforeTransaction(hook) { beforeTransaction = hook; } };
}

test('only expired owner/member relations deny login, old Bearer/Cookie, issue and refresh; renewal restores developer sessions', async t => {
  const h = await fixture(t);
  const remembered = await h.login('only', true); assert.equal(remembered.status, 200);
  const memberRemembered = await h.login('member', true); assert.equal(memberRemembered.status, 200);
  const snapshot = h.actor('only');
  h.setTime(start + 999); assert.equal((await h.request('/api/auth/me', { who: 'only' })).status, 200);
  h.setTime(start + 1000);
  for (const who of ['only', 'member']) {
    denied(await h.login(who)); denied(await h.request('/api/auth/me', { who })); denied(await h.request('/api/auth/me', { who, cookie: true }));
    assert.equal(h.app.auth.actor(bearer(h.tokens[who]), { required: false }), null);
    assert.throws(() => h.app.auth.issueAccess({ id: who }), { code: 'designer_expired' });
  }
  assert.equal((await h.login('only', false, 'incorrect-synthetic-password')).status, 401);
  denied(await h.refresh(remembered.data.refreshToken)); denied(await h.refresh(memberRemembered.data.refreshToken));
  assert.throws(() => h.app.context.permissions.requireRead(snapshot, 'p1'), { code: 'designer_expired' });
  assert.throws(() => createAccountProjectService(h.app.context).getSelf(snapshot), { code: 'designer_expired' });
  const renewal = await h.request('/api/admin/users/d1', { who: 'admin', method: 'PATCH', body: { expiresAt: new Date(start + 86400000).toISOString() } });
  assert.equal(renewal.status, 200);
  assert.equal((await h.login('only')).status, 200); assert.equal((await h.refresh(remembered.data.refreshToken)).status, 200);
  assert.equal((await h.request('/api/projects/p1', { who: 'only' })).status, 200);
  assert.equal((await h.request('/api/account/self', { who: 'only' })).status, 200);
  // Designer policy changes revoke that designer's sessions, not related developer versions.
  assert.equal(h.vault.catalog.users.find(u => u.id === 'only').sessionVersion, 0);
  assert.equal((await h.request('/api/auth/me', { who: 'd1' })).status, 401);
});

test('multi-designer login/refresh and lists retain valid projects only; direct resource paths fail closed without new grants', async t => {
  const h = await fixture(t), remembered = await h.login('multi', true);
  const resourcePaths = ['/api/projects/p1', '/api/projects/p1/groups', '/api/inspector/projects/p1/directory', '/api/inspector/frames/frame1/revisions/rev1', `/api/assets/${h.asset.id}`, `/api/assets/${h.asset.id}?frameId=frame1&revisionId=rev1`];
  for (const url of resourcePaths) assert.equal((await h.request(url)).status, 200, url);
  h.setTime(start + 1000);
  assert.equal((await h.login('multi')).status, 200); assert.equal((await h.refresh(remembered.data.refreshToken)).status, 200);
  assert.deepEqual((await h.request('/api/projects')).data.projects.map(p => p.id), ['p2']);
  assert.deepEqual((await h.request('/api/admin/projects')).data.projects, []);
  for (const url of [...resourcePaths, '/api/projects/p1/slices', '/api/projects/p1/slices.zip', '/api/projects/p1/slices/slice1/preview', '/api/projects/p1/slices/slice1/download', '/api/slices/slice1/download', '/api/inspector/frames/frame1/revisions/rev1/slices', '/api/inspector/frames/frame1/revisions/rev1/slices.zip', '/api/inspector/frames/frame1/revisions/rev1/slices/slice1/download']) denied(await h.request(url));
  assert.equal((await h.request('/api/projects/p1')).data.error.code, 'project_forbidden');
  assert.equal((await h.request('/api/projects/p1', { who: 'owneronly' })).data.error.code, 'project_forbidden');
  assert.equal((await h.request('/api/auth/me')).status, 200);
  assert.equal((await h.request('/api/assets/' + h.asset.id, { method: 'HEAD' })).status, 403);
  assert.equal((await h.request('/api/projects/p2')).status, 200);
  denied(await h.request('/api/projects/p3')); // unrelated valid designer never confers read
  denied(await h.request('/api/projects/p2/groups', { method: 'POST', body: { name: 'Not allowed' } }));
  assert.equal((await h.request('/api/projects/p1', { who: 'admin' })).status, 200);
  assert.equal((await h.request('/api/projects/p1', { who: 'd2' })).status, 403);
  // A valid account-owner relation alone permits login but never project read.
  assert.equal((await h.login('owneronly')).status, 200);
  denied(await h.request('/api/projects/p2', { who: 'owneronly' }));
});

test('live relation removal, disabled/deleted alternatives, soft-deleted projects and current project owner are rechecked', async t => {
  const h = await fixture(t), snapshot = h.actor('multi'); h.setTime(start + 1000);
  for (const status of ['disabled', 'deleted']) {
    await h.vault.transact(d => d.patch('users', 'd2', { status })); denied(await h.login('multi'));
    assert.throws(() => h.app.context.permissions.requireRead(snapshot, 'p2'), { code: 'designer_expired' });
  }
  await h.vault.transact(d => d.add('projectMembers', { userId: 'multi', projectId: 'p3', role: 'developer' }));
  for (const status of ['disabled', 'deleted']) {
    await h.vault.transact(d => d.patch('users', 'd2', { status }));
    assert.equal((await h.login('multi')).status, 200);
    const hidden = await h.request('/api/projects/p2'); denied(hidden); assert.equal(hidden.data.error.code, 'project_forbidden');
    assert.equal((await h.request('/api/projects/p2', { who: 'admin' })).status, 200);
    assert.deepEqual((await h.request('/api/projects')).data.projects.map(p => p.id), ['p3']);
  }
  await h.vault.transact(d => { for (const m of d.all('projectMembers')) if (m.projectId === 'p3') d.remove('projectMembers', m.id); d.patch('users', 'd2', { status: 'active' }); d.patch('projects', 'p2', { deletedAt: new Date(start).toISOString() }); });
  denied(await h.login('multi'));
  await h.vault.transact(d => { d.patch('projects', 'p2', { deletedAt: null }); for (const m of d.all('projectMembers')) if (m.projectId === 'p2') d.remove('projectMembers', m.id); });
  denied(await h.login('multi'));
  await h.vault.transact(d => d.patch('projects', 'p1', { ownerId: 'd3' }));
  assert.equal((await h.login('multi')).status, 200); assert.equal((await h.request('/api/projects/p1')).status, 200);
  assert.deepEqual((await h.request('/api/projects')).data.projects.map(p => p.id), ['p1']);
  // Current transaction rows, not the still-valid catalog, govern an in-flight permission check.
  await h.vault.transact(d => { d.patch('projects', 'p1', { ownerId: 'd1' }); assert.throws(() => h.app.context.permissions.requireRead(snapshot, 'p1', { draft: d }), { code: 'designer_expired' }); });
  denied(await h.request('/api/auth/me'));
});

test('legacy no-association and admin/ownerless relationships preserve compatibility; never create membership', async t => {
  const h = await fixture(t); h.setTime(start + 1000);
  for (const who of ['legacy', 'adminowned']) { assert.equal((await h.login(who)).status, 200); assert.deepEqual((await h.request('/api/projects', { who })).data.projects, []); }
  for (const projectId of ['pa', 'pn']) {
    await h.vault.transact(d => d.add('projectMembers', { userId: 'only', projectId, role: 'developer' }));
    assert.equal((await h.login('only')).status, 200);
    assert.equal((await h.request('/api/projects/' + projectId, { who: 'only' })).status, 200);
    denied(await h.request('/api/projects/p1', { who: 'only' }));
    await h.vault.transact(d => { for (const m of d.all('projectMembers')) if (m.userId === 'only' && m.projectId === projectId) d.remove('projectMembers', m.id); });
    denied(await h.login('only'));
  }
  await h.vault.transact(d => d.patch('users', 'only', { ownerId: 'admin' }));
  assert.equal((await h.login('only')).status, 200); denied(await h.request('/api/projects/p1', { who: 'only' }));
});

test('expiry during KDF/remember transaction or inspector disk read is rechecked before result', async t => {
  const h = await fixture(t);
  const delayed = h.app.auth.login('expiry-only', password, { rememberLogin: true }); h.setTime(start + 1000);
  await assert.rejects(delayed, { code: 'designer_expired' });
  assert.equal(h.vault.catalog.rememberedLogins.length, 0);
  h.setTime(start);
  h.beforeTransaction(() => h.setTime(start + 1000)); denied(await h.login('only', true));
  assert.equal(h.vault.catalog.rememberedLogins.length, 0);
  h.setTime(start);
  h.afterRead(() => h.setTime(start + 1000));
  denied(await h.request('/api/inspector/frames/frame1/revisions/rev1'));
  assert.equal((await h.request('/api/auth/me')).status, 200); // valid d2 still allows login
});

test('shared original bytes remain readable only through a still-authorized relation and explicit expired scope stays denied', async t => {
  const h = await fixture(t); h.setTime(start + 1000);
  denied(await h.request('/api/assets/' + h.asset.id));
  await h.vault.transact(d => {
    d.add('designFiles', { id: 'file2', projectId: 'p2' });
    d.add('frames', { id: 'frame2', designFileId: 'file2', projectId: 'p2', state: 'published', currentRevisionId: 'rev2' });
    d.add('frameRevisions', { id: 'rev2', frameId: 'frame2', projectId: 'p2', layerDocAssetId: h.asset.id });
  });
  assert.equal((await h.request('/api/assets/' + h.asset.id)).status, 200);
  assert.equal((await h.request(`/api/assets/${h.asset.id}?frameId=frame2&revisionId=rev2`)).status, 200);
  denied(await h.request(`/api/assets/${h.asset.id}?frameId=frame1&revisionId=rev1`));
  denied(await h.request('/api/assets/' + h.asset.id, { who: 'owneronly' }));
});

test('policy ignores claims/name strings, deduplicates relations and treats malformed expiry as expired', () => {
  const users = [{ id: 'd', role: 'designer', status: 'active', expiresAt: 'invalid' }, { id: 'ok', role: 'designer', status: 'active' }];
  const user = { id: 'u', role: 'developer', ownerId: 'd' };
  assert.equal(accountExpiryCode(user, { users }, start), 'designer_expired');
  assert.equal(accountExpiryCode(user, { users, projects: [{ id: 'p', ownerId: 'ok' }], projectMembers: [{ projectId: 'p', userId: 'u', role: 'admin' }] }, start), null);
  assert.equal(accountExpiryCode(user, { users, projects: [{ id: 'p', ownerId: 'ok' }], projectMembers: [{ projectId: 'p', userId: 'someone', createdBy: 'ok' }] }, start), 'designer_expired');
});
