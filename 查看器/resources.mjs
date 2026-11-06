import { LIMITS, finite } from './core.mjs';
export const abortError = (message = '已取消') => Object.assign(new Error(message), { name: 'AbortError' });
const timeoutError = message => Object.assign(new Error(message), { name: 'TimeoutError' });
function armTimeout(ms, callback) { if (!(ms > 0 && Number.isFinite(ms))) return null; const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }
const abortReason = signal => signal.reason?.name === 'TimeoutError' ? signal.reason : abortError();
export function safeSameOrigin(input, base) {
  if (typeof input !== 'string' || !input.trim() || input.trim() !== input || /[\u0000-\u001f\u007f]/.test(input)) throw new TypeError('同源资源URL不能为空或包含控制字符');
  const origin = new URL(base), url = new URL(input, origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password) throw new TypeError('资源必须是无内嵌凭据的同源HTTP(S) URL');
  return url.href;
}
export function safeFilename(input, fallback = 'download') {
  const result = String(input ?? fallback).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return Array.from(result).slice(0, 180).join('') || fallback;
}
export class LatestRequest {
  constructor() { this.generation = 0; this.controller = null; }
  begin() {
    this.controller?.abort(); this.controller = new AbortController();
    const generation = ++this.generation;
    return { generation, signal: this.controller.signal, current: () => generation === this.generation && !this.controller.signal.aborted };
  }
  cancel() { this.generation++; this.controller?.abort(); }
}
function resourceClose(value) { try { value?.bitmap?.close?.(); value?.close?.(); } catch { /* cleanup must not change terminal state */ } }
export class ResourceScheduler {
  constructor(limits = {}) {
    this.limits = { ...LIMITS, ...limits }; this.entries = new Map(); this.active = 0; this.pixels = 0; this.encoded = 0; this.generation = 0; this.disposed = false; this.clock = 0; this.peak = { physical: 0, pixels: 0, encoded: 0, native: 0 }; this.onChange = null; this.protectedKeys = new Set();
  }
  get diagnostics() {
    const entries = [...this.entries.values()];
    return { physical: this.active, decodedAndReservedPixels: this.pixels, encodedAndReservedBytes: this.encoded, native: entries.filter(e => e.kind === 'native' && e.reserved).length, queued: entries.filter(e => e.state === 'queued').length, resident: entries.filter(e => e.state === 'resident').length, generation: this.generation, peak: { ...this.peak }, disposed: this.disposed, limits: { ...this.limits } };
  }
  setGeneration(generation) {
    this.generation = generation;
    for (const entry of [...this.entries.values()]) if (entry.generation !== generation) this.cancel(entry.key);
  }
  get(key) { const e = this.entries.get(key); if (e?.state !== 'resident') return null; e.touched = ++this.clock; return e.value; }
  has(key) { return this.entries.has(key); }
  schedule(key, estimate, work, { kind = 'preview', generation = this.generation, timeoutMs = 60000 } = {}) {
    if (this.disposed) return Promise.reject(abortError('调度器已释放'));
    const existing = this.entries.get(key); if (existing) return existing.promise;
    const pixels = estimate.pixels, encoded = estimate.encoded;
    if (![pixels, encoded].every(v => Number.isSafeInteger(v) && v >= 0) || pixels > this.limits.pixels || encoded > this.limits.encoded) return Promise.reject(new RangeError('图像预算无效或单资源超过上限'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { key, pixels, encoded, work, kind, generation, promise, resolve, reject, controller: new AbortController(), state: 'queued', reserved: false, touched: ++this.clock, value: null, timeoutMs };
    this.entries.set(key, entry); this.pump(); return promise;
  }
  notify() { try { this.onChange?.(this.diagnostics); } catch { /* UI observers do not own scheduler state */ } }
  reserve(entry, pixels, encoded) {
    if (![pixels, encoded].every(v => Number.isSafeInteger(v) && v >= 0)) throw new RangeError('资源预留必须为非负安全整数');
    if (pixels > this.limits.pixels || encoded > this.limits.encoded) throw new RangeError('单资源预算超限');
    const dp = pixels - entry.pixels, de = encoded - entry.encoded;
    this.evictUntil(Math.max(0, dp), Math.max(0, de), false);
    if (this.pixels + dp > this.limits.pixels || this.encoded + de > this.limits.encoded) throw new RangeError('资源扩展预留超限');
    this.pixels += dp; this.encoded += de; entry.pixels = pixels; entry.encoded = encoded; this.recordPeak(); this.notify();
  }
  recordPeak() {
    this.peak.physical = Math.max(this.peak.physical, this.active); this.peak.pixels = Math.max(this.peak.pixels, this.pixels); this.peak.encoded = Math.max(this.peak.encoded, this.encoded);
    this.peak.native = Math.max(this.peak.native, [...this.entries.values()].filter(e => e.kind === 'native' && e.reserved).length);
  }
  release(entry) {
    if (!entry.reserved) return;
    this.pixels -= entry.pixels; this.encoded -= entry.encoded; entry.reserved = false;
  }
  evictUntil(pixels, encoded, native) {
    const candidates = [...this.entries.values()].filter(e => e.state === 'resident' && !this.protectedKeys.has(e.key)).sort((a, b) => a.touched - b.touched);
    const nativeCount = () => [...this.entries.values()].filter(e => e.kind === 'native' && e.reserved).length;
    while (candidates.length && (this.pixels + pixels > this.limits.pixels || this.encoded + encoded > this.limits.encoded || native && nativeCount() >= this.limits.native)) {
      const e = candidates.shift(); resourceClose(e.value); this.release(e); this.entries.delete(e.key);
    }
  }
  pump() {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (this.active >= this.limits.physical) break;
      if (entry.state !== 'queued') continue;
      if (entry.generation !== this.generation) { this.cancel(entry.key); continue; }
      this.evictUntil(entry.pixels, entry.encoded, entry.kind === 'native');
      const native = [...this.entries.values()].filter(e => e.kind === 'native' && e.reserved).length;
      if (this.pixels + entry.pixels > this.limits.pixels || this.encoded + entry.encoded > this.limits.encoded || entry.kind === 'native' && native >= this.limits.native) continue;
      entry.state = 'running'; entry.reserved = true; this.pixels += entry.pixels; this.encoded += entry.encoded; this.active++; this.recordPeak(); this.notify();
      const timer = armTimeout(entry.timeoutMs, () => entry.controller.abort(timeoutError('图像总等待超时；等待资源实际结束')));
      // Abort is a request, not physical termination. Both slots and reservations
      // remain owned until the actual work promise settles, even for stale work.
      Promise.resolve().then(() => entry.work({ signal: entry.controller.signal, reserve: (p, b) => this.reserve(entry, p, b), current: () => !this.disposed && !entry.controller.signal.aborted && entry.generation === this.generation })).then(value => {
        if (entry.controller.signal.aborted || entry.generation !== this.generation || this.disposed) { resourceClose(value); entry.reject(entry.controller.signal.reason?.name === 'TimeoutError' ? entry.controller.signal.reason : abortError()); entry.state = 'cancelled'; }
        else { entry.value = value; entry.state = 'resident'; entry.touched = ++this.clock; entry.resolve(value); }
      }, error => { entry.state = entry.controller.signal.aborted ? 'cancelled' : 'error'; entry.reject(entry.controller.signal.aborted ? entry.controller.signal.reason?.name === 'TimeoutError' ? entry.controller.signal.reason : abortError() : error); }).finally(() => {
        clearTimeout(timer); this.active--; if (entry.state !== 'resident') { this.release(entry); if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key); }
        this.notify(); this.pump();
      });
    }
  }
  cancel(key) {
    const entry = this.entries.get(key); if (!entry) return false;
    if (entry.state === 'queued') { entry.state = 'cancelled'; entry.controller.abort(); this.entries.delete(key); entry.reject(abortError()); }
    else if (entry.state === 'running' || entry.state === 'aborting') { entry.state = 'aborting'; entry.controller.abort(); }
    else if (entry.state === 'resident') { resourceClose(entry.value); this.release(entry); this.entries.delete(key); }
    this.notify(); return true;
  }
  protectKeys(keys) { this.protectedKeys = new Set(keys); }
  retainKeys(keys) { const keep = new Set(keys); this.protectedKeys = new Set([...this.protectedKeys].filter(key => keep.has(key))); for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.cancel(key); this.pump(); }
  dispose() { this.disposed = true; for (const key of [...this.entries.keys()]) this.cancel(key); this.notify(); }
}
export function imageEstimate(width, height, byteLength) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || !Number.isSafeInteger(byteLength) || byteLength <= 0) throw new TypeError('图像必须有真实整数尺寸与编码长度');
  // Include transfer chunks + Blob assembly headroom, before any GET/decode.
  const encoded = byteLength * 2 + 65536, pixels = width * height;
  if (!Number.isSafeInteger(encoded) || !Number.isSafeInteger(pixels)) throw new RangeError('图像尺寸/字节长度溢出');
  return { pixels, encoded };
}
// Read only a bounded raster header before asking the browser to allocate pixels.
// Unrecognized/truncated headers fail closed; the original bytes are not modified.
export function rasterDimensions(bytes, mime) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = (at, length) => String.fromCharCode(...b.subarray(at, at + length));
  let width, height;
  if (mime === 'image/png' && b.length >= 24 && [137,80,78,71,13,10,26,10].every((n, i) => b[i] === n) && text(12, 4) === 'IHDR') { width = view.getUint32(16); height = view.getUint32(20); }
  else if (mime === 'image/gif' && b.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) { width = view.getUint16(6, true); height = view.getUint16(8, true); }
  else if (mime === 'image/jpeg' && b.length >= 4 && b[0] === 255 && b[1] === 216) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at++] !== 255) break;
      while (b[at] === 255) at++;
      const marker = b[at++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (at + 2 > b.length) break; const length = view.getUint16(at);
      if (length < 2 || at + length > b.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && length >= 8) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break; }
      at += length;
    }
  } else if (mime === 'image/webp' && b.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') { width = 1 + b[24] + (b[25] << 8) + (b[26] << 16); height = 1 + b[27] + (b[28] << 8) + (b[29] << 16); }
    else if (kind === 'VP8L' && b[20] === 47) { width = 1 + b[21] + ((b[22] & 63) << 8); height = 1 + (b[22] >> 6) + (b[23] << 2) + ((b[24] & 15) << 10); }
    else if (kind === 'VP8 ' && b[23] === 157 && b[24] === 1 && b[25] === 42) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new TypeError('无法从有限64KiB原字节头验证图像尺寸，未解码');
  return { width, height };
}
export async function decodeDescriptor(descriptor, { signal: parentSignal, reserve, current }, { baseURL, fetchImpl = globalThis.fetch?.bind(globalThis), decode = globalThis.createImageBitmap?.bind(globalThis), idleTimeoutMs = 15000, totalTimeoutMs = 60000 } = {}) {
  const controller = new AbortController(), signal = controller.signal;
  const forwardAbort = () => controller.abort(parentSignal.reason); parentSignal.addEventListener('abort', forwardAbort, { once: true });
  if (parentSignal.aborted) forwardAbort();
  let response, reader, cancellation = null, idleTimer = null;
  const cancelReader = () => { if (reader && !cancellation) cancellation = Promise.resolve().then(() => reader.cancel(signal.reason)).catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = armTimeout(idleTimeoutMs, () => controller.abort(timeoutError('图像读取空闲超时；等待流实际结束'))); };
  const totalTimer = armTimeout(totalTimeoutMs, () => controller.abort(timeoutError('图像总等待超时；等待解码实际结束')));
  const check = () => { if (signal.aborted || !current()) throw abortReason(signal); };
  try {
    check(); const url = safeSameOrigin(descriptor.url, baseURL), mime = String(descriptor.mime ?? '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw new TypeError('预览只解码受支持的同源栅格格式');
    const estimate = imageEstimate(descriptor.width, descriptor.height, descriptor.byteLength); reserve(estimate.pixels, estimate.encoded); check(); resetIdle();
    response = await fetchImpl(url, { method: 'GET', signal, credentials: 'same-origin', redirect: 'error', cache: 'default' }); check(); resetIdle();
    if (!response.ok || response.type === 'opaque') throw new Error(`图像请求失败：${response.status}`);
    if (response.url) safeSameOrigin(response.url, baseURL);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime) throw new TypeError('图像MIME与资源声明不符');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== descriptor.byteLength)) throw new TypeError('图像长度与资源声明不符');
    if (!response.body?.getReader) throw new TypeError('宿主需支持有界流式图像读取');
    const chunks = []; reader = response.body.getReader(); let received = 0;
    while (true) {
      check(); const { value, done } = await reader.read(); check(); resetIdle(); if (done) break;
      received += value.byteLength; if (received > descriptor.byteLength) throw new RangeError('图像流超出预留长度'); chunks.push(value);
    }
    clearTimeout(idleTimer);
    if (received !== descriptor.byteLength) throw new TypeError('图像流长度不足'); check();
    if (typeof decode !== 'function') throw new TypeError('此浏览器不支持createImageBitmap；未回退为巨大PNG解码');
    const blob = new Blob(chunks, { type: mime }), dimensions = rasterDimensions(new Uint8Array(await blob.slice(0, 65536).arrayBuffer()), mime);
    if (dimensions.width !== descriptor.width || dimensions.height !== descriptor.height) throw new TypeError('原字节头尺寸与资源声明不符，未解码'); check();
    const bitmap = await decode(blob, { imageOrientation: 'none' });
    if (bitmap.width !== descriptor.width || bitmap.height !== descriptor.height) { bitmap.close?.(); throw new TypeError('实际解码尺寸与资源声明不符'); }
    if (signal.aborted || !current()) { bitmap.close?.(); throw abortReason(signal); }
    reserve(estimate.pixels, 0); return { bitmap, width: bitmap.width, height: bitmap.height, descriptor };
  } catch (error) {
    if (reader) { cancelReader(); await cancellation; }
    else if (response?.body?.cancel) { try { await response.body.cancel(); } catch { /* settled body */ } }
    throw signal.aborted ? abortReason(signal) : error;
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer); parentSignal.removeEventListener('abort', forwardAbort); signal.removeEventListener('abort', cancelReader);
    try { reader?.releaseLock?.(); } catch { /* stream already released */ }
  }
}
export class NativeDownload {
  constructor({ getDescriptor, baseURL, fetchImpl = globalThis.fetch?.bind(globalThis), handoff, onChange = null, timeoutMs = 30000 }) {
    this.timeoutMs = timeoutMs; this.getDescriptor = getDescriptor; this.baseURL = baseURL; this.fetchImpl = fetchImpl; this.handoff = handoff; this.onChange = onChange; this.state = 'idle'; this.message = '下载交给浏览器，保存结果不可由本页面确认'; this.generation = 0; this.controller = null; this.last = null;
  }
  get diagnostics() { return { state: this.state, message: this.message, frameId: this.last?.frameId ?? null, revisionId: this.last?.revisionId ?? null, headRequests: this.headRequests ?? 0, getRequests: 0, handoffs: this.handoffs ?? 0 }; }
  change(state, message) { this.state = state; this.message = message; try { this.onChange?.(this.diagnostics); } catch { /* render cannot mutate terminal guarantees */ } }
  async start(request) {
    if (['preparing', 'checking', 'cancelling', 'notSavedYet', 'unknown'].includes(this.state)) return false;
    this.last = { ...request }; const generation = ++this.generation, controller = this.controller = new AbortController();
    const current = () => generation === this.generation && !controller.signal.aborted;
    this.change('preparing', '准备当前画板 / 当前版本的原格式下载…');
    const timer = armTimeout(this.timeoutMs, () => { controller.abort(timeoutError('下载准备/HEAD超时')); this.change('cancelling', '准备/HEAD超时，等待物理结束；未猜测保存结果。'); });
    let enteredHandoff = false, response = null;
    try {
      const descriptor = await this.getDescriptor({ ...request, signal: controller.signal });
      if (!current()) throw abortError();
      if (descriptor.frameId != null && String(descriptor.frameId) !== String(request.frameId) || descriptor.revisionId != null && String(descriptor.revisionId) !== String(request.revisionId)) throw new TypeError('下载资源不属于当前画板/版本');
      const url = safeSameOrigin(descriptor.url, this.baseURL), expected = descriptor.mime?.split(';')[0].toLowerCase();
      const allowed = request.kind === 'zip' ? ['application/zip', 'application/x-zip-compressed'] : ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'application/pdf'];
      if (expected && !allowed.includes(expected)) throw new TypeError('下载声明格式不受支持');
      this.change('checking', '验证同源授权、文件格式和完整长度（HEAD）…');
      if (!current()) throw abortError();
      this.headRequests = (this.headRequests ?? 0) + 1;
      response = await this.fetchImpl(url, { method: 'HEAD', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
      // A conforming HEAD has no body. If an adapter returns one, settle its cancellation before unlocking.
      if (response.body?.cancel) await response.body.cancel();
      if (!current()) throw abortReason(controller.signal);
      if (!response.ok || response.type === 'opaque') throw new Error(`下载授权验证失败：${response.status}`);
      if (response.url) safeSameOrigin(response.url, this.baseURL);
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!allowed.includes(mime) || expected && expected !== mime) throw new TypeError('下载MIME不匹配');
      const rawLength = response.headers.get('content-length');
      if (!rawLength || !/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) <= 0) throw new TypeError('下载缺少可信完整长度，未发起GET');
      if (descriptor.byteLength != null && Number(rawLength) !== descriptor.byteLength) throw new TypeError('下载长度与资源声明不符');
      if (!current()) throw abortError();
      // No await, GET, arrayBuffer, Blob or second preparation between HEAD and anchor.
      enteredHandoff = true;
      this.handoff({ url, filename: safeFilename(descriptor.filename, request.kind === 'zip' ? 'slices.zip' : 'slice'), mime, byteLength: Number(rawLength) });
      this.handoffs = (this.handoffs ?? 0) + 1;
      this.change('notSavedYet', '已交给浏览器；尚不能确认文件已保存。请查看浏览器下载列表。');
      return true;
    } catch (error) {
      if (enteredHandoff) this.change('unknown', '下载接管结果未知；已锁定，不能自动重试。请先检查浏览器下载列表。');
      else if (controller.signal.reason?.name === 'TimeoutError') this.change('error', '下载准备/HEAD超时，资源已实际结束；未交给浏览器。');
      else if (controller.signal.aborted || error.name === 'AbortError') this.change('cancelled', '已取消准备；未交给浏览器下载。');
      else this.change('error', error.message || '下载验证失败');
      return false;
    } finally { clearTimeout(timer); }
  }
  cancel() {
    if (!['preparing', 'checking'].includes(this.state)) return false;
    this.controller?.abort(); this.change('cancelling', '已请求取消，等待准备/HEAD物理结束；未交给浏览器下载。'); return true;
  }
  acknowledgeBrowserChecked() {
    if (!['unknown', 'notSavedYet'].includes(this.state)) return false;
    this.change('idle', '用户已检查浏览器下载列表；若需要，可主动重新下载。'); return true;
  }
  dispose() { this.cancel(); this.onChange = null; }
}
