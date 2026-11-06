// Independently authored streaming primitives. Only Node built-ins; no vendor implementation.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';

export const MiB = 1024 * 1024;
export const MAX_RAW = 64 * MiB;
export const MAX_JSON = 32 * MiB;
export const MAX_PIXELS = 64_000_000;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const newId = () => randomBytes(18).toString('base64url');
export const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function problem(status, code) { const e = new Error(code); e.status = status; e.httpStatus = status; e.code = code; return e; }
export function demand(test, status = 400, code = 'invalid_request') { if (!test) throw problem(status, code); }
export function cancelled(signal) { if (signal?.aborted) throw problem(499, 'request_closed'); }
export const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
export const validNodeId = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x20\x7f]/.test(v);
export const validHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function checkQuery(query,allowed=[]){if(!query)return;const seen=new Set();for(const [key] of query){demand(allowed.includes(key) && !seen.has(key),400,'invalid_query');seen.add(key);}}

// An acquired lane is released by its caller only AFTER the underlying IO/worker closes.
export function createBudget(activeLimit, queuedLimit = 16, {busyCode='transfer_busy'} = {}) {
  let active = 0, peak = 0, closed = false; const queue = [], idle = [];
  function wake() { if (!active && !queue.length) for (const done of idle.splice(0)) done(); }
  function grant(item) {
    item.signal?.removeEventListener('abort', item.abort); active++; peak = Math.max(peak, active); let released = false;
    item.resolve(() => { if (released) return; released = true; active--; if (queue.length && !closed) grant(queue.shift()); wake(); });
  }
  return {
    acquire({ signal } = {}) {
      if (closed) return Promise.reject(problem(503, 'budget_closed'));
      if (signal?.aborted) return Promise.reject(problem(499, 'request_closed'));
      if (active >= activeLimit && queue.length >= queuedLimit) return Promise.reject(problem(429, busyCode));
      return new Promise((resolve, reject) => {
        const item = { resolve, reject, signal, abort: null };
        item.abort = () => { const n = queue.indexOf(item); if (n >= 0) { queue.splice(n, 1); reject(problem(499, 'request_closed')); wake(); } };
        if (active < activeLimit) grant(item); else { queue.push(item); signal?.addEventListener('abort', item.abort, { once: true }); }
      });
    },
    diagnostics: () => ({ active, queued: queue.length, peak }),
    async close() { closed = true; for (const item of queue.splice(0)) { item.signal?.removeEventListener('abort', item.abort); item.reject(problem(503, 'budget_closed')); } if (active) await new Promise(resolve => idle.push(resolve)); }
  };
}
export const zipBudget = createBudget(1, 0, {busyCode:'download_busy'});
export const nativeBudget = createBudget(6, 0, {busyCode:'download_busy'});

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); crcTable[n] = c >>> 0; }
export function crcUpdate(state, bytes) { for (const b of bytes) state = crcTable[(state ^ b) & 255] ^ (state >>> 8); return state >>> 0; }
export const crc32 = bytes => (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

export function imageInfo(bytes, mime, { complete = false } = {}) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); let width, height;
  if (mime === 'image/png') {
    demand(b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR', 400, 'invalid_png');
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
    demand(crc32(b.subarray(12, 29)) === b.readUInt32BE(29) && [0,2,3,4,6].includes(b[25]) && [1,2,4,8,16].includes(b[24]) && b[26] === 0 && b[27] === 0 && b[28] <= 1, 400, 'invalid_png');
    if (complete) {
      let offset = 8, ended = false, data = false;
      while (offset < b.length) { demand(offset + 12 <= b.length, 400, 'invalid_png'); const size = b.readUInt32BE(offset); demand(size <= b.length - offset - 12, 400, 'invalid_png'); const kind = b.toString('ascii', offset + 4, offset + 8); demand(crc32(b.subarray(offset + 4, offset + 8 + size)) === b.readUInt32BE(offset + 8 + size), 400, 'invalid_png'); if (kind === 'IDAT') data = true; if (kind === 'IEND') { demand(size === 0 && offset + 12 === b.length, 400, 'invalid_png'); ended = true; } offset += 12 + size; }
      demand(data && ended, 400, 'invalid_png');
    }
  } else if (mime === 'image/jpeg') {
    demand(b.length >= 4 && b[0] === 255 && b[1] === 216, 400, 'invalid_jpeg');
    let p = 2;
    while (p + 3 < b.length) { demand(b[p] === 255, 400, 'invalid_jpeg'); while (b[p] === 255) p++; const marker = b[p++]; if (marker === 0xd9 || marker === 0xda) break; if (marker >= 0xd0 && marker <= 0xd7 || marker === 1) continue; demand(p + 2 <= b.length, 400, 'invalid_jpeg'); const len = b.readUInt16BE(p); demand(len >= 2 && p + len <= b.length, 400, 'invalid_jpeg'); if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { demand(len >= 8, 400, 'invalid_jpeg'); height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break; } p += len; }
    demand(width && height && (!complete || b[b.length - 2] === 255 && b[b.length - 1] === 217), 400, 'invalid_jpeg');
  } else if (mime === 'image/webp') {
    demand(b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP', 400, 'invalid_webp');
    if (complete) demand(b.readUInt32LE(4) + 8 === b.length, 400, 'invalid_webp');
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
    else if (kind === 'VP8L') { demand(b[20] === 0x2f, 400, 'invalid_webp'); width = 1 + (((b[22] & 0x3f) << 8) | b[21]); height = 1 + (((b[24] & 15) << 10) | (b[23] << 2) | (b[22] >> 6)); }
    else if (kind === 'VP8 ') { demand(b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a, 400, 'invalid_webp'); width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else throw problem(400, 'invalid_webp');
  } else return null;
  demand(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= MAX_PIXELS, 413, 'image_pixel_limit');
  return { width, height };
}
export function validateBytes(descriptor, bytes) {
  demand(bytes instanceof Uint8Array && bytes.byteLength === descriptor.bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_RAW, 400, 'asset_length_mismatch');
  demand(validHash(descriptor.sha256) && sha256(bytes) === descriptor.sha256, 400, 'asset_sha_mismatch');
  if (['image/png','image/jpeg','image/webp'].includes(descriptor.mime)) return imageInfo(bytes, descriptor.mime, { complete: true });
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw problem(400, 'asset_mime_mismatch'); }
  if (descriptor.mime === 'application/json') { demand(bytes.length <= MAX_JSON, 413, 'json_limit'); try { JSON.parse(text); } catch { throw problem(400, 'invalid_json_asset'); } }
  else if (descriptor.mime === 'image/svg+xml') demand(/^\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(text) && !/<!DOCTYPE|<!ENTITY/i.test(text), 400, 'invalid_svg');
  else throw problem(400, 'unsupported_asset_mime');
  return null;
}

export async function readRaw(req, body, maximum = MAX_RAW, signal) {
  cancelled(signal);
  if (body instanceof Uint8Array) { demand(body.byteLength <= maximum, 413, 'body_limit'); return Buffer.from(body); }
  const rawLength = req.headers?.['content-length'];
  if (rawLength !== undefined) demand(/^\d+$/.test(String(rawLength)) && Number(rawLength) > 0 && Number(rawLength) <= maximum, 413, 'body_limit');
  const chunks = []; let total = 0;
  for await (const chunk of req) { cancelled(signal); total += chunk.length; demand(total <= maximum, 413, 'body_limit'); chunks.push(chunk); }
  demand(rawLength === undefined || Number(rawLength) === total, 400, 'asset_length_mismatch');
  return Buffer.concat(chunks, total);
}

// Walk each component without following symlinks, then validate the opened physical FD.
export async function openVerifiedAsset(vault, asset, { signal, maxBytes = MAX_RAW, computeCRC = false } = {}) {
  demand(asset && validHash(asset.sha256) && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= maxBytes, 409, 'asset_integrity');
  const relative = asset.relativePath;
  demand(typeof relative === 'string' && /^[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(relative) && relative.split('/')[0] === asset.sha256.slice(0,2) && relative.split('/')[1].split('.')[0] === asset.sha256, 409, 'asset_integrity');
  const base = path.resolve(vault.assetsDir); demand(await realpath(base) === base && (await lstat(base)).isDirectory() && !(await lstat(base)).isSymbolicLink(), 409, 'asset_integrity');
  const folder = path.join(base, relative.split('/')[0]), target = path.join(base, relative);
  let file;
  try {
    const st = await lstat(folder); demand(st.isDirectory() && !st.isSymbolicLink(), 409, 'asset_integrity');
    if (typeof vault.openOriginal === 'function') {
      const capability = await vault.openOriginal(asset,{signal}); const handle = capability.handle;
      demand(handle && typeof handle.read === 'function' && typeof capability.close === 'function',500,'vault_fd_contract');
      file = { fd:handle.fd, read:handle.read.bind(handle), stat:handle.stat.bind(handle), close:()=>capability.close() };
    } else file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat(); demand(stat.isFile() && stat.size === asset.bytes, 409, 'asset_integrity');
    demand(await realpath(target) === target && !(await lstat(folder)).isSymbolicLink(), 409, 'asset_integrity');
    if (process.platform === 'linux') demand(await realpath(`/proc/self/fd/${file.fd}`) === target, 409, 'asset_integrity');
    const hash = createHash('sha256'); let crc = 0xffffffff, position = 0; const buffer = Buffer.allocUnsafe(64 * 1024), prefix = [];
    while (position < stat.size) { cancelled(signal); const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position); demand(bytesRead > 0, 409, 'asset_integrity'); const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); if (computeCRC) crc = crcUpdate(crc, chunk); if (position < MiB) prefix.push(Buffer.from(chunk.subarray(0, MiB - position))); position += bytesRead; }
    demand(hash.digest('hex') === asset.sha256 && (await file.stat()).size === stat.size, 409, 'asset_integrity');
    const header = Buffer.concat(prefix); let dimensions = null;
    if (['image/png','image/jpeg','image/webp'].includes(asset.mime)) dimensions = imageInfo(header, asset.mime);
    return { file, bytes: stat.size, sha256: asset.sha256, crc32: (crc ^ 0xffffffff) >>> 0, dimensions, path: target };
  } catch (error) { await file?.close(); if (error?.code && typeof error.status === 'number') throw error; throw problem(409, 'asset_integrity'); }
}

export function downloadName(value, fallback = 'download.bin') {
  let name = String(value || fallback).normalize('NFC').replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + (name || fallback);
  while (Buffer.byteLength(name, 'utf8') > 180) name = [...name].slice(0,-1).join('');
  return name;
}
export const disposition = name => `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(downloadName(name)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
export async function writeChunk(res, bytes, signal) { cancelled(signal); demand(!res.destroyed, 499, 'request_closed'); if (!res.write(Buffer.from(bytes))) { await new Promise((resolve, reject) => { const clean = () => { res.off('drain', done); res.off('close', closed); res.off('error', bad); }; const done = () => { clean(); resolve(); }; const closed = () => { clean(); reject(problem(499, 'request_closed')); }; const bad = () => { clean(); reject(problem(499, 'request_closed')); }; res.once('drain', done); res.once('close', closed); res.once('error', bad); }); } }
export async function sendOpenFile(req, res, verified, { mime, filename, signal, headers = {} } = {}) {
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': verified.bytes, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", ...(filename ? { 'Content-Disposition': disposition(filename) } : {}), ...headers });
  if (req.method === 'HEAD') { res.end(); return; }
  let position = 0; const bytes = Buffer.allocUnsafe(64 * 1024);
  while (position < verified.bytes) { cancelled(signal); const next = await verified.file.read(bytes, 0, Math.min(bytes.length, verified.bytes-position), position); demand(next.bytesRead > 0, 409, 'asset_integrity'); await writeChunk(res, bytes.subarray(0,next.bytesRead), signal); position += next.bytesRead; }
  res.end();
}

function zipHeader(name, size, crc, offset, central) {
  const b = Buffer.alloc(central ? 46 : 30); b.writeUInt32LE(central ? 0x02014b50 : 0x04034b50);
  if (central) { b.writeUInt16LE((3<<8)|20,4); b.writeUInt16LE(20,6); b.writeUInt16LE(0x800,8); b.writeUInt16LE(33,14); b.writeUInt32LE(crc,16); b.writeUInt32LE(size,20); b.writeUInt32LE(size,24); b.writeUInt16LE(name.length,28); b.writeUInt32LE((0o100600 << 16) >>> 0,38); b.writeUInt32LE(offset,42); }
  else { b.writeUInt16LE(20,4); b.writeUInt16LE(0x800,6); b.writeUInt16LE(33,12); b.writeUInt32LE(crc,14); b.writeUInt32LE(size,18); b.writeUInt32LE(size,22); b.writeUInt16LE(name.length,26); }
  return b;
}
export const ZIP_INDEX_NAME='00_切图索引.json';
export async function closeZipPlan(plan){const tasks=[];for(const entry of plan?.entries || [])if(entry.opened){const opened=entry.opened;entry.opened=null;tasks.push(Promise.resolve().then(()=>opened.file.close()));}const outcomes=await Promise.allSettled(tasks);const failed=outcomes.find(r=>r.status==='rejected');if(failed)throw failed.reason;}
export async function planZip(vault,selections,{signal,reauthorize=()=>{},keepOpen=false,project}={}){
  demand(Array.isArray(selections) && selections.length>0,400,'empty_selection');demand(selections.length<=499,413,'zip_entry_limit');
  project=project || vault.catalog?.projects?.find(p=>p.id===selections[0].projectId);demand(project && validId(project.id) && typeof project.name==='string',400,'zip_project_required');
  let payloadBytes=0;const entries=[],used=new Set([ZIP_INDEX_NAME.toLocaleLowerCase('en-US')]);
  try{
    for(const row of selections){
      cancelled(signal);demand(validId(row.sliceId || row.id),400,'invalid_slice_id');const original=row.originalFileName || row.fileName || row.asset.id+'.bin';const base=downloadName(original,row.asset.id+'.bin');let name=base,n=1;
      while(used.has(name.toLocaleLowerCase('en-US'))){const ext=path.extname(base);name=downloadName(base.slice(0,base.length-ext.length),'asset')+'_'+n+++ext;}used.add(name.toLocaleLowerCase('en-US'));
      const opened=await openVerifiedAsset(vault,row.asset,{signal,computeCRC:true});const entry={name,nameBytes:Buffer.from(name),asset:row.asset,bytes:opened.bytes,crc32:opened.crc32,sha256:row.asset.sha256,sliceId:row.sliceId || row.id,frameId:row.frameId,frameName:row.frameName ?? null,revisionId:row.revisionId,exportNodeId:row.exportNodeId ?? null,format:row.format ?? null,scale:row.scale ?? null,originalFileName:original,nameLabel:row.name || row.exportName || original,opened};entries.push(entry);
      reauthorize();payloadBytes+=opened.bytes;demand(payloadBytes<=128*MiB,413,'zip_byte_limit');if(!keepOpen){await opened.file.close();entry.opened=null;}
    }
    const index=Buffer.from(JSON.stringify({project:{id:project.id,name:project.name},slices:entries.map(e=>({zipPath:e.name,id:e.sliceId,originalFileName:e.originalFileName,name:e.nameLabel,frameId:e.frameId,frameName:e.frameName,revisionId:e.revisionId,exportNodeId:e.exportNodeId,format:e.format,scale:e.scale,byteSize:e.bytes,sha256:e.sha256}))},null,2),'utf8');
    payloadBytes+=index.length;demand(payloadBytes<=128*MiB,413,'zip_byte_limit');entries.unshift({name:ZIP_INDEX_NAME,nameBytes:Buffer.from(ZIP_INDEX_NAME),data:index,bytes:index.length,crc32:crc32(index),sha256:sha256(index)});
    let offset=0,directoryBytes=0;for(const entry of entries){entry.offset=offset;offset+=30+entry.nameBytes.length+entry.bytes;directoryBytes+=46+entry.nameBytes.length;}demand(offset+directoryBytes+22<=0xffffffff,413,'zip_byte_limit');return {entries,bytes:offset+directoryBytes+22,payloadBytes,directoryOffset:offset,directoryBytes};
  }catch(e){await closeZipPlan({entries});throw e;}
}
export async function responseSettled(res){
  if(res.writableFinished || res.destroyed || res.closed)return;if(!res.writableEnded && !res.headersSent)return;
  await new Promise(resolve=>{const done=()=>{res.off('finish',done);res.off('close',done);res.off('error',done);resolve();};res.once('finish',done);res.once('close',done);res.once('error',done);if(res.writableFinished || res.destroyed || res.closed)done();});
}
export async function finishReceipt(res,receipts,id){if(!id)return;if(!res.writableEnded && !res.destroyed && res.headersSent)res.destroy();await responseSettled(res);receipts.finish(id);}
export async function streamZip(req,res,vault,plan,{signal,filename='slices.zip',reauthorize=()=>{}}={}){
  try{
    // Pin every verified physical FD before sending headers; never reopen a path mid-archive.
    for(const entry of plan.entries)if(entry.asset && !entry.opened){entry.opened=await openVerifiedAsset(vault,entry.asset,{signal,computeCRC:true});demand(entry.opened.crc32===entry.crc32,409,'asset_integrity');reauthorize();}
    reauthorize();if(req.method==='HEAD')await closeZipPlan(plan);
    res.writeHead(200,{'Content-Type':'application/zip','Content-Length':plan.bytes,'Content-Disposition':disposition(filename),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD'){res.end();return;}
    for(const entry of plan.entries){cancelled(signal);await writeChunk(res,zipHeader(entry.nameBytes,entry.bytes,entry.crc32,0,false),signal);await writeChunk(res,entry.nameBytes,signal);if(entry.data)await writeChunk(res,entry.data,signal);else{let position=0;const buffer=Buffer.allocUnsafe(64*1024);while(position<entry.bytes){cancelled(signal);const {bytesRead}=await entry.opened.file.read(buffer,0,Math.min(buffer.length,entry.bytes-position),position);demand(bytesRead>0,409,'asset_integrity');await writeChunk(res,buffer.subarray(0,bytesRead),signal);position+=bytesRead;}await entry.opened.file.close();entry.opened=null;}}
    for(const entry of plan.entries){await writeChunk(res,zipHeader(entry.nameBytes,entry.bytes,entry.crc32,entry.offset,true),signal);await writeChunk(res,entry.nameBytes,signal);}const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(plan.entries.length,8);end.writeUInt16LE(plan.entries.length,10);end.writeUInt32LE(plan.directoryBytes,12);end.writeUInt32LE(plan.directoryOffset,16);await writeChunk(res,end,signal);res.end();
  }finally{await closeZipPlan(plan);}
}

const receiptStores = new WeakMap();
export function receiptsFor(vault,clock=Date.now) { let store=receiptStores.get(vault); if(!store) {store=createReceipts({clock});receiptStores.set(vault,store);} return store; }
// Optional same-user physical-completion receipts. A receipt never means abort rolled back IO.
export function createReceipts({ clock = Date.now, ttl = 60_000, maximum = 1024 } = {}) {
  const records = new Map(); const trim = () => { for (const [id,r] of records) if (r.expiresAt <= clock()) records.delete(id); };
  return {
    // Terminal retention is best-effort under pressure; never evict an unexpired pending record.
    start(userId) { trim(); if(records.size>=maximum)for(const [id,r] of records){if(!r.pending){records.delete(id);if(records.size<maximum)break;}} demand(records.size < maximum,429,'receipt_busy'); const id = randomBytes(16).toString('hex'); records.set(id,{userId,pending:true,expiresAt:clock()+ttl}); return id; },
    // Map order among terminal records follows physical finish, not creation or reads.
    finish(id) { const r = records.get(id); if (r) { r.pending=false; r.expiresAt=clock()+ttl; records.delete(id);records.set(id,r); } },
    get(id,userId) { trim(); const r=records.get(id); demand(r && r.userId === userId,404,'receipt_not_found'); return { pending:r.pending,expiresAt:new Date(r.expiresAt).toISOString() }; }
  };
}
