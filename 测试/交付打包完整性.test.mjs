// Small isolated fixtures: no server, docker, network, credentials or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN = '发布审计/脚本/清洁发布包.mjs';
const CANDIDATE = '部署与运维/脚本/生成候选版.mjs';
const EPOCH = '1793059200';
const env = { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '', SOURCE_DATE_EPOCH: EPOCH, TZ: 'UTC' };
for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
const run = (args, cwd, overrides = {}) => spawnSync(args[0], args.slice(1), { cwd, env: { ...env, ...overrides }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const sha = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');
async function fixture(t, candidate = false) {
  const parent = await fs.realpath(process.env.HERON_AUDIT_TMP || os.tmpdir());
  const temp = await fs.mkdtemp(path.join(parent, 'handoff-package-test-'));
  const src = path.join(temp, 'src'); await fs.mkdir(src);
  t.after(async () => {
    assert.equal(await fs.realpath(temp), temp);
    assert.equal(path.dirname(temp), parent);
    await fs.rm(temp, { recursive: true, force: true });
  });
  for (const name of [CLEAN, ...(candidate ? [CANDIDATE] : [])]) {
    await fs.mkdir(path.dirname(path.join(src, name)), { recursive: true });
    await fs.copyFile(path.join(ROOT, name), path.join(src, name));
  }
  await fs.writeFile(path.join(src, 'README.md'), 'Synthetic package fixture\n');
  await fs.writeFile(path.join(src, 'package.json'), '{"type":"module"}\n');
  const checker = path.join(src, '部署与运维/脚本/环境检查.mjs');
  await fs.mkdir(path.dirname(checker), { recursive: true });
  await fs.writeFile(checker, 'console.log(JSON.stringify({ok:true,fixture:true}))\n');
  if (candidate) {
    await fs.mkdir(path.join(src, '构建'));
    await fs.writeFile(path.join(src, '构建/生成独立插件.mjs'), `import fs from 'node:fs/promises';
import path from 'node:path';
export async function generateStandalonePlugin({outputDirectory}) {
  await fs.mkdir(outputDirectory);
  for (const [name, text] of Object.entries({'main.js':'const fixture = true;\\n','ui.html':'<p>fixture</p>\\n','manifest.json':'{"name":"Fixture"}\\n','构建声明.json':'{"fixture":true}\\n'})) await fs.writeFile(path.join(outputDirectory,name),text);
}
`);
    for (const name of ['README.md', '01_安装与初始化.md', '02_升级回退与备份.md', '03_快速测试步骤.md']) {
      await fs.writeFile(path.join(src, '部署与运维', name), '# Synthetic runbook\n');
    }
    await fs.writeFile(path.join(src, '发布审计/18_实机测试清单初稿.md'), '# Synthetic checklist\n');
  }
  ok(run(['git', 'init', '-q', '--template='], src));
  ok(run(['git', 'add', '.'], src));
  ok(run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], src));
  return { temp, src };
}
test('清洁包：dry和WRITE都拒绝阻断，且不创建输出', async t => {
  const { src, temp } = await fixture(t);
  await fs.appendFile(path.join(src, 'README.md'), 'Synthetic address: 192.168.99.123\n');
  const dry = run([process.execPath, CLEAN, '--exclude-audit', '--dry-run'], src);
  assert.equal(dry.status, 2, dry.stderr);
  const out = path.join(temp, 'blocked');
  const write = run([process.execPath, CLEAN, '--exclude-audit', '--output', out, '--confirm-write'], src);
  assert.equal(write.status, 2, write.stdout + write.stderr);
  await assert.rejects(fs.lstat(out), { code: 'ENOENT' });
});
test('清洁包：顶层文件与目录symlink均拒绝', async t => {
  const { src, temp } = await fixture(t);
  const target = path.join(temp, 'external.txt'); await fs.writeFile(target, 'synthetic external\n');
  const readme = path.join(src, 'README.md');
  assert.equal(await fs.realpath(src), src);
  assert.equal(await fs.realpath(readme), readme);
  await fs.unlink(readme); await fs.symlink(target, readme);
  assert.notEqual(run([process.execPath, CLEAN, '--exclude-audit', '--output', path.join(temp, 'out-file'), '--confirm-write'], src).status, 0);
  assert.equal(await fs.realpath(readme), target);
  await fs.unlink(readme); await fs.writeFile(readme, 'fixture\n');
  await fs.symlink(temp, path.join(src, '平台'));
  assert.notEqual(run([process.execPath, CLEAN, '--exclude-audit', '--output', path.join(temp, 'out-dir'), '--confirm-write'], src).status, 0);
});
test('清洁包：环境检查可运行且进入SHA清单，清单无绝对ROOT', async t => {
  const { src, temp } = await fixture(t), out = path.join(temp, 'clean');
  ok(run([process.execPath, CLEAN, '--exclude-audit', '--output', out, '--confirm-write'], src));
  const sums = await fs.readFile(path.join(out, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /  部署与运维\/脚本\/环境检查[.]mjs\n/);
  assert.match(sums, /  发布审计\/脚本\/清洁发布包[.]mjs\n/, 'the distributed regression suite must retain its own packer input');
  ok(run([process.execPath, '部署与运维/脚本/环境检查.mjs'], out));
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(out, '发布清单.json'), 'utf8')), 'root'), false);
});
test('候选包：同epoch跨时间/TZ同字节，epoch控制ZIP及tar，不覆盖旧归档', async t => {
  const { src, temp } = await fixture(t, true);
  const build = (name, epoch = EPOCH, tz = 'UTC') => {
    const out = path.join(temp, name);
    ok(run([process.execPath, CANDIDATE, '--output', out, '--epoch', epoch], src, { TZ: tz }));
    return out;
  };
  const a = build('a');
  await new Promise(resolve => setTimeout(resolve, 3100));
  const b = build('b', EPOCH, 'Pacific/Honolulu');
  assert.equal(await sha(path.join(a, '插件开发包.zip')), await sha(path.join(b, '插件开发包.zip')));
  assert.equal(await sha(a + '.tar.gz'), await sha(b + '.tar.gz'));
  const c = build('c', String(Number(EPOCH) + 4));
  assert.notEqual(await sha(path.join(a, '插件开发包.zip')), await sha(path.join(c, '插件开发包.zip')));
  const list = ok(run(['tar', '--full-time', '-tvzf', c + '.tar.gz'], src));
  const stamp = new Date((Number(EPOCH) + 4) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  assert.ok(list.stdout.includes(stamp), list.stdout);
  const collision = path.join(temp, 'collision');
  await fs.writeFile(collision + '.tar.gz', 'keep existing\n');
  assert.notEqual(run([process.execPath, CANDIDATE, '--output', collision, '--epoch', EPOCH], src).status, 0);
  assert.equal(await fs.readFile(collision + '.tar.gz', 'utf8'), 'keep existing\n');
  assert.notEqual(run([process.execPath, CANDIDATE, '--output', path.join(temp, 'bad'), '--epoch', 'NaN'], src).status, 0);
});
test('交付runbook原文：备份真实合成数据，错误SHA禁止创建恢复目录', async t => {
  const { temp, src } = await fixture(t);
  const text = await fs.readFile(path.join(ROOT, '部署与运维/02_升级回退与备份.md'), 'utf8');
  const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
  assert.equal(blocks.length, 3);
  assert.match(text, /不得回灌/);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const data = path.join(temp, 'real-data'); await fs.mkdir(data);
  await fs.mkdir(path.join(data, 'assets'));
  await fs.writeFile(path.join(data, 'catalog.json'), '{"synthetic":true}\n');
  const backupRoot = path.join(temp, 'real-backups');
  assert.ok(blocks[1].includes('BACKUP_ROOT=/abs/own/test-backups'));
  const backupCode = blocks[1].replace('BACKUP_ROOT=/abs/own/test-backups', 'BACKUP_ROOT=' + quote(backupRoot));
  const result = ok(run(['bash', '-c', backupCode], src, { HANDOFF_DATA_DIR: data }));
  const backup = result.stdout.trim().split('\n').at(-1);
  assert.equal(path.dirname(backup), backupRoot);
  const validSums = await fs.readFile(path.join(backup, 'data.tar.gz.sha256'));
  await fs.writeFile(path.join(backup, 'data.tar.gz.sha256'), '0'.repeat(64) + '  data.tar.gz\n');
  const restore = path.join(temp, 'real-restore');
  const restoreCode = blocks[2]
    .replace('BACKUP=/abs/own/test-backups/<已核验的备份目录>', 'BACKUP=' + quote(backup))
    .replace('RESTORE=/abs/own/test-restore-data', 'RESTORE=' + quote(restore));
  const failed = run(['bash', '-c', restoreCode], src);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  await assert.rejects(fs.lstat(restore), { code: 'ENOENT' });
  await fs.writeFile(path.join(backup, 'data.tar.gz.sha256'), validSums);
  ok(run(['bash', '-c', restoreCode], src));
  assert.equal(await fs.readFile(path.join(restore, 'catalog.json'), 'utf8'), '{"synthetic":true}\n');
});
test('故障控制流：tar失败和SHA错误硬失败，未提取恢复数据', async t => {
  const { temp, src } = await fixture(t);
  const backup = path.join(temp, 'backup'); await fs.mkdir(backup);
  const fail = run(['bash', '-c', 'set -euo pipefail; tar -C "$1" -cf - . | gzip -n > "$2/partial"; touch "$2/success"', 'fixture', path.join(temp, 'missing'), backup], src);
  assert.notEqual(fail.status, 0);
  await assert.rejects(fs.lstat(path.join(backup, 'success')), { code: 'ENOENT' });
  const data = path.join(temp, 'data'); await fs.mkdir(data); await fs.writeFile(path.join(data, 'catalog.json'), '{}\n');
  ok(run(['tar', '-czf', path.join(backup, 'data.tar.gz'), '-C', data, '.'], src));
  await fs.writeFile(path.join(backup, 'data.tar.gz.sha256'), '0'.repeat(64) + '  data.tar.gz\n');
  const restore = path.join(temp, 'restore');
  const result = run(['bash', '-c', 'set -euo pipefail; cd "$1"; sha256sum -c data.tar.gz.sha256; mkdir "$2"; tar -xzf data.tar.gz -C "$2"', 'fixture', backup, restore], src);
  assert.notEqual(result.status, 0);
  await assert.rejects(fs.lstat(restore), { code: 'ENOENT' });
});
