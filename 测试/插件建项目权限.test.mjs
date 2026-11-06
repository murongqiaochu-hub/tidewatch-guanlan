import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatform } from '../平台/服务.mjs';
import { createProductionHTTP } from '../插件/production-protocol.mjs';

const password = 'Synthetic-Pass-123';

test('Bearer plugin writes accept the opaque Figma origin; cookie-only writes still fail CSRF', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'heron-plugin-origin-'));
  const canonical = await realpath(directory);
  const app = await createPlatform({ dataDir: canonical, secret: randomBytes(48), bootstrapAdmin: { username: 'admin', password }, logger: { error() {} } });
  const address = await app.listen(0);
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(canonical, { recursive: true }); });
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const token = auth.token;
  const cookie = login.headers.get('set-cookie');
  const post = (pathname, body, headers) => fetch(origin + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  let response = await post('/api/projects', { name: 'Opaque project' }, { authorization: `Bearer ${token}`, origin: 'null' });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const project = await response.json();
  response = await post(`/api/projects/${project.id}/groups`, { name: 'Opaque group' }, { authorization: `Bearer ${token}`, origin: 'null' });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));

  response = await post('/api/projects', { name: 'Cookie only' }, { cookie, origin: 'null' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'origin_denied');
  response = await post('/api/projects', { name: 'No auth' }, { origin: 'null' });
  assert.equal(response.status, 403);
  response = await post('/api/projects', { name: 'Foreign origin' }, { authorization: `Bearer ${token}`, origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  response = await post('/api/projects', { name: 'No origin API client' }, { authorization: `Bearer ${token}` });
  assert.equal(response.status, 201);
});

test('403 keeps the plugin session; only 401 clears it', async t => {
  let failure = 403;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/projects') { res.end(JSON.stringify({ projects: [] })); return; }
    if (req.method === 'POST' && req.url === '/api/projects') {
      res.statusCode = failure;
      res.end(JSON.stringify({ error: { code: failure === 403 ? 'origin_denied' : 'authentication_required' } }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'not_found' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createProductionHTTP({ origin, allowLocalhost: true });
  client.setToken('synthetic-plugin-token');
  await assert.rejects(client.createProject('Forbidden'), error => error.status === 403);
  assert.equal(client.status().authenticated, true, 'a permission response must not be treated as logout');
  assert.deepEqual(await client.projects(), [], 'the same token still reads projects');
  failure = 401;
  await assert.rejects(client.createProject('Expired'), error => error.status === 401);
  assert.equal(client.status().authenticated, false);
});

test('the plugin UI no longer logs out on 403', async () => {
  const ui = await readFile(new URL('../插件/ui.mjs', import.meta.url), 'utf8');
  const protocol = await readFile(new URL('../插件/production-protocol.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /\[401,403\]\.includes/);
  assert.doesNotMatch(protocol, /\[401, 403\]\.includes/);
  assert.match(protocol, /response\.status === 401/);
});
