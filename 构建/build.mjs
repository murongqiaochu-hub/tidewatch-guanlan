import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compileESM } from './esm-compiler.mjs';
import { storedZip } from '../宿主/stored-zip.mjs';
import { validateProductionPluginManifest, CUSTOM_HTTPS_MODE, CUSTOM_HTTPS_REASON } from '../平台/插件发行.mjs';
import { BRAND, applyBrandTokens } from '../品牌/identity.mjs';
import { pluginServiceOrigins } from '../平台/服务地址.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const pluginFiles = Object.freeze(['core.mjs', 'portable-sha256.mjs', 'exporter.mjs', 'publisher.mjs', 'bridge.mjs', 'protocol.mjs', 'publication-visibility.mjs', 'publication-snapshot.mjs', 'pending-journal.mjs', 'production-protocol.mjs', 'production-session.mjs', 'main.mjs', 'resize.mjs', 'ui.mjs', 'ui.css', 'ui.html', 'manifest.dev.json'].map(f => '插件/' + f));
export const productionHostFiles = Object.freeze(['宿主/production-adapter.mjs', '宿主/production-shell.css']);
export const viewerFiles = Object.freeze(['查看器/index.mjs', '查看器/core.mjs', '查看器/resources.mjs', '查看器/inspector.css']);
export const hostFiles = Object.freeze(['宿主/synthetic-fixtures.mjs', '宿主/demo-server.mjs', '宿主/browser-adapter.mjs', '宿主/image-store.mjs', '宿主/stored-zip.mjs', '宿主/synthetic-publish.mjs', '宿主/raster-codec.mjs', '宿主/demo-shell.css']);
export const buildFiles = Object.freeze(['构建/build.mjs', '构建/esm-compiler.mjs', '构建/README.md', '构建/打包交付插件.mjs', '平台/插件发行.mjs', '平台/服务地址.mjs', '品牌/identity.mjs']);
const ownTests = ['测试/宿主测试工具.mjs', '测试/宿主安全.test.mjs', '测试/宿主图片与适配.test.mjs', '测试/宿主事务.test.mjs', '测试/宿主目录与撤权.test.mjs', '测试/宿主JPEG.test.mjs', '测试/构建编译.test.mjs', '测试/构建生产模式.test.mjs'];
const interfaceTests = ['测试/插件导出.test.mjs', '测试/插件发布桥.test.mjs', '测试/插件入口.test.mjs', '测试/查看器核心.test.mjs', '测试/查看器资源.test.mjs', '测试/查看器界面模型.test.mjs', '测试/查看器原生Fetch接收者.test.mjs', '测试/查看器生产兼容核心.test.mjs', '测试/查看器生产交互.test.mjs', '测试/查看器LOD过渡.test.mjs', '测试/生产适配器.test.mjs', '测试/插件生产协议.test.mjs', '测试/插件生产流程.test.mjs'];
const optionalDocuments = ['package.json', 'README.md', 'NOTICE.md', 'NOTICE', 'LICENSE', '来源记录/宿主与构建来源.md', '来源记录/插件来源与验收.md', '来源记录/查看器来源与验收.md', '来源记录/02_旧模块条件复用审计.json', '来源记录/03_可见图片与默认原生细节行为补充.md', '来源记录/04_主Agent浏览器整合修正.md', '来源记录/生产兼容核心来源.md', '来源记录/生产查看器交互来源.md', '来源记录/插件生产兼容来源.md'];
export function validateServiceOrigin(value) {
  if (value === undefined || value === null || value === '') return null;
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || /[\s*]/.test(value)) throw new TypeError('Explicit HTTPS serviceOrigin must be an exact origin');
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.startsWith('[') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) throw new TypeError('Development manifest does not allow private/literal-IP services');
  return u.origin;
}
export async function readAllowedFile(canonicalRoot, name) {
  if (typeof name !== 'string' || !name || path.posix.normalize(name) !== name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || /(?:secret|credential|backup|private.?key)/i.test(name)) throw new Error('Unsafe source allowlist path');
  const file = path.join(canonicalRoot, name);
  for (let candidate = file; candidate !== canonicalRoot; candidate = path.dirname(candidate)) {
    if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error('Source symlink denied: ' + name);
  }
  if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw new Error('Source is not an exact regular file');
  return fs.readFile(file);
}
async function writePrivate(file, bytes) {
  const directory = path.dirname(file); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const rootCanonical = await fs.realpath(root);
  for (let d = directory; d !== rootCanonical; d = path.dirname(d)) {
    if (!d.startsWith(rootCanonical + path.sep)) throw new Error('Build output outside authorized ROOT');
    if ((await fs.lstat(d)).isSymbolicLink()) throw new Error('Output symlink denied');
    await fs.chmod(d, 0o700);
  }
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Output file symlink denied');
    await fs.readFile(file); // Observe existing output before replacing it.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await fs.open(file, 'w', 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.chmod(0o600); } finally { await handle.close(); }
}
export function inlinePluginUI(html, css, compiledJS) {
  if (/<\/script/i.test(compiledJS) || /<\/style/i.test(css)) throw new Error('Unsafe HTML raw-text terminator in own source');
  let result = applyBrandTokens(html);
  const scripts = [...result.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?ui\.mjs["'][^>]*>\s*<\/script>/gi)];
  const styles = [...result.matchAll(/<link\b[^>]*\bhref\s*=\s*["'](?:\.\/)?ui\.css["'][^>]*>/gi)];
  if (scripts.length !== 1 || styles.length !== 1) throw new Error('UI requires exactly one explicit own ui.mjs and ui.css reference');
  result = result.replace(scripts[0][0], '<script type="module">\n' + compiledJS + '\n</script>');
  result = result.replace(styles[0][0], '<style>\n' + css + '\n</style>');
  if (/<script\b[^>]*\bsrc\s*=/i.test(result) || /<link\b[^>]*\bhref\s*=/i.test(result) || /\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i.test(result)) throw new Error('Plugin UI contains a non-inlined network resource');
  return result;
}
// Pure helpers: minimal frozen-module builds can share the exact production contract without writing build outputs.
export function productionPluginConfig({ serviceMode, serviceOrigin, legacyOrigins } = {}) {
  if (serviceMode !== undefined && serviceMode !== CUSTOM_HTTPS_MODE) throw new TypeError('Unknown serviceMode');
  if (serviceMode === CUSTOM_HTTPS_MODE) {
    if (serviceOrigin != null || legacyOrigins !== undefined) throw new TypeError('Custom HTTPS mode forbids default/legacy origins');
    return { serviceMode, serviceOrigin: null, serviceOrigins: [], allowLocalhost: false };
  }
  const origin = validateServiceOrigin(serviceOrigin);
  if (!origin) throw new TypeError('Production requires an exact HTTPS origin');
  return { serviceOrigin: origin, serviceOrigins: pluginServiceOrigins(origin, { legacy: legacyOrigins }), allowLocalhost: false };
}
export function productionPluginManifest({ serviceMode, serviceOrigin, pluginId, localDevelopmentId, retainExistingPrivateApi = false } = {}) {
  if (pluginId !== undefined && (typeof pluginId !== 'string' || !/^\d{5,40}$/.test(pluginId))) throw new TypeError('Numeric registered identity required');
  if (localDevelopmentId !== undefined && (localDevelopmentId !== 'heron-sync-stage0-local' || pluginId !== undefined)) throw new TypeError('Invalid existing identity');
  if (retainExistingPrivateApi && localDevelopmentId !== 'heron-sync-stage0-local') throw new TypeError('Private API retention requires existing identity');
  const manifest = { name: BRAND.pluginName, id: pluginId || localDevelopmentId, api: '1.0.0', main: 'main.js', ui: 'ui.html', editorType: ['figma'], documentAccess: 'dynamic-page', ...(retainExistingPrivateApi ? { enablePrivatePluginApi: true } : {}), networkAccess: { allowedDomains: serviceMode === CUSTOM_HTTPS_MODE ? ['*'] : [serviceOrigin], reasoning: serviceMode === CUSTOM_HTTPS_MODE ? CUSTOM_HTTPS_REASON : BRAND.networkReason } };
  validateProductionPluginManifest(manifest, { serviceMode, serviceOrigin, allowRetainedPrivateAPI: retainExistingPrivateApi });
  return manifest;
}
export async function buildProject({ serviceOrigin, serviceMode, pluginId, mode = 'development', production = false, localDevelopmentId, retainExistingPrivateApi = false, extraSourceFiles = [], expectedFileHashes = {}, legacyOrigins } = {}) {
  if (!['development', 'release'].includes(mode)) throw new TypeError('Build mode');
  if (pluginId !== undefined && !/^\d{5,40}$/.test(pluginId)) throw new TypeError('Explicit registered development plugin ID must be numeric');
  if (localDevelopmentId !== undefined && (!production || localDevelopmentId !== 'heron-sync-stage0-local' || pluginId !== undefined)) throw new TypeError('Only the existing explicitly selected local development identity is allowed in production compatibility builds');
  if (retainExistingPrivateApi && (!production || localDevelopmentId !== 'heron-sync-stage0-local')) throw new TypeError('Private API flag can only retain the existing local-plugin setting, never enable it implicitly');
  if (serviceMode !== undefined && (!production || serviceMode !== CUSTOM_HTTPS_MODE)) throw new TypeError('Explicit custom-https mode requires production');
  const config = production ? productionPluginConfig({ serviceMode, serviceOrigin, legacyOrigins }) : null;
  const canonical = await fs.realpath(root), origin = production ? config.serviceOrigin : validateServiceOrigin(serviceOrigin);
  if (production && !pluginId && !localDevelopmentId) throw new TypeError('Production compatibility requires explicit plugin identity');
  const productionManifest = production ? productionPluginManifest({ serviceMode, serviceOrigin: origin, pluginId, localDevelopmentId, retainExistingPrivateApi }) : null;
  const placeholder = !pluginId && !localDevelopmentId;
  const required = [...pluginFiles, ...viewerFiles, ...productionHostFiles, ...buildFiles, '来源记录/01_独立实现行为合同.md', ...extraSourceFiles, ...(mode === 'development' ? [...hostFiles, ...ownTests, ...interfaceTests] : ['宿主/stored-zip.mjs'])];
  const sources = new Map();
  for (const name of [...new Set(required)].sort()) sources.set(name, await readAllowedFile(canonical, name));
  for (const name of optionalDocuments) {
    try { sources.set(name, await readAllowedFile(canonical, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const allowedFileHashes = Object.fromEntries([...sources].map(([name, bytes]) => [name, hash(bytes)]));
  for (const [name, expected] of Object.entries(expectedFileHashes)) {
    if (allowedFileHashes[name] !== expected) throw new Error('Explicit source hash mismatch: ' + name);
  }
  const modules = new Map(pluginFiles.filter(f => f.endsWith('.mjs')).map(f => [f, applyBrandTokens(sources.get(f).toString('utf8'))]));
  const main = compileESM(modules, '插件/main.mjs'), ui = compileESM(modules, '插件/ui.mjs');
  // The new entry's declared automatic startPlugin(figma,__html__) bootstrap
  // is preserved byte-for-byte in its transformed body. Never add a second
  // invocation, Node crypto/TextEncoder shim, eval or runtime module loader.
  const productionBootstrap = production ? `const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify(config)});\n` : '';
  let uiHTML = inlinePluginUI(applyBrandTokens(sources.get('插件/ui.html').toString('utf8')), sources.get('插件/ui.css').toString('utf8'), productionBootstrap + ui.code);
  const mainCode = productionBootstrap + main.code;
  if (production) {
    const marker = /(<meta\s+name=["']independent-production["']\s+content=["'])disabled(["']\s*\/?>)/;
    if (!marker.test(uiHTML)) throw new Error('Production UI activation marker missing');
    uiHTML = uiHTML.replace(marker, '$1enabled$2');
  }
  const manifest = productionManifest || { name: production ? BRAND.pluginName : 'Independent Inspector · Development', id: pluginId || localDevelopmentId || 'REPLACE_WITH_REGISTERED_DEVELOPMENT_PLUGIN_ID', api: '1.0.0', main: 'main.js', ui: 'ui.html', editorType: ['figma'], documentAccess: 'dynamic-page', ...(retainExistingPrivateApi ? { enablePrivatePluginApi: true } : {}), networkAccess: origin ? { allowedDomains: [origin], reasoning: BRAND.networkReason } : { allowedDomains: ['none'] } };
  if (production) validateProductionPluginManifest(manifest, { serviceOrigin: origin, serviceMode, allowRetainedPrivateAPI: retainExistingPrivateApi });
  const outputs = new Map([['插件/main.js', Buffer.from(mainCode)], ['插件/ui.html', Buffer.from(uiHTML)], ['插件/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]]);
  for (const name of viewerFiles) outputs.set(name, sources.get(name));
  if (production) for (const name of productionHostFiles) outputs.set('查看器/' + path.posix.basename(name), sources.get(name));
  if (mode === 'development') for (const name of hostFiles) outputs.set(name, sources.get(name));
  const declaration = {
    contractVersion: 1, syntheticOnly: !production, mode, productionCompatibility: production, ...(serviceMode ? { serviceMode } : {}), serviceOrigin: origin, pluginIdPlaceholder: placeholder,
    localDevelopmentIdentity: localDevelopmentId || null, registeredPluginIdentityVerified: false, retainExistingPrivateApi,
    nativeGlibcCorrespondingSourceVersion: '2.36-9+deb12u14', commercialLicenseCleared: false, integratedPlatformLicenseObligations: production ? 'legacy AGPL-3.0 grants retained (LICENSE literal); new product license is DRAFT ONLY and not effective; third-party notices preserved' : null,
    inputContractSHA: allowedFileHashes['来源记录/01_独立实现行为合同.md'],
    allowedFileHashes, outputFileHashes: Object.fromEntries([...outputs].map(([name, bytes]) => [name, hash(bytes)])),
    topologicalOrder: { main: main.order, ui: ui.order },
    externalDemoDependencies: mode === 'development' ? [{ binary: '/usr/bin/vips', verifiedVersion: '8.14.1', scope: 'own synthetic PNG preview to JPEG only; ≤2048/4Mi pixels; single physical child', bundled: false, commercialLicenseCleared: false, licenseConclusion: 'NOT_ASSESSED' }] : [],
    limitations: ['No real Figma/device validation', 'No production migration/auth/account access', 'No legal clean-room or commercial-license certification', 'Static own-ESM subset, not a general JavaScript compiler', 'Release source excludes synthetic server fixtures/tests by default']
  };
  outputs.set('构建声明.json', Buffer.from(JSON.stringify(declaration, null, 2) + '\n'));
  const outputDirectory = production ? path.join(canonical, '构建产物', '生产兼容包') : mode === 'development' ? path.join(canonical, '开发包') : path.join(canonical, '构建产物', '发布包');
  for (const [name, bytes] of outputs) await writePrivate(path.join(outputDirectory, name), bytes);
  const zipEntries = [...sources].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) => ({ name, bytes }));
  zipEntries.push({ name: 'SourceParams.json', bytes: Buffer.from(JSON.stringify({ ...declaration, interface: { viewer: 'mountInspector(container,{adapter,initialFrameId,initialRevisionId})', main: 'startPlugin(figma,__html__)', serviceOrigin: 'explicit exact HTTPS origin; defaults to no network' } }, null, 2) + '\n') });
  const sourceZIP = storedZip(zipEntries);
  await writePrivate(path.join(canonical, '构建产物', production ? '生产兼容源码.zip' : mode === 'release' ? '独立发布源码.zip' : '独立开发源码.zip'), sourceZIP);
  await writePrivate(path.join(canonical, '构建产物', production ? '生产兼容构建声明.json' : mode === 'release' ? '发布构建声明.json' : '开发构建声明.json'), Buffer.from(JSON.stringify(declaration, null, 2) + '\n'));
  return { mode, production, allowedFileHashes, outputFileHashes: declaration.outputFileHashes, sourceZipSHA: hash(sourceZIP), sourceEntries: zipEntries.map(e => e.name), mainOrder: main.order, uiOrder: ui.order, pluginIdPlaceholder: placeholder };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}; const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service-origin') options.serviceOrigin = args[++i];
    else if (args[i] === '--service-mode') options.serviceMode = args[++i];
    else if (args[i] === '--plugin-id') options.pluginId = args[++i];
    else if (args[i] === '--release') options.mode = 'release';
    else if (args[i] === '--production-compat') options.production = true;
    else if (args[i] === '--existing-local-plugin-id') options.localDevelopmentId = args[++i];
    else if (args[i] === '--retain-existing-private-api') options.retainExistingPrivateApi = true;
    else throw new Error('Unknown build argument: ' + args[i]);
  }
  const result = await buildProject(options);
  console.log(JSON.stringify({ mode: result.mode, sources: Object.keys(result.allowedFileHashes).length, outputs: Object.keys(result.outputFileHashes).length, sourceZipSHA: result.sourceZipSHA, pluginIdPlaceholder: result.pluginIdPlaceholder, mainOrder: result.mainOrder, uiOrder: result.uiOrder }));
}
