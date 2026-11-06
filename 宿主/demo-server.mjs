import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createFixtureCatalog, digest } from './synthetic-fixtures.mjs';
import { createImageStore, httpProblem, waitForRequest } from './image-store.mjs';
import { storedZip, crc32 } from './stored-zip.mjs';
import { createSyntheticPublisher } from './synthetic-publish.mjs';
import { codecDependency } from './raster-codec.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin' };
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
export const staticFiles = Object.freeze(['宿主/browser-adapter.mjs', '宿主/demo-shell.css', '查看器/index.mjs', '查看器/core.mjs', '查看器/resources.mjs', '查看器/inspector.css']);
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Independent Inspector｜合成兼容宿主</title><link rel="stylesheet" href="/查看器/inspector.css"><link rel="stylesheet" href="/宿主/demo-shell.css"></head><body><main id="inspector-root"></main><script type="module" src="/宿主/browser-adapter.mjs"></script></body></html>';
const cookieName = 'independent_demo_session';

export async function readBody(req, { limit = 1024 * 1024, timeoutMs = 5000 } = {}) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw httpProblem(413, 'Body byte limit');
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted); };
    const failed = error => { cleanup(); req.pause(); reject(error); };
    const aborted = () => failed(httpProblem(400, 'Body physically aborted'));
    const data = chunk => { total += chunk.length; if (total > limit) return failed(httpProblem(413, 'Body byte limit')); chunks.push(chunk); };
    const end = () => { cleanup(); if (length !== undefined && total !== Number(length)) return reject(httpProblem(400, 'Body length mismatch')); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => failed(httpProblem(408, 'Body timeout')), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
  });
}
function parseJSON(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw httpProblem(400, 'Invalid UTF-8 JSON'); } }

export async function createDemoServer({ count = 1100, imageGenerator, resourceTimeoutMs = 30_000, bodyTimeoutMs = 5000, rootDirectory = projectRoot } = {}) {
  const root = await fs.realpath(rootDirectory), catalog = createFixtureCatalog(count), sessions = new Map(), sockets = new Set(), handlers = new Set();
  const statistics = { documentsLoaded: 0, imageGetsActive: 0, imageGetsPeak: 0, imageGetsFinished: 0, imageGetsClosed: 0, imagesGenerated: 0, cacheBytesPeak: 0, originalDataWrites: 0, zipPreparations: 0 };
  // Leave 4MiB for retained ZIP bytes: combined image/ZIP cache stays ≤80MiB.
  const images = createImageStore({ statistics, encodedLimit: 76 * 1024 * 1024, ...(imageGenerator ? { generate: imageGenerator } : {}) });
  const publisher = createSyntheticPublisher({ initialRevisions: catalog.frames.map(f => ({ projectId: f.projectId, designFileId: f.designFileId, pageId: f.pageId, frameId: f.frameId, revisionId: f.revisionId, figmaNodeId: f.figmaNodeId })) });
  const archives = new Map(), archiveFlights = new Map(); let archiveBytes = 0, closing = false;
  Object.defineProperties(statistics, {
    zipCacheBytes: { enumerable: true, get: () => archiveBytes },
    encodedRetainedAndReservedBytes: { enumerable: true, get: () => statistics.cacheBytes + statistics.encodedReservedBytes + archiveBytes }
  });
  function session(role, projectId) {
    for (const [key, s] of sessions) if (s.expiresAt <= Date.now()) sessions.delete(key);
    if (sessions.size >= 256) throw httpProblem(429, 'Synthetic session budget');
    const token = randomUUID(); sessions.set(token, { actorId: randomUUID(), role, projectId, enabled: true, expiresAt: Date.now() + 8 * 60 * 60_000 }); return token;
  }
  function actor(req, publish = false) {
    let token = null;
    if (req.headers.authorization !== undefined) {
      if (!/^Bearer [\w-]{16,160}$/.test(req.headers.authorization)) throw httpProblem(401, 'Synthetic bearer required');
      token = req.headers.authorization.slice(7);
    } else {
      const cookies = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='));
      if (cookies.length === 1) token = cookies[0].slice(cookieName.length + 1);
    }
    const user = sessions.get(token);
    if (!user || !user.enabled || user.expiresAt <= Date.now()) throw httpProblem(401, 'Synthetic authentication required');
    if (!['developer', 'editor', 'viewer'].includes(user.role) || (publish && !['developer', 'editor'].includes(user.role))) throw httpProblem(403, 'Synthetic role denied');
    return user;
  }
  function frameById(id) { const frame = catalog.frames.find(f => f.frameId === id); if (!frame) throw httpProblem(404, 'Unknown frame'); return frame; }
  function revision(f, id) { if (!catalog.revisions(f.frameId).some(r => r.revisionId === id)) throw httpProblem(404, 'Revision is not in this frame'); }
  function authorize(req, frame) { const user = actor(req); if (user.projectId !== frame.projectId) throw httpProblem(403, 'Project access denied'); return user; }
  function origin(req, required = false) {
    const port = server.address()?.port;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) throw httpProblem(403, 'Synthetic loopback Host required');
    const expected = 'http://' + req.headers.host;
    if ((required && !req.headers.origin) || (req.headers.origin && req.headers.origin !== expected) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) throw httpProblem(403, 'Same-origin required');
    return expected;
  }
  function description(frameId, revisionId, mode, a = null, b = null) {
    const f = frameById(frameId); revision(f, revisionId);
    if (mode === 'preview' && (![64, 256, 1024, 2048].includes(a) || b !== null)) throw httpProblem(400, 'Preview level');
    if (mode === 'original' && (a !== null || b !== null)) throw httpProblem(400, 'Original path');
    if (mode === 'tile' && (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0)) throw httpProblem(400, 'Tile indexes');
    const native = mode === 'slice' ? { width: 96, height: 64 } : catalog.assetSize(f);
    const scale = mode === 'preview' ? Math.min(1, a / Math.max(native.width, native.height)) : 1;
    const offsetX = mode === 'tile' ? a * 512 : 0, offsetY = mode === 'tile' ? b * 512 : 0;
    const width = mode === 'tile' ? Math.min(512, native.width - offsetX) : Math.max(1, Math.round(native.width * scale));
    const height = mode === 'tile' ? Math.min(512, native.height - offsetY) : Math.max(1, Math.round(native.height * scale));
    if (width < 1 || height < 1) throw httpProblem(400, 'Tile outside source');
    const seed = f.seed + (revisionId.endsWith('-old') ? 3 : 0);
    // Equal own procedural byte sources share the RAM generation promise;
    // HTTP identities and authorization never share or change ownership.
    const mime = mode === 'preview' && a !== 64 ? 'image/jpeg' : 'image/png';
    const key = ['own-raster-v2', mime, mode, seed, native.width, native.height, width, height, offsetX, offsetY].join('/');
    return { f, native, width, height, offsetX, offsetY, mode, seed, mime, key };
  }
  function vector(f, r) {
    const colour = r.endsWith('-old') ? '#985b34' : '#347f98';
    return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><title>' + f.frameId + ' ' + r + '</title><rect width="96" height="64" rx="12" fill="' + colour + '"/></svg>');
  }
  async function archive(f, r) {
    const key = f.frameId + '/' + r;
    if (archives.has(key)) return archives.get(key);
    if (archiveFlights.has(key)) return archiveFlights.get(key);
    if (archiveFlights.size >= 16) throw httpProblem(429, 'Synthetic archive queue full');
    const promise = (async () => {
      const entries = [{ name: 'owned-slice.svg', bytes: vector(f, r) }, { name: 'owned-slice.png', bytes: await images.get(description(f.frameId, r, 'slice')) }];
      const index = { syntheticOnly: true, frameId: f.frameId, revisionId: r, entries: entries.map(e => ({ filename: e.name, byteLength: e.bytes.length, crc32: crc32(e.bytes), sha256: digest(e.bytes) })) };
      const bytes = storedZip([...entries, { name: 'index.json', bytes: Buffer.from(JSON.stringify(index)) }]);
      while (archives.size && (archives.size >= 32 || archiveBytes + bytes.length > 4 * 1024 * 1024)) { const first = archives.keys().next().value; archiveBytes -= archives.get(first).length; archives.delete(first); }
      if (bytes.length <= 4 * 1024 * 1024) { archives.set(key, bytes); archiveBytes += bytes.length; }
      statistics.zipPreparations++; return bytes;
    })();
    archiveFlights.set(key, promise);
    try { return await promise; } finally { archiveFlights.delete(key); }
  }
  function json(req, res, payload, status = 200, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { ...security, 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Content-Security-Policy': "default-src 'none'; sandbox", ...headers });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  function binary(req, res, bytes, mime, headers = {}) {
    res.writeHead(200, { ...security, 'Content-Type': mime, 'Content-Length': bytes.length, 'Content-Security-Policy': "default-src 'none'; sandbox", ...headers });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  function meter(res) {
    statistics.imageGetsActive++; statistics.imageGetsPeak = Math.max(statistics.imageGetsPeak, statistics.imageGetsActive);
    let settled = false;
    const finished = () => { if (!settled) { settled = true; statistics.imageGetsActive--; statistics.imageGetsFinished++; } };
    const closed = () => { if (!settled) { settled = true; statistics.imageGetsActive--; statistics.imageGetsClosed++; } };
    res.once('finish', finished); res.once('close', closed);
  }
  async function handle(req, res) {
    try {
      origin(req);
      if (closing) throw httpProblem(503, 'Synthetic server closing');
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw httpProblem(405, 'Method');
      // Reject dot and encoded traversal before URL's path normalization.
      const raw = decodeURIComponent(req.url.split('?')[0]);
      if (raw.includes('\\') || raw.includes('\0') || raw.split('/').some(p => p === '.' || p === '..')) throw httpProblem(404, 'Unsafe path');
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (url.pathname === '/health' && req.method !== 'POST') return json(req, res, { status: 'ok', syntheticOnly: true });
      if (url.pathname === '/api/demo/session') {
        if (req.method !== 'POST') throw httpProblem(405, 'Session requires POST');
        origin(req, true);
        const bytes = await readBody(req, { limit: 1024, timeoutMs: bodyTimeoutMs });
        const data = bytes.length ? parseJSON(bytes) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw httpProblem(400, 'Demo session takes no business credentials');
        const token = session('developer', 'project-owned');
        return json(req, res, { syntheticOnly: true, projectId: 'project-owned' }, 200, { 'Set-Cookie': cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800' });
      }
      if (url.pathname === '/api/demo/statistics' && req.method !== 'POST') {
        const user = actor(req, true);
        if (user.projectId !== 'project-owned') throw httpProblem(403, 'Project access denied');
        return json(req, res, { syntheticOnly: true, statistics, codecDependency, publishing: { ...publisher.metrics, openSessions: publisher.openSessions } });
      }
      const publishRoute = url.pathname.match(/^\/api\/independent-publish\/(prepare|upload|commit|query|abort)$/);
      if (publishRoute) {
        if (req.method !== 'POST') throw httpProblem(405, 'Publish requires POST');
        const user = actor(req, publishRoute[1] !== 'query'); origin(req, !req.headers.authorization);
        const requestId = req.headers['x-independent-request-id'];
        if (typeof requestId !== 'string' || !/^[\w.-]{1,160}$/.test(requestId)) throw httpProblem(400, 'Independent request ID');
        let result;
        if (publishRoute[1] === 'upload') {
          const sid = req.headers['x-independent-session-id'], encoded = req.headers['x-independent-descriptor'];
          if (typeof sid !== 'string' || !/^[\w-]{16,160}$/.test(sid) || typeof encoded !== 'string' || encoded.length > 8192) throw httpProblem(400, 'Upload descriptor headers');
          let d; try { d = JSON.parse(decodeURIComponent(encoded)); } catch { throw httpProblem(400, 'Upload descriptor encoding'); }
          if (req.headers['content-type'] !== d?.mime) throw httpProblem(400, 'Upload MIME mismatch');
          if (!Number.isSafeInteger(d?.byteLength) || d.byteLength < 1 || d.byteLength > 32 * 1024 * 1024) throw httpProblem(413, 'Upload declared byte limit');
          const bytes = await readBody(req, { limit: d.byteLength, timeoutMs: bodyTimeoutMs }); actor(req, true);
          result = await publisher.upload(sid, d, bytes, user);
        } else {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw httpProblem(415, 'Publish JSON required');
          const data = parseJSON(await readBody(req, { limit: 1024 * 1024, timeoutMs: bodyTimeoutMs })); actor(req, publishRoute[1] !== 'query');
          const key = publishRoute[1] === 'prepare' ? 'manifest' : 'sessionId';
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !(key in data)) throw httpProblem(400, 'Publish request schema');
          result = publishRoute[1] === 'prepare' ? await publisher.prepare(data.manifest, user) : await publisher[publishRoute[1]](data.sessionId, user);
        }
        return json(req, res, { requestId, result });
      }
      if (req.method === 'POST') throw httpProblem(405, 'Read-only resource');
      if (url.pathname === '/api/frames') {
        const user = actor(req); return json(req, res, { frames: catalog.frames.filter(f => f.projectId === user.projectId), completeDirectory: true });
      }
      const frameMatch = url.pathname.match(/^\/api\/frames\/(frame-\d+)(?:\/(revisions|document))?$/);
      if (frameMatch) {
        const f = frameById(frameMatch[1]); authorize(req, f);
        if (!frameMatch[2]) return json(req, res, f);
        if (frameMatch[2] === 'revisions') return json(req, res, { revisions: catalog.revisions(f.frameId) });
        const r = url.searchParams.get('revision'); revision(f, r);
        const d = description(f.frameId, r, 'original'), bytes = await waitForRequest(images.get(d), res, resourceTimeoutMs); authorize(req, f);
        const assetId = f.frameId + '.' + r; statistics.documentsLoaded++;
        return json(req, res, { identity: { projectId: f.projectId, designFileId: f.designFileId, pageId: f.pageId, frameId: f.frameId, revisionId: r, figmaNodeId: f.figmaNodeId }, layerDoc: catalog.document(f.frameId, r), assets: [{ assetId, width: d.width, height: d.height, mime: 'image/png', byteLength: bytes.length, kind: 'preview' }], slices: [{ sliceId: 'slice-owned-svg', name: '独立矢量切图', format: 'SVG', mime: 'image/svg+xml', frameId: f.frameId, revisionId: r }, { sliceId: 'slice-owned-png', name: '独立像素切图', format: 'PNG', mime: 'image/png', frameId: f.frameId, revisionId: r }] });
      }
      const originalAsset = url.pathname.match(/^\/api\/assets\/(frame-\d+)\.(revision-\d+-(?:current|old))$/);
      const picture = url.pathname.match(/^\/api\/fixture-images\/(frame-\d+)\/(revision-\d+-(?:current|old))\/(original|preview|tile)(?:\/(\d+)(?:_(\d+))?)?$/);
      if (picture || originalAsset) {
        const match = picture || originalAsset, f = frameById(match[1]); authorize(req, f);
        const d = description(match[1], match[2], originalAsset ? 'original' : match[3], match[4] === undefined ? null : Number(match[4]), match[5] === undefined ? null : Number(match[5]));
        if (req.method === 'GET') meter(res);
        const bytes = await waitForRequest(images.get(d), res, resourceTimeoutMs); authorize(req, f);
        if (res.destroyed) return;
        return binary(req, res, bytes, d.mime, { 'X-Fixture-Width': String(d.width), 'X-Fixture-Height': String(d.height), 'X-Fixture-SHA256': digest(bytes) });
      }
      if (url.pathname === '/api/demo/slice' || url.pathname === '/api/demo/zip') {
        const f = frameById(url.searchParams.get('frame')), r = url.searchParams.get('revision'); authorize(req, f); revision(f, r);
        const zip = url.pathname.endsWith('/zip'), sliceId = url.searchParams.get('sliceId') || 'slice-owned-svg';
        if (!zip && !['slice-owned-svg', 'slice-owned-png'].includes(sliceId)) throw httpProblem(404, 'Unknown slice');
        const png = !zip && sliceId.endsWith('-png');
        if (!zip && req.method === 'GET') meter(res); // Include real native PNG/SVG download GETs, not only canvas assets.
        const bytes = await waitForRequest(zip ? archive(f, r) : png ? images.get(description(f.frameId, r, 'slice')) : Promise.resolve(vector(f, r)), res, resourceTimeoutMs); authorize(req, f);
        const filename = zip ? f.frameId + '-' + r + '-slices.zip' : 'owned-slice.' + (png ? 'png' : 'svg');
        return binary(req, res, bytes, zip ? 'application/zip' : png ? 'image/png' : 'image/svg+xml', { 'Content-Disposition': 'attachment; filename="' + filename + '"' });
      }
      if (url.pathname.startsWith('/api/')) throw httpProblem(404, 'Unknown demo API');
      if (url.pathname === '/' || /^\/viewer\/(?:r\/frame-\d+|p\/project-owned(?:\/slices)?)$/.test(url.pathname)) return binary(req, res, Buffer.from(html), 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
      const name = decodeURIComponent(url.pathname).slice(1);
      if (!staticFiles.includes(name)) throw httpProblem(404, 'Static file not allowlisted');
      const file = path.join(root, name);
      for (let candidate = file; candidate !== root; candidate = path.dirname(candidate)) if ((await fs.lstat(candidate)).isSymbolicLink()) throw httpProblem(404, 'Static symlink denied');
      if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw httpProblem(404, 'Static path');
      const bytes = await fs.readFile(file);
      return binary(req, res, bytes, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', { 'Content-Security-Policy': csp });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = error.httpStatus || (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
        if ([408, 413].includes(status)) { res.once('finish', () => req.socket.destroy()); }
        json(req, res, { error: error.httpStatus ? error.message : 'Demo resource failed' }, status, [408, 413].includes(status) ? { Connection: 'close' } : {});
      } else if (!res.destroyed) res.destroy();
    }
  }
  const server = http.createServer((req, res) => {
    const work = handle(req, res); handlers.add(work); work.finally(() => handlers.delete(work));
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 64;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closePromise;
  return {
    server, catalog, statistics, publisher,
    createSession: (role = 'developer', projectId = 'project-owned') => session(role, projectId),
    disableSession(token) { const s = sessions.get(token); if (s) s.enabled = false; },
    setSessionRole(token, role) { const s = sessions.get(token); if (s) s.role = role; },
    setSessionProject(token, projectId) { const s = sessions.get(token); if (s) s.projectId = projectId; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const closed = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...handlers]); await images.close(); await Promise.allSettled([...archiveFlights.values()]); await closed;
        publisher.close(); sessions.clear(); archives.clear(); archiveBytes = 0;
      })();
      return closePromise;
    }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createDemoServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  console.log('OWN_SYNTHETIC_DEMO_URL=http://127.0.0.1:' + app.server.address().port);
  const end = async () => { await app.close(); process.exit(0); }; process.once('SIGINT', end); process.once('SIGTERM', end);
}
