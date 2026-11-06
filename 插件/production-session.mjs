// Production SDK task coordinator. No synthetic platform identities, node writes or private-API flags.
import { TaskBudget, checkCancelled, fail, id, record, exactKeys, jsonBytes, utf8, sha256, safeError, SOURCE_LIMIT } from './core.mjs';
import { createExporter, eligibleFrames, topLevelFrameSet } from './exporter.mjs';
import { validateSourceBinding } from './protocol.mjs';
import { ProductionError, validateSource, sameSource, validateProductionExport, validateProductionManifest, validatePrepareBody, validatePrepareResult, validateSessionResult, validateCommitResult, validateProjects, validatePublishSourceBody, PRODUCTION_BODY_LIMIT } from './production-protocol.mjs';

export function readPublicFileSource(sdk) {
  let fileKey; try { fileKey = sdk.fileKey; } catch { /* Public read may be unavailable in this launch. */ }
  return typeof fileKey === 'string' && fileKey.length ? validateSource({ kind: 'figma-file', fileKey }) : null;
}
export function readProductionSource(sdk, namespace) {
  return readPublicFileSource(sdk) || validateSource({ kind: 'plugin-launch', namespace });
}
export function listProductionFrames(sdk, scope) {
  const result = eligibleFrames(sdk, scope); const top = topLevelFrameSet(sdk);
  const frames = result.frames.filter(f => top.has(f));
  return { ...result, frames, excluded: [...result.excluded, ...result.frames.filter(f => !top.has(f)).map(f => ({ id: f.id, type: f.type, reason: 'not-top-level-frame' }))] };
}
const errorCode = error => safeError(error).code;
const terminal = phase => ['committed', 'aborted', 'expired'].includes(phase);
const pending = phase => ['preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare'].includes(phase);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function productionPrepareHash(body, operationId, batchIndex, cryptoAPI = globalThis.crypto, signal) {
  const input = { ...body, operationId, batchIndex };
  const canonical = JSON.stringify(input, (_key, value) => record(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
  return sha256(utf8(`publish-prepare-v1\n${canonical}`), cryptoAPI, signal);
}

// Translate descriptors only. Original LayerDoc / preview / slice bytes are never rewritten.
export async function translateProductionFrames(exported, { projectId, designFileId, source, page, bases, coordinateMode, coordinates, orderOffset = 0, designSpec = 'web', designScale = 1, groupId = null, cryptoAPI = globalThis.crypto, signal, budget = new TaskBudget() }) {
  if (coordinateMode !== undefined && coordinateMode !== 'project-xy') fail('BAD_SCHEMA');
  if (!['web', 'ios', 'android'].includes(designSpec) || !Number.isFinite(designScale) || designScale < 1 || designScale > 8) fail('BAD_SCHEMA');
  if (groupId !== null) id(groupId);
  if (coordinateMode === 'project-xy' && !(coordinates instanceof Map)) fail('BAD_SCHEMA');
  id(projectId); id(designFileId); validateSource(source); id(page.id);
  if (!(bases instanceof Map) || !Array.isArray(exported?.frames) || !exported.frames.length) fail('BAD_SCHEMA');
  const assets = new Map(); const frames = []; let originalBytes = 0;
  const insert = async (hash, mime, bytes) => {
    if (!(bytes instanceof Uint8Array) || !bytes.length || await sha256(bytes, cryptoAPI, signal) !== hash) fail('BAD_BYTES');
    const prior = assets.get(hash); if (prior && (prior.mime !== mime || prior.bytes !== bytes.length)) fail('BAD_BYTES');
    if (!prior) assets.set(hash, { sha256: hash, mime, bytes: bytes.length, data: bytes });
    originalBytes += bytes.length; if (originalBytes > SOURCE_LIMIT) fail('BUDGET_EXCEEDED');
  };
  const seen = new Set();
  for (const result of exported.frames) {
    checkCancelled(signal); const fid = id(result.figmaNodeId);
    if (seen.has(fid) || !bases.has(fid)) fail('BAD_SCHEMA'); seen.add(fid);
    const doc = result.layerDoc; const raw = doc?.frame;
    if (doc?.contractVersion !== 1 || raw?.id !== fid || raw.type !== 'FRAME' || typeof raw.name !== 'string' || !record(raw.absoluteBoundingBox) || !record(doc.styles) || !['TEXT', 'FILL', 'EFFECT', 'GRID'].every(k => Array.isArray(doc.styles[k])) || !Array.isArray(doc.components)) fail('BAD_SCHEMA');
    const encoded = jsonBytes(doc); if (!(result.bytes instanceof Uint8Array) || !sameBytes(encoded, result.bytes)) fail('BAD_BYTES');
    await insert(result.sha256, 'application/json', result.bytes);
    const subtree = new Set(); const stack = [raw];
    while (stack.length) { const node = stack.pop(); id(node.id); if (subtree.has(node.id)) fail('BAD_SCHEMA'); subtree.add(node.id); if (node.children !== undefined) { if (!Array.isArray(node.children)) fail('BAD_SCHEMA'); stack.push(...node.children); } }
    if (!Array.isArray(result.assets) || !Array.isArray(result.exports)) fail('BAD_SCHEMA');
    const declared = new Map();
    for (const asset of result.assets) {
      const d = asset.descriptor; if (!record(d) || !subtree.has(d.nodeId) || d.byteLength !== asset.bytes?.byteLength) fail('BAD_BYTES');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(d.mime) || d.format === 'PDF') fail('BAD_FORMAT');
      await insert(d.sha256, d.mime, asset.bytes); declared.set(d, asset);
    }
    const available = d => result.assets.some(a => a.descriptor.sha256 === d.sha256 && a.descriptor.nodeId === d.nodeId && a.descriptor.mime === d.mime && a.descriptor.byteLength === d.byteLength && JSON.stringify(a.descriptor.settings) === JSON.stringify(d.settings));
    const productionExports = result.exports.map(d => {
      if (!available(d) || !subtree.has(d.nodeId) || d.role !== 'slice') fail('BAD_BYTES');
      return validateProductionExport({ sha256: d.sha256, bytes: d.byteLength, mime: d.mime, exportNodeId: d.nodeId, fileName: d.fileName, ...(d.exportName !== undefined ? { exportName: d.exportName } : {}), format: d.format, pluginExportSetting: d.settings });
    });
    const preview = result.preview;
    if (preview && (!available(preview) || preview.nodeId !== fid || preview.role !== 'preview')) fail('BAD_BYTES');
    const b = raw.absoluteBoundingBox; const transform = raw.absoluteTransform;
    if (coordinateMode === 'project-xy' && (coordinates.get(fid)?.x !== b.x || coordinates.get(fid)?.y !== b.y)) fail('DOCUMENT_CHANGED');
    const hash = await sha256(jsonBytes([result.sha256, preview?.sha256 || null, productionExports, transform || null]), cryptoAPI, signal);
    const frame = { figmaNodeId: fid, figmaPageId: page.id, name: raw.name, ...(typeof page.name === 'string' ? { pageName: page.name } : {}), ...(Number.isFinite(page.order) ? { pageOrder: page.order } : {}), x: b.x, y: b.y, width: b.width, height: b.height, order: orderOffset + frames.length, hash, layerDocSha256: result.sha256, layerDocBytes: result.bytes.length, ...(preview ? { previewSha256: preview.sha256, previewBytes: preview.byteLength, previewMime: preview.mime } : {}), exports: productionExports, ...(transform !== undefined && transform !== null ? { transform } : {}), designSpec, designScale, baseRevisionId: bases.get(fid) };
    // Local validation checks all x/y/w/h against raw data, unlike the server's width/height-only check.
    validateProductionManifest(frame); for (const k of ['x', 'y', 'width', 'height']) if (frame[k] !== raw.absoluteBoundingBox[k]) fail('BAD_DIMENSIONS');
    frames.push(frame);
  }
  if (budget.used < originalBytes) budget.add('production-originals', originalBytes - budget.used);
  // Distinguish the new client's explicit ungrouped selection from legacy
  // clients that sent null to mean "leave the existing assignment unchanged".
  const body = validatePrepareBody({ projectId, designFile: { designFileId }, source, requireBaseRevision: true, ...(coordinateMode ? { coordinateMode } : {}), groupId, groupAssignment: 'set', frames });
  budget.set('production-manifest', jsonBytes(body).length);
  return { body, assets, budget };
}

export function createProductionSession({ sdk, adapter, namespace, exporter, cryptoAPI = globalThis.crypto, journal = async () => {}, onState = () => {}, discardHistory = false } = {}) {
  if (!sdk?.root || !sdk.currentPage) fail('SDK_CAPABILITY_MISSING');
  for (const method of ['projects', 'intent', 'claim', 'queryOperation', 'finish', 'publishSource', 'prepare', 'upload', 'commit', 'query', 'abort']) if (typeof adapter?.[method] !== 'function') fail('BAD_SCHEMA');
  const root = sdk.root; const launchSource = readProductionSource(sdk, namespace); let source = launchSource; exporter ||= createExporter(sdk, { cryptoAPI });
  let recoveryWindow = false;
  let active = false; let physical = Promise.resolve(); let sourceMode = source.kind === 'figma-file' ? 'sdk' : 'launch'; let boundProjectId = null;
  let state = { phase: 'idle', sessionId: null, locked: false, verified: false, source, sourceProof: null, completed: [], mappingAvailable: false, preparedFrames: [], expectedFrameIds: [], groupId: null, total: 0, done: 0, exportTotal: 0, exportDone: 0 };
  const physicallyBusy = () => active || Boolean(exporter.queue?.snapshot().pending);
  const canChangeSource = () => !physicallyBusy() && !state.locked && (discardHistory || ['idle', 'committed', 'aborted', 'expired', 'failed'].includes(state.phase));
  const manualAvailable = () => !(sourceMode === 'sdk' && source?.kind === 'figma-file') && readPublicFileSource(sdk) === null;
  const status = () => ({ ...state, source: source ? { ...source } : null, completed: state.completed.map(r => ({ ...r })), preparedFrames: state.preparedFrames.map(f => ({ ...f })), busy: active, sourceBinding: { mode: sourceMode, manualAvailable: manualAvailable(), canBind: canChangeSource() && manualAvailable(), canConfirmRecovery: !physicallyBusy() && sourceMode === 'recovery' && Boolean(state.sourceProof) && (state.locked || state.phase === 'committed' && !state.mappingAvailable), projectId: boundProjectId } });
  const update = async patch => { state = { ...state, ...patch }; await journal(status()); onState(status()); };
  const guard = page => { if (sdk.root !== root || page && sdk.currentPage !== page) fail('DOCUMENT_CHANGED'); };
  const guardSourceWrite = async () => {
    guard(); const actual = readPublicFileSource(sdk);
    if (actual && (source && !sameSource(actual, source) || !source && state.sourceProof && await sha256(jsonBytes(actual), cryptoAPI) !== state.sourceProof)) fail('DOCUMENT_CHANGED');
  };
  const exclusive = worker => {
    if (active) return Promise.reject(new ProductionError('BUSY')); active = true;
    physical = (async () => { try { return await worker(); } finally {
      active = false;
      // C28 production keeps only this run's display result, never a recovery queue.
      // A later explicit publish gets a new server operation and fresh base revisions.
      if (discardHistory) state = { ...state, locked: false };
      onState(status());
    } })(); return physical;
  };
  // A commit response is only an acknowledgement. Success additionally requires
  // every selected node to have a matching current revision in both reader paths.
  const visibilityFrames = () => {
    if (!Number.isSafeInteger(state.total) || state.total < 1 || !Array.isArray(state.expectedFrameIds) || state.expectedFrameIds.length !== state.total || state.done !== state.total) return null;
    const frames = state.completed.flatMap(result => result.frames).map(({ figmaNodeId, frameId, revisionId }) => ({ figmaNodeId, frameId, revisionId }));
    const ids = new Set(frames.map(frame => frame.figmaNodeId));
    if (frames.length !== state.total || ids.size !== state.total || state.expectedFrameIds.some(fid => !ids.has(fid))) return null;
    return frames;
  };
  const verifyVisibility = async (signal, completedOperation = false) => {
    const frames = visibilityFrames();
    await update({ phase: 'verifying', locked: true, verified: false });
    try {
      if (!frames || typeof adapter.verifyPublication !== 'function') fail('VISIBILITY_UNCONFIRMED');
      const receipt = await adapter.verifyPublication(state.projectId, state.groupId, frames, { signal });
      exactKeys(receipt, ['projectId', 'groupId', 'frameCount', 'catalogReadVersion']);
      if (receipt.projectId !== state.projectId || receipt.groupId !== state.groupId || receipt.frameCount !== frames.length || typeof receipt.catalogReadVersion !== 'string' || !/^[a-f0-9]{32}:[0-9]+$/.test(receipt.catalogReadVersion)) fail('VISIBILITY_UNCONFIRMED');
      if (completedOperation) { await update({ phase: 'committed', locked: false, verified: true, error: null, httpStatus: null }); return; }
      if (recoveryWindow) { await update({ phase: state.operationId ? 'unknownFinish' : 'verificationPending', locked: true, verified: false }); return; }
      await update({ phase: 'finishing', locked: true, verified: false });
      const finished = await adapter.finish(state.operationId, receipt.catalogReadVersion, { signal });
      if (!record(finished) || finished.operationId !== state.operationId || finished.projectId !== state.projectId || finished.status !== 'completed' || finished.groupId !== state.groupId || !Array.isArray(finished.frameIds) || finished.frameIds.length !== state.expectedFrameIds.length || state.expectedFrameIds.some(fid => !finished.frameIds.includes(fid)) || !Array.isArray(finished.remainingFrameIds) || finished.remainingFrameIds.length !== 0) fail('HTTP_RESPONSE_INVALID');
      await update({ phase: 'committed', locked: false, verified: true, error: null, httpStatus: null });
    } catch (error) {
      await update({ phase: state.phase === 'finishing' ? 'unknownFinish' : 'verificationPending', locked: true, verified: false, failureStage: state.phase === 'finishing' ? 'finishing' : 'verifying', error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : null });
      throw error;
    }
  };
  const setTerminal = async (response, operationCancelled = false) => {
    if (response.status === 'committed') {
      // Session GET does not return revision mappings; never infer them.
      await update({ phase: 'committed', locked: true, verified: false, mappingAvailable: false, commitResult: null });
    } else if (state.completed.length || state.done > 0) {
      await update({ phase: 'partial', locked: true, verified: false });
    } else await update({ phase: response.status, locked: !operationCancelled, verified: false, mappingAvailable: false, commitResult: null });
  };
  const cancelledState = async value => {
    if (!record(value) || value.operationId !== state.operationId || value.projectId !== state.projectId || value.status !== 'cancelled' || !Array.isArray(value.frameIds) || !Array.isArray(value.batches) || !Array.isArray(value.committedFrames) || !Array.isArray(value.remainingFrameIds) || value.lockScope !== 'service' || value.automaticExpiry !== false) fail('HTTP_RESPONSE_INVALID');
    const tombstone = value.frameIds.length === 0;
    if (tombstone) {
      if (value.cancelTombstone !== true || !/^op_[a-f0-9]{32}_[a-f0-9]{64}$/.test(state.operationId) || state.sessionId || state.completed.length || state.done || state.batchIndex != null || state.requestHash != null || state.batchFrameIds?.length || state.preparedFrames.length || value.groupId !== undefined || value.batches.length || value.committedFrames.length || value.remainingFrameIds.length) fail('HTTP_RESPONSE_INVALID');
    } else {
      if (value.cancelTombstone !== undefined) fail('HTTP_RESPONSE_INVALID');
      if (value.groupId !== state.groupId || value.frameIds.length !== state.expectedFrameIds.length || state.expectedFrameIds.some(fid => !value.frameIds.includes(fid))) fail('HTTP_RESPONSE_INVALID');
      const committed = [];
      for (const batch of value.batches) {
        if (!record(batch) || batch.operationId !== state.operationId || !['committed', 'aborted', 'expired'].includes(batch.status)) fail('HTTP_RESPONSE_INVALID');
        if (batch.status === 'committed') committed.push(...validateCommitResult(batch.commitResult, batch.sessionId, batch.frames).frames);
        else if (batch.commitResult !== undefined) fail('HTTP_RESPONSE_INVALID');
      }
      if (JSON.stringify(committed) !== JSON.stringify(value.committedFrames)) fail('HTTP_RESPONSE_INVALID');
      const nodes = new Set(committed.map(f => f.figmaNodeId)); if (nodes.size !== committed.length || committed.some(f => !state.expectedFrameIds.includes(f.figmaNodeId)) || value.remainingFrameIds.length !== state.expectedFrameIds.length - nodes.size || state.expectedFrameIds.some(fid => !nodes.has(fid) && !value.remainingFrameIds.includes(fid))) fail('HTTP_RESPONSE_INVALID');
      for (const previous of state.completed) { const batch = value.batches.find(b => b.sessionId === previous.sessionId && b.status === 'committed'); if (!batch || JSON.stringify(batch.commitResult.frames) !== JSON.stringify(previous.frames)) fail('HTTP_RESPONSE_INVALID'); }
      if (state.sessionId) { const batch = value.batches.find(b => b.sessionId === state.sessionId); if (!batch || state.batchIndex != null && batch.batchIndex !== state.batchIndex || state.requestHash && batch.requestHash !== state.requestHash || state.preparedFrames.length && (batch.frames.length !== state.preparedFrames.length || state.preparedFrames.some(f => !batch.frames.some(b => b.figmaNodeId === f.figmaNodeId && b.frameId === f.frameId)))) fail('HTTP_RESPONSE_INVALID'); }
    }
    const partial = value.committedFrames.length > 0 || value.batches.some(b => b.status === 'committed' || b.commitResult) || state.completed.length > 0 || state.done > 0;
    await update({ phase: partial ? 'partial' : 'aborted', locked: partial, verified: false, operationCancelled: !partial });
    return value;
  };
  const abortKnown = async () => {
    if (!state.sessionId || state.phase === 'partial' || state.completed.length > 0 || state.done > 0) {
      if (!state.operationId || typeof adapter.cancelOperation !== 'function') fail('UNKNOWN_PREPARE');
      try { return await cancelledState(await adapter.cancelOperation(state.operationId, {})); }
      catch (error) { await update({ phase: 'unknownClaim', locked: true, error: errorCode(error) }); throw error; }
    }
    try { const response = await adapter.abort(state.sessionId, state.operationId, {}); if (response.sessionId !== state.sessionId || !terminal(response.status)) fail('HTTP_RESPONSE_INVALID'); if (typeof adapter.cancelOperation !== 'function') fail('UNKNOWN_COMMIT'); const cancelled = await adapter.cancelOperation(state.operationId, {}); await cancelledState(cancelled); return response; }
    catch (error) { await update({ phase: 'unknownCommit', locked: true, verified: false, error: errorCode(error) }); throw error; }
  };
  return {
    get source() { return source ? { ...source } : null; }, exporter, status, drain: () => physical.catch(() => {}),
    restore(saved) {
      if (active || !record(saved) || !['claiming', 'unknownClaim', 'finishing', 'unknownFinish', 'idle', 'authorizing', 'resolvingSource', 'exporting', 'failed', 'committed', 'aborted', 'expired', 'preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare', 'verifying', 'verificationPending', 'partial'].includes(saved.phase)) fail('BAD_SCHEMA');
      recoveryWindow = true;
      if (saved.operationId !== null && saved.operationId !== undefined) id(saved.operationId);
      if (saved.sessionId !== null && saved.sessionId !== undefined) id(saved.sessionId);
      if (saved.projectId !== undefined) id(saved.projectId); if (saved.designFileId !== undefined) id(saved.designFileId);
      if (saved.sourceProof !== undefined && saved.sourceProof !== null && (typeof saved.sourceProof !== 'string' || !/^[a-f0-9]{64}$/.test(saved.sourceProof))) fail('BAD_SCHEMA');
      const restoredSource = saved.source ? validateSource(saved.source) : null;
      if (saved.manualRecovery === true && restoredSource) fail('BAD_SCHEMA');
      const preparedFrames = saved.preparedFrames || []; if (!Array.isArray(preparedFrames)) fail('BAD_SCHEMA');
      for (const frame of preparedFrames) { exactKeys(frame, ['figmaNodeId', 'frameId']); id(frame.figmaNodeId); id(frame.frameId); }
      const expectedFrameIds = saved.expectedFrameIds || []; if (!Array.isArray(expectedFrameIds) || new Set(expectedFrameIds).size !== expectedFrameIds.length) fail('BAD_SCHEMA'); expectedFrameIds.forEach(id);
      if (saved.groupId !== undefined && saved.groupId !== null) id(saved.groupId);
      if (saved.batchIndex != null && (!Number.isSafeInteger(saved.batchIndex) || saved.batchIndex < 0)) fail('BAD_SCHEMA');
      if (saved.requestHash != null && (typeof saved.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.requestHash))) fail('BAD_SCHEMA');
      if (saved.batchFrameIds != null) { if (!Array.isArray(saved.batchFrameIds) || !saved.batchFrameIds.length || new Set(saved.batchFrameIds).size !== saved.batchFrameIds.length) fail('BAD_SCHEMA'); saved.batchFrameIds.forEach(id); if (saved.batchFrameIds.some(fid => !expectedFrameIds.includes(fid))) fail('BAD_SCHEMA'); }
      source = restoredSource ? { ...restoredSource } : null; sourceMode = 'recovery'; boundProjectId = saved.projectId || null;
      state = { ...state, ...saved, source, sourceProof: saved.sourceProof || null, completed: Array.isArray(saved.completed) ? saved.completed.map(r => validateCommitResult(r, r.sessionId)) : [], preparedFrames, expectedFrameIds, groupId: saved.groupId ?? null, verified: saved.verified === true, exportTotal: Number.isSafeInteger(saved.exportTotal) && saved.exportTotal >= 0 ? saved.exportTotal : 0, exportDone: Number.isSafeInteger(saved.exportDone) && saved.exportDone >= 0 ? saved.exportDone : 0 };
      if (['claiming', 'unknownClaim', 'finishing', 'unknownFinish'].includes(saved.phase)) state = { ...state, phase: saved.phase === 'finishing' ? 'unknownFinish' : saved.phase === 'claiming' ? 'unknownClaim' : saved.phase, locked: true, verified: false };
      else if (pending(saved.phase)) state = { ...state, phase: saved.sessionId ? 'unknownCommit' : 'unknownPrepare', locked: true, verified: false };
      else if (['verifying', 'verificationPending'].includes(saved.phase)) state = { ...state, phase: 'verificationPending', locked: true, verified: false };
      else if (saved.phase === 'partial' || ['idle', 'authorizing', 'resolvingSource', 'exporting', 'failed', 'aborted', 'expired'].includes(saved.phase) && (state.completed.length || state.done > 0)) state = { ...state, phase: 'partial', locked: true, verified: false };
      // A prior verification is historical; another client may have changed the
      // current revision, group, or layout since this plugin was closed.
      else if (saved.phase === 'committed') state = { ...state, phase: saved.mappingAvailable ? 'verificationPending' : 'committed', locked: true, verified: false };
      else if (saved.locked === true && saved.phase !== 'committed') state = { ...state, phase: saved.sessionId ? 'unknownCommit' : 'unknownPrepare', locked: true, verified: false };
      state = { ...state, locked: true, verified: false };
      onState(status());
    },
    bindSource(payload, { signal } = {}) {
      const candidate = validateSourceBinding(payload);
      if (physicallyBusy()) return Promise.reject(new ProductionError('BUSY'));
      if (!canChangeSource()) return Promise.reject(new ProductionError(state.phase === 'unknownPrepare' ? 'UNKNOWN_PREPARE' : 'UNKNOWN_COMMIT'));
      if (!manualAvailable()) return Promise.reject(new ProductionError('BAD_SCHEMA'));
      return exclusive(async () => {
        guard(); checkCancelled(signal); const proof = await sha256(jsonBytes(candidate), cryptoAPI, signal); guard(); checkCancelled(signal);
        if (!manualAvailable()) fail('BAD_SCHEMA');
        source = candidate; sourceMode = 'user-confirmed'; boundProjectId = payload.projectId;
        // RAM only: binding itself never invokes the persistence journal.
        state = { phase: 'idle', sessionId: null, locked: false, verified: false, source, sourceProof: proof, projectId: payload.projectId, completed: [], mappingAvailable: false, preparedFrames: [], expectedFrameIds: [], groupId: null, total: 0, done: 0, exportTotal: 0, exportDone: 0 };
        onState(status()); return { state: status() };
      });
    },
    confirmRecoverySource(payload, { signal } = {}) {
      const candidate = validateSourceBinding(payload);
      if (physicallyBusy()) return Promise.reject(new ProductionError('BUSY'));
      if (sourceMode !== 'recovery' || !state.sourceProof || payload.projectId !== state.projectId) return Promise.reject(new ProductionError('BAD_SCHEMA'));
      return exclusive(async () => {
        guard(); checkCancelled(signal);
        if (await sha256(jsonBytes(candidate), cryptoAPI, signal) !== state.sourceProof) fail('DOCUMENT_CHANGED');
        guard(); checkCancelled(signal); const actual = readPublicFileSource(sdk); if (actual && !sameSource(actual, candidate)) fail('DOCUMENT_CHANGED');
        source = candidate; sourceMode = 'user-confirmed'; boundProjectId = payload.projectId; state = { ...state, source };
        // The same source context is confirmed, never changed; unknown lock/SID stay intact.
        onState(status()); return { state: status() };
      });
    },
    publish({ projectId, scope = 'selection', scale = 1, includeSlices = true, chunkCapacity = 16, coordinateMode, designSpec = 'web', groupId = null }, { signal } = {}) {
      if (coordinateMode !== undefined && coordinateMode !== 'project-xy') return Promise.reject(new ProductionError('BAD_SCHEMA'));
      if (!['web', 'ios', 'android'].includes(designSpec)) return Promise.reject(new ProductionError('BAD_SCHEMA'));
      if (groupId !== null) { try { id(groupId); } catch (error) { return Promise.reject(error); } }
      if (active) return Promise.reject(new ProductionError('BUSY'));
      if (state.locked) return Promise.reject(new ProductionError(state.phase === 'unknownPrepare' ? 'UNKNOWN_PREPARE' : 'UNKNOWN_COMMIT'));
      return exclusive(async () => {
        guard(); checkCancelled(signal); id(projectId);
        if (sourceMode === 'recovery') {
          // A reopened launch never silently inherits a manual key or old namespace.
          source = readProductionSource(sdk, namespace); sourceMode = source.kind === 'figma-file' ? 'sdk' : 'launch'; boundProjectId = null; state = { ...state, source, sourceProof: null };
        }
        if (boundProjectId !== null && boundProjectId !== projectId) fail('DOCUMENT_CHANGED');
        await guardSourceWrite(); if (!source) fail('BAD_SCHEMA');
        const page = sdk.currentPage; const selected = listProductionFrames(sdk, scope); if (!selected.frames.length) fail('NO_FRAMES');
        if (!Number.isSafeInteger(chunkCapacity) || chunkCapacity < 1 || chunkCapacity > 64) fail('BAD_SCHEMA');
        const frames = selected.frames.slice(); if (frames.length > 10000) fail('BUDGET_EXCEEDED'); const frameIds = frames.map(f => id(f.id)); if (new Set(frameIds).size !== frames.length) fail('DUPLICATE_FRAME');
        let coordinates = null;
        await update({ phase: 'authorizing', operationId: null, operationCancelled: false, batchIndex: null, batchFrameIds: null, requestHash: null, sessionId: null, locked: false, verified: false, completed: [], mappingAvailable: false, commitResult: null, preparedFrames: [], expectedFrameIds: frameIds, groupId, projectId, total: frames.length, done: 0, exportTotal: frames.length, exportDone: 0, sourceBytes: null, uploadDone: 0, uploadTotal: 0, uploadedBytes: 0, uploadTotalBytes: 0, error: null, httpStatus: null, failureStage: null });
        try {
          const projects = validateProjects(await adapter.projects({ signal })); if (!projects.some(p => p.id === projectId && p.permissions.canPublish === true)) throw new ProductionError('HTTP_FAILED', { status: 403 });
          const intent = await adapter.intent(projectId, { signal });
          exactKeys(intent, ['operationId', 'projectId']); if (intent.projectId !== projectId || typeof intent.operationId !== 'string' || !/^op_[a-f0-9]{32}_[a-f0-9]{64}$/.test(intent.operationId)) fail('HTTP_RESPONSE_INVALID');
          const operationId = intent.operationId;
          await update({ phase: 'claiming', operationId, locked: true });
          let claimed;
          try { claimed = await adapter.claim({ operationId, projectId, frameIds, groupId, ...(discardHistory ? { replacePrevious: true } : {}) }, { signal }); }
          catch (error) { await update({ phase: 'unknownClaim', locked: true, error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : null }); throw error; }
          if (!record(claimed) || claimed.operationId !== operationId || claimed.projectId !== projectId || claimed.groupId !== groupId || claimed.status !== 'open' || !Array.isArray(claimed.frameIds) || claimed.frameIds.length !== frameIds.length || frameIds.some(fid => !claimed.frameIds.includes(fid))) { await update({ phase: 'unknownClaim', locked: true }); fail('HTTP_RESPONSE_INVALID'); }
          // Read public SDK geometry only after authorization; never use design writes or user-entered positions.
           coordinates = coordinateMode === 'project-xy' ? new Map(frames.map(frame => [frame.id, { x: frame.absoluteBoundingBox?.x, y: frame.absoluteBoundingBox?.y }])) : null;
           if (coordinates && new Set([...coordinates.values()].map(({ x, y }) => `${x},${y}`)).size !== coordinates.size) fail('DUPLICATE_FRAME');
           if (coordinates) for (let i = 0; i < frameIds.length; i += 1000) {
             const ids = frameIds.slice(i, i + 1000);
             validatePublishSourceBody({ source, frameIds: ids, coordinates: ids.map(fid => ({ frameId: fid, ...coordinates.get(fid) })) });
           }
           const bases = new Map(); let designFileId = null;
          await update({ phase: 'resolvingSource' });
          // Fetch ALL task bases before the first SDK export. Never refresh/rebase between rounds.
          for (let i = 0; i < frameIds.length; i += 1000) {
            guard(page); checkCancelled(signal); const ids = frameIds.slice(i, i + 1000);
            const resolved = await adapter.publishSource(projectId, { source, ...(typeof root.name === 'string' ? { name: root.name } : {}), frameIds: ids, ...(coordinates ? { coordinates: ids.map(fid => ({ frameId: fid, ...coordinates.get(fid) })) } : {}) }, operationId, { signal });
            if (!record(resolved) || resolved.projectId !== projectId || !sameSource(source, resolved.source) || !record(resolved.baseRevisions) || (coordinates ? resolved.coordinateMode !== 'project-xy' : resolved.coordinateMode !== undefined)) fail('HTTP_RESPONSE_INVALID'); id(resolved.designFileId);
            if (designFileId !== null && resolved.designFileId !== designFileId || Object.keys(resolved.baseRevisions).length !== ids.length) fail('HTTP_RESPONSE_INVALID'); designFileId = resolved.designFileId;
            for (const fid of ids) { if (!Object.hasOwn(resolved.baseRevisions, fid)) fail('HTTP_RESPONSE_INVALID'); const rev = resolved.baseRevisions[fid]; if (rev !== null) id(rev); bases.set(fid, rev); }
          }
          guard(page); checkCancelled(signal); const budget = new TaskBudget();
          await update({ phase: 'exporting', designFileId });
          const exported = await exporter.exportFrames(frames, { signal, scale, includeSlices, chunkCapacity, budget, onProgress: progress => {
             guard(page);
             if (Number.isSafeInteger(progress.done) && progress.done > state.exportDone && progress.done <= frames.length) state.exportDone = progress.done;
             if (Number.isSafeInteger(progress.sourceBytes) && progress.sourceBytes >= 0) state.sourceBytes = progress.sourceBytes;
             // Physical SDK progress remains in RAM until the next awaited journal update;
             // an SDK failure persists the count in the outer catch.
             onState(status());
           } });
           await update({ exportDone: exported.frames.length });
          guard(page); checkCancelled(signal);
          if (exported.frames.length !== frames.length || exported.frames.some((f, i) => f.figmaNodeId !== frameIds[i])) fail('DOCUMENT_CHANGED');
          for (let offset = 0; offset < exported.frames.length; offset += chunkCapacity) {
            guard(page); checkCancelled(signal);
            if (coordinates) for (const frame of frames.slice(offset, offset + chunkCapacity)) {
               const before = coordinates.get(frame.id); const now = frame.absoluteBoundingBox;
               if (now?.x !== before.x || now?.y !== before.y) fail('DOCUMENT_CHANGED');
             }
             const publication = await translateProductionFrames({ frames: exported.frames.slice(offset, offset + chunkCapacity) }, { projectId, designFileId, source, page: { id: page.id, name: page.name, order: Array.isArray(root.children) ? root.children.indexOf(page) : undefined }, bases, coordinateMode, coordinates, orderOffset: offset, designSpec, designScale: scale, groupId, cryptoAPI, signal, budget });
            const batchIndex = offset / chunkCapacity;
            const batchFrameIds = publication.body.frames.map(frame => frame.figmaNodeId);
            const requestHash = await productionPrepareHash(publication.body, operationId, batchIndex, cryptoAPI, signal);
            let prepareDispatched = false; let commitDispatched = false;
            await update({ phase: 'preparing', sessionId: null, batchIndex, batchFrameIds, requestHash, locked: true, mappingAvailable: false, commitResult: null, preparedFrames: [] });
            try {
              checkCancelled(signal); guard(page); await guardSourceWrite(); prepareDispatched = true;
              const raw = await adapter.prepare(publication.body, operationId, offset / chunkCapacity, { signal });
              // Persist sid even on conflict/invalid response. Do not throw it away and re-prepare.
              if (record(raw) && typeof raw.sessionId === 'string') { id(raw.sessionId); await update({ sessionId: raw.sessionId }); }
              const prepared = validatePrepareResult(raw, publication.body, () => {}, operationId, batchIndex);
              if (prepared.requestHash !== requestHash) fail('HTTP_RESPONSE_INVALID');
              await update({ phase: 'prepared', expiresAt: prepared.expiresAt, preparedFrames: prepared.frames.map(f => ({ figmaNodeId: f.figmaNodeId, frameId: f.frameId })) });
              if (prepared.frames.some(f => f.status === 'conflict')) fail('CONFLICT');
              const uploadTotalBytes = prepared.missingAssetSha256.reduce((sum, hash) => {
                const asset = publication.assets.get(hash); if (!asset) fail('HTTP_RESPONSE_INVALID'); return sum + asset.bytes;
              }, 0);
              await update({ uploadDone: 0, uploadTotal: prepared.missingAssetSha256.length, uploadedBytes: 0, uploadTotalBytes });
              for (const hash of prepared.missingAssetSha256) {
                const asset = publication.assets.get(hash); if (!asset) fail('HTTP_RESPONSE_INVALID');
                if (asset.bytes > Math.min(PRODUCTION_BODY_LIMIT, prepared.maxUploadBytes)) fail('HTTP_BODY_TOO_LARGE');
                budget.add('operation-envelope', 36);
                guard(page); checkCancelled(signal); await update({ phase: 'uploading' });
                const ack = await adapter.upload(state.sessionId, asset, operationId, { signal });
                exactKeys(ack, ['ok', 'sha256', 'bytes', 'mime']);
                if (ack.ok !== true || ack.sha256 !== hash || ack.bytes !== asset.bytes || ack.mime !== asset.mime) fail('HTTP_RESPONSE_INVALID');
                await update({ uploadDone: state.uploadDone + 1, uploadedBytes: state.uploadedBytes + asset.bytes });
              }
              guard(page); checkCancelled(signal); await update({ phase: 'committing' }); commitDispatched = true;
              const committed = validateCommitResult(await adapter.commit(state.sessionId, operationId, { signal }), state.sessionId, state.preparedFrames);
              // A confirmed commit is retained even after cancellation, but it is not
              // a whole-task success until all batches are visible in the reader paths.
              const completed = [...state.completed, committed]; await update({ phase: 'committing', locked: true, verified: false, mappingAvailable: true, commitResult: committed, completed, done: offset + publication.body.frames.length });
            } catch (error) {
              if (commitDispatched) { await update({ failureStage: 'committing', httpStatus: Number.isInteger(error?.status) ? error.status : null, phase: 'unknownCommit', locked: true, verified: false, error: errorCode(error) }); fail('UNKNOWN_COMMIT'); }
              // A known session is preserved for explicit query/abort; do not clean
              // staged uploads automatically after a timeout, failure, or cancel.
              if (state.sessionId) await update({ failureStage: state.phase, phase: 'unknownCommit', locked: true, verified: false, error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : null });
              else if (prepareDispatched) { await update({ failureStage: 'preparing', httpStatus: Number.isInteger(error?.status) ? error.status : null, phase: 'unknownPrepare', locked: true, verified: false, error: errorCode(error) }); fail('UNKNOWN_PREPARE'); }
              else await update({ failureStage: state.phase, httpStatus: Number.isInteger(error?.status) ? error.status : null, phase: 'failed', locked: Boolean(state.operationId), verified: false, error: errorCode(error) });
              throw error;
            }
          }
          await verifyVisibility(signal);
          return { state: status(), results: state.completed };
        } catch (error) {
          if (state.completed.length && state.done < state.total && !['unknownCommit', 'unknownPrepare', 'partial'].includes(state.phase)) await update({ failureStage: state.failureStage || state.phase, phase: 'partial', locked: true, verified: false, error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : state.httpStatus || null });
          else if (!terminal(state.phase) && !['unknownClaim', 'unknownPrepare', 'unknownCommit', 'unknownFinish', 'verificationPending', 'partial'].includes(state.phase)) await update({ failureStage: state.failureStage || state.phase, phase: 'failed', locked: Boolean(state.operationId), verified: false, error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : state.httpStatus || null });
          throw error;
        }
      });
    },
    query({ signal } = {}) {
      if (state.operationId && (recoveryWindow || !state.sessionId || ['unknownClaim', 'unknownPrepare', 'unknownFinish', 'claiming', 'finishing'].includes(state.phase))) return exclusive(async () => {
        const result = await adapter.queryOperation(state.operationId, { signal });
        if (!record(result) || result.operationId !== state.operationId || result.projectId !== state.projectId || !Array.isArray(result.frameIds)) fail('HTTP_RESPONSE_INVALID');
        if (result.status === 'cancelled') { await cancelledState(result); return { result, state: status() }; }
        if (result.groupId !== state.groupId || result.frameIds.length !== state.expectedFrameIds.length || state.expectedFrameIds.some(fid => !result.frameIds.includes(fid))) fail('HTTP_RESPONSE_INVALID');
        if (state.phase === 'unknownPrepare' && !state.sessionId && Number.isSafeInteger(state.batchIndex) && typeof state.requestHash === 'string' && Array.isArray(state.batchFrameIds) && Array.isArray(result.batches)) {
          const matches = result.batches.filter(batch => batch.batchIndex === state.batchIndex);
          if (matches.length > 1) fail('HTTP_RESPONSE_INVALID');
          if (matches.length === 1) {
            const batch = matches[0], prepared = batch.prepareResult;
            if (batch.operationId !== state.operationId || batch.requestHash !== state.requestHash || !record(prepared) || prepared.requestHash !== state.requestHash || prepared.sessionId !== batch.sessionId || prepared.operationId !== state.operationId || prepared.batchIndex !== state.batchIndex || !Array.isArray(prepared.frames) || prepared.frames.length !== state.batchFrameIds.length || state.batchFrameIds.some(fid => !prepared.frames.some(f => f.figmaNodeId === fid))) fail('HTTP_RESPONSE_INVALID');
            const preparedFrames = prepared.frames.map(f => { id(f.figmaNodeId); id(f.frameId); return { figmaNodeId: f.figmaNodeId, frameId: f.frameId }; });
            if (new Set(preparedFrames.map(f => f.figmaNodeId)).size !== preparedFrames.length || new Set(preparedFrames.map(f => f.frameId)).size !== preparedFrames.length) fail('HTTP_RESPONSE_INVALID');
            id(batch.sessionId); await update({ sessionId: batch.sessionId, preparedFrames, phase: 'unknownCommit', locked: true, verified: false });
            const sidResult = validateSessionResult(await adapter.query(batch.sessionId, { signal }), batch.sessionId);
            if (sidResult.operationId !== state.operationId || sidResult.batchIndex !== state.batchIndex || sidResult.requestHash !== state.requestHash || sidResult.frames.length !== preparedFrames.length || preparedFrames.some(f => !sidResult.frames.some(s => s.figmaNodeId === f.figmaNodeId && s.frameId === f.frameId))) fail('HTTP_RESPONSE_INVALID');
            if (terminal(sidResult.status)) await setTerminal(sidResult); else await update({ phase: 'unknownCommit', locked: true, verified: false });
            return { result: sidResult, state: status() };
          }
        }
        if (recoveryWindow && state.sessionId && ['open', 'partial'].includes(result.status)) {
          if (!Number.isSafeInteger(state.batchIndex) || typeof state.requestHash !== 'string' || !Array.isArray(state.batchFrameIds) || !Array.isArray(result.batches)) fail('HTTP_RESPONSE_INVALID');
          const matches = result.batches.filter(b => b.sessionId === state.sessionId && b.batchIndex === state.batchIndex); if (matches.length !== 1) fail('HTTP_RESPONSE_INVALID');
          const batch = matches[0], prepared = batch.prepareResult;
          if (batch.operationId !== state.operationId || batch.requestHash !== state.requestHash || !record(prepared) || prepared.sessionId !== state.sessionId || prepared.operationId !== state.operationId || prepared.batchIndex !== state.batchIndex || prepared.requestHash !== state.requestHash || !Array.isArray(prepared.frames) || prepared.frames.length !== state.batchFrameIds.length || state.batchFrameIds.some(fid => !prepared.frames.some(f => f.figmaNodeId === fid))) fail('HTTP_RESPONSE_INVALID');
          const preparedFrames = prepared.frames.map(f => { id(f.figmaNodeId); id(f.frameId); return { figmaNodeId: f.figmaNodeId, frameId: f.frameId }; });
          if (new Set(preparedFrames.map(f => f.figmaNodeId)).size !== preparedFrames.length || new Set(preparedFrames.map(f => f.frameId)).size !== preparedFrames.length || state.preparedFrames.length && (state.preparedFrames.length !== preparedFrames.length || state.preparedFrames.some(f => !preparedFrames.some(p => p.figmaNodeId === f.figmaNodeId && p.frameId === f.frameId)))) fail('HTTP_RESPONSE_INVALID');
          const sidResult = validateSessionResult(await adapter.query(state.sessionId, { signal }), state.sessionId);
          if (sidResult.operationId !== state.operationId || sidResult.batchIndex !== state.batchIndex || sidResult.requestHash !== state.requestHash || sidResult.frames.length !== preparedFrames.length || preparedFrames.some(f => !sidResult.frames.some(s => s.figmaNodeId === f.figmaNodeId && s.frameId === f.frameId))) fail('HTTP_RESPONSE_INVALID');
          if (terminal(sidResult.status)) await setTerminal(sidResult); else await update({ phase: 'unknownCommit', locked: true, verified: false });
          return { result: sidResult, state: status() };
        }
        if (result.status === 'completed') {
          if (result.lockScope !== 'service' || result.automaticExpiry !== false || !Array.isArray(result.batches) || !result.batches.length || !Array.isArray(result.committedFrames) || !Array.isArray(result.remainingFrameIds) || result.remainingFrameIds.length) fail('HTTP_RESPONSE_INVALID');
          const completed = []; const seenSid = new Set();
          for (let i = 0; i < result.batches.length; i++) {
            const batch = result.batches[i]; if (!record(batch) || batch.operationId !== state.operationId || batch.batchIndex !== i || batch.status !== 'committed' || seenSid.has(batch.sessionId) || !record(batch.prepareResult)) fail('HTTP_RESPONSE_INVALID');
            const { prepareResult, commitResult, ...sessionResult } = batch; validateSessionResult(sessionResult, batch.sessionId); seenSid.add(batch.sessionId);
            if (prepareResult.sessionId !== batch.sessionId || prepareResult.status !== 'open' || prepareResult.operationId !== state.operationId || prepareResult.batchIndex !== i || prepareResult.automaticExpiry !== false || prepareResult.expiresAt !== null || prepareResult.requestHash !== batch.requestHash || !Array.isArray(prepareResult.frames) || prepareResult.frames.length !== batch.frames.length || prepareResult.frames.some(f => !batch.frames.some(b => b.figmaNodeId === f.figmaNodeId && b.frameId === f.frameId))) fail('HTTP_RESPONSE_INVALID');
            completed.push(validateCommitResult(commitResult, batch.sessionId, batch.frames));
          }
          const frames = completed.flatMap(item => item.frames); const nodes = new Set(frames.map(f => f.figmaNodeId));
          if (frames.length !== state.expectedFrameIds.length || nodes.size !== frames.length || state.expectedFrameIds.some(fid => !nodes.has(fid)) || JSON.stringify(frames) !== JSON.stringify(result.committedFrames)) fail('HTTP_RESPONSE_INVALID');
          for (const prior of state.completed) { const current = completed.find(item => item.sessionId === prior.sessionId); if (!current || JSON.stringify(current.frames) !== JSON.stringify(prior.frames)) fail('HTTP_RESPONSE_INVALID'); }
          if (state.sessionId && !seenSid.has(state.sessionId)) fail('HTTP_RESPONSE_INVALID');
          if (state.sessionId && state.preparedFrames.length) { const batch = result.batches.find(b => b.sessionId === state.sessionId); if (batch.frames.length !== state.preparedFrames.length || state.preparedFrames.some(f => !batch.frames.some(b => b.figmaNodeId === f.figmaNodeId && b.frameId === f.frameId))) fail('HTTP_RESPONSE_INVALID'); }
          await update({ completed, done: frames.length, total: state.expectedFrameIds.length, mappingAvailable: true, locked: true, verified: false });
          await verifyVisibility(signal, true);
        } else await update({ locked: true, verified: false });
        return { result, state: status() };
      });
      if (!state.sessionId) return Promise.reject(new ProductionError('UNKNOWN_PREPARE'));
      const original = state.sessionId;
      return exclusive(async () => {
        try {
          if (state.phase === 'verificationPending') { await verifyVisibility(signal); return { state: status() }; }
          const result = validateSessionResult(await adapter.query(original, { signal }), original);
          if (state.operationId && (result.operationId !== state.operationId || state.requestHash && result.requestHash !== state.requestHash || state.batchIndex != null && result.batchIndex !== state.batchIndex)) fail('HTTP_RESPONSE_INVALID');
          if (state.preparedFrames.length && (result.frames.length !== state.preparedFrames.length || result.frames.some(f => !state.preparedFrames.some(p => p.figmaNodeId === f.figmaNodeId && p.frameId === f.frameId)))) fail('HTTP_RESPONSE_INVALID');
          if (result.status === 'committed' && state.completed.some(r => r.sessionId === original)) {
            if (visibilityFrames()) await verifyVisibility(signal);
            else await update({ phase: 'partial', locked: true, verified: false });
          } else if (terminal(result.status)) await setTerminal(result);
          else await update({ phase: 'unknownCommit', locked: true, verified: false });
          return { result, state: status() };
        } catch (error) {
          if (state.phase !== 'verificationPending' && state.phase !== 'partial') await update({ phase: 'unknownCommit', locked: true, verified: false, error: errorCode(error), httpStatus: error?.status || null });
          throw error;
        }
      });
    },
    abort() {
      if (recoveryWindow) {
        if (!state.operationId || typeof adapter.recoverCancel !== 'function' || ['committed', 'verifying', 'verificationPending'].includes(state.phase)) return Promise.reject(new ProductionError('UNKNOWN_COMMIT'));
        return exclusive(async () => { try { if (!/^op_[a-f0-9]{32}_[a-f0-9]{64}$/.test(state.operationId)) { const existing = await adapter.queryOperation(state.operationId, {}); if (!record(existing) || existing.operationId !== state.operationId || existing.projectId !== state.projectId || existing.groupId !== state.groupId || !Array.isArray(existing.frameIds) || existing.frameIds.length !== state.expectedFrameIds.length || state.expectedFrameIds.some(fid => !existing.frameIds.includes(fid))) fail('HTTP_RESPONSE_INVALID'); } const result = await cancelledState(await adapter.recoverCancel(state.operationId, state.projectId, {})); return { result, state: status() }; } catch (error) { await update({ locked: true, verified: false, error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : null }); throw error; } });
      }
      if (['committed', 'verificationPending', 'verifying'].includes(state.phase)) return Promise.reject(new ProductionError('BAD_SCHEMA'));
      return exclusive(async () => ({ result: await abortKnown(), state: status() }));
    },
    recoverCommit({ signal } = {}) {
      if (state.phase !== 'committed' || !state.sessionId || state.mappingAvailable) return Promise.reject(new ProductionError('UNKNOWN_COMMIT'));
      return exclusive(async () => {
        // Only an explicit read of the original SID, never another commit POST.
        try {
          if (sourceMode === 'recovery' && (!source || readPublicFileSource(sdk) === null && source.kind === 'figma-file')) fail('BAD_SCHEMA');
          await guardSourceWrite();
          if (typeof adapter.queryCommitResult !== 'function') fail('HTTP_RESPONSE_INVALID');
          const result = validateCommitResult(await adapter.queryCommitResult(state.sessionId, { signal }), state.sessionId, state.preparedFrames.length ? state.preparedFrames : null);
          const completed = [...state.completed.filter(item => item.sessionId !== result.sessionId), result];
          const done = completed.reduce((n, item) => n + item.frames.length, 0);
          await update({ locked: true, verified: false, mappingAvailable: true, commitResult: result, completed, done });
          if (visibilityFrames()) await verifyVisibility(signal);
          else await update({ phase: 'partial', locked: true, verified: false });
          return { result, state: status() };
        } catch (error) {
          if (!['verificationPending', 'partial'].includes(state.phase)) await update({ phase: 'committed', locked: true, verified: false, failureStage: 'committing', error: errorCode(error), httpStatus: Number.isInteger(error?.status) ? error.status : null });
          throw error;
        }
      });
    }
  };
}
