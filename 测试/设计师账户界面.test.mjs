import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { hashPassword } from '../平台/认证.mjs';
import { createProductionHTTP } from '../插件/production-protocol.mjs';
import { safeError } from '../插件/core.mjs';
import { pluginErrorText } from '../插件/ui.mjs';
import { publicProblemText, shanghaiDateInput, shanghaiDateISO } from '../界面/app.mjs';

const expiredText = '设计师账户已到期，请联系管理员续期。';
const quotaText = '项目数量已达上限，请联系管理员提高额度，或删除现有项目后再新建。';
const timeFixture = '2040-12-31T15:59:00.000Z';

function jsonResponse(value, status = 200, contentType = 'application/json', extraHeaders = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return new Response(body, { status, headers: { 'content-type': contentType, ...extraHeaders } });
}
function clientFor(response) {
  const client = createProductionHTTP({ origin: 'http://127.0.0.1:19090', allowLocalhost: true, fetchAPI: async () => response });
  client.setToken('synthetic-access-token');
  return client;
}

 test('阶段二：Web日期控件秒值规范化、额度错误静态映射', () => {
  assert.equal(shanghaiDateISO('2040-12-31T23:59'), '2040-12-31T15:59:00.000Z');
  assert.equal(shanghaiDateISO('2040-12-31T23:59:00'), '2040-12-31T15:59:00.000Z');
  assert.equal(shanghaiDateISO('2040-12-31T23:59:47'), '2040-12-31T15:59:47.000Z');
  assert.equal(shanghaiDateInput(timeFixture), '2040-12-31T23:59');
  assert.equal(shanghaiDateInput('2040-12-31T15:59:47.000Z'), '2040-12-31T23:59:47');
  assert.throws(() => shanghaiDateISO('2040-02-30T23:59'), /有效的到期日期/);
  assert.equal(publicProblemText({ status: 403, code: 'designer_expired', message: '内部诊断' }), expiredText);
  assert.equal(publicProblemText({ status: 409, code: 'project_quota_exceeded', message: '内部诊断' }), quotaText);
  assert.equal(publicProblemText({ status: 409, code: 'other', message: '内部诊断' }), '内容或权限已变化，请重新读取并核对后再操作。');
  assert.equal(pluginErrorText('DESIGNER_EXPIRED'), expiredText);
  assert.equal(pluginErrorText('PROJECT_QUOTA_EXCEEDED'), quotaText);
});

test('阶段二：account/self DTO严格校验及仅限原DTO字段', async () => {
  const account = {
    id: 'designer_1', username: 'designer-one', role: 'designer', status: 'active', ownerId: null,
    displayName: '设计师一', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: timeFixture,
    projectLimit: 3, ownedProjectCount: 2,
  };
  const valid = clientFor(jsonResponse(account));
  assert.deepEqual(await valid.accountSelf(), account);

  const malformed = [
    { ...account, projectLimit: '3' },
    { ...account, ownedProjectCount: -1 },
    { ...account, expiresAt: '2040-02-30T00:00:00Z' },
    { ...account, id: 'designer_1', unsafeDiagnostic: 'must not be allowed' },
    { ...account, role: 'admin', expiresAt: null, projectLimit: 0.5 },
  ];
  for (const value of malformed) {
    const client = clientFor(jsonResponse(value));
    await assert.rejects(client.accountSelf(), error => error.code === 'HTTP_RESPONSE_INVALID');
  }
});

test('阶段二：仅严格状态与JSON错误码映射，期限清token、额度保留会话', async () => {
  const expired = clientFor(jsonResponse({ error: { code: 'designer_expired', message: 'private details' } }, 403));
  await assert.rejects(expired.projects(), error => error.code === 'DESIGNER_EXPIRED' && error.status === 403);
  assert.equal(safeError({ code: 'DESIGNER_EXPIRED' }).code, 'DESIGNER_EXPIRED');
  assert.equal(expired.status().authenticated, false);

  const quota = clientFor(jsonResponse({ error: { code: 'project_quota_exceeded', message: 'private details' } }, 409));
  await assert.rejects(quota.projects(), error => error.code === 'PROJECT_QUOTA_EXCEEDED' && error.status === 409);
  assert.equal(safeError({ code: 'PROJECT_QUOTA_EXCEEDED' }).code, 'PROJECT_QUOTA_EXCEEDED');
  assert.equal(quota.status().authenticated, true);

  const nonMappings = [
    jsonResponse({ error: { code: 'project_quota_exceeded' } }, 403),
    jsonResponse({ error: { code: 'designer_expired' } }, 409),
    jsonResponse({ error: { code: 'designer_expired' } }, 403, 'text/html'),
    jsonResponse('{"error":{"code":"designer_expired"', 403),
    jsonResponse({ error: { code: 'designer_expired' } }, 403, 'application/json', { 'content-length': '999' }),
  ];
  for (const response of nonMappings) {
    const client = clientFor(response);
    await assert.rejects(client.projects(), error => error.code === 'HTTP_FAILED');
    assert.equal(client.status().authenticated, true);
  }
});

test('阶段二：开发者仅访问本人账户页，无邀请导航或用户目录API', { timeout: 120_000 }, async () => {
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), 'guanlan-stage2-web-'));
  let app;
  try {
    app = await createPlatform({ dataDir: path.join(tempParent, 'vault'), secret: randomBytes(48), host: '127.0.0.1' });
    const now = '2026-11-03T05:00:00.000Z';
    const admin = { id: 'stage2_admin', username: 'admin', ...await hashPassword('StageTwoAdminPassword!'), role: 'admin', status: 'active', ownerId: null, displayName: '管理员', sessionVersion: 0, createdAt: now };
    const developer = { id: 'stage2_dev', username: 'stage2dev', ...await hashPassword('StageTwoDeveloperPass!'), role: 'developer', status: 'active', ownerId: null, displayName: '开发者', sessionVersion: 0, createdAt: now };
    await app.vault.transact(draft => { draft.add('users', admin); draft.add('users', developer); });
    const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: developer.username, password: 'StageTwoDeveloperPass!' }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    assert.deepEqual(Object.keys(auth.user).sort(), ['id', 'role', 'username']);
    const headers = { authorization: `Bearer ${auth.token}` };
    const pluginClient = createProductionHTTP({ origin, allowLocalhost: true, fetchAPI: fetch }); pluginClient.setToken(auth.token);
    const pluginSelf = await pluginClient.accountSelf(); assert.equal(pluginSelf.id, developer.id); assert.equal(pluginSelf.projectLimit, null); assert.equal(pluginSelf.ownedProjectCount, 0);
    assert.deepEqual(Object.keys(await pluginClient.me()).sort(), ['id', 'role', 'username']);
    const accountPage = await fetch(`${origin}/accounts`, { headers });
    assert.equal(accountPage.status, 200);
    const html = await accountPage.text();
    assert.match(html, /href="\/accounts"/);
    assert.doesNotMatch(html, /href="\/invites"/);
    const account = await fetch(`${origin}/api/account/self`, { headers });
    assert.equal(account.status, 200);
    const self = await account.json();
    assert.equal(self.id, developer.id);
    assert.equal(self.expiresAt, null);
    assert.equal(self.projectLimit, null);
    assert.equal(self.ownedProjectCount, 0);
    assert.equal((await fetch(`${origin}/invites`, { headers })).status, 403);
    assert.equal((await fetch(`${origin}/api/admin/users`, { headers })).status, 403);
  } finally {
    if (app) await app.close();
    await fs.rm(tempParent, { recursive: true, force: true });
  }
});
