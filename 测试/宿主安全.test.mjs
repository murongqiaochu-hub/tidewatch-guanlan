import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startHost, privateFixtureDirectory, privateFile } from './宿主测试工具.mjs';

for (const route of ['/api/frames', '/api/frames/frame-0', '/api/frames/frame-0/revisions', '/api/frames/frame-0/document?revision=revision-0-current', '/api/assets/frame-0.revision-0-current', '/api/fixture-images/frame-0/revision-0-current/preview/64', '/api/demo/slice?frame=frame-0&revision=revision-0-current', '/api/demo/zip?frame=frame-0&revision=revision-0-current']) {
  test('HTTP anonymous rejects: ' + route, async t => {
    const { base } = await startHost(t, { count: 3 }); assert.equal((await fetch(base + route)).status, 401);
  });
}
test('Demo session requires same-origin POST and gives HttpOnly Lax RAM cookie', async t => {
  const { base, app } = await startHost(t);
  assert.equal((await fetch(base + '/api/demo/session')).status, 405);
  assert.equal((await fetch(base + '/api/demo/session', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/demo/session', { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' })).status, 403);
  const response = await fetch(base + '/api/demo/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.deepEqual(await response.json(), { syntheticOnly: true, projectId: 'project-owned' });
  const header = { Cookie: cookie.split(';')[0] };
  assert.equal((await fetch(base + '/api/frames', { headers: header })).status, 200);
  assert.equal((await fetch(base + '/api/fixture-images/frame-0/revision-0-current/preview/64', { headers: header })).status, 200);
  app.disableSession(cookie.split(';')[0].split('=')[1]);
  assert.equal((await fetch(base + '/api/frames', { headers: header })).status, 401);
});
test('Cross-project, roles, project changes and disabled sessions apply immediately', async t => {
  const { app, request, token, base } = await startHost(t, { count: 3 });
  const stranger = app.createSession('viewer', 'project-other');
  for (const route of ['/api/frames/frame-0', '/api/fixture-images/frame-0/revision-0-current/preview/64', '/api/demo/zip?frame=frame-0&revision=revision-0-current']) assert.equal((await request(route, { headers: { Authorization: 'Bearer ' + stranger } })).status, 403);
  app.setSessionProject(token, 'project-other'); assert.equal((await request('/api/frames/frame-0')).status, 403);
  app.setSessionProject(token, 'project-owned'); app.setSessionRole(token, 'disabled-role'); assert.equal((await request('/api/frames')).status, 403);
  app.setSessionRole(token, 'viewer'); assert.equal((await request('/api/frames')).status, 200);
  const post = await request('/api/independent-publish/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Independent-Request-Id': 'read-only' }, body: '{}' }); assert.equal(post.status, 403);
  app.disableSession(token); assert.equal((await request('/api/frames')).status, 401);
  assert.equal((await fetch(base + '/api/frames', { headers: { Authorization: 'Bearer wrong', Cookie: 'independent_demo_session=' + stranger } })).status, 401);
});
test('CSP, no-sniff, hostile Origin/Host and JSON XSS remain data', async t => {
  const { request, app, base } = await startHost(t, { count: 3 });
  app.catalog.frames[0].name = '</script><img src=x onerror=alert(1)>';
  const response = await request('/api/frames'); assert.match(response.headers.get('content-type'), /^application\/json/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await response.json()).frames[0].name, '</script><img src=x onerror=alert(1)>');
  const entry = await fetch(base + '/'); assert.match(entry.headers.get('content-security-policy'), /default-src 'none'/); assert.match(entry.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.doesNotMatch(await entry.text(), /onerror=|unsafe-inline|unsafe-eval/);
  assert.equal((await request('/api/frames', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/frames', { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHost, 403);
});
test('Host external shell CSS bounds the viewport with vh/dvh fallback and keeps strict CSP; no viewer implementation changes', async t => {
  const { request } = await startHost(t);
  const entry = await request('/'), html = await entry.text();
  assert.match(html, /<link rel="stylesheet" href="\/宿主\/demo-shell\.css">/);
  assert.doesNotMatch(html, /<style\b|\bstyle=/i);
  assert.match(entry.headers.get('content-security-policy'), /style-src 'self'/);
  assert.doesNotMatch(entry.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  const response = await request('/宿主/demo-shell.css');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/css/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const css = await response.text();
  assert.match(css, /html,\s*body\s*\{[^}]*margin:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/);
  assert.match(css, /#inspector-root\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;[^}]*max-height:\s*100vh;[^}]*max-height:\s*100dvh;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
  assert.doesNotMatch(css, /\.ii-|@import|url\(/); // Host boundary only; not a copied/overridden library UI.
});
test('Static exact allowlist serves only viewer/adaptor modules, never host internals', async t => {
  const { request } = await startHost(t);
  assert.equal((await request('/%E5%AE%BF%E4%B8%BB/browser-adapter.mjs')).status, 200);
  for (const route of ['/宿主/demo-server.mjs', '/宿主/synthetic-fixtures.mjs', '/插件/main.mjs', '/package.json', '/来源记录/01_独立实现行为合同.md', '/查看器/', '/宿主/browser-adapter.mjs.map', '/查看器/nonexistent.mjs', '/%2e%2e/package.json', '/%5cpackage.json']) assert.equal((await request(route)).status, 404);
});
test('Static symlink escapes are rejected using canonical authorized root', async t => {
  const directory = await privateFixtureDirectory(t);
  await privateFile(path.join(directory, 'outside.mjs'), 'export const privateValue=1;');
  await fs.mkdir(path.join(directory, '查看器'), { mode: 0o700 }); await fs.chmod(path.join(directory, '查看器'), 0o700);
  await fs.symlink('../outside.mjs', path.join(directory, '查看器/index.mjs'));
  const { request } = await startHost(t, { rootDirectory: directory });
  assert.equal((await request('/查看器/index.mjs')).status, 404);
});
test('Revision belongs to exact frame, invalid tile and preview boundaries reject', async t => {
  const { request } = await startHost(t, { count: 3 });
  assert.equal((await request('/api/frames/frame-0/document?revision=revision-1-current')).status, 404);
  for (const route of ['/api/fixture-images/frame-0/revision-0-current/preview/65', '/api/fixture-images/frame-0/revision-0-current/tile/99_0', '/api/fixture-images/frame-0/revision-0-current/original/2']) assert.equal((await request(route)).status, 400);
  assert.equal((await request('/api/frames', { method: 'PUT' })).status, 405);
});
test('readBody rejects oversized and malformed JSON with physical connection close', async t => {
  const { base } = await startHost(t, { bodyTimeoutMs: 100 });
  const tooLarge = await fetch(base + '/api/demo/session', { method: 'POST', headers: { Origin: base }, body: 'x'.repeat(1025) }); assert.equal(tooLarge.status, 413); assert.equal(tooLarge.headers.get('connection'), 'close');
  const malformed = await fetch(base + '/api/demo/session', { method: 'POST', headers: { Origin: base }, body: '{' }); assert.equal(malformed.status, 400);
  const invalidUTF = await fetch(base + '/api/demo/session', { method: 'POST', headers: { Origin: base }, body: Buffer.from([0xff]) }); assert.equal(invalidUTF.status, 400);
});
test('readBody enforces timeout on a physically incomplete request', async t => {
  const { base } = await startHost(t, { bodyTimeoutMs: 40 });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/demo/session', { method: 'POST', headers: { Origin: base, 'Content-Length': '10' } }, res => { const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('end', ()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()})); });
    req.on('error', reject); req.write('{');
  });
  assert.equal(result.status, 408); assert.match(result.body, /Body timeout/);
});
