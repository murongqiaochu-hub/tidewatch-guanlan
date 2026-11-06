#!/usr/bin/env node
// 本机回环演练：安装/初始化/健康/网页/错配/重启/备份恢复/旧版本回退。
// 只使用临时目录与合成数据；不接触生产数据、容器、网络或凭据。
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP = process.argv.includes('--keep');
const results = [];
const started = Date.now();
let temp;

const log = (step, ok, detail = '') => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitHealth(base, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('health timeout');
}

function startServer(codeDir, env) {
  const child = spawn(process.execPath, ['平台/启动.mjs'], { cwd: codeDir, env: { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  return { child, getOut: () => out, getErr: () => err };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const end = Date.now() + 10000;
  while (Date.now() < end && server.child.exitCode === null) await sleep(100);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function req(base, method, p, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function extractCommit(commit, dest, pathspec) {
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const archive = execFileSync('git', ['-C', ROOT, 'archive', commit, ...pathspec], { maxBuffer: 64 * 1024 * 1024 });
  const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'inherit'] });
  tar.stdin.end(archive);
  await new Promise((resolve, reject) => tar.once('close', code => code === 0 ? resolve() : reject(new Error('tar exit ' + code))));
}

async function expectStartupFailure(name, codeDir, env) {
  const s = startServer(codeDir, env);
  const end = Date.now() + 15000;
  while (Date.now() < end && s.child.exitCode === null) await sleep(100);
  const failed = s.child.exitCode !== null && s.child.exitCode !== 0;
  log('misconfig:' + name, failed, failed ? 'rejected as expected' : 'unexpectedly started');
  if (s.child.exitCode === null) await stopServer(s);
  return { failed, stderr: s.getErr().slice(0, 200) };
}

async function main() {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'heron-rehearsal-'));
  await fs.chmod(temp, 0o700);
  const data = path.join(temp, 'data');
  const secrets = path.join(temp, 'secrets');
  const backup = path.join(temp, 'backup');
  await fs.mkdir(secrets, { recursive: true, mode: 0o700 });
  const jwt = path.join(secrets, 'jwt');
  const admin = path.join(secrets, 'admin');
  const password = 'rehearsal-' + Math.random().toString(36).slice(2) + 'Aa1';
  await fs.writeFile(jwt, 'jwt-' + Math.random().toString(36).repeat(3), { mode: 0o600 });
  await fs.writeFile(admin, password, { mode: 0o600 });
  await fs.chmod(jwt, 0o600); await fs.chmod(admin, 0o600);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    HANDOFF_DATA_DIR: data, HANDOFF_JWT_SECRET_FILE: jwt, HANDOFF_ADMIN_PASSWORD_FILE: admin,
    HANDOFF_HOST: '127.0.0.1', HANDOFF_PORT: String(port), HANDOFF_PUBLIC_ORIGIN: origin,
  };

  // 1. install + init + health + login page
  let s = startServer(ROOT, env);
  let health = await waitHealth(origin);
  log('start', health.status === 'ok', `version ${health.version}`);
  const loginPage = await fetch(origin + '/login');
  log('login-page', loginPage.status === 200, 'HTTP ' + loginPage.status);
  const badLogin = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong-password' } });
  log('wrong-password', badLogin.status === 401, 'HTTP ' + badLogin.status);
  const login = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password } });
  log('login', login.status === 200 && typeof login.data?.token === 'string', 'HTTP ' + login.status);
  const token = login.data.token;
  const created = await req(origin, 'POST', '/api/projects', { token, body: { name: '合成测试项目 A' } });
  log('create-project', created.status === 201 && (created.data?.project?.name || created.data?.name) === '合成测试项目 A', 'HTTP ' + created.status);
  const list1 = await req(origin, 'GET', '/api/projects', { token });
  log('list-projects', list1.status === 200 && JSON.stringify(list1.data).includes('合成测试项目 A'));

  // 2. stop/restart persistence
  await stopServer(s);
  s = startServer(ROOT, env);
  await waitHealth(origin);
  const login2 = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password } });
  const list2 = await req(origin, 'GET', '/api/projects', { token: login2.data.token });
  log('restart-persistence', list2.status === 200 && JSON.stringify(list2.data).includes('合成测试项目 A'));

  // 3. backup then mutate
  await stopServer(s);
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.cp(data, backup, { recursive: true, preserveTimestamps: true });
  s = startServer(ROOT, env); await waitHealth(origin);
  const login3 = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password } });
  const token3 = login3.data.token;
  const b = await req(origin, 'POST', '/api/projects', { token: token3, body: { name: '升级后项目 B' } });
  log('post-upgrade-write', b.status === 201, 'HTTP ' + b.status);
  await stopServer(s);

  // 4. old code rollback against newer data
  const oldCode = path.join(temp, 'old-code');
  await extractCommit('7c6a9cf', oldCode, ['平台', '品牌', '宿主', '查看器', '插件', '构建', '界面', 'package.json']);
  let old = startServer(oldCode, env);
  try {
    await waitHealth(origin);
    const l = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password } });
    const pl = await req(origin, 'GET', '/api/projects', { token: l.data.token });
    const text = JSON.stringify(pl.data);
    log('rollback-old-code-reads-new-data', pl.status === 200 && text.includes('升级后项目 B'), 'HTTP ' + pl.status);
  } catch (error) {
    log('rollback-old-code-reads-new-data', false, error.message);
  } finally { await stopServer(old); }

  // 5. restore backup (pre-upgrade), start new code, expect A only
  await fs.rm(data, { recursive: true, force: true });
  await fs.cp(backup, data, { recursive: true, preserveTimestamps: true });
  s = startServer(ROOT, env); await waitHealth(origin);
  const l4 = await req(origin, 'POST', '/api/auth/login', { body: { username: 'admin', password } });
  const pl4 = await req(origin, 'GET', '/api/projects', { token: l4.data.token });
  const text4 = JSON.stringify(pl4.data);
  log('restore-backup', pl4.status === 200 && text4.includes('合成测试项目 A') && !text4.includes('升级后项目 B'));
  const h4 = await waitHealth(origin);
  log('restored-health', h4.status === 'ok', `frames ${h4.storage?.frames}`);
  await stopServer(s);

  // 6. misconfiguration checks
  await expectStartupFailure('missing-data-dir', ROOT, { ...env, HANDOFF_DATA_DIR: '' });
  await expectStartupFailure('missing-jwt', ROOT, { ...env, HANDOFF_JWT_SECRET_FILE: path.join(temp, 'nope') });
  const loose = path.join(secrets, 'loose');
  await fs.writeFile(loose, 'x'.repeat(32), { mode: 0o644 });
  await fs.chmod(loose, 0o644); // umask may narrow the requested mode; force the loose mode for the check
  await expectStartupFailure('loose-secret-mode', ROOT, { ...env, HANDOFF_JWT_SECRET_FILE: loose });
  await expectStartupFailure('invalid-port', ROOT, { ...env, HANDOFF_PORT: '70000' });

  const failed = results.filter(r => !r.ok);
  const summary = { ok: failed.length === 0, steps: results.length, failed: failed.map(f => f.step), durationMs: Date.now() - started, temp: KEEP ? temp : null, results };
  console.log(JSON.stringify(summary, null, 2));
  if (!KEEP) await fs.rm(temp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch(async error => {
  console.error('REHEARSAL ERROR', error);
  if (temp && !KEEP) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  process.exit(2);
});
