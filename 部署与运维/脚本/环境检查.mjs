#!/usr/bin/env node
// 只读环境检查：不启动服务、不写数据、不读取密钥内容。
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = arg('--data-dir');
const port = Number(arg('--port') || 0);

const checks = [];
const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

const major = Number(process.versions.node.split('.')[0]);
add('node', major >= 22, `Node ${process.versions.node} (requires >=22)`);
add('platform', process.platform === 'linux' && process.arch === 'x64', `${process.platform}/${process.arch}`);

for (const cmd of ['cc', 'dpkg-deb', 'tar', 'gzip', 'sha256sum', 'curl']) {
  let ok = true;
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); } catch { ok = false; }
  add('cmd:' + cmd, ok, ok ? 'found' : 'missing (optional unless building/running codec or backups)');
}

if (dataDir) {
  try {
    const st = await fs.lstat(dataDir);
    const isDir = st.isDirectory();
    const mode = st.mode & 0o777;
    add('data-dir', isDir, isDir ? `exists mode ${mode.toString(8)}` : 'not a directory');
    if (isDir) {
      const entries = await fs.readdir(dataDir);
      add('data-dir-empty', entries.length === 0, `${entries.length} entries (bootstrap requires empty or missing)`);
      try { await fs.access(dataDir, fs.constants.W_OK); add('data-dir-writable', true, 'writable'); }
      catch { add('data-dir-writable', false, 'not writable'); }
      add('data-dir-mode', (mode & 0o077) === 0, `mode ${mode.toString(8)} (expect 700)`);
    }
  } catch (error) {
    add('data-dir', error.code === 'ENOENT', error.code === 'ENOENT' ? 'missing (will be created)' : String(error.code));
  }
}

for (const [env, label] of [['HANDOFF_JWT_SECRET_FILE', 'jwt-secret'], ['HANDOFF_ADMIN_PASSWORD_FILE', 'admin-password']]) {
  const file = process.env[env];
  if (!file) { add(label, false, env + ' not set'); continue; }
  try {
    const st = await fs.lstat(file);
    const ok = st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= 16384 && (st.mode & 0o077) === 0;
    add(label, ok, ok ? 'private regular file' : `mode ${(st.mode & 0o777).toString(8)} or type/size invalid`);
  } catch (error) { add(label, false, String(error.code)); }
}

if (port) {
  const free = await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
  add('port', free, `${port} ${free ? 'free on 127.0.0.1' : 'in use'}`);
}

const codec = path.resolve('原生编码器/运行时/heron-codec');
try { const st = await fs.lstat(codec); add('codec', st.isFile(), st.isFile() ? 'present' : 'not a file'); }
catch { add('codec', false, 'not built (preview returns 503 until built/configured)'); }

const errors = checks.filter(c => !c.ok && ['node', 'platform', 'data-dir', 'data-dir-writable', 'data-dir-mode', 'jwt-secret', 'admin-password', 'port'].includes(c.id));
console.log(JSON.stringify({ ok: errors.length === 0, errors: errors.map(e => e.id), checks }, null, 2));
process.exit(errors.length ? 1 : 0);
