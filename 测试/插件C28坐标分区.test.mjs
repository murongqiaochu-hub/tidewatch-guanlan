// NOT_REAL_FIGMA: synthetic public SDK + real local publishing/validation code.
// No live service, document edits, credentials, image renderer or deployed UI involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createExporter, eligibleFrames, topLevelFrameSet } from '../插件/exporter.mjs';
import { listProductionFrames, translateProductionFrames } from '../插件/production-session.mjs';
import { validatePublishSourceBody } from '../插件/production-protocol.mjs';
import { createPublishing } from '../平台/发布.mjs';
import { crc32, problem } from '../平台/下载.mjs';

function png(width, height) {
  const chunk = (kind, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const image = png(1600, 1120);
function model(x, y, depth = 0, scope = 'selection') {
  let calls = 0;
  const frame = Object.freeze({ id: '2:1', type: 'FRAME', name: 'Board', x: 20, y: 30, width: 1600, height: 1120,
    absoluteBoundingBox: Object.freeze({ x, y, width: 1600, height: 1120 }), absoluteTransform: Object.freeze([Object.freeze([1, 0, x]), Object.freeze([0, 1, y])]),
    children: Object.freeze([]), exportSettings: Object.freeze([]), async exportAsync(settings) { calls++; assert.equal(settings.useAbsoluteBounds, true); return image; } });
  let outer = frame;
  for (let i = 0; i < depth; i++) outer = Object.freeze({ id: `s:${i}`, type: 'SECTION', children: Object.freeze([outer]) });
  const page = { id: 'page:1', name: 'Real page, not section', children: [outer], selection: scope === 'frame' ? [frame] : [outer] };
  return { frame, outer, sdk: { root: { children: [page] }, currentPage: page, fileKey: 'FileA' }, calls: () => calls };
}
function server() {
  const names = ['users','projects','projectMembers','projectInvites','inviteClaims','designFiles','pages','sections','frames','frameRevisions','assets','revisionAssets','publishSessions','auditLogs','rememberedLogins','frameGroups','publishOperations'];
  let catalog = Object.fromEntries(names.map(n => [n, []])), tail = Promise.resolve(); catalog.projects.push({ id: 'p', name: 'P' });
  const bytes = new Map(), staged = new Map();
  const vault = { get catalog() { return catalog; }, transact(fn) { const task = tail.then(async () => { const copy = structuredClone(catalog); const d = { all: n => copy[n], byId: (n, id) => copy[n].find(r => r.id === id), add: (n, r) => copy[n].push(r), patch: (n, id, fields) => Object.assign(copy[n].find(r => r.id === id), fields) }; const result = await fn(d); catalog = copy; return result; }); tail = task.catch(() => {}); return task; },
    async stageAsset(s, d, b) { staged.set(s + '/' + d.sha256, Buffer.from(b)); }, async readStaged(s, h) { const b = staged.get(s + '/' + h); if (!b) throw problem(409, 'missing'); return b; },
    async putOriginal(d) { bytes.set(d.sha256, d.data); return { id: 'a_' + d.sha256, sha256: d.sha256, mime: d.mime, bytes: d.bytes, relativePath: d.sha256 }; }, async readOriginal(a) { return bytes.get(a.sha256); } };
  const context = { vault, clock: () => 1800000000000, auth: { actor: () => ({ id: 'u' }) }, permissions: { requireRead() {}, requirePublish() {}, project: () => ({}) } };
  return { vault, service: createPublishing(context) };
}

for (const [x, y] of [[-126320, -67904], [126320, 67904], [-10000000.25, 10000000.5], [10000000.25, -10000000.5]]) for (const depth of [0, 2]) {
  test(`C28 real local source→export→translate→prepare→upload→commit: ${x},${y}, SECTION depth ${depth}`, async () => {
    const m = model(x, y, depth), h = server(), req = { headers: { 'content-type': 'application/octet-stream' } };
    for (const scope of ['selection', 'page']) assert.deepEqual(listProductionFrames(m.sdk, scope).frames, [m.frame]);
    m.sdk.currentPage.selection = [m.frame]; assert.deepEqual(listProductionFrames(m.sdk, 'selection').frames, [m.frame]);
    const source = { kind: 'figma-file', fileKey: m.sdk.fileKey }, coordinates = [{ frameId: m.frame.id, x, y }];
    const bound = await h.service.publishSource(req, 'p', validatePublishSourceBody({ source, frameIds: [m.frame.id], coordinates }));
    const exported = await createExporter(m.sdk, { cryptoAPI: webcrypto }).exportFrames(listProductionFrames(m.sdk, 'selection').frames, { includeSlices: false });
    const translated = await translateProductionFrames(exported, { projectId: 'p', designFileId: bound.designFileId, source, page: m.sdk.currentPage, bases: new Map(Object.entries(bound.baseRevisions)), coordinateMode: 'project-xy', coordinates: new Map([[m.frame.id, { x, y }]]), cryptoAPI: webcrypto });
    assert.deepEqual(exported.frames[0].preview.target, { width: 1600, height: 1120 });
    assert.equal(translated.body.frames[0].figmaPageId, 'page:1');
    const prepared = await h.service.prepare(req, translated.body);
    for (const hash of prepared.missingAssetSha256) { const asset = translated.assets.get(hash); await h.service.upload({ headers: { ...req.headers, 'x-asset-mime': asset.mime } }, prepared.sessionId, hash, asset.data); }
    const result = await h.service.commit(req, prepared.sessionId);
    assert.equal(result.status, 'committed'); assert.equal(h.vault.catalog.frameRevisions.length, 1);
    const revision = h.vault.catalog.frameRevisions[0]; assert.equal(revision.x, x); assert.equal(revision.y, y);
    assert.equal(h.vault.catalog.pages[0].figmaPageId, 'page:1'); assert.equal(m.calls(), 1);
    assert.equal(m.frame.x, 20); assert.equal(m.frame.y, 30); assert.deepEqual(m.frame.absoluteBoundingBox, { x, y, width: 1600, height: 1120 });
  });
}

test('C28 overlapping Section/Frame selections collect each frame once (no duplicate publish)', async () => {
  const m = model(-126320, -67904, 2); m.sdk.currentPage.selection = [m.outer, m.frame, m.outer.children[0]];
  assert.deepEqual(eligibleFrames(m.sdk).frames, [m.frame]);
  const out = await createExporter(m.sdk, { cryptoAPI: webcrypto }).exportSelection({ includeSlices: false });
  assert.equal(out.frames.length, 1); assert.equal(m.calls(), 1);
});
test('C28 deeply nested Sections are not silently dropped at depth eight', () => {
  const m = model(126320, 67904, 12);
  assert.deepEqual(eligibleFrames(m.sdk, 'page').frames, [m.frame]);
  assert.deepEqual([...topLevelFrameSet(m.sdk)], [m.frame]);
  assert.deepEqual(listProductionFrames(m.sdk, 'selection').frames, [m.frame]);
});
test('C28 empty/unreadable/cyclic Sections do not silently produce partial success', () => {
  const m = model(0, 0);
  const empty = { id: 's:empty', type: 'SECTION', children: [] };
  m.sdk.currentPage.selection = [empty];
  assert.deepEqual(eligibleFrames(m.sdk).excluded, [{ id: empty.id, type: 'SECTION', reason: 'section-without-frame' }]);
  const unreadable = { id: 's:bad', type: 'SECTION', get children() { throw Error('sdk getter'); } };
  m.sdk.currentPage.selection = [m.frame, unreadable];
  assert.throws(() => eligibleFrames(m.sdk), { code: 'SDK_READ_FAILED' });
  const cyclic = { id: 's:cycle', type: 'SECTION', children: [] }; cyclic.children.push(cyclic);
  m.sdk.currentPage.children = [cyclic];
  assert.throws(() => topLevelFrameSet(m.sdk), { code: 'SDK_READ_FAILED' });
});
test('C28 excessive Section depth fails explicitly, never truncates the board list', () => {
  const m = model(0, 0, 1025);
  assert.throws(() => eligibleFrames(m.sdk, 'page'), { code: 'UNSUPPORTED_DEPTH' });
});
test('C28 Sections do not promote boards nested inside a Frame or Group', () => {
  const m = model(0, 0); const nested = { ...m.frame, id: '2:2' };
  m.sdk.currentPage.children = [{ id: 's:1', type: 'SECTION', children: [{ ...m.frame, children: [nested] }, { id: 'g:1', type: 'GROUP', children: [nested] }] }];
  m.sdk.currentPage.selection = [nested];
  assert.equal(listProductionFrames(m.sdk, 'selection').frames.length, 0);
});
