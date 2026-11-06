import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionAdapter } from '../宿主/production-adapter.mjs'

const context = { projectId: 'prj_01', designFileId: 'file_alpha', frameId: 'frm_A', revisionId: 'rev_A1' }
const row = { projectId: 'prj_01', designFileId: 'file_alpha', pageId: 'page_7', frameId: 'frm_A', revisionId: 'rev_A1', currentRevisionId: 'rev_A1', name: '同名', groupId: 'grp_1', previewAsset: { assetId: 'asset_hero', width: 100, height: 80, mime: 'image/png', byteLength: 100 } }
const hero = { assetId: 'asset_hero', frameId: 'frm_A', revisionId: 'rev_A1', width: 100, height: 80, mime: 'image/png', byteLength: 100 }
const slice = { ...hero, assetId: 'asset_cut', sliceId: 'ra_A', width: 30, height: 20, byteLength: 75 }
const dto = { identity: { projectId: 'prj_01', designFileId: 'file_alpha', pageId: 'page_7', frameId: 'frm_A', revisionId: 'rev_A1' }, layerDoc: { contractVersion: 1, frame: { id: '19:2', type: 'FRAME', absoluteBoundingBox: { x: -0.25, y: 3.75, width: 100, height: 80 } } }, assets: [hero], slices: [slice], context }
const JSONResponse = value => { const body = JSON.stringify(value); return new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } }) }
function rig(override = () => null, windowObject) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, credentials: options.credentials, redirect: options.redirect })
    const custom = await override(url, options); if (custom) return custom
    const path = new URL(url).pathname
    if (path.endsWith('/directory')) return JSONResponse({ projectId: context.projectId, frames: [row], groups: [{ id: 'grp_1', projectId: context.projectId, name: '分组', frameCount: 1 }], permissions: { canPublish: false } })
    if (path.endsWith('/revisions')) return JSONResponse({ frameId: row.frameId, currentRevisionId: row.revisionId, revisions: [{ id: row.revisionId, name: '原稿', createdAt: '2026-10-15T00:00:00Z' }] })
    if (path.endsWith('/revisions/rev_A1')) return JSONResponse(dto)
    if (options.method === 'HEAD') return new Response(null, { headers: { 'content-type': path.endsWith('.zip') ? 'application/zip' : path.includes('/download') ? 'image/png' : path.endsWith('.png') ? 'image/png' : 'image/jpeg', 'content-length': '75', 'x-heron-preview-width': path.includes('/native/') ? '512' : '30', 'x-heron-preview-height': '20', 'content-disposition': "attachment; filename=\"slice.bin\"; filename*=UTF-8''%E5%9B%BE%E6%A0%87%E5%88%87%E5%9B%BE.png" } })
    throw new Error('Unexpected fixture request')
  }
  return { calls, adapter: createProductionAdapter({ context, baseURL: 'https://owned.example', fetchImpl, windowObject }) }
}
async function ready(r) { await r.adapter.listFrames(); await r.adapter.loadRevision(row.frameId, row.revisionId); return r }

test('production shape stable IDs load directory, versions, one tree with source float intact', async () => {
  const r = await ready(rig()); const versions = await r.adapter.listRevisions(row.frameId)
  assert.equal(versions[0].revisionId, row.revisionId); assert.equal(versions[0].current, true)
  const result = await r.adapter.loadRevision(row.frameId, row.revisionId)
  assert.equal(result.layerDoc.frame.absoluteBoundingBox.x, -0.25)
  assert.equal(r.calls.filter(c => c.method === 'GET' && c.url.includes('/api/inspector/frames/')).length, 2)
  assert.ok(r.calls.every(c => c.credentials === 'same-origin' && c.redirect === 'error'))
})
test('directory exposes project-scoped frame groups with project identity', async () => {
  const r = rig(); const frames = await r.adapter.listFrames()
  assert.equal(frames.length, 1); assert.equal(frames.groups.length, 1); assert.equal(frames.groups[0].projectId, context.projectId); assert.equal(frames.groups[0].name, '分组')
})

test('slice asset gets real JPEG descriptor, not frame-ID synthetic fixture restriction', async () => {
  const r = await ready(rig()), result = await r.adapter.getPreview('asset_cut', { frameId: row.frameId, revisionId: row.revisionId, maxDimension: 256 })
  assert.equal(result.assetId, 'asset_cut'); assert.equal(result.mime, 'image/jpeg'); assert.equal(result.width, 30)
  assert.equal(r.calls.at(-1).url, 'https://owned.example/api/previews/asset_cut/256.jpg')
})
test('native tile indices translate to source 512 pixel offsets', async () => {
  const r = await ready(rig()), result = await r.adapter.getNativeTile('asset_hero', { frameId: row.frameId, revisionId: row.revisionId, x: 1, y: 2, tileSize: 512 })
  assert.equal(r.calls.at(-1).url, 'https://owned.example/api/previews/asset_hero/native/512_1024.png'); assert.equal(result.width, 512)
})
test('rejects unknown asset and cross-revision ownership before network', async () => {
  const r = await ready(rig()), count = r.calls.length
  await assert.rejects(r.adapter.getPreview('unowned', { frameId: row.frameId, revisionId: row.revisionId, maxDimension: 64 }))
  await assert.rejects(r.adapter.getPreview('asset_cut', { frameId: row.frameId, revisionId: 'rev_other', maxDimension: 64 }))
  assert.equal(r.calls.length, count)
})
test('ZIP is selected-revision scoped HEAD, never absent ids full-project or body GET', async () => {
  const r = await ready(rig()), count = r.calls.length, result = await r.adapter.getSliceDownloadUrl(row.frameId, row.revisionId, { kind: 'zip' })
  assert.equal(result.mime, 'application/zip'); assert.equal(result.frameId, row.frameId); assert.equal(result.revisionId, row.revisionId)
  assert.equal(r.calls.length, count + 1); assert.equal(r.calls.at(-1).method, 'HEAD')
  assert.equal(r.calls.at(-1).url, 'https://owned.example/api/inspector/frames/frm_A/revisions/rev_A1/slices.zip')
})
test('UTF8 filename decoded from RFC5987 with native source MIME', async () => {
  const r = await ready(rig()), result = await r.adapter.getSliceDownloadUrl(row.frameId, row.revisionId, { kind: 'slice', sliceId: 'ra_A' })
  assert.equal(result.filename, '图标切图.png'); assert.equal(result.mime, 'image/png')
})
test('bad slice not requested and unknown MIME does not become PNG', async () => {
  const r = await ready(rig()), count = r.calls.length
  await assert.rejects(r.adapter.getSliceDownloadUrl(row.frameId, row.revisionId, { kind: 'slice', sliceId: 'other_ra' }))
  assert.equal(r.calls.length, count)
})
test('bad/zero/absent actual length rejects image descriptor', async () => {
  const r = await ready(rig((url, o) => o.method === 'HEAD' ? new Response(null, { headers: { 'content-type': 'image/jpeg', 'content-length': '0', 'x-heron-preview-width': '64', 'x-heron-preview-height': '64' } }) : null))
  await assert.rejects(r.adapter.getPreview('asset_cut', { frameId: row.frameId, revisionId: row.revisionId, maxDimension: 64 }), /长度/)
})
test('bad actual MIME cannot pass JPEG filename gate', async () => {
  const r = await ready(rig((url, o) => o.method === 'HEAD' ? new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '100', 'x-heron-preview-width': '64', 'x-heron-preview-height': '64' } }) : null))
  await assert.rejects(r.adapter.getPreview('asset_hero', { frameId: row.frameId, revisionId: row.revisionId, maxDimension: 64 }), /JPEG/)
})
test('cross-project DTO is rejected, not replaced with latest synthetic data', async () => {
  const r = rig(url => url.endsWith('/revisions/rev_A1') ? JSONResponse({ ...dto, identity: { ...dto.identity, projectId: 'other_p' } }) : null)
  await r.adapter.listFrames(); await assert.rejects(r.adapter.loadRevision(row.frameId, row.revisionId), /身份/)
})
test('current alias queries actual version directory before loading the exact revision', async () => {
  const r = rig(); await r.adapter.listFrames(); const result = await r.adapter.loadRevision(row.frameId, 'current')
  assert.equal(result.identity.revisionId, row.revisionId)
  assert.equal(r.calls.at(-2).url, 'https://owned.example/api/frames/frm_A/revisions')
  assert.equal(r.calls.at(-1).url, 'https://owned.example/api/inspector/frames/frm_A/revisions/rev_A1')
})
test('owned history pushes stable selected identities and resolves browser URL', () => {
  const calls = [], location = { origin: 'https://owned.example', href: 'https://owned.example/viewer/r/frm_A?revision=rev_A1' }
  const windowObject = { location, history: { pushState(state, title, url) { calls.push(['push', state, url]); location.href = url }, replaceState(state, title, url) { calls.push(['replace', state, url]); location.href = url } } }
  const { adapter } = rig(undefined, windowObject)
  adapter.onNavigate({ frameId: 'frm_B', revisionId: 'rev_B2' }); assert.equal(calls.length, 1)
  assert.deepEqual(adapter.resolveLocation(), { frameId: 'frm_B', revisionId: 'rev_B2', mode: 'frame' })
  adapter.onNavigate({ frameId: 'frm_B', revisionId: 'rev_B2' }); assert.equal(calls.length, 1)
  adapter.onNavigate({ frameId: 'frm_A', revisionId: 'rev_A1', replace: true }); assert.equal(calls[1][0], 'replace')
})
test('rejects cross-origin or credential-bearing base and unsafe directory IDs', async () => {
  assert.throws(() => createProductionAdapter({ context, baseURL: 'https://user:pass@owned.example', fetchImpl: fetch }))
  assert.throws(() => createProductionAdapter({ context, baseURL: 'https://other.example', fetchImpl: fetch, windowObject: { location: { origin: 'https://owned.example' } } }))
  await assert.rejects(rig().adapter.listFrames({ designFileId: '../escape' }))
})
