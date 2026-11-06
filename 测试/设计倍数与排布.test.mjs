import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createProductionSession, productionPrepareHash } from '../插件/production-session.mjs';
import { PRODUCTION_BODY_LIMIT } from '../插件/production-protocol.mjs';
import { createPublishing, validatePrepare, fingerprint } from '../平台/发布.mjs';
import { displayValue } from '../查看器/core.mjs';

const expiry = '2099-01-01T00:00:00.000Z';
const namespace = `src_launch_${'a'.repeat(32)}`;
function png() { const a = new Uint8Array(33); a.set([137, 80, 78, 71, 13, 10, 26, 10]); const v = new DataView(a.buffer); v.setUint32(8, 13); a.set([73, 72, 68, 82], 12); v.setUint32(16, 2); v.setUint32(20, 3); return a; }
function sdkModel() {
  const page = { id: '1:1', name: 'Page', children: [], selection: [] }; const root = { name: 'File', children: [page] };
  page.children = [{ id: '2:1', type: 'FRAME', name: 'Frame', width: 1, height: 1.5, absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1.5 }, absoluteTransform: [[1, 0, 0], [0, 1, 0]], children: [], exportAsync: async () => png() }];
  page.selection = page.children.slice(); return { sdk: { editorType: 'figma', root, currentPage: page, fileKey: 'actualFileKey' } };
}
function adapterFor(calls) {
  let count = 0, nextIntent = 0; const sessions = new Map(), operations = new Map();
  const version = `${'a'.repeat(32)}:1`, policy = { version: 1, mode: 'adaptive', maxConcurrentUploads: 1, maxInFlightBytes: PRODUCTION_BODY_LIMIT };
  return {
    projects: async () => [{ id: 'p', name: 'P', permissions: { canPublish: true } }],
    async intent(projectId) { return { projectId, operationId: `op_${(++nextIntent).toString(16).padStart(32, '0')}_${'a'.repeat(64)}` }; },
    async claim(input) { const operation = { ...structuredClone(input), status: 'open' }; operations.set(input.operationId, operation); return { ...operation }; },
    async queryOperation() { assert.fail('unexpected operation query'); },
    async finish(operationId, readVersion) { assert.equal(readVersion, version); const operation = operations.get(operationId); assert.ok(operation); return { ...operation, status: 'completed', remainingFrameIds: [] }; },
    async publishSource(projectId, body) { calls.push(['source', body]); return { projectId, designFileId: 'platform-file', source: body.source, baseRevisions: Object.fromEntries(body.frameIds.map(id => [id, null])) }; },
    async prepare(body, operationId, batchIndex) { calls.push(['prepare', body]); assert.ok(operations.has(operationId)); const sid = `sid-${++count}`; const frames = body.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: `platform-${f.figmaNodeId}`, status: 'new', missingAssetSha256: [...new Set([f.layerDocSha256, ...(f.previewSha256 ? [f.previewSha256] : []), ...f.exports.map(e => e.sha256)])] })); sessions.set(sid, frames); const requestHash = await productionPrepareHash(body, operationId, batchIndex, webcrypto); return { sessionId: sid, status: 'open', expiresAt: null, automaticExpiry: false, operationId, batchIndex, requestHash, designFileId: 'platform-file', maxUploadBytes: PRODUCTION_BODY_LIMIT, uploadPolicy: policy, missingAssetSha256: [...new Set(frames.flatMap(f => f.missingAssetSha256))], frames }; },
    async upload(sid, asset) { return { ok: true, sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime }; },
    async commit(sid) { return { sessionId: sid, status: 'committed', frames: sessions.get(sid).map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId, revisionId: `rev-${f.figmaNodeId}`, status: 'new' })) }; },
    async queryCommitResult() { assert.fail('unexpected result query'); },
    async query(sid) { return { sessionId: sid, status: 'open', expiresAt: expiry, uploaded: [], uploadPolicy: {}, frames: sessions.get(sid) }; },
    async abort(sid) { return { sessionId: sid, status: 'aborted' }; },
    async verifyPublication(projectId, groupId, frames) {
      calls.push(['verify', projectId, groupId, structuredClone(frames)]); assert.equal(projectId, 'p');
      for (const frame of frames) {
        assert.ok([...sessions.values()].flat().some(f => f.figmaNodeId === frame.figmaNodeId && f.frameId === frame.frameId));
        assert.equal(frame.revisionId, `rev-${frame.figmaNodeId}`);
      }
      return { projectId, groupId, frameCount: frames.length, catalogReadVersion: version };
    }
  };
}
const sessionFor = (sdk, adapter) => createProductionSession({ sdk, adapter, namespace, cryptoAPI: webcrypto });

test('published manifest carries 规范/倍数 and rejects unknown specs', async () => {
  const calls = [], session = sessionFor(sdkModel().sdk, adapterFor(calls));
  await session.publish({ projectId: 'p', scale: 2, designSpec: 'ios' });
  const frame = calls.find(call => call[0] === 'prepare')[1].frames[0];
  assert.equal(frame.designSpec, 'ios'); assert.equal(frame.designScale, 2);
  const rejected = sessionFor(sdkModel().sdk, adapterFor([]));
  await assert.rejects(rejected.publish({ projectId: 'p', designSpec: 'desktop' }), { code: 'BAD_SCHEMA' });
  assert.equal(rejected.status().phase, 'idle');
});

test('publish carries the selected project group to prepare', async () => {
  const calls = [], session = sessionFor(sdkModel().sdk, adapterFor(calls));
  await session.publish({ projectId: 'p', groupId: 'group-1', scale: 2 });
  assert.equal(calls.find(call => call[0] === 'prepare')[1].groupId, 'group-1');
  const rejected = sessionFor(sdkModel().sdk, adapterFor([]));
  await assert.rejects(rejected.publish({ projectId: 'p', groupId: 'bad/group' }), { code: 'BAD_ID' });
});

test('server accepts valid design metadata on prepare and stores it on the frame at commit', async () => {
  const doc = { contractVersion: 1, frame: { id: '1:1', type: 'FRAME', name: 'Frame', absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, children: [] }, styles: { TEXT: [], FILL: [], EFFECT: [], GRID: [] }, components: [] };
  const bytes = Buffer.from(JSON.stringify(doc));
  const { sha256 } = await import('../平台/下载.mjs');
  const f = { figmaNodeId: '1:1', figmaPageId: '0:1', name: 'Frame', x: 0, y: 0, width: 20, height: 10, layerDocSha256: sha256(bytes), layerDocBytes: bytes.length, exports: [], baseRevisionId: null };
  f.hash = sha256(Buffer.from(JSON.stringify([f.layerDocSha256, null, [], null])));
  assert.doesNotThrow(() => validatePrepare({ projectId: 'p', designFile: { designFileId: 'f' }, source: { kind: 'figma-file', fileKey: 'File123' }, requireBaseRevision: true, frames: [{ ...f, designSpec: 'android', designScale: 3 }] }));
  assert.throws(() => validatePrepare({ projectId: 'p', designFile: { designFileId: 'f' }, source: { kind: 'figma-file', fileKey: 'File123' }, requireBaseRevision: true, frames: [{ ...f, designSpec: 'desktop' }] }), e => e.code === 'invalid_design_spec');
  assert.throws(() => validatePrepare({ projectId: 'p', designFile: { designFileId: 'f' }, source: { kind: 'figma-file', fileKey: 'File123' }, requireBaseRevision: true, frames: [{ ...f, designScale: 0 }] }), e => e.code === 'invalid_design_scale');
  assert.equal(typeof createPublishing, 'function');
  assert.equal(fingerprint({ ...f, designSpec: 'android', designScale: 3 }), fingerprint(f), 'design metadata must not rewrite source identity');
});

test('viewer converts 750 design pixels to the selected platform unit', () => {
  assert.equal(displayValue(750, { unit: 'px', platform: 'web', density: 1 }).text, '750px');
  assert.equal(displayValue(750, { unit: 'pt', platform: 'ios', density: 2 }).text, '375pt');
  assert.equal(displayValue(750, { unit: 'dp', platform: 'android', density: 3 }).text, '250dp');
});

test('workspace follows the requested order and drops the exclusion sentence', async () => {
  const html = await readFile(new URL('../插件/ui.html', import.meta.url), 'utf8');
  const ids = ['design-spec', 'design-scale', 'production-project-open', 'production-group-open', 'frames', 'scope-selection', 'publish', 'production-settings-toggle'];
  const positions = ids.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position > 0), 'every requested control exists');
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b), 'controls follow the requested top-to-bottom order');
  assert.match(html, /设计倍数/); assert.match(html, /该页全部画板/); assert.match(html, /Web/); assert.match(html, /@3x/);
  assert.doesNotMatch(html, /项排除|非 FRAME|非当前页顶层画板|画板清单|导出设置|正在读取画板/);
  assert.ok(html.includes('id="excluded" hidden'), 'legacy live region stays hidden and empty');
  assert.ok(html.includes('id="scope" hidden'), 'legacy scope select is driven by the two radios');
  assert.ok(html.indexOf('id="production-group-page"') > html.indexOf('id="production-project-page"'), 'project groups are selected on their own project-scoped page');
  assert.ok(!html.includes('id="production-group-list"') && !html.includes('id="production-create-group"'), 'the old project-group model is gone');
});
