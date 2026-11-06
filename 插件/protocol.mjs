// Shared strict operation schemas for the new main/iframe pair.
import { fail, exactKeys, record, id, number, SOURCE_LIMIT, digestString } from './core.mjs';
import { validateManifest, validateDescriptor, validateIdentity } from './publisher.mjs';
export const CHANNEL = 'independent-inspector-v1';

// Public file-link parsing is deliberately independent of browser/Node URL globals.
// Never infer a global file identity from root/page IDs, names or platform UUIDs.
export function parsePublicFigmaSource(input, inputType) {
  if (typeof input !== 'string' || !input.length || input.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f\\]/.test(input)) fail('BAD_SCHEMA');
  let fileKey;
  if (inputType === 'key') fileKey = input;
  else if (inputType === 'url') {
    const match = /^https:\/\/(?:www\.)?figma\.com\/(?:file|design)\/([A-Za-z0-9]{1,128})(?=$|[/?#])([^]*)$/.exec(input);
    if (!match) fail('BAD_SCHEMA');
    // Decode only to reject malformed encoding and encoded controls; never decode the key.
    let tail; try { tail = decodeURIComponent(match[2]); } catch { fail('BAD_SCHEMA'); }
    if (/[\u0000-\u001f\u007f-\u009f\\]/.test(tail)) fail('BAD_SCHEMA');
    const pathTail = decodeURIComponent(match[2].split(/[?#]/, 1)[0]);
    if (pathTail.split('/').some(part => part === '.' || part === '..')) fail('BAD_SCHEMA');
    fileKey = match[1];
  } else fail('BAD_SCHEMA');
  if (!/^[A-Za-z0-9]{1,128}$/.test(fileKey)) fail('BAD_SCHEMA');
  return { kind: 'figma-file', fileKey };
}
export function validateSourceBinding(payload) {
  exactKeys(payload, ['projectId', 'inputType', 'input', 'confirmedCurrentFile']); id(payload.projectId);
  if (payload.confirmedCurrentFile !== true) fail('BAD_SCHEMA');
  return parsePublicFigmaSource(payload.input, payload.inputType);
}
export function validateOperation(operation, payload) {
  switch (operation) {
    case 'production-source-binding':
    case 'production-source-recovery': validateSourceBinding(payload); break;
    case 'hello': exactKeys(payload, []); break;
    case 'list': exactKeys(payload, ['scope']); if (!['selection', 'page'].includes(payload.scope)) fail('BAD_SCHEMA'); break;
    case 'resize': exactKeys(payload, ['height']); number(payload.height, 480, 1100); if (!Number.isInteger(payload.height)) fail('BAD_SCHEMA'); break;
    case 'export':
    case 'publish':
      exactKeys(payload, ['scope', 'scale', 'includeSlices', 'chunkCapacity', 'bindings', 'service']);
      if (!['selection', 'page'].includes(payload.scope) || typeof payload.includeSlices !== 'boolean') fail('BAD_SCHEMA');
      number(payload.scale, 0.001, 64); number(payload.chunkCapacity, 1, 64); if (!Number.isInteger(payload.chunkCapacity) || !Array.isArray(payload.bindings)) fail('BAD_SCHEMA');
      for (const binding of payload.bindings) { exactKeys(binding, ['figmaNodeId', 'identity', 'expectedRevisionId']); id(binding.figmaNodeId); validateIdentity(binding.identity); if (binding.identity.figmaNodeId !== binding.figmaNodeId) fail('BAD_SCHEMA'); if (binding.expectedRevisionId !== null) id(binding.expectedRevisionId); }
      if (payload.service !== null) { exactKeys(payload.service, ['origin', 'allowLocalhost']); if (typeof payload.service.origin !== 'string' || payload.service.origin.length > 2048 || typeof payload.service.allowLocalhost !== 'boolean') fail('BAD_SCHEMA'); }
      if (operation === 'publish' && payload.service === null) fail('BAD_ORIGIN');
      break;
    case 'digest': exactKeys(payload, ['bytes']); if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength > SOURCE_LIMIT) fail('BAD_BYTES'); break;
    case 'network':
      exactKeys(payload, ['method', 'service', 'manifest', 'sessionId', 'descriptor', 'bytes', 'wireRequestId']);
      if (!['prepare', 'upload', 'commit', 'query', 'abort'].includes(payload.method)) fail('BAD_SCHEMA');
      exactKeys(payload.service, ['origin', 'allowLocalhost']); if (typeof payload.service.origin !== 'string' || typeof payload.service.allowLocalhost !== 'boolean') fail('BAD_SCHEMA'); id(payload.wireRequestId);
      if (payload.method === 'prepare') { validateManifest(payload.manifest); if (payload.sessionId !== null || payload.descriptor !== null || payload.bytes !== null) fail('BAD_SCHEMA'); }
      else {
        id(payload.sessionId); if (payload.manifest !== null) fail('BAD_SCHEMA');
        if (payload.method === 'upload') { validateDescriptor(payload.descriptor); if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength !== payload.descriptor.byteLength) fail('BAD_BYTES'); }
        else if (payload.descriptor !== null || payload.bytes !== null) fail('BAD_SCHEMA');
      }
      break;
    case 'query':
    case 'abort': exactKeys(payload, []); break;
    case 'frames-changed': exactKeys(payload, []); break;
    case 'notice': exactKeys(payload, ['state']); if (!record(payload.state)) fail('BAD_SCHEMA'); break;
    case 'close': exactKeys(payload, []); break;
    default: fail('BAD_SCHEMA');
  }
}
export function validateOperationResult(operation, result) {
  if (operation === 'digest') { exactKeys(result, ['digest']); if (!(result.digest instanceof Uint8Array) || result.digest.byteLength !== 32) fail('BAD_BYTES'); }
  else if (['production-source-binding', 'production-source-recovery'].includes(operation)) { exactKeys(result, ['state']); if (!record(result.state)) fail('BAD_SCHEMA'); }
  else if (operation === 'resize') { exactKeys(result, ['width', 'height']); if (result.width !== 480) fail('BAD_SCHEMA'); number(result.height, 480, 1100); }
  else if (operation === 'network') { if (!record(result)) fail('HTTP_RESPONSE_INVALID'); }
  else if (['query', 'abort'].includes(operation)) { if (!record(result)) fail('BAD_SCHEMA'); }
  else if (['notice', 'close', 'frames-changed'].includes(operation)) { exactKeys(result, ['accepted']); if (result.accepted !== true) fail('BAD_SCHEMA'); }
  else if (operation === 'hello') { exactKeys(result, ['product', 'height', 'state', 'verification']); if (result.product !== 'Independent Inspector · Development' || result.verification !== 'DEVICE_VALIDATION_PENDING') fail('BAD_SCHEMA'); number(result.height, 480, 1100); if (!record(result.state)) fail('BAD_SCHEMA'); }
  else if (operation === 'list') { exactKeys(result, ['scope', 'pageId', 'frames', 'excluded']); id(result.pageId); if (!Array.isArray(result.frames) || !Array.isArray(result.excluded)) fail('BAD_SCHEMA'); for (const f of result.frames) { id(f.id); if (typeof f.name !== 'string') fail('BAD_SCHEMA'); } }
  else if (operation === 'export') { exactKeys(result, ['manifest', 'assets', 'eligibility', 'verification']); validateManifest(result.manifest); if (result.verification !== 'SDK_BYTES_UNVERIFIED_DEVICE' || !Array.isArray(result.assets)) fail('BAD_SCHEMA'); for (const a of result.assets) { exactKeys(a, ['descriptor', 'bytes']); validateDescriptor(a.descriptor); if (!(a.bytes instanceof Uint8Array) || a.bytes.byteLength !== a.descriptor.byteLength) fail('BAD_BYTES'); } }
  else if (operation === 'publish') { exactKeys(result, ['publication', 'state']); if (!record(result.publication) || !record(result.state)) fail('BAD_SCHEMA'); }
  else fail('BAD_SCHEMA');
}
