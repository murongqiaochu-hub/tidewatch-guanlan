// One independently authored contract for production builders, packaging and HTTP delivery.
// Not imported by the SDK sandbox. Only Node built-ins and the existing stored-ZIP primitive.
import { crc32, sha256, storedZip } from '../宿主/stored-zip.mjs';
import { BRAND } from '../品牌/identity.mjs';
import { configuredServiceOrigin, isCanonicalLegacyHTTPOrigin } from './服务地址.mjs';

// 无公共默认服务地址：必须由显式参数或 HANDOFF_PUBLIC_ORIGIN 提供，避免静默连接。
export const DEFAULT_PLUGIN_ORIGIN = null;
export function resolveServiceOrigin(value) {
  const origin = value ?? configuredServiceOrigin();
  if (!origin) throw new TypeError('Plugin release requires an explicit serviceOrigin (HANDOFF_PUBLIC_ORIGIN)');
  return origin;
}
export const CUSTOM_HTTPS_MODE = 'custom-https';
export const CUSTOM_HTTPS_REASON = '用户可选择并填写自己的 HTTPS 自建服务器；插件仅向用户选择的服务器进行账户认证、设计稿发布与资源传输，不内置公共服务器。';
function customMode(serviceMode, serviceOrigin) {
  demand(serviceMode === undefined || serviceMode === CUSTOM_HTTPS_MODE, 'service_mode');
  if (serviceMode === CUSTOM_HTTPS_MODE) {
    demand(serviceOrigin === undefined || serviceOrigin === null, 'custom_has_no_default_origin');
    return true;
  }
  return false;
}
export const MAX_PLUGIN_ARCHIVE_BYTES = 2 * 1024 * 1024;
const names = ['main.js', 'ui.html', 'manifest.json', '发行信息.json', '安装说明.txt'];
const demand = (ok, code) => { if (!ok) throw new TypeError('Plugin release contract: ' + code); };
export function exactPluginHTTPSOrigin(value) {
  demand(typeof value === 'string' && !/[\s\\*]/.test(value), 'https_origin_required');
  let u; try { u = new URL(value); } catch { demand(false, 'https_origin_required'); }
  demand(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && value.replace(/\/$/, '') === u.origin, 'https_origin_required');
  demand(!['localhost','127.0.0.1','[::1]'].includes(u.hostname) && !u.hostname.endsWith('.local') && !u.hostname.endsWith('.localhost') && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname), 'public_https_required');
  return u.origin;
}
export function validateProductionPluginManifest(manifest, { serviceOrigin = DEFAULT_PLUGIN_ORIGIN, serviceMode, allowRetainedPrivateAPI = false } = {}) {
  const custom = customMode(serviceMode, serviceOrigin);
  const origin = custom ? null : exactPluginHTTPSOrigin(resolveServiceOrigin(serviceOrigin)), m = manifest;
  demand(m && !Array.isArray(m) && typeof m === 'object', 'manifest_object');
  demand(m.name === BRAND.pluginName && typeof m.id === 'string' && !/[\s\x00-\x1f\x7f]/.test(m.id) && (m.id === 'heron-sync-stage0-local' || /^\d{5,40}$/.test(m.id)) && m.api === '1.0.0', 'manifest_identity');
  if (custom) demand(/^\d{5,40}$/.test(m.id), 'custom_registered_identity_required');
  demand(m.main === 'main.js' && m.ui === 'ui.html' && m.documentAccess === 'dynamic-page' && JSON.stringify(m.editorType) === '["figma"]', 'manifest_files');
  const n = m.networkAccess;
  demand(n && typeof n === 'object' && !Array.isArray(n) && JSON.stringify(n.allowedDomains) === JSON.stringify(custom ? ['*'] : [origin]), 'only_exact_https_allowed');
  demand(!Object.hasOwn(n, 'devAllowedDomains') && Object.keys(n).every(k => ['allowedDomains','reasoning'].includes(k)), 'no_development_network_permissions');
  demand(typeof n.reasoning === 'string' && n.reasoning.trim().length > 0 && n.reasoning.length <= 1024, 'network_reasoning');
  if (custom) {
    demand(/HTTPS/i.test(n.reasoning) && /用户/.test(n.reasoning) && /自建服务器/.test(n.reasoning), 'custom_network_reasoning');
    demand(!Object.hasOwn(m, 'enablePrivatePluginApi'), 'no_custom_private_api');
  }
  demand(!Object.hasOwn(m, 'enableProposedApi') && (m.enablePrivatePluginApi === undefined || allowRetainedPrivateAPI && m.enablePrivatePluginApi === true), 'no_implicit_private_api');
  return origin;
}
const isLegacyHTTPOrigin = isCanonicalLegacyHTTPOrigin;
function validateRuntime(files, origin, serviceMode) {
  const main = files.get('main.js')?.toString('utf8'), ui = files.get('ui.html')?.toString('utf8');
  demand(typeof main === 'string' && typeof ui === 'string' && !main.includes('HERON_QA_') && !ui.includes('HERON_QA_'), 'clean_runtime_required');
  const prefix = /^const __INDEPENDENT_PRODUCTION__ = Object\.freeze\((\{[^\n]+\})\);\r?\n/.exec(main);
  demand(prefix, 'explicit_production_runtime');
  let config; try { config = JSON.parse(prefix[1]); } catch { demand(false, 'production_runtime_json'); }
  demand(config.serviceOrigin === origin && config.allowLocalhost === false && config.serviceMode === serviceMode, 'runtime_origin_mismatch');
  if (serviceMode === CUSTOM_HTTPS_MODE) demand(Object.keys(config).sort().join(',') === 'allowLocalhost,serviceMode,serviceOrigin,serviceOrigins' && Array.isArray(config.serviceOrigins) && config.serviceOrigins.length === 0, 'custom_runtime_config');
  // 附加地址来自部署配置（HANDOFF_LEGACY_LAN_ORIGINS / 构建参数），但只允许
  // 非公网可路由的 HTTP 遗留地址（RFC1918、.local/.test/.example/.invalid、单标签主机），
  // 防止伪造发行把任意公网 origin 塞进插件。
  const extra = config.serviceOrigins;
  demand(serviceMode === CUSTOM_HTTPS_MODE || extra === undefined || (
    Array.isArray(extra) && extra.length >= 1 && extra.length <= 8 &&
    extra.includes(origin) && new Set(extra).size === extra.length &&
    extra.every(value => typeof value === 'string' && value.length <= 2048 && (value === origin || isLegacyHTTPOrigin(value)))
  ), 'runtime_origin_list_mismatch');
  demand(/<meta\s+name=["']independent-production["']\s+content=["']enabled["']\s*\/?>/.test(ui), 'production_ui_required');
  const scripts = [...ui.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  demand(scripts.length === 1, 'single_inline_ui_runtime_required');
  const uiPrefix = /^\s*const __INDEPENDENT_PRODUCTION__ = Object\.freeze\((\{[^\n]+\})\);\r?\n/.exec(scripts[0][1]);
  demand(uiPrefix, 'explicit_ui_production_runtime');
  let uiConfig; try { uiConfig = JSON.parse(uiPrefix[1]); } catch { demand(false, 'ui_production_runtime_json'); }
  demand(JSON.stringify(Object.keys(uiConfig).sort()) === JSON.stringify(Object.keys(config).sort()) && Object.keys(config).every(key => JSON.stringify(uiConfig[key]) === JSON.stringify(config[key])), 'ui_runtime_config_mismatch');
}
// Strict bounded ZIP32/STORED reader: central/local agreement, CRC, no aliases, links,
// duplicates, overlapping entries, trailing data, compression or path traversal.
export function readStoredPluginZIP(value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  demand(b.length >= 22 && b.length <= MAX_PLUGIN_ARCHIVE_BYTES, 'archive_size');
  const end = b.length - 22;
  demand(b.readUInt32LE(end) === 0x06054b50 && b.readUInt16LE(end + 4) === 0 && b.readUInt16LE(end + 6) === 0 && b.readUInt16LE(end + 20) === 0, 'zip_end');
  const count = b.readUInt16LE(end + 10), size = b.readUInt32LE(end + 12), start = b.readUInt32LE(end + 16);
  demand(count >= 3 && count <= names.length && count === b.readUInt16LE(end + 8) && start + size === end, 'zip_directory');
  const files = new Map(); let p = start, nextLocal = 0;
  for (let i = 0; i < count; i++) {
    demand(p + 46 <= end && b.readUInt32LE(p) === 0x02014b50, 'zip_entry');
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), bytes = b.readUInt32LE(p + 24), length = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42), mode = b.readUInt32LE(p + 38) >>> 16;
    demand(flags === 0x800 && method === 0 && bytes === b.readUInt32LE(p + 20) && extra === 0 && comment === 0 && b.readUInt16LE(p + 34) === 0 && (mode & 0o170000) === 0o100000, 'zip_entry_type');
    demand(p + 46 + length <= end && local === nextLocal && local + 30 <= start && b.readUInt32LE(local) === 0x04034b50, 'zip_local');
    const nameBytes = b.subarray(p + 46, p + 46 + length), name = nameBytes.toString('utf8');
    demand(names.includes(name) && !files.has(name) && nameBytes.equals(Buffer.from(name, 'utf8')), 'zip_filename');
    demand(b.readUInt16LE(local + 6) === flags && b.readUInt16LE(local + 8) === method && b.readUInt32LE(local + 14) === crc && b.readUInt32LE(local + 18) === bytes && b.readUInt32LE(local + 22) === bytes && b.readUInt16LE(local + 26) === length && b.readUInt16LE(local + 28) === 0, 'zip_local_mismatch');
    const dataStart = local + 30 + length, dataEnd = dataStart + bytes;
    demand(dataEnd <= start && b.subarray(local + 30, dataStart).equals(nameBytes), 'zip_local_name');
    const data = b.subarray(dataStart, dataEnd); demand(crc32(data) === crc, 'zip_crc');
    files.set(name, data); nextLocal = dataEnd; p += 46 + length;
  }
  demand(p === end && nextLocal === start && ['main.js','ui.html','manifest.json'].every(n => files.has(n)), 'zip_complete');
  return files;
}
export function inspectPluginRelease(bytes, { serviceOrigin = DEFAULT_PLUGIN_ORIGIN, serviceMode } = {}) {
  const files = readStoredPluginZIP(bytes); let manifest, release;
  try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); release = JSON.parse(files.get('发行信息.json')?.toString('utf8')); } catch { demand(false, 'release_json_required'); }
  const origin = validateProductionPluginManifest(manifest, { serviceOrigin, serviceMode }); validateRuntime(files, origin, serviceMode);
  demand(files.has('安装说明.txt') && files.get('安装说明.txt').length > 0, 'installation_instructions_required');
  demand(release?.schema === (serviceMode === CUSTOM_HTTPS_MODE ? 2 : 1) && release.serviceMode === serviceMode && typeof release.release === 'string' && /^C[1-9]\d{0,3}$/.test(release.release) && typeof release.date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(release.date) && Number.isFinite(Date.parse(release.date)) && new Date(release.date).toISOString().slice(0,10) === release.date, 'release_version');
  if (serviceMode === CUSTOM_HTTPS_MODE) demand(Object.keys(release).sort().join(',') === 'date,files,release,schema,serviceMode,serviceOrigin', 'custom_release_config');
  demand(release.serviceOrigin === origin && ['main.js','ui.html','manifest.json'].every(n => release.files?.[n] === sha256(files.get(n))), 'mixed_release_files');
  return { release: release.release, date: release.date, serviceOrigin: origin, ...(serviceMode ? { serviceMode } : {}), sha256: sha256(bytes), bytes: bytes.length, filename: BRAND.releaseFileName, manifest, files };
}
export function packagePluginRelease(input, { serviceOrigin = DEFAULT_PLUGIN_ORIGIN, serviceMode, release, date } = {}) {
  const files = new Map(['main.js','ui.html','manifest.json'].map(n => [n, Buffer.from(input instanceof Map ? input.get(n) : input[n])]));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8')), origin = validateProductionPluginManifest(manifest, { serviceOrigin, serviceMode }); validateRuntime(files, origin, serviceMode);
  files.set('发行信息.json', Buffer.from(JSON.stringify({ schema: serviceMode === CUSTOM_HTTPS_MODE ? 2 : 1, release, date, ...(serviceMode ? { serviceMode } : {}), serviceOrigin: origin, files: Object.fromEntries([...files].map(([n,b]) => [n,sha256(b)])) }, null, 2) + '\n'));
  files.set('安装说明.txt', Buffer.from(`${BRAND.pluginName} · ${release} · ${date}\n\n1. 将本压缩包完整解压到一个新文件夹，不要覆盖或导入旧的 plugin 解压目录。\n2. 在 Figma 开发插件中导入这个新文件夹内的 manifest.json；不要导入旧目录，也不要只替换单个文件。\n3. ${serviceMode === CUSTOM_HTTPS_MODE ? '在插件设置中填写你自己的 HTTPS 自建服务器地址；本发行版不内置默认服务器。通配网络权限仅用于连接用户选择的服务器，不申请开发网络或私有 API 权限。' : `插件服务地址使用 ${origin}。本发行版不申请 HTTP、通配符或开发网络权限，不需要手工修改清单。`}\n4. 如 Figma 中存在同名旧开发插件，核对其本地目录后再选择新目录的插件；不要删除设计文件。\n5. 如仍有清单错误，请提交本目录的 manifest.json 和发行信息.json，不要发送任何账号密码。\n`));
  const bytes = storedZip([...files].map(([name, bytes]) => ({name, bytes}))); inspectPluginRelease(bytes, { serviceOrigin: origin, serviceMode }); return bytes;
}
