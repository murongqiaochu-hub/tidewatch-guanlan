import { randomUUID } from 'node:crypto';
import { sha256 } from './stored-zip.mjs';
import { httpProblem } from './image-store.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[\w:.-]{1,160}$/;
const clone = value => JSON.parse(JSON.stringify(value));
function check(condition, message) { if (!condition) throw httpProblem(400, message); }
function descriptor(value) {
  check(value && hashPattern.test(value.sha256), 'Asset SHA256');
  check(Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 32 * 1024 * 1024, 'Asset byteLength');
  check(['application/json', 'image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf', 'application/octet-stream'].includes(value.mime), 'Asset MIME');
  return { sha256: value.sha256, byteLength: value.byteLength, mime: value.mime };
}
const assetKey = d => [d.sha256, d.byteLength, d.mime].join(':');
export function frameContentHash(frame) {
  return sha256(Buffer.from(JSON.stringify([frame.layerDocSHA, frame.previewSHA ?? null, frame.exports || [], frame.transform ?? null])));
}

// Synthetic, process-local transaction demonstration, not a production auth,
// storage migration, SDK fixture, distributed DB or legacy core adapter.
export function createSyntheticPublisher({ ttlMs = 5 * 60_000, byteLimit = 80 * 1024 * 1024, maxOpen = 32, now = Date.now, initialRevisions = [] } = {}) {
  const sessions = new Map(), committedAssets = new Map(), heads = new Map(), revisions = new Map();
  let closed = false, retainedBytes = 0, revisionCounter = 0;
  for (const identity of initialRevisions) heads.set([identity.projectId, identity.designFileId, identity.pageId, identity.frameId].join('/'), clone(identity));
  const metrics = { prepared: 0, uploaded: 0, committed: 0, aborted: 0, expired: 0, originalDataWrites: 0, retainedBytes: 0 };
  function requireActor(actor, publish = false) {
    if (!actor?.enabled) throw httpProblem(401, 'Synthetic authentication required');
    if (publish && !['developer', 'editor'].includes(actor.role)) throw httpProblem(403, 'Synthetic publish role required');
  }
  function resolve(session, state) {
    if (session.state === 'prepared') {
      for (const bytes of session.uploads.values()) retainedBytes -= bytes.length;
      session.uploads.clear(); session.state = state; metrics[state]++; metrics.retainedBytes = retainedBytes;
    }
  }
  function sweep() { for (const session of sessions.values()) if (session.state === 'prepared' && now() >= session.expiresAt) resolve(session, 'expired'); }
  function owned(sessionId, actor, publish = false) {
    requireActor(actor, publish); sweep();
    check(typeof sessionId === 'string' && /^[\w-]{16,160}$/.test(sessionId), 'Synthetic session ID');
    const s = sessions.get(sessionId);
    if (s && (s.actorId !== actor.actorId || s.manifest.projectId !== actor.projectId)) throw httpProblem(403, 'Synthetic session owner mismatch');
    return s;
  }
  function state(s, sessionId) {
    return s ? { sessionId, state: s.state, ...(s.identities ? { revisions: clone(s.identities) } : {}) } : { sessionId, state: 'unknown' };
  }
  function validateManifest(input, actor) {
    check(input && typeof input === 'object' && !Array.isArray(input), 'Publish manifest');
    check(input.contractVersion === 1 && Array.isArray(input.frames) && input.frames.length > 0, 'Publish contractVersion/frames');
    check(Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024, 'Publish manifest JSON budget');
    const source = clone(input);
    const first = source.frames[0]?.identity;
    check(first && idPattern.test(first.projectId), 'Publish project identity');
    if (actor.projectId !== first.projectId) throw httpProblem(403, 'Project access denied');
    const m = { projectId: first.projectId, assets: source.assets, frames: source.frames.map(f => ({
      ...f.identity, expectedRevisionId: f.expectedRevisionId,
      layerDocSHA: f.layerDoc?.sha256, previewSHA: f.preview?.sha256 ?? null,
      exports: f.exports, transform: f.transform, contentHash: f.contentHash,
      width: f.absoluteBoundingBox?.width, height: f.absoluteBoundingBox?.height,
      absoluteBoundingBox: f.absoluteBoundingBox
    })) };
    check(Number.isSafeInteger(source.sourceBytes) && source.sourceBytes > 0 && source.sourceBytes <= 64 * 1024 * 1024, 'Source byte budget');
    check(Array.isArray(m.assets) && m.assets.length > 0 && m.assets.length <= 256, 'Manifest asset count');
    m.assets = m.assets.map(descriptor);
    check(new Set(m.assets.map(a => a.sha256)).size === m.assets.length, 'Duplicate manifest SHA');
    const byHash = new Map(m.assets.map(a => [a.sha256, a]));
    check(Array.isArray(m.frames) && m.frames.length > 0 && m.frames.length <= 1100, 'Manifest frame count');
    check(new Set(m.frames.map(f => f.frameId)).size === m.frames.length, 'Duplicate frame ID');
    for (const f of m.frames) {
      if (f.projectId !== m.projectId) throw httpProblem(403, 'Frame project access denied');
      check(idPattern.test(f.designFileId) && idPattern.test(f.pageId) && idPattern.test(f.revisionId), 'Full revision identity');
      check(idPattern.test(f.frameId) && idPattern.test(f.figmaNodeId) && f.frameId !== f.figmaNodeId, 'Frame stable and Figma identity');
      check(f.absoluteBoundingBox && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(f.absoluteBoundingBox[k])) && f.width > 0 && f.height > 0, 'Manifest absoluteBoundingBox');
      check(f.expectedRevisionId === null || (typeof f.expectedRevisionId === 'string' && idPattern.test(f.expectedRevisionId)), 'Explicit expectedRevisionId required');
      check(byHash.get(f.layerDocSHA)?.mime === 'application/json', 'LayerDoc descriptor required');
      check(f.previewSHA == null || byHash.has(f.previewSHA), 'Preview descriptor required');
      check(Array.isArray(f.exports) && f.exports.length <= 256, 'Frame export descriptors');
      for (const e of f.exports) {
        check(e && byHash.has(e.sha256), 'Export original SHA descriptor');
        check(['PNG', 'JPG', 'SVG', 'PDF'].includes(e.format), 'Actual export format');
        const mime = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf' }[e.format];
        check(byHash.get(e.sha256).mime === mime, 'Export MIME/format mismatch');
        if (e.targetWidth !== undefined) check(Number.isSafeInteger(e.targetWidth) && e.targetWidth > 0, 'Export targetWidth');
        if (e.targetHeight !== undefined) check(Number.isSafeInteger(e.targetHeight) && e.targetHeight > 0, 'Export targetHeight');
        if (e.scale != null) check(Number.isFinite(e.scale) && e.scale > 0, 'Export scale');
        if (e.target != null) check(Number.isSafeInteger(e.target.width) && e.target.width > 0 && Number.isSafeInteger(e.target.height) && e.target.height > 0, 'Export target');
      }
      check(f.transform == null || (Array.isArray(f.transform) && f.transform.length === 2 && f.transform.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))), 'Frame transform');
      check(f.contentHash === frameContentHash(f), 'Frame content hash');
    }
    const sourceTotal = m.assets.reduce((n, a) => n + a.byteLength, 0);
    check(sourceTotal <= byteLimit && source.sourceBytes >= sourceTotal, 'Manifest bytes budget');
    return m;
  }
  return {
    metrics,
    async prepare(input, actor) {
      if (closed) throw httpProblem(503, 'Synthetic publisher closed');
      requireActor(actor, true); sweep();
      if (sessions.size >= 512) throw httpProblem(429, 'Synthetic terminal session retention budget');
      if ([...sessions.values()].filter(s => s.state === 'prepared').length >= maxOpen) throw httpProblem(429, 'Synthetic open session budget');
      const manifest = validateManifest(input, actor), sessionId = randomUUID();
      for (const a of manifest.assets) {
        const found = [...committedAssets.values()].find(item => item.descriptor.sha256 === a.sha256);
        if (found && assetKey(found.descriptor) !== assetKey(a)) throw httpProblem(409, 'SHA descriptor type/length mismatch');
      }
      sessions.set(sessionId, { sessionId, actorId: actor.actorId, manifest, state: 'prepared', uploads: new Map(), expiresAt: now() + ttlMs }); metrics.prepared++;
      return { sessionId, state: 'prepared', missing: manifest.assets.filter(a => !committedAssets.has(assetKey(a))).map(a => a.sha256) };
    },
    async upload(sessionId, input, bytes, actor) {
      const s = owned(sessionId, actor, true);
      if (!s) throw httpProblem(404, 'Unknown synthetic session');
      if (s.state !== 'prepared') throw httpProblem(409, 'Synthetic session not prepared');
      const d = descriptor(input), listed = s.manifest.assets.find(a => assetKey(a) === assetKey(d));
      check(listed, 'Asset is not in manifest');
      const data = Buffer.from(bytes);
      check(data.length === d.byteLength && sha256(data) === d.sha256, 'Asset original bytes/hash mismatch');
      if (!committedAssets.has(assetKey(d)) && !s.uploads.has(assetKey(d))) {
        if (retainedBytes + data.length > byteLimit) throw httpProblem(507, 'Synthetic retained bytes budget');
        s.uploads.set(assetKey(d), data); retainedBytes += data.length; metrics.uploaded++; metrics.retainedBytes = retainedBytes;
      }
      return { sessionId, state: 'uploaded', sha256: d.sha256 };
    },
    async commit(sessionId, actor) {
      const s = owned(sessionId, actor, true);
      if (!s || ['aborted', 'expired'].includes(s.state)) return { sessionId, state: 'unknown' };
      if (s.state !== 'prepared') return state(s, sessionId);
      const keyOf = f => [f.projectId, f.designFileId, f.pageId, f.frameId].join('/');
      for (const a of s.manifest.assets) if (!committedAssets.has(assetKey(a)) && !s.uploads.has(assetKey(a))) throw httpProblem(409, 'Missing upload');
      const documents = new Map();
      for (const f of s.manifest.frames) {
        const head = heads.get(keyOf(f));
        if ((head?.revisionId ?? null) !== f.expectedRevisionId) throw httpProblem(409, 'Expected revision conflict');
        const d = s.manifest.assets.find(a => a.sha256 === f.layerDocSHA);
        let doc;
        try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(committedAssets.get(assetKey(d))?.bytes || s.uploads.get(assetKey(d)))); } catch { throw httpProblem(400, 'Invalid LayerDoc JSON'); }
        check(doc?.contractVersion === 1 && doc.frame?.type === 'FRAME' && doc.frame.id === f.figmaNodeId && Array.isArray(doc.frame.children), 'LayerDoc/frame identity mismatch');
        const box = doc.frame.absoluteBoundingBox;
        check(box && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(box[k])) && box.width > 0 && box.height > 0, 'LayerDoc dimensions');
        if (f.width !== undefined) check(f.width === box.width, 'Manifest LayerDoc width mismatch');
        if (f.height !== undefined) check(f.height === box.height, 'Manifest LayerDoc height mismatch');
        check(f.absoluteBoundingBox.x === box.x && f.absoluteBoundingBox.y === box.y, 'Manifest LayerDoc position mismatch');
        check(doc.styles && ['TEXT', 'FILL', 'EFFECT', 'GRID'].every(k => Array.isArray(doc.styles[k])) && Array.isArray(doc.components), 'LayerDoc style/component arrays');
        documents.set(f.frameId, doc);
      }
      // All validation and CAS precede this synchronous atomic RAM commit.
      const identities = s.manifest.frames.map(f => ({ projectId: f.projectId, designFileId: f.designFileId, pageId: f.pageId, frameId: f.frameId, figmaNodeId: f.figmaNodeId, revisionId: 'independent-revision-' + (++revisionCounter) }));
      for (const a of s.manifest.assets) {
        if (!committedAssets.has(assetKey(a))) committedAssets.set(assetKey(a), { descriptor: a, bytes: s.uploads.get(assetKey(a)) });
        else if (s.uploads.has(assetKey(a))) retainedBytes -= s.uploads.get(assetKey(a)).length;
      }
      for (const identity of identities) { heads.set(keyOf(identity), identity); revisions.set(identity.revisionId, { identity, layerDoc: documents.get(identity.frameId) }); }
      s.uploads.clear(); s.identities = identities; s.state = 'committed'; metrics.committed++; metrics.retainedBytes = retainedBytes;
      return state(s, sessionId);
    },
    async query(sessionId, actor) { return state(owned(sessionId, actor), sessionId); },
    async abort(sessionId, actor) { const s = owned(sessionId, actor, true); if (s) resolve(s, 'aborted'); return state(s, sessionId); },
    getRevision(revisionId, actor) { requireActor(actor); const r = revisions.get(revisionId); if (r && r.identity.projectId !== actor.projectId) throw httpProblem(403, 'Project access denied'); return r ? clone(r) : null; },
    close() { closed = true; for (const s of sessions.values()) resolve(s, 'aborted'); committedAssets.clear(); heads.clear(); revisions.clear(); retainedBytes = 0; metrics.retainedBytes = 0; },
    get openSessions() { sweep(); return [...sessions.values()].filter(s => s.state === 'prepared').length; }
  };
}
