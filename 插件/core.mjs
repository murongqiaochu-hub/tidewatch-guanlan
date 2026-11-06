// Independent Inspector — new author expression; ownership terms pending.
export const SOURCE_LIMIT = 64 * 1024 * 1024;
export const CONTRACT_VERSION = 1;
export class InspectorError extends Error {
  constructor(code) { super(code); this.name = 'InspectorError'; this.code = code; }
}
export function fail(code) { throw new InspectorError(code); }
export function checkCancelled(signal) { if (signal?.aborted) fail('CANCELLED'); }
export function cancellationController() {
  if (typeof AbortController !== 'undefined') return new AbortController();
  // SDK sandbox fallback only. Network fetch always uses the iframe's native controller.
  const listeners = new Map();
  const signal = {
    aborted: false,
    addEventListener(type, listener, options) { if (type === 'abort') listeners.set(listener, Boolean(options?.once)); },
    removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener); }
  };
  return { signal, abort() { if (signal.aborted) return; signal.aborted = true; for (const [listener, once] of [...listeners]) { if (once) listeners.delete(listener); listener({ type: 'abort', target: signal }); } } };
}
export function safeError(error) {
  const known = new Set(['CANCELLED', 'BUDGET_EXCEEDED', 'BAD_SCHEMA', 'BAD_ORIGIN', 'BAD_URL', 'BAD_ID', 'BAD_FORMAT', 'BAD_BYTES', 'BAD_DIMENSIONS', 'SDK_DIMENSION_MISMATCH', 'SDK_EXPORT_FAILED', 'SDK_READ_FAILED', 'SDK_CAPABILITY_MISSING', 'NO_FRAMES', 'DUPLICATE_FRAME', 'QUEUE_FULL', 'BUSY', 'UNKNOWN_COMMIT', 'UNKNOWN_PREPARE', 'VISIBILITY_UNCONFIRMED', 'DESIGNER_EXPIRED', 'PROJECT_QUOTA_EXCEEDED', 'HTTP_FAILED', 'HTTP_BODY_TOO_LARGE', 'HTTP_RESPONSE_INVALID', 'CONFLICT', 'CLOSED', 'REQUEST_TIMEOUT', 'DIGEST_UNAVAILABLE', 'DOCUMENT_CHANGED', 'UNSUPPORTED_DEPTH']);
  return { code: known.has(error?.code) ? error.code : 'OPERATION_FAILED' };
}
export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9:;_-]{1,160}$/.test(value)) fail('BAD_ID'); return value; }
export function exactKeys(value, keys, required = keys) {
  if (!record(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('BAD_SCHEMA');
  return value;
}
export function number(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('BAD_SCHEMA'); return value; }
export function utf8(value) {
  if (typeof value !== 'string') fail('BAD_SCHEMA');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  // Figma's main JS sandbox has no DOM TextEncoder. Unicode scalar UTF-8 only;
  // hashing remains WebCrypto in the browser iframe, never a homemade hash.
  const bytes = [];
  for (const character of value) {
    let code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
    else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
  }
  return new Uint8Array(bytes);
}
export function jsonBytes(value) {
  try { return utf8(JSON.stringify(value)); } catch { fail('BAD_SCHEMA'); }
}
export async function sha256(bytes, cryptoAPI = globalThis.crypto, signal) {
  checkCancelled(signal);
  if (!(bytes instanceof Uint8Array)) fail('BAD_BYTES');
  if (!cryptoAPI?.subtle?.digest) fail('DIGEST_UNAVAILABLE');
  const digest = new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', bytes));
  checkCancelled(signal);
  return Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
}
export function digestString(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('BAD_SCHEMA'); return value; }
export class TaskBudget {
  constructor(limit = SOURCE_LIMIT) { number(limit, 1, SOURCE_LIMIT); this.limit = limit; this.used = 0; this.entries = new Map(); }
  set(key, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('BAD_SCHEMA');
    const total = this.used - (this.entries.get(key) || 0) + bytes;
    if (total > this.limit) fail('BUDGET_EXCEEDED');
    this.entries.set(key, bytes); this.used = total; return bytes;
  }
  add(key, bytes) { return this.set(key, (this.entries.get(key) || 0) + bytes); }
  release(key) { this.used -= this.entries.get(key) || 0; this.entries.delete(key); }
  snapshot() { return { limit: this.limit, used: this.used }; }
}
// A slot is released only after the actual worker settles, including after abort.
export function createSerialQueue({ capacity = 8 } = {}) {
  number(capacity, 1, 1024);
  let tail = Promise.resolve(); let count = 0; let active = 0; let closed = false;
  return {
    run(worker, { signal } = {}) {
      if (closed) return Promise.reject(new InspectorError('CLOSED'));
      if (count >= capacity) return Promise.reject(new InspectorError('QUEUE_FULL'));
      count++;
      const task = tail.then(async () => {
        checkCancelled(signal); active++;
        try { return await worker(); } finally { active--; }
      });
      tail = task.catch(() => {}).finally(() => { count--; });
      return task;
    },
    close() { closed = true; },
    drain() { return tail; },
    snapshot() { return { pending: count, active, capacity, closed }; }
  };
}
export function safeFileName(name, nodeId, extension) {
  if (!/^(png|jpg|svg|pdf|json)$/.test(extension)) fail('BAD_FORMAT');
  id(nodeId);
  let stem = String(name ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[.\s]+$/g, '').replace(/^\.+/g, '').trim();
  if (!stem || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = 'frame';
  // Lossless ASCII-ID base64url prevents colon/underscore/instance-semicolon collisions.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let suffix = '';
  for (let i = 0; i < nodeId.length; i += 3) {
    const a = nodeId.charCodeAt(i), b = nodeId.charCodeAt(i + 1) || 0, c = nodeId.charCodeAt(i + 2) || 0;
    suffix += alphabet[a >> 2] + alphabet[(a & 3) << 4 | b >> 4];
    if (i + 1 < nodeId.length) suffix += alphabet[(b & 15) << 2 | c >> 6];
    if (i + 2 < nodeId.length) suffix += alphabet[c & 63];
  }
  const allowance = Math.min(120, 240 - suffix.length - extension.length - 2);
  let safeStem = '';
  for (const character of stem) { if (utf8(safeStem + character).byteLength > allowance) break; safeStem += character; }
  return `${safeStem || 'frame'}-${suffix}.${extension}`;
}
export const FORMATS = Object.freeze({ PNG: { mime: 'image/png', extension: 'png' }, JPG: { mime: 'image/jpeg', extension: 'jpg' }, SVG: { mime: 'image/svg+xml', extension: 'svg' }, PDF: { mime: 'application/pdf', extension: 'pdf' } });
export function targetPixels(width, height, scale = 1) {
  number(width, 0, 1e8); number(height, 0, 1e8); number(scale, 0.001, 64);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (!Number.isSafeInteger(targetWidth * targetHeight)) fail('BAD_DIMENSIONS');
  return { width: targetWidth, height: targetHeight };
}
export function serviceOrigin(value, { allowLocalhost = false } = {}) {
  let url; try { url = new URL(value); } catch { fail('BAD_ORIGIN'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== value.replace(/\/$/, '')) fail('BAD_ORIGIN');
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalhost && localhost && url.protocol === 'http:')) fail('BAD_ORIGIN');
  return url.origin;
}
export function sameServiceURL(value, origin, { allowLocalhost = false } = {}) {
  const trusted = serviceOrigin(origin, { allowLocalhost });
  let url; try { url = new URL(value, `${trusted}/`); } catch { fail('BAD_URL'); }
  if (url.origin !== trusted || url.username || url.password || url.hash || /[\u0000-\u0020\\]/.test(value)) fail('BAD_URL');
  return url.href;
}
export function requestId(cryptoAPI = globalThis.crypto) {
  if (!cryptoAPI?.getRandomValues) fail('DIGEST_UNAVAILABLE');
  const bytes = cryptoAPI.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
