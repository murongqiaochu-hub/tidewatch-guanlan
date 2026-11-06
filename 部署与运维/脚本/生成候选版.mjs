#!/usr/bin/env node
// 生成开发候选包：清洁源码 + 运行手册 + 插件开发包 + 版本清单。
// 不发布、不上传；插件默认使用占位 origin，仅供界面/构建检查，真机登录需重建。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateStandalonePlugin } from '../../构建/生成独立插件.mjs';

const ROOT = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const requestedOut = arg('--output');
const epoch = arg('--epoch') ?? '1793059200'; // 2026-10-27T00:00:00Z
if (!/^[0-9]+$/.test(epoch) || !Number.isSafeInteger(Number(epoch)) || Number(epoch) < 315532800 || Number(epoch) > 4354819199) throw new Error('epoch must fit ZIP timestamps (1980–2107)');
if (!requestedOut || !path.isAbsolute(requestedOut)) throw new Error('Explicit absolute --output required');
const resolvedOut = path.resolve(requestedOut);
const out = path.join(await fs.realpath(path.dirname(resolvedOut)), path.basename(resolvedOut));
if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error('Output must be outside the repository');
try { if ((await fs.lstat(out)).isSymbolicLink()) throw new Error('Output symlink refused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const chmodTree = async dir => {
  const walk = async d => {
    await fs.chmod(d, 0o700);
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else if (e.isFile()) await fs.chmod(p, 0o600);
    }
  };
  await walk(dir);
};

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const short = commit.slice(0, 7);
const generatedAt = new Date(Number(epoch) * 1000).toISOString();

await fs.mkdir(out, { recursive: true, mode: 0o700 });
await fs.chmod(out, 0o700);
if ((await fs.readdir(out)).length) throw new Error('Output directory must be empty');

const srcDir = path.join(out, '源码');
const docDir = path.join(out, '文档');
const pluginDir = path.join(out, '插件开发包');
await fs.mkdir(docDir, { recursive: true, mode: 0o700 });

// 1) clean source package
execFileSync(process.execPath, [path.join(ROOT, '发布审计/脚本/清洁发布包.mjs'), '--exclude-audit', '--output', srcDir, '--confirm-write'], {
  cwd: ROOT, env: { ...process.env, SOURCE_DATE_EPOCH: epoch, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '' }, stdio: 'inherit',
});

// 2) runbook + checklist
for (const name of ['README.md', '01_安装与初始化.md', '02_升级回退与备份.md', '03_快速测试步骤.md']) {
  await fs.copyFile(path.join(ROOT, '部署与运维', name), path.join(docDir, name));
}
await fs.copyFile(path.join(ROOT, '发布审计/18_实机测试清单初稿.md'), path.join(docDir, '实机测试清单.md'));
await chmodTree(docDir);

// 3) plugin dev bundle (placeholder origin; rebuild for real service)
const PLACEHOLDER = 'https://service.example.test:49156';
await generateStandalonePlugin({ serviceOrigin: PLACEHOLDER, localDevelopmentId: 'heron-sync-stage0-local', outputDirectory: pluginDir });
await chmodTree(pluginDir);
const pluginManifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'manifest.json'), 'utf8'));
await fs.writeFile(path.join(pluginDir, '安装说明.txt'), [
  '开发候选插件包（非正式发行）',
  '',
  '1. 本包的服务器地址是占位地址 https://service.example.test:49156，不能用于真实登录。',
  '2. 真机测试请用你自己的服务地址重建：',
  '   node 构建/生成独立插件.mjs --service-origin https://<你的测试地址> --local-plugin-id heron-sync-stage0-local --output <新目录>',
  '3. 在 Figma「开发插件」中导入新目录内的 manifest.json；不要覆盖旧目录。',
  '4. 当前名称沿用开发名，商业名称未定；不要把本包当作正式发行或官方插件。',
  '',
].join('\n'), { mode: 0o600 });

// 4) version manifest
const tree = async dir => {
  const files = [];
  const walk = async rel => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) files.push(child);
    }
  };
  await walk('');
  files.sort();
  const sums = [];
  for (const f of files) sums.push(sha(await fs.readFile(path.join(dir, f))) + '  ' + f);
  return { files: files.length, treeSha256: sha(Buffer.from(sums.join('\n'))), sums };
};
const sourceTree = await tree(srcDir);
const pluginFiles = await tree(pluginDir);

await chmodTree(pluginDir);
const zipPath = path.join(out, '插件开发包.zip');
// -X does not remove ZIP's DOS timestamps. Fix time, timezone and member order.
const pluginNames = pluginFiles.sums.map(sum => sum.slice(66));
for (const name of pluginNames) await fs.utimes(path.join(pluginDir, name), Number(epoch), Number(epoch));
execFileSync('zip', ['-X', '-q', zipPath, ...pluginNames], { cwd: pluginDir, env: { ...process.env, TZ: 'UTC' } });
const zipSha = sha(await fs.readFile(zipPath));

const version = {
  kind: 'DEV_CANDIDATE_NOT_A_RELEASE',
  commit,
  commitShort: short,
  generatedAt,
  temporaryTitle: '沿用现有开发名（未定商业品牌）',
  sourcePackage: { path: '源码', files: sourceTree.files, treeSha256: sourceTree.treeSha256 },
  plugin: {
    path: '插件开发包', files: pluginFiles.files, treeSha256: pluginFiles.treeSha256,
    zipSha256: zipSha, manifestName: pluginManifest.name, placeholderOrigin: PLACEHOLDER,
    rebuildCommand: 'node 构建/生成独立插件.mjs --service-origin https://<你的测试地址> --local-plugin-id heron-sync-stage0-local --output <新目录>',
  },
  buildCommands: [
    '开发工程：node 部署与运维/脚本/生成候选版.mjs --output <绝对新目录> --epoch <整数秒>',
    '客户插件：node 构建/生成独立插件.mjs --service-origin <origin> --local-plugin-id heron-sync-stage0-local --output <绝对新目录>',
  ],
  verified: '本清单仅标识构建输入和产物；验收结果须查对应独立证据，不自动宣称通过',
  limits: ['插件占位 origin 不能真实登录', '无 TLS/反向代理', '未跑 24k/8k 与 Docker profile', '候选版不是正式发行'],
};
await fs.writeFile(path.join(out, '版本清单.json'), JSON.stringify(version, null, 2) + '\n', { mode: 0o600 });

await chmodTree(out);
// 5) checksums over candidate (excluding SHA256SUMS itself) + deterministic tar
const all = await tree(out);
const sumsPath = path.join(out, 'SHA256SUMS');
await fs.writeFile(sumsPath, all.sums.join('\n') + '\n', { mode: 0o600 });
await fs.chmod(sumsPath, 0o600);

const tarPath = path.join(path.dirname(out), path.basename(out) + '.tar.gz');
execFileSync('bash', ['-c', 'set -euo pipefail; set -C; tar --sort=name --mtime="@$3" --owner=0 --group=0 --numeric-owner -C "$1" -cf - . | gzip -n > "$2"', 'candidate-archive', out, tarPath, epoch]);
console.log(JSON.stringify({ out, commit: short, sourceFiles: sourceTree.files, pluginFiles: pluginFiles.files, pluginZip: zipSha, tar: tarPath, tarSha256: sha(await fs.readFile(tarPath)) }, null, 2));
