// Synthetic loopback HTTP + real Vault only. No live service, credentials or user data.
// Keep each isolated directory for inspection; never remove an existing project here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';

async function fixture(t, { fault } = {}) {
  const parent = await realpath(tmpdir());
  const dataDir = await mkdtemp(path.join(parent, 'heron-delete-regression-'));
  const app = await createPlatform({ dataDir, secret: Buffer.alloc(48, 7), limits: { fault }, logger: { error() {} } });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); t.diagnostic(`Preserved synthetic Vault: ${dataDir}`); });
  await app.vault.transact(d => {
    for (const [id, role] of [['owner', 'designer'], ['other', 'designer'], ['reader', 'developer']]) {
      d.add('users', { id, username: `synthetic-${id}`, role, status: 'active', sessionVersion: 0 });
    }
    d.add('projects', { id: 'target', name: '合成待删除项目', ownerId: 'owner' });
    d.add('projects', { id: 'foreign', name: '必须保留的其他项目', ownerId: 'other' });
    d.add('frameGroups', { id: 'target-group', projectId: 'target', name: '目标分组' });
    d.add('frameGroups', { id: 'foreign-group', projectId: 'foreign', name: '其他分组' });
    d.add('auditLogs', { id: 'old-audit', action: 'synthetic.previous', target: 'target' });
  });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const tokens = Object.fromEntries(app.vault.catalog.users.map(u => [u.id, app.auth.issueAccess(u)]));
  async function request(route, { method = 'GET', body, who = 'owner' } = {}) {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const route = '/api/admin/projects/target';
  const preview = async () => { const r = await request(route + '/delete-preview'); assert.equal(r.status, 200); return r.body; };
  const remove = async (p, overrides = {}, who = 'owner') => request(route, { method: 'DELETE', who, body: { confirmName: p.project.name, acknowledge: true, previewToken: p.previewToken, ...overrides } });
  const disk = () => readFile(path.join(dataDir, 'catalog.json'));
  const operation = (status = 'open', extra = {}) => ({ id: 'synthetic-operation', projectId: 'target', projectOwnerId: 'owner', createdBy: 'owner', requestHash: 'a'.repeat(64), frameIds: ['synthetic-source-node'], groupId: 'target-group', status, ...extra });
  return { app, request, preview, remove, disk, operation, dataDir };
}

test('grouped project preview includes its groups; deletion keeps other project, audit and original bytes', async t => {
  const h = await fixture(t), bytes = Buffer.from('synthetic retained source asset');
  const original = await h.app.vault.putOriginal({ data: bytes, bytes: bytes.length, mime: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex') });
  await h.app.vault.transact(d => {
    d.add('assets', original);
    d.add('designFiles', { id: 'file', projectId: 'target' });
    d.add('pages', { id: 'page', designFileId: 'file', figmaPageId: 'synthetic-page' });
    d.add('frames', { id: 'frame', designFileId: 'file', pageId: 'page', groupId: 'target-group', state: 'published', currentRevisionId: 'revision' });
    d.add('frameRevisions', { id: 'revision', frameId: 'frame', layerDocAssetId: original.id });
    d.add('revisionAssets', { revisionId: 'revision', assetId: original.id });
  });
  const p = await h.preview();
  assert.equal(p.canDelete, true); assert.equal(p.counts.frameGroups, 1);
  const r = await h.remove(p); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted, true); assert.equal(r.body.counts.frameGroups, 1);
  assert.deepEqual(h.app.vault.catalog.projects.map(x => x.id), ['foreign']);
  assert.deepEqual(h.app.vault.catalog.frameGroups.map(x => x.id), ['foreign-group']);
  assert.equal(h.app.vault.catalog.frames.length, 0);
  assert.equal(h.app.vault.catalog.assets[0].sha256, original.sha256);
  assert.ok(h.app.vault.catalog.auditLogs.some(x => x.id === 'old-audit'));
  assert.ok(h.app.vault.catalog.auditLogs.some(x => x.action === 'project.delete'));
  // Read via the existing asset capability, not a guessed storage pathname.
  assert.deepEqual(await h.app.vault.readOriginal(original), bytes);
});

for (const change of ['add', 'rename', 'remove']) test(`group ${change} after preview is stale and never commits partial deletion`, async t => {
  const h = await fixture(t), old = await h.preview();
  await h.app.vault.transact(d => {
    if (change === 'add') d.add('frameGroups', { id: 'new-group', projectId: 'target', name: '新分组' });
    if (change === 'rename') d.patch('frameGroups', 'target-group', { name: '已改名' });
    if (change === 'remove') d.remove('frameGroups', 'target-group');
  });
  const before = await h.disk(), r = await h.remove(old);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'delete_preview_stale');
  assert.deepEqual(await h.disk(), before);
  const fresh = await h.preview(); assert.notEqual(fresh.previewToken, old.previewToken);
  assert.equal((await h.remove(fresh)).status, 200);
});

for (const status of ['open', 'unknown-state']) test(`${status} operation without a session blocks preview and deletion`, async t => {
  const h = await fixture(t);
  await h.app.vault.transact(d => d.add('publishOperations', h.operation(status)));
  const p = await h.preview(), before = await h.disk();
  assert.equal(p.activePublishSessions.length, 0); assert.equal(p.canDelete, false);
  assert.equal(p.activePublishOperations.length, 1); assert.ok(p.blockers.includes('project_busy'));
  const r = await h.remove(p); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'project_busy');
  assert.deepEqual(await h.disk(), before);
});

test('partial operation with committed session still blocks without cancelling or clearing it', async t => {
  const h = await fixture(t);
  await h.app.vault.transact(d => {
    d.add('publishOperations', h.operation('partial'));
    d.add('publishSessions', { id: 'finished-batch', projectId: 'target', operationId: 'synthetic-operation', createdBy: 'owner', batchIndex: 0, requestHash: 'b'.repeat(64), groupId: 'target-group', prepareResult: { sessionId: 'finished-batch' }, status: 'committed' });
  });
  const p = await h.preview(), before = await h.disk();
  assert.equal(p.activePublishSessions.length, 0); assert.equal(p.canDelete, false);
  const r = await h.remove(p); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'project_busy');
  assert.deepEqual(await h.disk(), before);
});

test('another project operation and group are neither blocked nor removed', async t => {
  const h = await fixture(t);
  await h.app.vault.transact(d => d.add('publishOperations', h.operation('open', { projectId: 'foreign', projectOwnerId: 'other', createdBy: 'other', groupId: 'foreign-group' })));
  const saved = JSON.stringify(h.app.vault.catalog.publishOperations), p = await h.preview();
  assert.equal(p.canDelete, true); assert.equal((await h.remove(p)).status, 200);
  assert.equal(JSON.stringify(h.app.vault.catalog.publishOperations), saved);
  assert.equal(h.app.vault.catalog.frameGroups[0].id, 'foreign-group');
});

test('operation started after preview is rechecked inside transaction', async t => {
  const h = await fixture(t), p = await h.preview();
  await h.app.vault.transact(d => d.add('publishOperations', h.operation()));
  const before = await h.disk(), r = await h.remove(p);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'project_busy'); assert.deepEqual(await h.disk(), before);
});

for (const status of ['completed', 'cancelled']) test(`${status} operation tombstone survives project deletion unchanged`, async t => {
  const h = await fixture(t);
  await h.app.vault.transact(d => d.add('publishOperations', h.operation(status)));
  const saved = JSON.stringify(h.app.vault.catalog.publishOperations), p = await h.preview();
  assert.equal(p.canDelete, true); assert.equal(p.publishOperationsRetained, true);
  const r = await h.remove(p); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(JSON.stringify(h.app.vault.catalog.publishOperations), saved);
});

test('permissions, exact-name and acknowledgement checks remain mandatory', async t => {
  const h = await fixture(t), p = await h.preview(), before = await h.disk();
  assert.equal((await h.remove(p, { confirmName: p.project.name + ' ' })).status, 400);
  assert.equal((await h.remove(p, { acknowledge: false })).status, 400);
  assert.equal((await h.remove(p, {}, 'reader')).status, 403);
  await h.app.vault.transact(d => d.patch('projects', 'target', { ownerId: 'other' }));
  const changed = await h.disk(), r = await h.remove(p);
  assert.equal(r.status, 403); assert.deepEqual(await h.disk(), changed); assert.notDeepEqual(changed, before);
});

test('failed durable save rolls back groups and all project relationships', async t => {
  let armed = false;
  const h = await fixture(t, { fault(point) { if (armed && point === 'beforeRename') throw Error('synthetic durable-save failure'); } });
  const p = await h.preview(), before = await h.disk(), current = h.app.vault.catalog;
  armed = true;
  const r = await h.remove(p); assert.equal(r.status, 500);
  assert.equal(h.app.vault.catalog, current); assert.deepEqual(await h.disk(), before);
});
