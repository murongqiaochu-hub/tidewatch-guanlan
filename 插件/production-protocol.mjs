// New implementation from the supplied, sanitized production wire semantics only.
import { fail, record, exactKeys, id, digestString, jsonBytes, sha256, checkCancelled, number, SOURCE_LIMIT, cancellationController } from './core.mjs';
import { validateOperation, validateOperationResult } from './protocol.mjs';
import { validateVisibilityRequest, verifyPublicationVisibility } from './publication-visibility.mjs';
import { verifyPublicationSnapshot } from './publication-snapshot.mjs';

export const PRODUCTION_BODY_LIMIT = 25 * 1024 * 1024;
export const PRODUCTION_RESPONSE_LIMIT = 4 * 1024 * 1024;
// Full reader DTOs, never target-filtered. Directory/history/snapshot match
// 宿主/production-adapter.mjs; canvas gets 16 MiB for its wider project metadata.
// These are response-body byte ceilings, not a bound on the expanded JSON heap.
export const PRODUCTION_VERIFICATION_LIMITS = Object.freeze({
  canvas: 16 * 1024 * 1024,
  directory: 8 * 1024 * 1024,
  revisions: 8 * 1024 * 1024,
  snapshot: 65 * 1024 * 1024
});
export class ProductionError extends Error {
  constructor(code, { status = null, dispatched = false } = {}) { super(code); this.name = 'ProductionError'; this.code = code; this.status = status; this.dispatched = dispatched; }
}
const invalid = () => fail('HTTP_RESPONSE_INVALID');
const text = (v, max = 1024) => { if (typeof v !== 'string' || !v.length || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) fail('BAD_SCHEMA'); return v; };
const integer = (v, max = SOURCE_LIMIT) => { if (!Number.isSafeInteger(v) || v < 1 || v > max) fail('BAD_SCHEMA'); return v; };
const finite = v => { if (typeof v !== 'number' || !Number.isFinite(v)) fail('BAD_SCHEMA'); return v; };
export function validateSource(source) {
  if (source?.kind === 'figma-file') { exactKeys(source, ['kind', 'fileKey']); if (typeof source.fileKey !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(source.fileKey)) fail('BAD_SCHEMA'); }
  else { exactKeys(source, ['kind', 'namespace']); if (source.kind !== 'plugin-launch' || typeof source.namespace !== 'string' || !/^src_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/.test(source.namespace)) fail('BAD_SCHEMA'); }
  return source;
}
export const sameSource = (a, b) => { validateSource(a); validateSource(b); return a.kind === b.kind && (a.kind === 'figma-file' ? a.fileKey === b.fileKey : a.namespace === b.namespace); };
export function validateProductionExport(value) {
  exactKeys(value, ['sha256', 'bytes', 'mime', 'exportNodeId', 'fileName', 'exportName', 'format', 'pluginExportSetting'], ['sha256', 'bytes', 'mime', 'exportNodeId', 'fileName']);
  digestString(value.sha256); integer(value.bytes); id(value.exportNodeId); text(value.fileName, 256);
  if (/[\/\\]/.test(value.fileName)) fail('BAD_SCHEMA');
  const formats = { PNG: 'image/png', JPG: 'image/jpeg', JPEG: 'image/jpeg', WEBP: 'image/webp', SVG: 'image/svg+xml' };
  if (!Object.values(formats).includes(value.mime) || value.format !== undefined && formats[value.format] !== value.mime) fail('BAD_FORMAT');
  if (value.exportName !== undefined) text(value.exportName, 256);
  if (value.pluginExportSetting !== undefined && !record(value.pluginExportSetting)) fail('BAD_SCHEMA');
  return value;
}
export function validateProductionManifest(frame) {
  exactKeys(frame, ['figmaNodeId', 'figmaPageId', 'name', 'pageName', 'pageOrder', 'x', 'y', 'width', 'height', 'order', 'hash', 'layerDocSha256', 'layerDocBytes', 'previewSha256', 'previewBytes', 'previewMime', 'exports', 'transform', 'designSpec', 'designScale', 'baseRevisionId'], ['figmaNodeId', 'figmaPageId', 'name', 'x', 'y', 'width', 'height', 'hash', 'layerDocSha256', 'layerDocBytes', 'exports', 'baseRevisionId']);
  if (frame.designSpec !== undefined && !['web', 'ios', 'android'].includes(frame.designSpec)) fail('BAD_SCHEMA');
  if (frame.designScale !== undefined && (!Number.isFinite(frame.designScale) || frame.designScale < 1 || frame.designScale > 8)) fail('BAD_SCHEMA');
  id(frame.figmaNodeId); id(frame.figmaPageId); if (typeof frame.name !== 'string' || frame.name.length > 4096) fail('BAD_SCHEMA');
  if (frame.pageName !== undefined && (typeof frame.pageName !== 'string' || frame.pageName.length > 4096)) fail('BAD_SCHEMA');
  for (const key of ['x', 'y', 'width', 'height']) finite(frame[key]);
  if (frame.width <= 0 || frame.height <= 0) fail('BAD_DIMENSIONS');
  for (const key of ['order', 'pageOrder']) if (frame[key] !== undefined) finite(frame[key]);
  digestString(frame.hash); digestString(frame.layerDocSha256); integer(frame.layerDocBytes);
  if (frame.baseRevisionId !== null) id(frame.baseRevisionId);
  if (frame.previewSha256 !== undefined) { digestString(frame.previewSha256); integer(frame.previewBytes); if (!['image/png', 'image/jpeg', 'image/webp'].includes(frame.previewMime)) fail('BAD_FORMAT'); }
  else if (frame.previewBytes !== undefined || frame.previewMime !== undefined) fail('BAD_SCHEMA');
  if (!Array.isArray(frame.exports)) fail('BAD_SCHEMA'); frame.exports.forEach(validateProductionExport);
  if (frame.transform !== undefined && (!Array.isArray(frame.transform) || frame.transform.length !== 2 || frame.transform.some(row => !Array.isArray(row) || row.length !== 3 || row.some(n => typeof n !== 'number' || !Number.isFinite(n))))) fail('BAD_SCHEMA');
  return frame;
}
export function validatePublishSourceBody(body) {
  exactKeys(body, ['source', 'name', 'frameIds', 'coordinates'], ['source', 'frameIds']);
  validateSource(body.source);
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 4096)) fail('BAD_SCHEMA');
  if (!Array.isArray(body.frameIds) || !body.frameIds.length || body.frameIds.length > 1000 || new Set(body.frameIds).size !== body.frameIds.length) fail('BAD_SCHEMA');
  body.frameIds.forEach(id);
  if (body.coordinates !== undefined) {
    if (!Array.isArray(body.coordinates) || body.coordinates.length !== body.frameIds.length) fail('BAD_SCHEMA');
    for (let i = 0; i < body.frameIds.length; i++) {
      const point = body.coordinates[i]; exactKeys(point, ['frameId', 'x', 'y']);
      if (id(point.frameId) !== body.frameIds[i]) fail('BAD_SCHEMA'); finite(point.x); finite(point.y);
    }
    if (new Set(body.coordinates.map(point => `${point.x},${point.y}`)).size !== body.coordinates.length) fail('DUPLICATE_FRAME');
  }
  return body;
}
export function validatePrepareBody(body) {
  exactKeys(body, ['projectId', 'designFile', 'source', 'requireBaseRevision', 'coordinateMode', 'frames', 'groupId', 'groupAssignment'], ['projectId', 'designFile', 'source', 'requireBaseRevision', 'frames']); if (body.coordinateMode !== undefined && body.coordinateMode !== 'project-xy') fail('BAD_SCHEMA'); if (body.groupId !== undefined && body.groupId !== null) id(body.groupId); if (body.groupAssignment !== undefined && (body.groupAssignment !== 'set' || !Object.hasOwn(body, 'groupId') || body.groupId === undefined)) fail('BAD_SCHEMA'); id(body.projectId); exactKeys(body.designFile, ['designFileId']); id(body.designFile.designFileId); validateSource(body.source);
  if (body.requireBaseRevision !== true || !Array.isArray(body.frames) || !body.frames.length || body.frames.length > 1000) fail('BAD_SCHEMA');
  const seen = new Set(); for (const frame of body.frames) { validateProductionManifest(frame); if (seen.has(frame.figmaNodeId)) fail('DUPLICATE_FRAME'); seen.add(frame.figmaNodeId); }
  return body;
}
function hashes(values, unique = true) { if (!Array.isArray(values) || unique && new Set(values).size !== values.length) invalid(); values.forEach(digestString); return values; }
function expiry(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(); return value; }
function accountTime(value) {
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if(!match)invalid();const [,yearText,monthText,dayText,hourText,minuteText,secondText,,zone,,zoneHourText,zoneMinuteText]=match,year=Number(yearText),month=Number(monthText),day=Number(dayText),hour=Number(hourText),minute=Number(minuteText),second=Number(secondText),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59||zone!=='Z'&&(Number(zoneHourText)>23||Number(zoneMinuteText)>59)||!Number.isFinite(Date.parse(value)))invalid();return value;
}
function validateAccountSelf(value){
  try {
    exactKeys(value,['id','username','role','expiresAt','projectLimit','ownedProjectCount','displayName','status','ownerId','createdAt'],['id','username','role','expiresAt','projectLimit','ownedProjectCount']);id(value.id);text(value.username,256);if(!['admin','designer','developer'].includes(value.role))invalid();
    if(value.expiresAt!==null)accountTime(value.expiresAt);if(value.projectLimit!==null&&(!Number.isSafeInteger(value.projectLimit)||value.projectLimit<0))invalid();if(!Number.isSafeInteger(value.ownedProjectCount)||value.ownedProjectCount<0)invalid();
    if(value.displayName!==undefined&&(typeof value.displayName!=='string'||value.displayName.length>160||/[\u0000-\u001f\u007f]/.test(value.displayName)))invalid();if(value.status!==undefined&&!['active','disabled'].includes(value.status))invalid();if(value.ownerId!==undefined&&value.ownerId!==null)id(value.ownerId);if(value.createdAt!==undefined&&value.createdAt!==null)accountTime(value.createdAt);return value;
  } catch(error) { if(error?.code==='BAD_SCHEMA'||error?.code==='BAD_ID')invalid(); throw error; }
}
// Remembered-device expiry is deployed as epoch milliseconds, not session ISO time.
// Preserve its wire type/value; neither coercion nor a local expiry guess is allowed.
function rememberExpiry(value) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) invalid(); return value; }
  return expiry(value); // Compatibility with independently configured ISO services.
}
const frameStates = ['new', 'changed', 'metadata-only', 'unchanged', 'conflict'];
const terminalStates = ['committed', 'aborted', 'expired'];
function validateOperationPolicy(policy) { exactKeys(policy, ['version', 'mode', 'maxConcurrentUploads', 'maxInFlightBytes']); if (policy.version !== 1 || policy.mode !== 'adaptive' || !Number.isSafeInteger(policy.maxConcurrentUploads) || policy.maxConcurrentUploads < 1 || !Number.isSafeInteger(policy.maxInFlightBytes) || policy.maxInFlightBytes < 1) invalid(); }
export function validatePrepareResult(value, body, onSession = () => {}, operationId = null, batchIndex = null) {
  // A received sid is journaled before validating conflict/missing/remaining fields.
  if (!record(value)) invalid(); id(value.sessionId); onSession(value.sessionId);
  exactKeys(value, ['sessionId', 'status', 'expiresAt', 'designFileId', 'maxUploadBytes', 'uploadPolicy', 'missingAssetSha256', 'frames', 'automaticExpiry', 'operationId', 'batchIndex', 'requestHash'], ['sessionId', 'status', 'expiresAt', 'designFileId', 'maxUploadBytes', 'uploadPolicy', 'missingAssetSha256', 'frames']);
  if (value.status !== 'open' || value.designFileId !== body.designFile.designFileId) invalid();
  if (operationId !== null) { if (value.operationId !== operationId || value.batchIndex !== batchIndex || value.automaticExpiry !== false || value.expiresAt !== null) invalid(); digestString(value.requestHash); } else expiry(value.expiresAt); integer(value.maxUploadBytes, Number.MAX_SAFE_INTEGER); if (!record(value.uploadPolicy)) invalid(); hashes(value.missingAssetSha256);
  if (!Array.isArray(value.frames) || value.frames.length !== body.frames.length) invalid();
  const expected = new Set(body.frames.map(f => f.figmaNodeId)); const platformIds = new Set();
  const declared = new Map(body.frames.map(f => [f.figmaNodeId, new Set([f.layerDocSha256, ...(f.previewSha256 ? [f.previewSha256] : []), ...(f.exports || []).map(e => e.sha256)].filter(Boolean))]));
  const allDeclared = new Set([...declared.values()].flatMap(s => [...s]));
  if (value.missingAssetSha256.some(h => !allDeclared.has(h))) invalid();
  for (const f of value.frames) { exactKeys(f, ['figmaNodeId', 'frameId', 'status', 'missingAssetSha256']); id(f.figmaNodeId); id(f.frameId); if (!expected.delete(f.figmaNodeId) || platformIds.has(f.frameId) || !frameStates.includes(f.status)) invalid(); platformIds.add(f.frameId); hashes(f.missingAssetSha256, false); if (f.missingAssetSha256.some(h => !value.missingAssetSha256.includes(h) || !declared.get(f.figmaNodeId).has(h))) invalid(); }
  if (expected.size) invalid(); return value;
}
export function validateSessionResult(value, sessionId) {
  exactKeys(value, ['sessionId', 'status', 'expiresAt', 'uploaded', 'uploadPolicy', 'frames', 'automaticExpiry', 'operationId', 'batchIndex', 'requestHash'], ['sessionId', 'status', 'expiresAt', 'uploaded', 'uploadPolicy', 'frames']);
  if (value.sessionId !== id(sessionId) || !['open', ...terminalStates].includes(value.status)) invalid();
  if (value.operationId !== undefined) { id(value.operationId); if (value.automaticExpiry !== false || value.expiresAt !== null || !Number.isSafeInteger(value.batchIndex) || value.batchIndex < 0) invalid(); digestString(value.requestHash); validateOperationPolicy(value.uploadPolicy); hashes(value.uploaded); } else expiry(value.expiresAt); if (!record(value.uploadPolicy) || !Array.isArray(value.frames) || !(Array.isArray(value.uploaded) || record(value.uploaded) || Number.isSafeInteger(value.uploaded) && value.uploaded >= 0)) invalid();
  const seen = new Set(); for (const f of value.frames) { exactKeys(f, ['figmaNodeId', 'status', 'frameId']); id(f.figmaNodeId); id(f.frameId); if (seen.has(f.figmaNodeId) || ![...frameStates, ...terminalStates, 'open'].includes(f.status)) invalid(); seen.add(f.figmaNodeId); }
  return value;
}
export function validateCommitResult(value, sessionId, expectedFrames = null) {
  exactKeys(value, ['sessionId', 'status', 'frames', 'idempotent'], ['sessionId', 'status', 'frames']);
  if (Object.hasOwn(value, 'idempotent') && typeof value.idempotent !== 'boolean') invalid();
  if (value.sessionId !== id(sessionId) || value.status !== 'committed' || !Array.isArray(value.frames)) invalid();
  const expected = expectedFrames ? new Map(expectedFrames.map(f => [f.figmaNodeId, f.frameId])) : null; const seen = new Set();
  for (const f of value.frames) { exactKeys(f, ['figmaNodeId', 'frameId', 'revisionId', 'previousRevisionId', 'status'], ['figmaNodeId', 'frameId', 'revisionId', 'status']); id(f.figmaNodeId); id(f.frameId); id(f.revisionId); if (f.previousRevisionId !== undefined && f.previousRevisionId !== null) id(f.previousRevisionId); if (seen.has(f.figmaNodeId) || !['new', 'changed', 'metadata-only', 'unchanged', 'committed'].includes(f.status) || expected && expected.get(f.figmaNodeId) !== f.frameId) invalid(); seen.add(f.figmaNodeId); }
  if (expected && seen.size !== expected.size) invalid(); return value;
}
export function validateProjects(value) {
  const projects = Array.isArray(value) ? value : (exactKeys(value, ['projects']), value.projects);
  if (!Array.isArray(projects)) invalid(); const seen = new Set();
  for (const p of projects) { if (!record(p) || !record(p.permissions) || typeof p.permissions.canPublish !== 'boolean' || typeof p.name !== 'string') invalid(); id(p.id); if (p.groupId !== undefined && p.groupId !== null) id(p.groupId); if (seen.has(p.id)) invalid(); seen.add(p.id); }
  return projects;
}

// Production supports explicit RFC1918 HTTP services; public HTTP stays forbidden.
// The plugin manifest and main configuration further constrain this to approved endpoints.
const privateIPv4 = host => {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  return parts.every(n => n >= 0 && n <= 255) && (parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
};
// 服务地址来自构建期注入的 __INDEPENDENT_PRODUCTION__（见 平台/服务地址.mjs）。
// 仓库不再内置任何具体域名/内网地址；未注入时不认领任何遗留地址。
function productionInjection() {
  const viaGlobal = typeof globalThis !== 'undefined' ? globalThis.__INDEPENDENT_PRODUCTION__ : null;
  if (viaGlobal && typeof viaGlobal === 'object') return viaGlobal;
  // SDK sandbox scripts may expose the injected global as a bare binding.
  if (typeof __INDEPENDENT_PRODUCTION__ !== 'undefined' && __INDEPENDENT_PRODUCTION__ && typeof __INDEPENDENT_PRODUCTION__ === 'object') return __INDEPENDENT_PRODUCTION__;
  return null;
}
export const customHTTPSMode = () => productionInjection()?.serviceMode === 'custom-https';
// Strict authority parser also runs in Figma's URL-less main sandbox. No URL
// repair (credentials, slashes, escaped hosts or shortened numeric IPs) is allowed.
export function customHTTPSOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) fail('BAD_ORIGIN');
  const match = /^https:\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match) fail('BAD_ORIGIN');
  let host = match[1].toLowerCase();
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) fail('BAD_ORIGIN');
  if (host[0] === '[') {
    let address = host.slice(1, -1);
    if (address.includes('.')) {
      const at = address.lastIndexOf(':'); const parts = address.slice(at + 1).split('.');
      if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) fail('BAD_ORIGIN');
      address = address.slice(0, at + 1) + ((Number(parts[0]) << 8) | Number(parts[1])).toString(16) + ':' + ((Number(parts[2]) << 8) | Number(parts[3])).toString(16);
    }
    const halves = address.split('::');
    if (halves.length > 2) fail('BAD_ORIGIN');
    const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if ([...left, ...right].some(p => !/^[0-9a-f]{1,4}$/.test(p)) || (halves.length === 1 ? left.length !== 8 : left.length + right.length >= 8)) fail('BAD_ORIGIN');
    const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(p => Number.parseInt(p, 16).toString(16));
    let start = -1, length = 1;
    for (let i = 0; i < 8;) { if (words[i] !== '0') { i++; continue; } let end = i; while (end < 8 && words[end] === '0') end++; if (end - i > length) { start = i; length = end - i; } i = end; }
    host = '[' + (start < 0 ? words.join(':') : words.slice(0, start).join(':') + '::' + words.slice(start + length).join(':')) + ']';
  } else {
    if (host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('BAD_ORIGIN');
    // WHATWG treats a numeric last label as IPv4: reject all ambiguous forms.
    if (/^(?:[0-9]+|0x[0-9a-f]+)$/.test(host.split('.').at(-1))) {
      const parts = host.split('.');
      if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) fail('BAD_ORIGIN');
    }
  }
  return `https://${host}${port === 443 ? '' : ':' + port}`;
}
export function injectedServiceOrigin() {
  const value = productionInjection()?.serviceOrigin;
  return typeof value === 'string' && value ? value : null;
}
export function injectedServiceOrigins() {
  const list = productionInjection()?.serviceOrigins;
  return Array.isArray(list) ? list.filter(value => typeof value === 'string' && value) : [];
}
function exactLegacyHTTP(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const lower = trimmed.toLowerCase();
  const match = injectedServiceOrigins().find(origin => origin.startsWith('http://') && origin.toLowerCase() === lower);
  return match || null;
}
// Login-only migration: never rewrite persisted service/session origins or HTTP adapters.
export function normalizeProductionLoginOrigin(value, { allowLocalhost = false, state = null, remembered = null } = {}) {
  if (customHTTPSMode()) return customHTTPSOrigin(value);
  const origin = productionServiceOrigin(value, { allowLocalhost });
  const httpsOrigin = injectedServiceOrigin();
  if (!httpsOrigin || !exactLegacyHTTP(origin)) return origin;
  if (state?.locked || state?.sessionId || state?.requestId || state?.completed?.length || state?.phase && state.phase !== 'idle' || remembered && productionServiceOrigin(remembered.origin, { allowLocalhost }) === origin) fail('BAD_ORIGIN');
  return httpsOrigin;
}
export function productionServiceOrigin(value, { allowLocalhost = false } = {}) {
  if (customHTTPSMode()) { if (allowLocalhost) fail('BAD_ORIGIN'); return customHTTPSOrigin(value); }
  const legacy = exactLegacyHTTP(value);
  if (legacy) return legacy;
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\]/.test(value)) fail('BAD_ORIGIN');
  if (typeof URL === 'undefined') return validateOriginForSandbox(value, allowLocalhost);
  let url; try { url = new URL(value); } catch { fail('BAD_ORIGIN'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== value.replace(/\/$/, '')) fail('BAD_ORIGIN');
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (privateIPv4(url.hostname) || allowLocalhost && localhost))) fail('BAD_ORIGIN');
  return url.origin;
}
function sameProductionServiceURL(value, origin, { allowLocalhost = false } = {}) {
  const trusted = productionServiceOrigin(origin, { allowLocalhost });
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) fail('BAD_URL');
  let url; try { url = new URL(value, `${trusted}/`); } catch { fail('BAD_URL'); }
  if (url.origin !== trusted || url.username || url.password || url.hash) fail('BAD_URL');
  return url.href;
}
function validateOriginForSandbox(value, allowLocalhost) {
  if (customHTTPSMode()) { if (allowLocalhost) fail('BAD_ORIGIN'); return customHTTPSOrigin(value); }
  const legacy = exactLegacyHTTP(value);
  if (legacy) return legacy;
  if (typeof URL !== 'undefined') return productionServiceOrigin(value, { allowLocalhost });
  // The SDK main sandbox need not provide URL. Only canonical ASCII origins cross RPC.
  if (typeof value !== 'string' || value.length > 2048) fail('BAD_ORIGIN');
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || match[2].includes('..') || match[3] && Number(match[3]) > 65535 || match[1] !== 'https' && !(privateIPv4(match[2]) || allowLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(match[2]))) fail('BAD_ORIGIN');
  return value;
}
export function validateRememberedLogin(value) {
  exactKeys(value, ['origin', 'allowLocalhost', 'username', 'refreshToken', 'refreshExpiresAt']);
  if (typeof value.allowLocalhost !== 'boolean') fail('BAD_SCHEMA'); validateOriginForSandbox(value.origin, value.allowLocalhost); text(value.username, 256); text(value.refreshToken, 8192); rememberExpiry(value.refreshExpiresAt); return value;
}
function validateService(service) { exactKeys(service, ['origin', 'allowLocalhost']); if (typeof service.allowLocalhost !== 'boolean') fail('BAD_SCHEMA'); validateOriginForSandbox(service.origin, service.allowLocalhost); }
// Opt-in schema wrappers: no change to the shared demo schema or physical RPC transport.
export function validateProductionOperation(operation, payload) {
  if (operation === 'production-control') {
    if (!record(payload)) fail('BAD_SCHEMA');
    if (['connect', 'connect-account'].includes(payload.action)) { exactKeys(payload, ['action', 'service', 'namespace']); validateService(payload.service); validateSource({ kind: 'plugin-launch', namespace: payload.namespace }); }
    else if (payload.action === 'publish') { exactKeys(payload, ['action', 'projectId', 'scope', 'scale', 'includeSlices', 'chunkCapacity', 'coordinateMode', 'designSpec', 'groupId'], ['action', 'projectId', 'scope', 'scale', 'includeSlices', 'chunkCapacity']); if (payload.coordinateMode !== undefined && payload.coordinateMode !== 'project-xy') fail('BAD_SCHEMA'); id(payload.projectId); if (!['selection', 'page'].includes(payload.scope) || typeof payload.includeSlices !== 'boolean') fail('BAD_SCHEMA'); number(payload.scale, 0.001, 64); number(payload.chunkCapacity, 1, 64); if (!Number.isInteger(payload.chunkCapacity)) fail('BAD_SCHEMA'); if (payload.designSpec !== undefined && !['web', 'ios', 'android'].includes(payload.designSpec)) fail('BAD_SCHEMA'); if (payload.groupId !== undefined && payload.groupId !== null) id(payload.groupId); }
    else if (payload.action === 'remember-write') { exactKeys(payload, ['action', 'remembered']); validateRememberedLogin(payload.remembered); }
    else if (payload.action === 'cancel-recovery') { exactKeys(payload, ['action', 'operationId', 'projectId']); id(payload.operationId); id(payload.projectId); }
    else if (['status', 'reconcile', 'query', 'abort', 'recoverCommit', 'remember-read', 'remember-clear'].includes(payload.action)) exactKeys(payload, ['action']);
    else fail('BAD_SCHEMA'); return;
  }
  if (operation === 'production-network') {
    exactKeys(payload, ['method', 'service', 'args']); validateService(payload.service); if (!Array.isArray(payload.args)) fail('BAD_SCHEMA');
    const args = payload.args;
    if (payload.method === 'projects') { if (args.length) fail('BAD_SCHEMA'); }
    else if (payload.method === 'intent') { if (args.length !== 1) fail('BAD_SCHEMA'); id(args[0]); }
    else if (payload.method === 'recoverCancel') { if (args.length !== 2) fail('BAD_SCHEMA'); id(args[0]); id(args[1]); }
    else if (payload.method === 'claim') { if (args.length !== 1 || !record(args[0])) fail('BAD_SCHEMA'); exactKeys(args[0], ['operationId', 'projectId', 'frameIds', 'groupId', 'replacePrevious'], ['operationId', 'projectId', 'frameIds', 'groupId']); if (args[0].replacePrevious !== undefined && args[0].replacePrevious !== true) fail('BAD_SCHEMA'); id(args[0].operationId); id(args[0].projectId); if (!Array.isArray(args[0].frameIds) || !args[0].frameIds.length || new Set(args[0].frameIds).size !== args[0].frameIds.length) fail('BAD_SCHEMA'); args[0].frameIds.forEach(id); if (args[0].groupId !== null) id(args[0].groupId); }
    else if (payload.method === 'publishSource') { if (args.length !== 3) fail('BAD_SCHEMA'); id(args[0]); validatePublishSourceBody(args[1]); id(args[2]); }
    else if (payload.method === 'prepare') { if (args.length !== 3) fail('BAD_SCHEMA'); validatePrepareBody(args[0]); id(args[1]); if (!Number.isSafeInteger(args[2]) || args[2] < 0) fail('BAD_SCHEMA'); }
    else if (['queryOperation', 'operationReceipt', 'cancelOperation'].includes(payload.method)) { if (args.length !== 1) fail('BAD_SCHEMA'); id(args[0]); }
    else if (payload.method === 'finish') { if (args.length !== 2 || typeof args[1] !== 'string' || !/^[a-f0-9]{32}:[0-9]+$/.test(args[1])) fail('BAD_SCHEMA'); id(args[0]); }
    else if (payload.method === 'upload') { if (args.length !== 3) fail('BAD_SCHEMA'); id(args[0]); id(args[2]); const a = args[1]; exactKeys(a, ['sha256', 'bytes', 'mime', 'data']); digestString(a.sha256); integer(a.bytes, PRODUCTION_BODY_LIMIT); if (!(a.data instanceof Uint8Array) || a.data.length !== a.bytes || !['application/json', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(a.mime)) fail('BAD_BYTES'); }
    else if (['commit', 'abort'].includes(payload.method)) { if (args.length !== 2) fail('BAD_SCHEMA'); id(args[0]); id(args[1]); }
    else if (['query', 'queryCommitResult'].includes(payload.method)) { if (args.length !== 1) fail('BAD_SCHEMA'); id(args[0]); }
    else if (payload.method === 'verifyPublication') { if (args.length !== 3) fail('BAD_SCHEMA'); validateVisibilityRequest(args[0], args[1], args[2]); }
    else fail('BAD_SCHEMA'); return;
  }
  // Production cannot invoke demo synthetic bindings/network by accident.
  if (['export', 'publish', 'network', 'query', 'abort'].includes(operation)) fail('BAD_SCHEMA');
  validateOperation(operation, payload);
}
export function validateProductionOperationResult(operation, result) {
  if (operation === 'production-control') { if (!record(result)) fail('BAD_SCHEMA'); return; }
  if (operation === 'production-network') {
    if (result?.ok === true) { exactKeys(result, ['ok', 'value']); if (!record(result.value) && !Array.isArray(result.value)) fail('HTTP_RESPONSE_INVALID'); }
    else { exactKeys(result, ['ok', 'error']); exactKeys(result.error, ['code', 'status', 'dispatched']); if (result.ok !== false || typeof result.error.code !== 'string' || result.error.code.length > 64 || typeof result.error.dispatched !== 'boolean' || result.error.status !== null && (!Number.isInteger(result.error.status) || result.error.status < 100 || result.error.status > 599)) fail('BAD_SCHEMA'); }
    return;
  }
  validateOperationResult(operation, result);
}

// One physical request at a time. No Promise.race or early unlock on timeout/cancel.
export function createProductionHTTP({ origin, allowLocalhost = false, fetchAPI = globalThis.fetch, cryptoAPI = globalThis.crypto, responseLimit = 1024 * 1024, timeoutMs = 120000 } = {}) {
  const trusted = productionServiceOrigin(origin, { allowLocalhost }); number(responseLimit, 1, PRODUCTION_RESPONSE_LIMIT); number(timeoutMs, 1, 3600000);
  if (typeof fetchAPI !== 'function') fail('BAD_SCHEMA'); let token = null; let active = false;
  // Writer capabilities live exclusively in this network UI instance, never in RPC DTOs or storage.
  const writers = new Map();
  const writer = operationId => { const value = writers.get(id(operationId)); if (!value) fail('UNKNOWN_COMMIT'); return value; };
  const operationPath = operationId => `/api/publish/operations/${encodeURIComponent(id(operationId))}`;
  const safeWriterDTO = value => {
    if (!record(value)) invalid();
    if (!writers.size) return value;
    const stack = [value]; const secrets = [...writers.values()].map(w => w.secret);
    while (stack.length) { const item = stack.pop(); if (!item || typeof item !== 'object') continue; for (const [key, child] of Object.entries(item)) { if (key === 'writerSecret' || secrets.some(secret => key.includes(secret) || typeof child === 'string' && child.includes(secret))) invalid(); if (child && typeof child === 'object') stack.push(child); } }
    return value;
  };
  const safeOperation = (value, operationId) => {
    safeWriterDTO(value);
    exactKeys(value, ['operationId', 'projectId', 'createdBy', 'status', 'frameIds', 'groupId', 'createdAt', 'updatedAt', 'finishedAt', 'lockScope', 'automaticExpiry', 'batches', 'committedFrames', 'remainingFrameIds', 'cancelTombstone'], ['operationId', 'projectId', 'createdBy', 'status', 'frameIds', 'createdAt', 'updatedAt', 'finishedAt', 'lockScope', 'automaticExpiry', 'batches', 'committedFrames', 'remainingFrameIds']);
    if (value.cancelTombstone !== undefined && value.cancelTombstone !== true) invalid();
    if (value.operationId !== operationId || value.lockScope !== 'service' || value.automaticExpiry !== false || !['open', 'partial', 'completed', 'cancelled'].includes(value.status)) invalid();
    id(value.projectId); id(value.createdBy); if (value.groupId !== undefined && value.groupId !== null) id(value.groupId); expiry(value.createdAt); expiry(value.updatedAt); if (value.finishedAt !== null) expiry(value.finishedAt);
    for (const key of ['frameIds', 'remainingFrameIds']) { if (!Array.isArray(value[key]) || new Set(value[key]).size !== value[key].length || value[key].length > 10000) invalid(); value[key].forEach(id); }
    if (!Array.isArray(value.batches) || !Array.isArray(value.committedFrames)) invalid();
    for (const batch of value.batches) {
      if (!record(batch)) invalid(); const { prepareResult, commitResult, ...session } = batch; validateSessionResult(session, batch.sessionId);
      if (session.operationId !== operationId || !record(prepareResult)) invalid(); validateOperationPolicy(session.uploadPolicy);
      exactKeys(prepareResult, ['sessionId', 'status', 'expiresAt', 'automaticExpiry', 'operationId', 'batchIndex', 'requestHash', 'designFileId', 'maxUploadBytes', 'uploadPolicy', 'missingAssetSha256', 'frames']);
      if (prepareResult.sessionId !== batch.sessionId || prepareResult.operationId !== operationId || prepareResult.batchIndex !== batch.batchIndex || prepareResult.requestHash !== batch.requestHash || prepareResult.expiresAt !== null || prepareResult.automaticExpiry !== false || prepareResult.status !== 'open') invalid();
      id(prepareResult.designFileId); integer(prepareResult.maxUploadBytes, Number.MAX_SAFE_INTEGER); validateOperationPolicy(prepareResult.uploadPolicy); hashes(prepareResult.missingAssetSha256); if (!Array.isArray(prepareResult.frames)) invalid();
      for (const f of prepareResult.frames) { exactKeys(f, ['figmaNodeId', 'frameId', 'status', 'missingAssetSha256']); id(f.figmaNodeId); id(f.frameId); if (!frameStates.includes(f.status)) invalid(); hashes(f.missingAssetSha256, false); }
      if (batch.status === 'committed') validateCommitResult(commitResult, batch.sessionId); else if (commitResult !== undefined) invalid();
    }
    for (const f of value.committedFrames) { exactKeys(f, ['figmaNodeId', 'frameId', 'revisionId', 'previousRevisionId', 'status'], ['figmaNodeId', 'frameId', 'revisionId', 'status']); id(f.figmaNodeId); id(f.frameId); id(f.revisionId); if (f.previousRevisionId != null) id(f.previousRevisionId); if (!['new', 'changed', 'metadata-only', 'unchanged', 'committed'].includes(f.status)) invalid(); }
    return value;
  };
  const setToken = value => { if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(value))) fail('BAD_SCHEMA'); if (token !== value) writers.clear(); token = value; };
  // The read ceiling is private to these call sites; caller context cannot raise
  // ordinary responseLimit or opt a write into the larger verification budget.
  const call = async (path, method, payload, { signal, authenticated = true, mime = null, strictLength = false, operationAsset = false } = {}, verificationLimit = null) => {
    checkCancelled(signal); if (active) fail('BUSY'); if (authenticated && !token) throw new ProductionError('HTTP_FAILED', { status: 401 });
    const body = payload === undefined ? undefined : payload instanceof Uint8Array ? payload : jsonBytes(payload);
    if (body && body.byteLength > PRODUCTION_BODY_LIMIT + (operationAsset ? 36 : 0)) fail('HTTP_BODY_TOO_LARGE');
    const url = sameProductionServiceURL(path, trusted, { allowLocalhost }); const headers = {};
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = mime ? 'application/octet-stream' : 'application/json'; if (mime) headers['X-Asset-Mime'] = mime;
    const controller = cancellationController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response; let reader; let bodyDone = false; let bodySettled = false; let requestError; let dispatched = false; active = true;
    try {
      checkCancelled(signal); dispatched = true;
      response = await fetchAPI(url, { method, headers, ...(body ? { body } : {}), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (response.redirected || response.url && new URL(response.url).origin !== trusted) invalid();
      if (!response.body?.getReader) invalid(); reader = response.body.getReader();
      // A rejected cancel is only releasable if the stream independently closed
      // or errored. Otherwise keep this client's physical slot blocked.
      reader.closed?.then(() => { bodySettled = true; }, () => { bodySettled = true; });
      if (verificationLimit !== null) checkCancelled(controller.signal);
      const limit = response.ok && verificationLimit !== null ? verificationLimit : responseLimit;
      const length = response.headers.get('content-length'), declared = length === null ? null : Number(length);
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(declared))) invalid();
      if (declared !== null && declared > limit) fail('HTTP_BODY_TOO_LARGE');
      if (response.ok && strictLength && (declared === null || declared < 1)) invalid();
      const matchLength = strictLength || verificationLimit !== null;
      const chunks = []; let size = 0;
      while (true) {
        const part = await reader.read(); if (part.done) bodyDone = true;
        if (verificationLimit !== null) checkCancelled(controller.signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) fail('HTTP_BODY_TOO_LARGE');
        if (matchLength && declared !== null && size > declared) invalid();
        chunks.push(part.value);
      }
      if (!response.ok) {
        if (response.status === 401) { token = null; writers.clear(); }
        if ((response.status === 403 || response.status === 409) && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json' && (declared === null || size === declared)) {
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          try {
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), code = record(body?.error) ? body.error.code : null;
            if (response.status === 403 && code === 'designer_expired') { token = null; writers.clear(); throw new ProductionError('DESIGNER_EXPIRED', { status: response.status, dispatched }); }
            if (response.status === 409 && code === 'project_quota_exceeded') throw new ProductionError('PROJECT_QUOTA_EXCEEDED', { status: response.status, dispatched });
          } catch (error) { if (error instanceof ProductionError) throw error; }
        }
        throw new ProductionError('HTTP_FAILED', { status: response.status, dispatched });
      }
      if (matchLength && declared !== null && size !== declared) invalid();
      // Only ordinary acknowledgements (especially commit) win late cancellation.
      // Verification reads must remain uncancelled through the last snapshot.
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') invalid();
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); } return value;
    } catch (error) {
      requestError = error instanceof ProductionError ? error : new ProductionError(timedOut ? 'REQUEST_TIMEOUT' : signal?.aborted ? 'CANCELLED' : error?.code || 'HTTP_FAILED', { status: response?.status || null, dispatched });
      throw requestError;
    } finally {
      // Await stream cancellation too; physical settlement, not AbortSignal, releases the slot.
      // cancel() can close a ReadableStream before its underlying cancellation
      // rejects. Only closure observed BEFORE cancel is independent evidence.
      let settled = bodyDone || bodySettled;
      try {
        if (reader) {
          try { if (!bodyDone) await reader.cancel(); settled = true; }
          finally { reader.releaseLock(); }
        } else { if (response?.body && !bodyDone) await response.body.cancel(); settled = true; }
      } catch {
        // Cancellation rejection without independent closure cannot establish that
        // underlying work stopped. Keep the bridge RPC pending rather than emit
        // a false physicalDone acknowledgment; require host teardown to recover.
        if (!settled) {
          clearTimeout(timer); signal?.removeEventListener('abort', abort); active = true;
          await new Promise(() => {});
        }
        throw requestError || new ProductionError('HTTP_FAILED', { status: response?.status || null, dispatched });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active = !settled; }
    }
  };
  const sessionPath = sid => `/api/publish/sessions/${encodeURIComponent(id(sid))}`;
  return {
    origin: trusted, setToken, clearToken() { token = null; writers.clear(); }, status: () => ({ active, authenticated: token !== null }),
    async login({ username, password, rememberLogin = false }, context = {}) {
      text(username, 256); if (typeof password !== 'string' || !password.length || password.length > 4096 || typeof rememberLogin !== 'boolean') fail('BAD_SCHEMA');
      token = null; writers.clear(); const result = await call('/api/auth/login', 'POST', { username, password, ...(rememberLogin ? { rememberLogin: true } : {}) }, { ...context, authenticated: false });
      exactKeys(result, ['token', 'user', 'refreshToken', 'refreshExpiresAt'], ['token', 'user']); if (!record(result.user)) invalid();
      if (result.refreshToken !== undefined) text(result.refreshToken, 8192); if (result.refreshExpiresAt !== undefined) rememberExpiry(result.refreshExpiresAt); setToken(result.token); return result;
    },
    async refresh(refreshToken, context = {}) {
      text(refreshToken, 8192); token = null; writers.clear();
      const value = await call('/api/auth/refresh', 'POST', { refreshToken }, { ...context, authenticated: false });
      exactKeys(value, ['token', 'user', 'refreshExpiresAt']); if (!record(value.user)) invalid(); rememberExpiry(value.refreshExpiresAt); setToken(value.token); return value;
    },
    async rememberedLogout(refreshToken, context = {}) {
      text(refreshToken, 8192); const value = await call('/api/auth/remembered-logout', 'POST', { refreshToken }, { ...context, authenticated: false }); token = null; writers.clear(); return value;
    },
    async me(context) { const value = await call('/api/auth/me', 'GET', undefined, context); exactKeys(value, ['id', 'username', 'role']); id(value.id); text(value.username, 256); text(value.role, 64); return value; },
    async accountSelf(context) { return validateAccountSelf(await call('/api/account/self', 'GET', undefined, context)); },
    async projects(context) { return validateProjects(await call('/api/projects', 'GET', undefined, context)); },
    async frameGroups(projectId, context) {
      id(projectId); const response = await call(`/api/projects/${encodeURIComponent(projectId)}/groups`, 'GET', undefined, context);
      exactKeys(response, ['groups']); if (!Array.isArray(response.groups) || response.groups.length > 1000) invalid();
      const seen = new Set();
      for (const group of response.groups) {
        exactKeys(group, ['id', 'projectId', 'name', 'createdAt', 'frameCount'], ['id', 'projectId', 'name']);
        id(group.id); id(group.projectId); if (group.projectId !== projectId) invalid();
        text(group.name, 128); if (group.createdAt !== undefined) expiry(group.createdAt);
        if (group.frameCount !== undefined && (!Number.isSafeInteger(group.frameCount) || group.frameCount < 0)) invalid();
        if (seen.has(group.id)) invalid(); seen.add(group.id);
      }
      return response.groups;
    },
    async createFrameGroup(projectId, name, context) {
      id(projectId);
      if (typeof name !== 'string' || !name.trim() || name.trim() !== name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) fail('BAD_SCHEMA');
      const response = await call(`/api/projects/${encodeURIComponent(projectId)}/groups`, 'POST', { name }, context); exactKeys(response, ['group']);
      const group = response.group; if (!record(group) || group.name !== name || group.projectId !== projectId) invalid(); id(group.id);
      return group;
    },
    async createProject(name, context) {
      if (typeof name !== 'string' || !name.trim() || name.trim() !== name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) fail('BAD_SCHEMA');
      const value = await call('/api/projects', 'POST', { name }, context);
      if (!record(value) || typeof value.name !== 'string' || value.name !== name) invalid(); id(value.id);
      return value;
    },
    async intent(projectId, context) { const value = await call(`/api/publish/intent?projectId=${encodeURIComponent(id(projectId))}`, 'GET', undefined, context); exactKeys(value, ['operationId', 'projectId']); if (value.projectId !== projectId || typeof value.operationId !== 'string' || !/^op_[a-f0-9]{32}_[a-f0-9]{64}$/.test(value.operationId)) invalid(); return value; },
    async recoverCancel(operationId, projectId, context) { id(projectId); const value = safeOperation(await call(`${operationPath(operationId)}/recover-cancel`, 'POST', { projectId }, context), operationId); if (value.projectId !== projectId || value.status !== 'cancelled') invalid(); return value; },
    async claim(input, context) {
      if (writers.has(input.operationId) || typeof cryptoAPI?.getRandomValues !== 'function') fail('BAD_SCHEMA');
      const bytes = new Uint8Array(32); cryptoAPI.getRandomValues(bytes);
      const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      writers.set(input.operationId, { bytes, secret });
      return safeOperation(await call('/api/publish/operations', 'POST', { ...input, writerSecret: secret }, context), input.operationId);
    },
    async queryOperation(operationId, context) { return safeOperation(await call(operationPath(operationId), 'GET', undefined, context, PRODUCTION_VERIFICATION_LIMITS.snapshot), operationId); },
    async operationReceipt(operationId, context) {
      const value = await call(`${operationPath(operationId)}/receipt`, 'GET', undefined, context);
      exactKeys(value, ['operationId', 'projectId', 'status', 'terminal', 'projectDeleted']);
      if (value.operationId !== operationId || !['open','partial','completed','cancelled'].includes(value.status) || value.terminal !== ['completed','cancelled'].includes(value.status) || typeof value.projectDeleted !== 'boolean' || value.projectDeleted && !value.terminal) invalid();
      id(value.projectId); return value;
    },
    async finish(operationId, catalogReadVersion, context) { if (typeof catalogReadVersion !== 'string' || !/^[a-f0-9]{32}:[0-9]+$/.test(catalogReadVersion)) fail('BAD_SCHEMA'); const value = safeOperation(await call(`${operationPath(operationId)}/finish`, 'POST', { writerSecret: writer(operationId).secret, catalogReadVersion }, context), operationId); if (value.status === 'completed') writers.delete(operationId); return value; },
    async cancelOperation(operationId, context) { const value = safeOperation(await call(`${operationPath(operationId)}/cancel`, 'POST', { writerSecret: writer(operationId).secret }, context), operationId); if (value.status === 'cancelled') writers.delete(operationId); return value; },
    async publishSource(projectId, body, operationId, context) {
      validatePublishSourceBody(body);
      const value = safeWriterDTO(await call(`/api/projects/${encodeURIComponent(id(projectId))}/publish-source`, 'POST', { ...body, operationId, writerSecret: writer(operationId).secret }, context));
      exactKeys(value, ['projectId', 'designFileId', 'source', 'baseRevisions', 'coordinateMode'], ['projectId', 'designFileId', 'source', 'baseRevisions']); id(value.designFileId);
      if (body.coordinates ? value.coordinateMode !== 'project-xy' : value.coordinateMode !== undefined) invalid();
      if (value.projectId !== projectId || !sameSource(value.source, body.source) || !record(value.baseRevisions) || Object.keys(value.baseRevisions).length !== body.frameIds.length) invalid();
      for (const fid of body.frameIds) { if (!Object.hasOwn(value.baseRevisions, fid)) invalid(); if (value.baseRevisions[fid] !== null) id(value.baseRevisions[fid]); } return value;
    },
    // Validation of prepare results belongs to the coordinator, after sid journaling.
    async prepare(body, operationId, batchIndex, context) { validatePrepareBody(body); const value = validatePrepareResult(safeWriterDTO(await call('/api/publish/sessions', 'POST', { ...body, operationId, batchIndex, writerSecret: writer(operationId).secret }, context)), body, () => {}, operationId, batchIndex); validateOperationPolicy(value.uploadPolicy); return value; },
    async upload(sid, asset, operationId, context) {
      if (operationId === undefined || record(operationId)) { context = operationId; operationId = null; }
      exactKeys(asset, ['sha256', 'bytes', 'mime', 'data']); digestString(asset.sha256); integer(asset.bytes, PRODUCTION_BODY_LIMIT);
      if (!['application/json', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(asset.mime) || !(asset.data instanceof Uint8Array) || asset.data.byteLength !== asset.bytes || await sha256(asset.data, cryptoAPI, context?.signal) !== asset.sha256) fail('BAD_BYTES');
      let payload = asset.data;
      if (operationId !== null) { payload = new Uint8Array(asset.bytes + 36); payload.set([71, 76, 80, 49]); payload.set(writer(operationId).bytes, 4); payload.set(asset.data, 36); }
      const value = await call(`${sessionPath(sid)}/assets/${asset.sha256}`, 'PUT', payload, { ...context, mime: asset.mime, operationAsset: operationId !== null });
      exactKeys(value, ['ok', 'sha256', 'bytes', 'mime']); if (value.ok !== true || value.sha256 !== asset.sha256 || value.bytes !== asset.bytes || value.mime !== asset.mime) invalid(); return value;
    },
    async commit(sid, operationId, context) { return validateCommitResult(safeWriterDTO(await call(`${sessionPath(sid)}/commit`, 'POST', { writerSecret: writer(operationId).secret }, context)), sid); },
    async query(sid, context) { return validateSessionResult(safeWriterDTO(await call(sessionPath(sid), 'GET', undefined, context)), sid); },
    async queryCommitResult(sid, context) { return validateCommitResult(safeWriterDTO(await call(`${sessionPath(sid)}/result`, 'GET', undefined, context)), sid); },
    async abort(sid, operationId, context) { const value = safeWriterDTO(await call(`${sessionPath(sid)}/abort`, 'POST', { writerSecret: writer(operationId).secret }, context)); if (!record(value) || value.sessionId !== sid || !['open', ...terminalStates].includes(value.status)) invalid(); return value; },
    async verifyPublication(projectId, groupId, frames, context) {
      validateVisibilityRequest(projectId, groupId, frames);
      // Read precisely the same project canvas and inspector directory as the user;
      // neither an HTTP 200 nor a commit response alone is treated as visibility.
      const canvas = await call(`/api/projects/${encodeURIComponent(projectId)}/canvas`, 'GET', undefined, context, PRODUCTION_VERIFICATION_LIMITS.canvas);
      const directory = await call(`/api/inspector/projects/${encodeURIComponent(projectId)}/directory`, 'GET', undefined, { ...context, strictLength: true }, PRODUCTION_VERIFICATION_LIMITS.directory);
      const receipt = verifyPublicationVisibility(projectId, groupId, frames, canvas, directory);
      const directoryById = new Map(directory.frames.map(row => [row.frameId, row]));
      for (const target of frames) {
        const fid = encodeURIComponent(target.frameId), rid = encodeURIComponent(target.revisionId);
        const revisions = await call(`/api/frames/${fid}/revisions`, 'GET', undefined, { ...context, strictLength: true }, PRODUCTION_VERIFICATION_LIMITS.revisions);
        const snapshot = await call(`/api/inspector/frames/${fid}/revisions/${rid}`, 'GET', undefined, { ...context, strictLength: true }, PRODUCTION_VERIFICATION_LIMITS.snapshot);
        verifyPublicationSnapshot(projectId, groupId, target, canvas.catalogReadVersion, revisions, snapshot, directoryById.get(target.frameId));
      }
      checkCancelled(context?.signal);
      return { ...receipt, catalogReadVersion: canvas.catalogReadVersion };
    }
  };
}
