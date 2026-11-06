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

test('C29 selected slice uses PNG variant while frame preview remains JPEG',async()=>{const r=await ready(rig()),options={frameId:row.frameId,revisionId:row.revisionId,maxDimension:256,variant:'slice-alpha'};const result=await r.adapter.getPreview('asset_cut',options);assert.equal(result.mime,'image/png');assert.match(r.calls.at(-1).url,/asset_cut\/slice\/256\.png$/);const count=r.calls.length;await assert.rejects(r.adapter.getPreview('asset_hero',options));assert.equal(r.calls.length,count);await r.adapter.getPreview('asset_hero',{...options,variant:undefined});assert.match(r.calls.at(-1).url,/256\.jpg$/);});
test('C29 slice variant rejects JPEG response instead of white fallback',async()=>{const r=await ready(rig((url,o)=>o.method==='HEAD'?new Response(null,{headers:{'content-type':'image/jpeg','content-length':'75','x-heron-preview-width':'30','x-heron-preview-height':'20'}}):null));await assert.rejects(r.adapter.getPreview('asset_cut',{frameId:row.frameId,revisionId:row.revisionId,maxDimension:256,variant:'slice-alpha'}),/PNG/);});
