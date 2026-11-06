// 服务地址的显式配置入口。
// 原则：仓库不内置任何公共/个人默认服务器；未配置时明确报错，绝不静默连接。
// 原部署继续兼容：生产 compose 已设置 HANDOFF_PUBLIC_ORIGIN；
// 旧内网地址通过 HANDOFF_LEGACY_LAN_ORIGINS（逗号分隔）显式声明，默认空。
export const SERVICE_ORIGIN_ENV = 'HANDOFF_PUBLIC_ORIGIN';
export const LEGACY_ORIGINS_ENV = 'HANDOFF_LEGACY_LAN_ORIGINS';

const trimOrigin = value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';

export function configuredServiceOrigin(env = process.env) {
  return trimOrigin(env?.[SERVICE_ORIGIN_ENV]) || null;
}

export function requiredServiceOrigin(env = process.env) {
  const origin = configuredServiceOrigin(env);
  if (!origin) {
    throw new Error(
      `${SERVICE_ORIGIN_ENV} is not configured. This build has no public default server; ` +
      'set the exact HTTPS service origin explicitly (see 平台/README.md, section 来源地址与插件).'
    );
  }
  return origin;
}

export function isCanonicalLegacyHTTPOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\*]/.test(value)) return false;
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin) return false;
  const host = url.hostname;
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(part => Number(part) <= 255);
  const privateIPv4 = ipv4 && (host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host));
  return privateIPv4 || /\.(?:local|test|example|invalid)$/.test(host) || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host);
}

export function legacyLanOrigins(env = process.env, explicit) {
  const raw = explicit ?? env?.[LEGACY_ORIGINS_ENV] ?? '';
  const origins = String(raw).split(',').map(trimOrigin).filter(Boolean);
  if (!origins.every(isCanonicalLegacyHTTPOrigin)) throw new TypeError('Legacy origins must be exact canonical private/reserved HTTP origins');
  return origins;
}

export function pluginServiceOrigins(origin, { env = process.env, legacy } = {}) {
  if (!origin) throw new Error('pluginServiceOrigins requires an explicit service origin');
  const origins = [...new Set([origin, ...legacyLanOrigins(env, legacy)])];
  if (origins.length > 8) throw new TypeError('At most eight plugin service origins are supported');
  return origins;
}
