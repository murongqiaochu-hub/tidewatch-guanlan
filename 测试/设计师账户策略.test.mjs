import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';
import { hashPassword } from '../平台/认证.mjs';
import { validateExpiresAt, validateProjectLimit } from '../平台/账户策略.mjs';

const ADMIN_PASSWORD = 'stage-one-admin-password';
const PASSWORD = 'stage-one-user-password';
const NEW_PASSWORD = 'stage-one-new-password';
const baseTime = Date.parse('2026-11-03T12:00:00.000Z');

function expectStatus(result, status, code) {
  assert.equal(result.status, status, `expected HTTP ${status}, received ${result.status}: ${JSON.stringify(result.data)}`);
  if (code) assert.equal(result.data?.error?.code, code, `expected error code ${code}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function createGateState(rawVault) {
  const state = { gate: null };
  async function pause(method, phase) {
    const gate = state.gate;
    if (!gate || gate.method !== method || gate.phase !== phase) return;
    if (gate.skip > 0) { gate.skip--; return; }
    state.gate = null;
    gate.enteredResolve();
    await gate.releasePromise;
  }
  async function intercept(method, phase, operation) {
    if (phase === 'before') await pause(method, phase);
    const result = await operation();
    if (phase === 'after') await pause(method, phase);
    return result;
  }
  const vault = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'transact') return (...args) => intercept('transact', 'before', () => rawVault.transact(...args));
      if (property === 'stageAsset') return (...args) => intercept('stageAsset', 'after', () => rawVault.stageAsset(...args));
      if (property === 'readStaged') return (...args) => intercept('readStaged', 'after', () => rawVault.readStaged(...args));
      if (property === 'putOriginal') return (...args) => intercept('putOriginal', 'after', () => rawVault.putOriginal(...args));
      const value = Reflect.get(rawVault, property, rawVault);
      return typeof value === 'function' ? value.bind(rawVault) : value;
    },
  });
  function arm(method, phase = 'after', skip = 0) {
    assert.equal(state.gate, null, 'a prior test gate is still armed');
    let enteredResolve, releaseResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const releasePromise = new Promise(resolve => { releaseResolve = resolve; });
    state.gate = { method, phase, skip, enteredResolve, releasePromise };
    return { entered, release: releaseResolve };
  }
  return { vault, arm, hasArmedGate: () => state.gate !== null };
}

test('阶段一后端隔离HTTP合同', { timeout: 120_000 }, async t => {
  let now = baseTime;
  let app, baseUrl, tempParent;
  const designerTokens = new Map();
  try {
    tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'guanlan-stage1-'));
    const dataDir = path.join(tempParent, 'isolated-vault');
    const rawVault = await openVault({ dataDir, clock: () => now });
    const gates = createGateState(rawVault);
    app = await createPlatform({ dataDir, secret: randomBytes(48), clock: () => now, vault: gates.vault, host: '127.0.0.1' });
    const adminCredential = await hashPassword(ADMIN_PASSWORD);
    await app.vault.transact(draft => draft.add('users', {
      id: 'fixture_admin', username: 'admin', ...adminCredential, role: 'admin', status: 'active',
      ownerId: null, sessionVersion: 0, createdAt: new Date(now).toISOString(),
    }));
    const address = await app.listen(0);
    baseUrl = `http://127.0.0.1:${address.port}`;

    async function call(method, pathname, { token, body, rawBody, headers = {} } = {}) {
      const requestHeaders = { ...headers };
      if (token) requestHeaders.authorization = `Bearer ${token}`;
      let requestBody;
      if (rawBody !== undefined) requestBody = rawBody;
      else if (body !== undefined) {
        requestHeaders['content-type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }
      const response = await fetch(`${baseUrl}${pathname}`, { method, headers: requestHeaders, body: requestBody });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    }

    const adminLogin = expectStatus(await call('POST', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } }), 200);
    const adminToken = adminLogin.token;
    const adminId = adminLogin.user.id;
    assert.deepEqual(Object.keys(adminLogin.user).sort(), ['id', 'role', 'username']);

    async function createAccount(username, options = {}) {
      const body = { username, password: PASSWORD, ...(options.role ? { role: options.role } : {}), ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}), ...(options.displayName !== undefined ? { displayName: options.displayName } : {}), ...(Object.hasOwn(options, 'expiresAt') ? { expiresAt: options.expiresAt } : {}), ...(Object.hasOwn(options, 'projectLimit') ? { projectLimit: options.projectLimit } : {}) };
      const result = await call('POST', '/api/admin/users', { token: adminToken, body });
      expectStatus(result, 201);
      return result.data.user;
    }
    async function login(username, password = PASSWORD, rememberLogin = false) {
      return call('POST', '/api/auth/login', { body: { username, password, rememberLogin } });
    }
    async function createProject(token, name) {
      return call('POST', '/api/projects', { token, body: { name } });
    }
    async function listSelf(token, query = '') {
      return call('GET', `/api/account/self${query}`, { token });
    }
    async function deleteProject(projectId) {
      const preview = expectStatus(await call('GET', `/api/projects/${projectId}/delete-preview`, { token: adminToken }), 200);
      assert.equal(preview.canDelete, true);
      return call('DELETE', `/api/projects/${projectId}`, { token: adminToken, body: { acknowledge: true, confirmName: preview.project.name, previewToken: preview.previewToken } });
    }
    async function createPublishSession(token, projectId, fileKey, nodeId) {
      const layerDoc = Buffer.from(JSON.stringify({ contractVersion: 1, frame: { type: 'FRAME', id: nodeId, name: 'Root', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } } }));
      const layerSha = createHash('sha256').update(layerDoc).digest('hex');
      const result = await call('POST', '/api/publish/sessions', { token, body: {
        projectId,
        designFile: { figmaFileKey: fileKey, name: 'Synthetic test file' },
        requireBaseRevision: true,
        frames: [{ figmaNodeId: nodeId, figmaPageId: `page-${nodeId}`, name: 'Synthetic frame', x: 0, y: 0, width: 1, height: 1, hash: createHash('sha256').update(`manifest-${nodeId}`).digest('hex'), layerDocSha256: layerSha, layerDocBytes: layerDoc.length, exports: [], baseRevisionId: null }],
      } });
      expectStatus(result, 200);
      return { sessionId: result.data.sessionId, layerDoc, layerSha };
    }
    async function uploadLayer(token, publish) {
      return call('PUT', `/api/publish/sessions/${publish.sessionId}/assets/${publish.layerSha}`, {
        token, rawBody: publish.layerDoc,
        headers: { 'content-type': 'application/octet-stream', 'x-asset-mime': 'application/json' },
      });
    }
    async function createDesigner(username, policy = {}) {
      const record = await createAccount(username, { role: 'designer', ...policy });
      const auth = expectStatus(await login(username), 200);
      designerTokens.set(record.id, auth.token);
      return { record, token: auth.token };
    }
    function setTime(value) { now = value; }

    await t.test('旧设计师字段缺失兼容与C31三字段不变', async () => {
      const credential = await hashPassword(PASSWORD);
      await app.vault.transact(draft => draft.add('users', { id: 'legacy_designer', username: 'legacy', ...credential, role: 'designer', status: 'active', ownerId: null, sessionVersion: 0, createdAt: new Date(now).toISOString() }));
      const auth = expectStatus(await login('legacy'), 200);
      assert.deepEqual(Object.keys(auth.user).sort(), ['id', 'role', 'username']);
      const me = expectStatus(await call('GET', '/api/auth/me', { token: auth.token }), 200);
      assert.deepEqual(Object.keys(me).sort(), ['id', 'role', 'username']);
      assert.equal(me.id, 'legacy_designer');
      const self = expectStatus(await listSelf(auth.token), 200);
      assert.equal(self.expiresAt, null);
      assert.equal(self.projectLimit, null);
      for (let i = 0; i < 4; i++) expectStatus(await createProject(auth.token, `legacy-project-${i}`), 201);
      assert.equal(expectStatus(await listSelf(auth.token), 200).ownedProjectCount, 4);
      assert.equal(app.vault.catalog.users.find(user => user.id === 'legacy_designer').role, 'designer');
      assert.equal(Object.hasOwn(app.vault.catalog.users.find(user => user.id === 'legacy_designer'), 'expiresAt'), false);
    });

    await t.test('管理员策略CRUD、日期额度校验及账户DTO', async () => {
      const created = await createAccount('policy-user', { role: 'designer' });
      assert.equal(created.expiresAt, null);
      assert.equal(created.projectLimit, null);
      assert.equal(created.ownedProjectCount, 0);
      expectStatus(await call('POST', '/api/admin/users', { token: adminToken, body: { username: 'bad-date', password: PASSWORD, role: 'designer', expiresAt: '2026-11-03' } }), 400, 'invalid_expires_at');
      expectStatus(await call('POST', '/api/admin/users', { token: adminToken, body: { username: 'bad-calendar', password: PASSWORD, role: 'designer', expiresAt: '2026-02-30T12:00:00Z' } }), 400, 'invalid_expires_at');
      expectStatus(await call('POST', '/api/admin/users', { token: adminToken, body: { username: 'bad-limit', password: PASSWORD, role: 'designer', projectLimit: '3' } }), 400, 'invalid_project_limit');
      expectStatus(await call('POST', '/api/admin/users', { token: adminToken, body: { username: 'non-designer-limit', password: PASSWORD, role: 'developer', projectLimit: 2 } }), 400, 'strategy_fields_require_designer');
      expectStatus(await call('PATCH', `/api/admin/users/${created.id}`, { token: adminToken, body: { expiresAt: '2027-01-02T03:04:05+08:00', projectLimit: 3 } }), 200);
      const updated = expectStatus(await call('GET', `/api/admin/users/${created.id}`, { token: adminToken }), 200).user;
      assert.equal(updated.expiresAt, '2027-01-01T19:04:05.000Z');
      assert.equal(updated.projectLimit, 3);
      const beforeQuotaChange = expectStatus(await login('policy-user'), 200).token;
      expectStatus(await call('PATCH', `/api/admin/users/${created.id}`, { token: adminToken, body: { projectLimit: 2 } }), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: beforeQuotaChange }), 200);
      expectStatus(await call('PATCH', `/api/admin/users/${created.id}`, { token: adminToken, body: { expiresAt: null, projectLimit: null } }), 200);
      const cleared = expectStatus(await call('GET', `/api/admin/users/${created.id}`, { token: adminToken }), 200).user;
      assert.equal(cleared.expiresAt, null);
      assert.equal(cleared.projectLimit, null);
      assert.throws(() => validateExpiresAt('2026-11-03T12:00:00'), { code: 'invalid_expires_at' });
      assert.throws(() => validateExpiresAt('2026-02-30T12:00:00Z'), { code: 'invalid_expires_at' });
      assert.throws(() => validateProjectLimit(Number.NaN), { code: 'invalid_project_limit' });
      assert.throws(() => validateProjectLimit(Number.MAX_SAFE_INTEGER + 1), { code: 'invalid_project_limit' });
    });

    await t.test('额度上限、删除释放、超额项目读写与零额度', async () => {
      const { record, token } = await createDesigner('quota-three', { projectLimit: 3 });
      const projects = [];
      for (let i = 0; i < 3; i++) projects.push(expectStatus(await createProject(token, `quota-${i}`), 201));
      expectStatus(await createProject(token, 'quota-fourth'), 409, 'project_quota_exceeded');
      expectStatus(await call('PATCH', `/api/admin/users/${record.id}`, { token: adminToken, body: { projectLimit: 1 } }), 200);
      assert.equal(expectStatus(await call('GET', `/api/projects/${projects[0].id}`, { token }), 200).id, projects[0].id);
      expectStatus(await call('PATCH', `/api/projects/${projects[0].id}`, { token, body: { name: 'still-editable' } }), 200);
      expectStatus(await createProject(token, 'still-no-new-project'), 409, 'project_quota_exceeded');
      expectStatus(await call('PATCH', `/api/admin/users/${record.id}`, { token: adminToken, body: { projectLimit: 0 } }), 200);
      expectStatus(await createProject(token, 'zero-limit'), 409, 'project_quota_exceeded');
      expectStatus(await deleteProject(projects[1].id), 200);
      expectStatus(await call('PATCH', `/api/admin/users/${record.id}`, { token: adminToken, body: { projectLimit: 3 } }), 200);
      expectStatus(await createProject(token, 'after-delete-slot-released'), 201);
    });

    await t.test('并发新建与所有权转入共用容量事务', async () => {
      const { record, token } = await createDesigner('concurrent-three', { projectLimit: 3 });
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createProject(token, `parallel-${i}`)));
      assert.equal(results.filter(result => result.status === 201).length, 3);
      assert.equal(results.filter(result => result.status === 409 && result.data?.error?.code === 'project_quota_exceeded').length, 7);
      assert.equal(expectStatus(await listSelf(token), 200).ownedProjectCount, 3);

      const mixed = await createDesigner('transfer-three', { projectLimit: 3 });
      const transferable = expectStatus(await createProject(adminToken, 'admin-transferable'), 201);
      const requests = [
        call('POST', `/api/projects/${transferable.id}/owner`, { token: adminToken, body: { ownerId: mixed.record.id, expectedOwnerId: adminId } }),
        ...Array.from({ length: 3 }, (_, i) => createProject(mixed.token, `mixed-parallel-${i}`)),
      ];
      const mixedResults = await Promise.all(requests);
      assert.equal(mixedResults.filter(result => result.status === 201 || result.status === 200 && result.data?.ownerId === mixed.record.id).length, 3);
      assert.equal(expectStatus(await listSelf(mixed.token), 200).ownedProjectCount, 3);
      const alreadyOwnedId = mixedResults[0].status === 200 ? transferable.id : mixedResults.find((result, index) => index > 0 && result.status === 201).data.id;
      expectStatus(await call('PATCH', `/api/admin/users/${mixed.record.id}`, { token: adminToken, body: { projectLimit: 1 } }), 200);
      expectStatus(await call('PATCH', `/api/projects/${alreadyOwnedId}`, { token: adminToken, body: { name: 'over-limit-rename' } }), 200);
      expectStatus(await call('POST', `/api/projects/${alreadyOwnedId}/owner`, { token: adminToken, body: { ownerId: mixed.record.id, expectedOwnerId: mixed.record.id } }), 200);
      const extra = expectStatus(await createProject(adminToken, 'second-transferable'), 201);
      expectStatus(await call('POST', `/api/projects/${extra.id}/owner`, { token: adminToken, body: { ownerId: mixed.record.id, expectedOwnerId: adminId } }), 409, 'project_quota_exceeded');

      const expiry = new Date(now + 5000).toISOString();
      const expiredTarget = await createDesigner('transfer-expired', { expiresAt: expiry });
      const another = expectStatus(await createProject(adminToken, 'expired-transferable'), 201);
      setTime(Date.parse(expiry));
      expectStatus(await call('POST', `/api/projects/${another.id}/owner`, { token: adminToken, body: { ownerId: expiredTarget.record.id, expectedOwnerId: adminId } }), 403, 'designer_expired');
      setTime(baseTime);
    });

    await t.test('账户CRUD作用域及本人接口字段隔离', async () => {
      const d1 = await createDesigner('designer-scope-one');
      const d2 = await createDesigner('designer-scope-two');
      const ownDeveloper = expectStatus(await call('POST', '/api/users', { token: d1.token, body: { username: 'owned-dev-one', password: PASSWORD, displayName: '开发者一' } }), 201).user;
      const otherDeveloper = expectStatus(await call('POST', '/api/users', { token: d2.token, body: { username: 'owned-dev-two', password: PASSWORD } }), 201).user;
      const d1List = expectStatus(await call('GET', '/api/users', { token: d1.token }), 200).users;
      assert.deepEqual(d1List.map(user => user.id), [ownDeveloper.id]);
      assert.equal(d1List[0].expiresAt, null);
      assert.equal(d1List[0].projectLimit, null);
      expectStatus(await call('GET', `/api/users/${otherDeveloper.id}`, { token: d1.token }), 403, 'account_forbidden');
      expectStatus(await call('GET', `/api/users/${d1.record.id}`, { token: d1.token }), 403, 'account_forbidden');
      expectStatus(await call('DELETE', `/api/users/${d1.record.id}`, { token: d1.token }), 403, 'account_forbidden');
      const devLogin = expectStatus(await login('owned-dev-one'), 200);
      expectStatus(await call('GET', '/api/users', { token: devLogin.token }), 403, 'account_forbidden');
      expectStatus(await call('GET', `/api/users/${otherDeveloper.id}`, { token: devLogin.token }), 403, 'account_forbidden');
      expectStatus(await call('PATCH', `/api/users/${otherDeveloper.id}`, { token: devLogin.token, body: { displayName: 'not-allowed' } }), 403, 'account_forbidden');
      expectStatus(await call('DELETE', `/api/users/${ownDeveloper.id}`, { token: devLogin.token }), 403, 'account_forbidden');
      expectStatus(await call('GET', '/api/admin/invites', { token: devLogin.token }), 403, 'invite_forbidden');
      for (const field of ['id', 'role', 'ownerId', 'expiresAt', 'projectLimit']) {
        expectStatus(await call('PATCH', '/api/auth/me', { token: devLogin.token, body: { [field]: field === 'id' ? 'fixture_admin' : null } }), 400, 'invalid_fields');
      }
      const self = expectStatus(await listSelf(devLogin.token, '?id=fixture_admin&ownerId=fixture_admin'), 200);
      assert.equal(self.id, ownDeveloper.id);
      expectStatus(await call('GET', '/api/admin/users', { token: adminToken }), 200);
      expectStatus(await call('PATCH', `/api/users/${ownDeveloper.id}`, { token: d1.token, body: { username: 'owned-dev-renamed' } }), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: devLogin.token }), 401, 'authentication_required');
    });

    await t.test('本人改名改密、版本撤销、规范化不误撤销与同名竞态', async () => {
      const person = await createAccount('profile-owner', { role: 'developer' });
      const auth = expectStatus(await login('profile-owner', PASSWORD, true), 200);
      const oldToken = auth.token, oldRefresh = auth.refreshToken;
      const failedNoPassword = await call('PATCH', '/api/auth/me', { token: oldToken, body: { username: 'profile-renamed' } });
      expectStatus(failedNoPassword, 401, 'invalid_credentials');
      expectStatus(await call('PATCH', '/api/auth/me', { token: oldToken, body: { username: 'profile-renamed', currentPassword: 'wrong-current-password' } }), 401, 'invalid_credentials');
      const renamed = expectStatus(await call('PATCH', '/api/auth/me', { token: oldToken, body: { username: ' Profile-Renamed ', currentPassword: PASSWORD } }), 200);
      assert.equal(renamed.username, 'profile-renamed');
      assert.equal(renamed.id, person.id);
      expectStatus(await call('GET', '/api/auth/me', { token: oldToken }), 401, 'authentication_required');
      expectStatus(await call('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } }), 401, 'invalid_refresh_token');
      expectStatus(await login('profile-owner'), 401, 'invalid_credentials');
      const fresh = expectStatus(await login('profile-renamed'), 200);
      const versionBeforeNoop = app.vault.catalog.users.find(user => user.id === person.id).sessionVersion;
      expectStatus(await call('PATCH', '/api/auth/me', { token: fresh.token, body: { username: '  PROFILE-RENAMED  ' } }), 200);
      assert.equal(app.vault.catalog.users.find(user => user.id === person.id).sessionVersion, versionBeforeNoop);
      expectStatus(await call('GET', '/api/auth/me', { token: fresh.token }), 200);
      expectStatus(await call('PATCH', '/api/auth/me', { token: fresh.token, body: { password: NEW_PASSWORD, currentPassword: PASSWORD } }), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: fresh.token }), 401, 'authentication_required');
      expectStatus(await login('profile-renamed', PASSWORD), 401, 'invalid_credentials');
      const afterPassword = expectStatus(await login('profile-renamed', NEW_PASSWORD), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: afterPassword.token }), 200);

      const dupeA = await createAccount('race-owner-a', { role: 'developer' });
      const dupeB = await createAccount('race-owner-b', { role: 'developer' });
      const authA = expectStatus(await login(dupeA.username), 200), authB = expectStatus(await login(dupeB.username), 200);
      const raced = await Promise.all([
        call('PATCH', '/api/auth/me', { token: authA.token, body: { username: 'one-race-name', currentPassword: PASSWORD } }),
        call('PATCH', '/api/auth/me', { token: authB.token, body: { username: 'one-race-name', currentPassword: PASSWORD } }),
      ]);
      assert.equal(raced.filter(result => result.status === 200).length, 1);
      assert.equal(raced.filter(result => result.status === 409 && result.data?.error?.code === 'username_exists').length, 1);

      const adminEdited = await createAccount('admin-edits-name', { role: 'developer' });
      const remembered = expectStatus(await login(adminEdited.username, PASSWORD, true), 200);
      expectStatus(await call('PATCH', `/api/admin/users/${adminEdited.id}`, { token: adminToken, body: { username: 'admin-edited-name' } }), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: remembered.token }), 401, 'authentication_required');
      expectStatus(await call('POST', '/api/auth/refresh', { body: { refreshToken: remembered.refreshToken } }), 401, 'invalid_refresh_token');
    });

    await t.test('期限前一毫秒可用、到点拒绝登录令牌刷新及邀请权限', async () => {
      const expiryMs = now + 10_000;
      const { record, token } = await createDesigner('expires-now', { expiresAt: new Date(expiryMs).toISOString() });
      const project = expectStatus(await createProject(token, 'expiring-owned-project'), 201);
      const invite = expectStatus(await call('POST', `/api/projects/${project.id}/invites`, { token, body: { label: 'expiry-check' } }), 201).invite;
      const expiredSession = await createPublishSession(token, project.id, 'ExpiredSessionFile', 'ExpiredSessionNode');
      const remembered = expectStatus(await login('expires-now', PASSWORD, true), 200);
      const rememberedCount = app.vault.catalog.rememberedLogins.filter(item => item.userId === record.id).length;
      const rememberGate = gates.arm('transact', 'before');
      const delayedRemember = login('expires-now', PASSWORD, true);
      await rememberGate.entered;
      setTime(expiryMs);
      rememberGate.release();
      expectStatus(await delayedRemember, 403, 'designer_expired');
      assert.equal(app.vault.catalog.rememberedLogins.filter(item => item.userId === record.id).length, rememberedCount);
      setTime(baseTime);
      const queuedCreateGate = gates.arm('transact', 'before');
      const queuedCreate = createProject(token, 'queued-create-crossed-expiry');
      await queuedCreateGate.entered;
      setTime(expiryMs);
      queuedCreateGate.release();
      expectStatus(await queuedCreate, 403, 'designer_expired');
      setTime(baseTime);
      setTime(expiryMs - 1);
      expectStatus(await call('GET', '/api/auth/me', { token: remembered.token }), 200);
      expectStatus(await call('GET', `/api/projects/${project.id}`, { token: remembered.token }), 200);
      setTime(expiryMs);
      expectStatus(await call('GET', '/api/auth/me', { token: remembered.token }), 403, 'designer_expired');
      expectStatus(await call('GET', `/api/projects/${project.id}`, { token: remembered.token }), 403, 'designer_expired');
      expectStatus(await call('GET', '/api/publish/intent?projectId=' + project.id, { token: remembered.token }), 403, 'designer_expired');
      expectStatus(await call('POST', '/api/publish/sessions', { token: remembered.token, body: {} }), 403, 'designer_expired');
      expectStatus(await uploadLayer(remembered.token, expiredSession), 403, 'designer_expired');
      expectStatus(await call('POST', `/api/publish/sessions/${expiredSession.sessionId}/commit`, { token: remembered.token, body: {} }), 403, 'designer_expired');
      expectStatus(await login('expires-now', 'wrong-password-for-expiry'), 401, 'invalid_credentials');
      expectStatus(await login('expires-now'), 403, 'designer_expired');
      expectStatus(await call('POST', '/api/auth/refresh', { body: { refreshToken: remembered.refreshToken } }), 403, 'designer_expired');
      expectStatus(await call('GET', `/api/invites/${invite.rawToken}`), 410, 'invite_creator_inactive');
      expectStatus(await call('PATCH', `/api/admin/users/${record.id}`, { token: adminToken, body: { expiresAt: null } }), 200);
      expectStatus(await call('GET', '/api/auth/me', { token: remembered.token }), 401, 'authentication_required');
      expectStatus(await call('POST', '/api/auth/refresh', { body: { refreshToken: remembered.refreshToken } }), 401, 'invalid_refresh_token');
      const renewed = expectStatus(await login('expires-now'), 200);
      assert.equal(expectStatus(await listSelf(renewed.token), 200).expiresAt, null);
      setTime(baseTime);
    });

    await t.test('過期時鐘跨越上传与commit各await仍拒绝', async () => {
      const expiryMs = now + 60_000;
      const { record, token } = await createDesigner('long-request-expiry', { expiresAt: new Date(expiryMs).toISOString() });
      const project = expectStatus(await createProject(token, 'long-request-project'), 201);

      const uploadCase = await createPublishSession(token, project.id, 'LongUploadFile', 'LongUploadNode');
      const uploadGate = gates.arm('stageAsset', 'after');
      const uploadPromise = uploadLayer(token, uploadCase);
      await uploadGate.entered;
      setTime(expiryMs);
      uploadGate.release();
      expectStatus(await uploadPromise, 403, 'designer_expired');
      assert.equal(app.vault.catalog.publishSessions.find(session => session.id === uploadCase.sessionId).uploaded.length, 0);
      setTime(baseTime);
      expectStatus(await call('POST', `/api/publish/sessions/${uploadCase.sessionId}/abort`, { token, body: {} }), 200);

      const readCase = await createPublishSession(token, project.id, 'LongReadFile', 'LongReadNode');
      expectStatus(await uploadLayer(token, readCase), 200);
      const readGate = gates.arm('readStaged', 'after');
      const readCommit = call('POST', `/api/publish/sessions/${readCase.sessionId}/commit`, { token, body: {} });
      await readGate.entered;
      setTime(expiryMs);
      readGate.release();
      expectStatus(await readCommit, 403, 'designer_expired');
      setTime(baseTime);
      expectStatus(await call('POST', `/api/publish/sessions/${readCase.sessionId}/abort`, { token, body: {} }), 200);

      const putCase = await createPublishSession(token, project.id, 'LongPutFile', 'LongPutNode');
      expectStatus(await uploadLayer(token, putCase), 200);
      const putGate = gates.arm('putOriginal', 'after');
      const putCommit = call('POST', `/api/publish/sessions/${putCase.sessionId}/commit`, { token, body: {} });
      await putGate.entered;
      setTime(expiryMs);
      putGate.release();
      expectStatus(await putCommit, 403, 'designer_expired');
      setTime(baseTime);
      expectStatus(await call('POST', `/api/publish/sessions/${putCase.sessionId}/abort`, { token, body: {} }), 200);

      const txCase = await createPublishSession(token, project.id, 'LongTxFile', 'LongTxNode');
      expectStatus(await uploadLayer(token, txCase), 200);
      const txGate = gates.arm('transact', 'before', 1);
      const txCommit = call('POST', `/api/publish/sessions/${txCase.sessionId}/commit`, { token, body: {} });
      await txGate.entered;
      setTime(expiryMs);
      txGate.release();
      expectStatus(await txCommit, 403, 'designer_expired');
      assert.equal(app.vault.catalog.publishSessions.find(session => session.id === txCase.sessionId).status, 'open');
      setTime(baseTime);
      expectStatus(await call('POST', `/api/publish/sessions/${txCase.sessionId}/abort`, { token, body: {} }), 200);
      assert.equal(gates.hasArmedGate(), false);
      assert.equal(app.vault.catalog.users.find(user => user.id === record.id).expiresAt, new Date(expiryMs).toISOString());
    });

    await t.test('平台认证权限回归：管理员、设计师与开发者边界', async () => {
      const designer = await createDesigner('permissions-owner');
      const developer = await createAccount('permissions-member', { role: 'developer' });
      const project = expectStatus(await createProject(adminToken, 'permission-regression-project'), 201);
      expectStatus(await call('PUT', `/api/projects/${project.id}/members/${developer.id}`, { token: adminToken, body: {} }), 200);
      const developerAuth = expectStatus(await login(developer.username), 200);
      const visible = expectStatus(await call('GET', '/api/projects', { token: developerAuth.token }), 200).projects;
      assert.equal(visible.some(item => item.id === project.id), true);
      expectStatus(await call('POST', `/api/projects/${project.id}/groups`, { token: developerAuth.token, body: { name: 'forbidden-group' } }), 403, 'project_forbidden');
      const owned = expectStatus(await createProject(designer.token, 'designer-regression-project'), 201);
      expectStatus(await call('POST', `/api/projects/${owned.id}/groups`, { token: designer.token, body: { name: 'allowed-group' } }), 201);
      expectStatus(await call('GET', `/api/projects/${project.id}`, { token: adminToken }), 200);
      expectStatus(await call('POST', `/api/projects/${project.id}/groups`, { token: adminToken, body: { name: 'admin-group' } }), 201);
    });

    assert.equal(app.vault.catalog.users.find(user => user.id === adminId).role, 'admin');
  } finally {
    if (app) await app.close();
    if (tempParent) {
      const resolved = await fs.realpath(tempParent);
      if (resolved !== tempParent || !resolved.startsWith(path.join(os.tmpdir(), 'guanlan-stage1-'))) throw new Error('refusing cleanup outside the synthetic temp root');
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
});
