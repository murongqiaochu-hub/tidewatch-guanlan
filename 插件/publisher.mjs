// Independent publish coordinator. The adapter owns service-specific endpoints.
import { SOURCE_LIMIT, TaskBudget, createSerialQueue, checkCancelled, fail, exactKeys, record, id, digestString, jsonBytes, sha256, FORMATS, serviceOrigin, sameServiceURL, safeError, number, requestId } from './core.mjs';

export function validateIdentity(value) {
  exactKeys(value, ['projectId', 'designFileId', 'pageId', 'frameId', 'revisionId', 'figmaNodeId']);
  for (const key of Object.keys(value)) id(value[key]);
  if (value.frameId === value.figmaNodeId) fail('BAD_SCHEMA');
  return value;
}
export function validateDescriptor(value) {
  if (!record(value)) fail('BAD_SCHEMA');
  digestString(value.sha256); number(value.byteLength, 1, SOURCE_LIMIT);
  if (!Number.isSafeInteger(value.byteLength)) fail('BAD_SCHEMA');
  if (value.mime === 'application/json') {
    exactKeys(value, ['sha256', 'byteLength', 'mime', 'role', 'fileName'], ['sha256', 'byteLength', 'mime', 'role']);
    if (value.role !== 'layerDoc') fail('BAD_SCHEMA');
  } else {
    exactKeys(value, ['nodeId', 'role', 'format', 'mime', 'byteLength', 'sha256', 'fileName', 'scale', 'target', 'settings']);
    id(value.nodeId);
    if (!FORMATS[value.format] || FORMATS[value.format].mime !== value.mime || !['preview', 'slice'].includes(value.role) || !record(value.settings) || value.settings.format !== value.format) fail('BAD_SCHEMA');
    if (value.scale !== null) number(value.scale, 0.001, 64);
    if (value.target !== null) { exactKeys(value.target, ['width', 'height']); for (const n of Object.values(value.target)) { number(n, 1, 1e8); if (!Number.isSafeInteger(n)) fail('BAD_SCHEMA'); } }
  }
  if (value.fileName !== undefined && (typeof value.fileName !== 'string' || value.fileName.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(value.fileName))) fail('BAD_SCHEMA');
  return value;
}
export function validateManifest(manifest) {
  exactKeys(manifest, ['contractVersion', 'frames', 'assets', 'sourceBytes']);
  if (manifest.contractVersion !== 1 || !Array.isArray(manifest.frames) || !manifest.frames.length || !Array.isArray(manifest.assets)) fail('BAD_SCHEMA');
  number(manifest.sourceBytes, 1, SOURCE_LIMIT);
  const ids = new Set(); const hashes = new Map();
  for (const asset of manifest.assets) {
    validateDescriptor(asset);
    if (hashes.has(asset.sha256)) fail('BAD_SCHEMA');
    hashes.set(asset.sha256, asset);
  }
  for (const frame of manifest.frames) {
    exactKeys(frame, ['identity', 'expectedRevisionId', 'layerDoc', 'preview', 'exports', 'contentHash', 'absoluteBoundingBox', 'transform']);
    validateIdentity(frame.identity);
    if (ids.has(frame.identity.frameId)) fail('DUPLICATE_FRAME'); ids.add(frame.identity.frameId);
    if (frame.expectedRevisionId !== null) id(frame.expectedRevisionId);
    digestString(frame.contentHash); validateDescriptor(frame.layerDoc);
    if (frame.preview !== null) validateDescriptor(frame.preview);
    if (!Array.isArray(frame.exports)) fail('BAD_SCHEMA');
    for (const asset of [frame.layerDoc, ...(frame.preview ? [frame.preview] : []), ...frame.exports]) {
      validateDescriptor(asset);
      const actual = hashes.get(asset.sha256);
      if (!actual || actual.mime !== asset.mime || actual.byteLength !== asset.byteLength) fail('BAD_SCHEMA');
    }
    exactKeys(frame.absoluteBoundingBox, ['x', 'y', 'width', 'height']);
    for (const key of ['x', 'y']) number(frame.absoluteBoundingBox[key], -1e9, 1e9);
    for (const key of ['width', 'height']) number(frame.absoluteBoundingBox[key], 0, 1e8);
    if (frame.transform !== null && (!Array.isArray(frame.transform) || frame.transform.length !== 2 || frame.transform.some(row => !Array.isArray(row) || row.length !== 3 || row.some(n => !Number.isFinite(n))))) fail('BAD_SCHEMA');
  }
  return manifest;
}
export async function buildPublication(exported, identities, { budget = new TaskBudget(), cryptoAPI = globalThis.crypto, digest = sha256, signal } = {}) {
  if (!Array.isArray(exported?.frames) || !exported.frames.length || !(identities instanceof Map)) fail('BAD_SCHEMA');
  const frames = []; const assets = new Map(); let originalSourceBytes = 0;
  const insert = async (descriptor, bytes) => {
    validateDescriptor(descriptor);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== descriptor.byteLength || await digest(bytes, cryptoAPI, signal) !== descriptor.sha256) fail('BAD_BYTES');
    const prior = assets.get(descriptor.sha256);
    if (prior && (prior.descriptor.mime !== descriptor.mime || prior.descriptor.byteLength !== descriptor.byteLength)) fail('BAD_SCHEMA');
    if (!prior) assets.set(descriptor.sha256, { descriptor, bytes });
  };
  for (const result of exported.frames) {
    checkCancelled(signal);
    const binding = identities.get(result.figmaNodeId);
    exactKeys(binding, ['identity', 'expectedRevisionId']); validateIdentity(binding.identity);
    if (binding.identity.figmaNodeId !== result.figmaNodeId || result.layerDoc?.contractVersion !== 1 || result.layerDoc.frame?.id !== result.figmaNodeId || result.layerDoc.frame.type !== 'FRAME') fail('BAD_SCHEMA');
    if (binding.expectedRevisionId !== null) id(binding.expectedRevisionId);
    const encoded = jsonBytes(result.layerDoc);
    if (!(result.bytes instanceof Uint8Array) || encoded.byteLength !== result.bytes.byteLength || await digest(encoded, cryptoAPI, signal) !== result.sha256) fail('BAD_BYTES');
    const layerDoc = { sha256: result.sha256, byteLength: result.bytes.byteLength, mime: 'application/json', role: 'layerDoc' };
    await insert(layerDoc, result.bytes); originalSourceBytes += result.bytes.byteLength;
    for (const asset of result.assets) { await insert(asset.descriptor, asset.bytes); originalSourceBytes += asset.bytes.byteLength; }
    if (originalSourceBytes > budget.limit) fail('BUDGET_EXCEEDED');
    const transform = result.layerDoc.frame.absoluteTransform ?? null;
    const contentHash = await digest(jsonBytes([result.sha256, result.preview?.sha256 ?? null, result.exports, transform]), cryptoAPI, signal);
    if (contentHash !== result.contentHash) fail('BAD_BYTES');
    frames.push({ identity: { ...binding.identity }, expectedRevisionId: binding.expectedRevisionId, layerDoc, preview: result.preview ?? null, exports: result.exports, contentHash, absoluteBoundingBox: result.layerDoc.frame.absoluteBoundingBox, transform });
  }
  // One task budget covers original LayerDocs, SDK bytes and manifest, not 64 MiB per frame.
  // Deduplication does not erase physical export bytes from a task's budget.
  if (budget.used < originalSourceBytes) budget.add('unaccounted-originals', originalSourceBytes - budget.used);
  const manifest = { contractVersion: 1, frames, assets: [...assets.values()].map(a => a.descriptor), sourceBytes: budget.used };
  let size = 0;
  for (let i = 0; i < 3; i++) { size = jsonBytes(manifest).byteLength; budget.set('manifest', size); manifest.sourceBytes = budget.used; }
  validateManifest(manifest);
  return { manifest, assets, budget };
}
function resultSession(value, expected, states) {
  exactKeys(value, ['sessionId', 'state', 'missing', 'revisions'], ['sessionId', 'state']);
  id(value.sessionId);
  if (expected && value.sessionId !== expected) fail('HTTP_RESPONSE_INVALID');
  if (!states.includes(value.state)) fail('HTTP_RESPONSE_INVALID');
  if (value.missing !== undefined) { if (!Array.isArray(value.missing)) fail('HTTP_RESPONSE_INVALID'); for (const hash of value.missing) digestString(hash); if (new Set(value.missing).size !== value.missing.length) fail('HTTP_RESPONSE_INVALID'); }
  if (value.revisions !== undefined) { if (!Array.isArray(value.revisions)) fail('HTTP_RESPONSE_INVALID'); for (const identity of value.revisions) validateIdentity(identity); }
  return value;
}
export function createPublisher(adapter, { queue = createSerialQueue({ capacity: 1 }), onState = () => {}, journal = async () => {}, makeRequestId = requestId } = {}) {
  for (const method of ['prepare', 'upload', 'commit', 'query', 'abort']) if (typeof adapter?.[method] !== 'function') fail('BAD_SCHEMA');
  let state = { phase: 'idle', sessionId: null, requestId: null, sessionQuery: null };
  let locked = false;
  const update = async patch => { state = { ...state, ...patch }; await journal({ ...state }); onState({ ...state }); };
  const uncertain = async (phase, error) => { locked = true; await update({ phase, sessionQuery: state.sessionId, error: safeError(error).code }); };
  const abortSession = async () => {
    if (!state.sessionId) return;
    try {
      const result = resultSession(await adapter.abort(state.sessionId, { requestId: makeRequestId() }), state.sessionId, ['aborted', 'expired', 'committed', 'unknown']);
      if (result.state === 'unknown') await uncertain('unknownCommit', { code: 'UNKNOWN_COMMIT' });
      else { locked = false; await update({ phase: result.state, sessionQuery: null }); }
    } catch (error) { await uncertain('unknownCommit', error); }
  };
  return {
    publish(publication, { signal } = {}) {
      if (locked) return Promise.reject(Object.assign(new Error('UNKNOWN_COMMIT'), { code: state.phase === 'unknownPrepare' ? 'UNKNOWN_PREPARE' : 'UNKNOWN_COMMIT' }));
      if (queue.snapshot().pending) return Promise.reject(Object.assign(new Error('BUSY'), { code: 'BUSY' }));
      validateManifest(publication?.manifest);
      if (!(publication.assets instanceof Map)) fail('BAD_SCHEMA');
      return queue.run(async () => {
        checkCancelled(signal);
        let commitStarted = false; let prepareStarted = false;
        try {
          await update({ phase: 'preparing', sessionId: null, requestId: makeRequestId(), sessionQuery: null, error: null });
          prepareStarted = true;
          // Do not race physical prepare/upload/commit promises against abort.
          const prepared = resultSession(await adapter.prepare(publication.manifest, { signal, requestId: state.requestId }), null, ['prepared']);
          await update({ phase: 'prepared', sessionId: prepared.sessionId, sessionQuery: prepared.sessionId });
          checkCancelled(signal);
          const missing = prepared.missing ?? publication.manifest.assets.map(a => a.sha256);
          for (const hash of missing) {
            if (!publication.assets.has(hash)) fail('HTTP_RESPONSE_INVALID');
            checkCancelled(signal);
            const asset = publication.assets.get(hash);
            await update({ phase: 'uploading' });
            const result = await adapter.upload(state.sessionId, asset.descriptor, asset.bytes, { signal, requestId: makeRequestId() });
            exactKeys(result, ['sessionId', 'state', 'sha256']);
            if (result.sessionId !== state.sessionId || result.state !== 'uploaded' || result.sha256 !== hash) fail('HTTP_RESPONSE_INVALID');
          }
          checkCancelled(signal);
          await update({ phase: 'committing', requestId: makeRequestId(), sessionQuery: state.sessionId });
          commitStarted = true;
          const committed = resultSession(await adapter.commit(state.sessionId, { signal, requestId: state.requestId }), state.sessionId, ['committed', 'unknown']);
          if (committed.state === 'unknown') { await uncertain('unknownCommit', { code: 'UNKNOWN_COMMIT' }); fail('UNKNOWN_COMMIT'); }
          // Successful server confirmation wins a late cancellation; do not call abort on committed work.
          locked = false; await update({ phase: 'committed', sessionQuery: null });
          return committed;
        } catch (error) {
          if (commitStarted) {
            if (state.phase !== 'unknownCommit') await uncertain('unknownCommit', error);
            fail('UNKNOWN_COMMIT');
          }
          if (state.sessionId) await abortSession();
          else if (prepareStarted && error?.code !== 'CONFLICT') await uncertain('unknownPrepare', error);
          else await update({ phase: 'failed', error: safeError(error).code });
          throw error;
        }
      }, { signal });
    },
    query({ signal } = {}) {
      if (!state.sessionId) return Promise.reject(Object.assign(new Error('UNKNOWN_PREPARE'), { code: 'UNKNOWN_PREPARE' }));
      const originalId = state.sessionId;
      return queue.run(async () => {
        const result = resultSession(await adapter.query(originalId, { signal, requestId: makeRequestId() }), originalId, ['prepared', 'uploading', 'committed', 'aborted', 'expired', 'unknown']);
        if (['committed', 'aborted', 'expired'].includes(result.state)) { locked = false; await update({ phase: result.state, sessionQuery: null }); }
        else { locked = true; await update({ phase: 'unknownCommit', sessionQuery: originalId }); }
        return result;
      }, { signal });
    },
    abort() { if (!state.sessionId) return Promise.reject(Object.assign(new Error('UNKNOWN_PREPARE'), { code: 'UNKNOWN_PREPARE' })); return queue.run(abortSession); },
    restore(saved) {
      if (queue.snapshot().pending || !record(saved) || !['unknownCommit', 'committing', 'prepared', 'uploading', 'unknownPrepare', 'preparing'].includes(saved.phase)) fail('BAD_SCHEMA');
      if (saved.sessionId !== null) id(saved.sessionId);
      if (saved.requestId !== null) id(saved.requestId);
      state = { phase: saved.sessionId ? 'unknownCommit' : 'unknownPrepare', sessionId: saved.sessionId, sessionQuery: saved.sessionId, requestId: saved.requestId }; locked = true;
      onState({ ...state });
    },
    status() { return { ...state, locked, queue: queue.snapshot() }; },
    drain() { return queue.drain(); }
  };
}

// Default standalone wire contract, overridable through createPublisher(adapter).
export function createHTTPAdapter({ origin, fetchAPI = globalThis.fetch, allowLocalhost = false, authorization = null, responseLimit = 1024 * 1024 } = {}) {
  const trusted = serviceOrigin(origin, { allowLocalhost });
  if (typeof fetchAPI !== 'function') fail('BAD_SCHEMA');
  if (authorization !== null && (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(authorization))) fail('BAD_SCHEMA');
  number(responseLimit, 1, 4 * 1024 * 1024);
  const call = async (operation, payload, { signal, requestId: reqId } = {}, bytes = null) => {
    id(reqId); checkCancelled(signal);
    if (!['prepare', 'upload', 'commit', 'query', 'abort'].includes(operation)) fail('BAD_SCHEMA');
    const url = sameServiceURL(`/api/independent-publish/${operation}`, trusted, { allowLocalhost });
    const body = bytes ?? jsonBytes(payload);
    if (!(body instanceof Uint8Array) || body.byteLength > SOURCE_LIMIT) fail('HTTP_BODY_TOO_LARGE');
    const headers = { 'Content-Type': bytes ? payload.descriptor.mime : 'application/json', 'X-Independent-Request-Id': reqId };
    if (authorization !== null) headers.Authorization = authorization;
    if (bytes) { headers['X-Independent-Session-Id'] = id(payload.sessionId); headers['X-Independent-Descriptor'] = encodeURIComponent(JSON.stringify(validateDescriptor(payload.descriptor))); }
    let response;
    try { response = await fetchAPI(url, { method: 'POST', headers, body, signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }); } catch { checkCancelled(signal); fail('HTTP_FAILED'); }
    if (response.status === 409) fail('CONFLICT');
    if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== trusted) fail('HTTP_FAILED');
    const contentType = response.headers.get('content-type')?.split(';')[0].trim();
    if (contentType !== 'application/json') fail('HTTP_RESPONSE_INVALID');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) fail('HTTP_BODY_TOO_LARGE');
    if (!response.body?.getReader) fail('HTTP_RESPONSE_INVALID');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) { const result = await reader.read(); if (result.done) break; checkCancelled(signal); size += result.value.byteLength; if (size > responseLimit) { await reader.cancel(); fail('HTTP_BODY_TOO_LARGE'); } chunks.push(result.value); }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { fail('HTTP_RESPONSE_INVALID'); }
    exactKeys(result, ['requestId', 'result']);
    if (result.requestId !== reqId || !record(result.result)) fail('HTTP_RESPONSE_INVALID');
    return result.result;
  };
  return {
    prepare(manifest, context) { validateManifest(manifest); return call('prepare', { manifest }, context); },
    upload(sessionId, descriptor, bytes, context) { id(sessionId); validateDescriptor(descriptor); if (!(bytes instanceof Uint8Array) || bytes.byteLength !== descriptor.byteLength) fail('BAD_BYTES'); return call('upload', { sessionId, descriptor }, context, bytes); },
    commit(sessionId, context) { return call('commit', { sessionId: id(sessionId) }, context); },
    query(sessionId, context) { return call('query', { sessionId: id(sessionId) }, context); },
    abort(sessionId, context) { return call('abort', { sessionId: id(sessionId) }, context); }
  };
}
