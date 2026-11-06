import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openVault } from '../平台/仓库.mjs';
import { createPermissions } from '../平台/权限.mjs';
import { installAccountsProjects } from '../平台/账户项目.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heron-frame-groups-'));
  const vault = await openVault({ dataDir: dir });
  await vault.transact(d => {
    for (const [id, role] of [['admin', 'admin'], ['owner', 'designer'], ['other', 'designer'], ['dev', 'developer']]) d.add('users', { id, username: id, role, status: 'active', sessionVersion: 0 });
    d.add('projects', { id: 'legacy', name: 'Legacy', ownerId: 'owner' });
    d.add('projects', { id: 'foreign', name: 'Foreign', ownerId: 'other' });
    d.add('designFiles', { id: 'file-1', projectId: 'legacy', name: 'File' });
    d.add('pages', { id: 'page-1', designFileId: 'file-1', figmaPageId: '0:1', name: 'Page' });
    d.add('frameRevisions', { id: 'rev-1', frameId: 'frame-1', projectId: 'legacy', designFileId: 'file-1', pageId: 'page-1' });
    d.add('frames', { id: 'frame-1', projectId: 'legacy', designFileId: 'file-1', pageId: 'page-1', state: 'published', currentRevisionId: 'rev-1', name: 'Frame' });
  });
  const permissions = createPermissions({ vault }), routes = [];
  const service = installAccountsProjects({ vault, permissions, auth: { actor(req) { if (!req.user) throw Object.assign(new Error('authentication_required'), { status: 401, code: 'authentication_required' }); return req.user; } }, route(method, regex, handler, options) { routes.push({ method, regex, handler, options }); } });
  const user = id => vault.catalog.users.find(x => x.id === id);
  async function request(method, url, id, body = {}) {
    const route = routes.find(r => r.method === method && r.regex.test(url)); assert.ok(route, `${method} ${url}`);
    try { return { status: route.options?.status ?? 200, body: await route.handler({ user: id ? user(id) : null, headers: {} }, {}, { body, params: route.regex.exec(url).groups ?? {}, signal: new AbortController().signal }) }; }
    catch (e) { return { status: e.status ?? 500, code: e.code }; }
  }
  t.after(async () => { await vault.close(); const real = await fs.realpath(dir), temp = await fs.realpath(os.tmpdir()); assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^heron-frame-groups-[A-Za-z0-9_-]+$/); await fs.rm(real, { recursive: true }); });
  return { vault, service, request, dir };
}

test('frame groups are project-scoped, unique per project and survive reopen', async t => {
  const f = await fixture(t), { request, vault } = f;
  assert.deepEqual(vault.catalog.frameGroups, []);
  assert.deepEqual((await request('GET', '/api/projects/legacy/groups', 'owner')).body, { groups: [] });
  assert.equal((await request('GET', '/api/projects/legacy/groups', null)).status, 401);
  assert.equal((await request('GET', '/api/projects/foreign/groups', 'owner')).status, 403);
  assert.equal((await request('POST', '/api/projects/foreign/groups', 'owner', { name: 'No' })).status, 403);
  assert.equal((await request('POST', '/api/projects/legacy/groups', 'dev', { name: 'No' })).status, 403);
  assert.equal((await request('POST', '/api/projects/legacy/groups', 'owner', { name: '   ' })).status, 400);
  const group = await request('POST', '/api/projects/legacy/groups', 'owner', { name: '  英雄  ' });
  assert.equal(group.status, 201); assert.equal(group.body.group.name, '英雄'); assert.equal(group.body.group.projectId, 'legacy');
  assert.equal((await request('POST', '/api/projects/legacy/groups', 'owner', { name: '英雄' })).code, 'group_name_exists');
  const otherGroup = await request('POST', '/api/projects/foreign/groups', 'other', { name: '英雄' });
  assert.equal(otherGroup.status, 201); assert.notEqual(otherGroup.body.group.id, group.body.group.id);
  assert.deepEqual((await request('GET', '/api/projects/foreign/groups', 'other')).body.groups.map(g => g.name), ['英雄']);
  assert.deepEqual((await request('GET', '/api/projects/legacy/groups', 'admin')).body.groups.map(g => [g.name, g.frameCount]), [['英雄', 0]]);
  await vault.close();
  const reopened = await openVault({ dataDir: f.dir });
  assert.equal(reopened.catalog.frameGroups.length, 2); assert.equal(reopened.catalog.frameGroups.find(g => g.projectId === 'legacy').name, '英雄');
  await reopened.close();
});

test('frames move between project groups with CAS and cannot cross projects', async t => {
  const { request, vault } = await fixture(t);
  const group = (await request('POST', '/api/projects/legacy/groups', 'owner', { name: 'A' })).body.group;
  const other = (await request('POST', '/api/projects/foreign/groups', 'other', { name: 'B' })).body.group;
  assert.equal((await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: other.id, expectedGroupId: null })).status, 404);
  assert.equal((await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: group.id })).status, 400);
  assert.equal((await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'dev', { groupId: group.id, expectedGroupId: null })).status, 403);
  const first = await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: group.id, expectedGroupId: null });
  assert.equal(first.status, 200); assert.equal(first.body.groupId, group.id);
  assert.equal((await request('GET', '/api/projects/legacy/groups', 'owner')).body.groups.find(g => g.id === group.id).frameCount, 1);
  assert.equal((await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: null, expectedGroupId: null })).code, 'group_conflict');
  const racers = await Promise.all([
    request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: null, expectedGroupId: group.id }),
    request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'admin', { groupId: group.id, expectedGroupId: group.id })
  ]);
  assert.deepEqual(racers.map(r => r.status).sort(), [200, 409]);
  assert.equal(vault.catalog.frames.find(f => f.id === 'frame-1').groupId, null);
  assert.equal((await request('PATCH', '/api/projects/legacy/frames/frame-1/group', 'owner', { groupId: other.id, expectedGroupId: null })).status, 404);
});

test('projects no longer take a project-level group', async t => {
  const { request } = await fixture(t);
  const created = await request('POST', '/api/projects', 'owner', { name: 'Flat project' });
  assert.equal(created.status, 201); assert.equal(Object.hasOwn(created.body, 'groupId'), false);
  assert.equal((await request('POST', '/api/projects', 'owner', { name: 'With group', groupId: 'anything' })).status, 400);
  const listed = (await request('GET', '/api/projects', 'owner')).body.projects;
  assert.equal(listed.every(p => !Object.hasOwn(p, 'groupId')), true);
});
