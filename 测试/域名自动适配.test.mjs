import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createPlatform } from '../平台/服务.mjs'
import { createConfiguredPlatform } from '../平台/启动.mjs'
import { createRequestSourcePolicy, matchOriginHost, resolveOriginMode } from '../平台/请求来源.mjs'

const password = 'Isolated-Origin-2026!'

async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(parent, 'owned-origin-http-'))
  const marker = crypto.randomBytes(16).toString('hex')
  await fs.chmod(root, 0o700)
  await fs.writeFile(path.join(root, 'OWNER'), marker, { mode: 0o600 })
  await fs.chmod(path.join(root, 'OWNER'), 0o600)
  let platform
  t.after(async () => {
    await platform?.close()
    assert.equal(await fs.realpath(root), root)
    assert.equal(path.dirname(root), parent)
    assert.equal(await fs.readFile(path.join(root, 'OWNER'), 'utf8'), marker)
    await fs.rm(root, { recursive: true })
  })
  platform = await createPlatform({
    dataDir: path.join(root, 'data'),
    secret: crypto.randomBytes(48),
    bootstrapAdmin: { username: 'admin', password },
    logger: { error() {} },
    ...options
  })
  const address = await platform.listen()
  return { platform, address, root, request: (url, args = {}) => wireRequest(address, url, args) }
}

function wireRequest(address, url, { method = 'GET', hostHeader, origin, headers = {}, body, token } = {}) {
  const wireHeaders = { Host: hostHeader ?? `127.0.0.1:${address.port}`, ...headers }
  if (origin !== undefined) wireHeaders.Origin = origin
  if (token) wireHeaders.Authorization = `Bearer ${token}`
  if (body !== undefined && !Object.keys(wireHeaders).some(key => key.toLowerCase() === 'content-type')) wireHeaders['Content-Type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, headers: wireHeaders, agent: false }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const bytes = Buffer.concat(chunks)
        let json
        try { json = JSON.parse(bytes.toString('utf8')) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, json, text: bytes.toString('utf8') })
      })
    })
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function startupFixture(t) {
  const parent = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(parent, 'owned-origin-startup-'))
  const marker = crypto.randomBytes(16).toString('hex')
  await fs.chmod(root, 0o700)
  const writePrivate = async (name, value) => {
    const filename = path.join(root, name)
    await fs.writeFile(filename, value, { mode: 0o600 })
    await fs.chmod(filename, 0o600)
    return filename
  }
  const owner = await writePrivate('OWNER', marker)
  const jwt = await writePrivate('jwt', crypto.randomBytes(48).toString('hex'))
  const passwordFile = await writePrivate('password', password)
  const apps = new Set()
  const env = { HANDOFF_DATA_DIR: path.join(root, 'data'), JWT_SECRET_FILE: jwt, HANDOFF_ADMIN_PASSWORD_FILE: passwordFile, HANDOFF_HOST: '127.0.0.1' }
  t.after(async () => {
    for (const app of apps) await app.close()
    assert.equal(await fs.realpath(root), root)
    assert.equal(path.dirname(root), parent)
    assert.equal(await fs.readFile(owner, 'utf8'), marker)
    await fs.rm(root, { recursive: true })
  })
  return { root, env, apps }
}

test('REAL HTTP: native Host header allows the same account on distinct deployment domains', async t => {
  const f = await fixture(t)
  assert.equal(f.platform.context.originMode, 'auto')
  for (const host of ['alpha.example.test:49156', 'beta.example.test:49156']) {
    const login = await f.request('/api/auth/login', { method: 'POST', hostHeader: host, origin: `https://${host}`, body: { username: 'admin', password } })
    assert.equal(login.status, 200, login.text)
    assert.equal(typeof login.json.token, 'string')
    const cookie = [].concat(login.headers['set-cookie'] ?? []).join('; ')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Max-Age=43200/)
    assert.match(cookie, /(?:^|;\s*)Secure(?:;|$)/)
    const me = await f.request('/api/auth/me', { hostHeader: host, origin: `https://${host}`, token: login.json.token })
    assert.equal(me.status, 200, me.text)
    assert.equal(me.json.username, 'admin')
  }
  assert.equal(f.platform.vault.catalog.users.length, 1)
  assert.equal(f.platform.vault.catalog.projects.length, 0)
})

test('REAL HTTP: LAN HTTP and no-Origin clients retain legacy login and cookie behavior', async t => {
  const f = await fixture(t)
  // Synthetic RFC1918 fixture; never bake a real deployment address into tests or packages.
  const lanHost = '10.20.30.180:4318'
  const lan = await f.request('/api/auth/login', { method: 'POST', hostHeader: lanHost, origin: `http://${lanHost}`, body: { username: 'admin', password } })
  assert.equal(lan.status, 200, lan.text)
  assert.doesNotMatch([].concat(lan.headers['set-cookie'] ?? []).join('; '), /(?:^|;\s*)Secure(?:;|$)/)
  const noOrigin = await f.request('/api/auth/login', { method: 'POST', hostHeader: '127.0.0.1:4318', body: { username: 'admin', password } })
  assert.equal(noOrigin.status, 200, noOrigin.text)
  assert.doesNotMatch([].concat(noOrigin.headers['set-cookie'] ?? []).join('; '), /(?:^|;\s*)Secure(?:;|$)/)
})

test('REAL HTTP: case, default ports, IPv6 and IDN normalize against the actual Host', async t => {
  const f = await fixture(t)
  const cases = [
    { hostHeader: 'MiXeD.Example:443', origin: 'HTTPS://mixed.example:443' },
    { hostHeader: 'MIXED.Example:80', origin: 'http://mixed.example' },
    { hostHeader: '[2001:DB8::1]:443', origin: 'https://[2001:db8::1]' },
    { hostHeader: 'xn--bcher-kva.example', origin: 'https://xn--bcher-kva.example' }
  ]
  for (const options of cases) {
    const login = await f.request('/api/auth/login', { method: 'POST', ...options, body: { username: 'admin', password } })
    assert.equal(login.status, 200, `${options.hostHeader} / ${options.origin}: ${login.text}`)
  }
})

test('URL normalization: case, default ports, IPv6, IDN, port mismatch and direct TLS', () => {
  assert.deepEqual(matchOriginHost('HTTPS://MIXED.Example:443', 'mixed.example'), { secure: true })
  assert.deepEqual(matchOriginHost('http://mixed.example:80', 'MIXED.EXAMPLE'), { secure: false })
  assert.deepEqual(matchOriginHost('https://[2001:DB8::1]', '[2001:db8::1]:443'), { secure: true })
  assert.deepEqual(matchOriginHost('https://bücher.example', 'XN--BCHER-KVA.EXAMPLE'), { secure: true })
  assert.equal(matchOriginHost('https://mixed.example:444', 'mixed.example:443'), null)
  assert.equal(matchOriginHost('http://mixed.example', 'mixed.example', { encrypted: true }), null)
  assert.deepEqual(matchOriginHost('https://mixed.example', 'mixed.example', { encrypted: true }), { secure: true })
  assert.equal(resolveOriginMode(undefined, null), 'auto')
  assert.equal(resolveOriginMode(undefined, 'https://old.example'), 'fixed')
  assert.equal(resolveOriginMode('auto', 'https://old.example'), 'auto')
  assert.throws(() => resolveOriginMode('trust-proxy', null), /Origin mode/)
})

test('direct TLS sockets reject HTTP Origin and retain Secure for HTTPS Origin', () => {
  const policy = createRequestSourcePolicy({ mode: 'auto', deny: () => Object.assign(new Error('denied'), { status: 403 }) })
  const httpRequest = { headers: { host: 'app.example.test', origin: 'http://app.example.test' }, socket: { encrypted: true } }
  assert.throws(() => policy.assertSameOrigin(httpRequest), { status: 403 })
  const httpsRequest = { headers: { host: 'app.example.test', origin: 'https://app.example.test' }, socket: { encrypted: true } }
  assert.deepEqual(policy.assertSameOrigin(httpsRequest), { secure: true })
  assert.equal(policy.isSecureRequest(httpsRequest), true)
})

test('REAL HTTP: same-site sibling domains, cross-site metadata and forged proxy headers are denied', async t => {
  const f = await fixture(t)
  const cases = [
    { hostHeader: 'app.example.test', origin: 'https://sibling.example.test', headers: { 'Sec-Fetch-Site': 'same-site' } },
    { hostHeader: 'app.example.test:49156', origin: 'https://app.example.test:49157' },
    { hostHeader: 'app.example.test', origin: 'https://app.example.test', headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { hostHeader: 'app.example.test', origin: 'https://evil.example', headers: { 'X-Forwarded-Host': 'app.example.test', 'X-Forwarded-Proto': 'https', Forwarded: 'host=app.example.test;proto=https' } }
  ]
  for (const options of cases) {
    const denied = await f.request('/api/auth/login', { method: 'POST', ...options, body: { username: 'admin', password } })
    assert.equal(denied.status, 403, denied.text)
  }
  const allowed = await f.request('/api/auth/login', { method: 'POST', hostHeader: 'app.example.test', origin: 'https://app.example.test', body: { username: 'admin', password } })
  assert.equal(allowed.status, 200, allowed.text)
})

test('REAL HTTP: malformed or multi-value Host and Origin fail closed', async t => {
  const f = await fixture(t)
  const invalidOrigins = [
    'https://app.example.test/',
    'https://app.example.test/path',
    'https://app.example.test?x=1',
    'https://app.example.test#fragment',
    'https://user@app.example.test',
    'ftp://app.example.test',
    'https://app.example.test, https://evil.example.test',
    'https://app.example.test\\evil',
    'https://app.example.test:',
    'https://app.example.test:65536'
  ]
  for (const origin of invalidOrigins) {
    const denied = await f.request('/api/auth/login', { method: 'POST', hostHeader: 'app.example.test', origin, body: { username: 'admin', password } })
    assert.equal(denied.status, 403, `${origin}: ${denied.text}`)
  }
  for (const hostHeader of ['app.example.test, evil.example.test', 'user@app.example.test', 'app..example.test', 'app.example.test:']) {
    const denied = await f.request('/api/auth/login', { method: 'POST', hostHeader, origin: 'https://app.example.test', body: { username: 'admin', password } })
    assert.equal(denied.status, 403, `${hostHeader}: ${denied.text}`)
  }
  const repeatedOrigin = await f.request('/api/auth/login', { method: 'POST', hostHeader: 'app.example.test', headers: { Origin: ['https://app.example.test', 'https://app.example.test'] }, body: { username: 'admin', password } })
  assert.equal(repeatedOrigin.status, 403, repeatedOrigin.text)
  const policy = createRequestSourcePolicy({ mode: 'auto', deny: () => Object.assign(new Error('denied'), { status: 403 }) })
  const duplicateHost = { headers: { host: 'first.example.test' }, headersDistinct: { host: ['first.example.test', 'second.example.test'], origin: ['https://first.example.test'] }, socket: {} }
  assert.throws(() => policy.assertSameOrigin(duplicateHost), { status: 403 })
})

test('fixed compatibility and explicit auto never promote the old public origin to a whitelist', async t => {
  const fixed = await fixture(t, { publicOrigin: 'https://old.example.test' })
  assert.equal(fixed.platform.context.originMode, 'fixed')
  const legacy = await fixed.request('/api/auth/login', { method: 'POST', hostHeader: 'alias.example.test', origin: 'https://old.example.test', body: { username: 'admin', password } })
  assert.equal(legacy.status, 200, legacy.text)
  assert.match([].concat(legacy.headers['set-cookie'] ?? []).join('; '), /(?:^|;\s*)Secure(?:;|$)/)
  const denied = await fixed.request('/api/auth/login', { method: 'POST', hostHeader: 'alias.example.test', origin: 'https://new.example.test', body: { username: 'admin', password } })
  assert.equal(denied.status, 403)

  const automatic = await fixture(t, { publicOrigin: 'https://old.example.test', originMode: 'auto' })
  assert.equal(automatic.platform.context.originMode, 'auto')
  const oldAlias = await automatic.request('/api/auth/login', { method: 'POST', hostHeader: 'new.example.test', origin: 'https://old.example.test', body: { username: 'admin', password } })
  assert.equal(oldAlias.status, 403, oldAlias.text)
  const newOrigin = await automatic.request('/api/auth/login', { method: 'POST', hostHeader: 'new.example.test', origin: 'https://new.example.test', body: { username: 'admin', password } })
  assert.equal(newOrigin.status, 200, newOrigin.text)
})

test('CLI config defaults to auto, permits fixed opt-in, and rejects invalid modes before data creation', async t => {
  const f = await startupFixture(t)
  await assert.rejects(createConfiguredPlatform({ ...f.env, HANDOFF_ORIGIN_MODE: 'trust-proxy' }), /HANDOFF_ORIGIN_MODE/)
  await assert.rejects(fs.lstat(f.env.HANDOFF_DATA_DIR), { code: 'ENOENT' })
  const automatic = await createConfiguredPlatform(f.env)
  f.apps.add(automatic)
  assert.equal(automatic.context.originMode, 'auto')
  await automatic.close()
  f.apps.delete(automatic)
  const fixed = await createConfiguredPlatform({ ...f.env, HANDOFF_ORIGIN_MODE: 'fixed', HANDOFF_PUBLIC_ORIGIN: 'https://old.example.test' })
  f.apps.add(fixed)
  assert.equal(fixed.context.originMode, 'fixed')
})
