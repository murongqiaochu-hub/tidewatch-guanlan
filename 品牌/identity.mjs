// 单一品牌事实源（single source of truth）。
// 产品显示名为“Tidewatch 观澜”；商标、同名产品与域名尚未核验，见项目根目录 BRANDING.md。
// 改名的唯一入口：修改本文件常量，再运行 `node --test 测试/*.test.mjs` 与构建。
// 未解析的品牌占位符会让构建直接抛错，避免半改名产物。
// 保持不变：既有插件 ID、协议名与请求/响应头；显示品牌变更不涉及运行身份。
// x-heron-* 与 heron-* 是内部协议/存储兼容标记，不能为显示品牌更名而改动。
import { brandMarkSVG } from './guanlan-logo.mjs';
export const BRAND = Object.freeze({
  pluginName: 'Tidewatch 观澜',
  product: '观澜',
  subtitle: 'Tidewatch 设计交付',
  releaseFileName: 'tidewatch.zip',
  networkReason: '用于连接 Tidewatch 观澜交付服务，完成账户认证、项目读取与设计稿发布。',
  status: 'NAME_DECIDED_20261102',
  decisionRecord: 'BRANDING.md',
});

export const BRAND_TOKENS = Object.freeze({
  '{{BRAND_PLUGIN_NAME}}': BRAND.pluginName,
  '{{BRAND_PRODUCT}}': BRAND.product,
  '{{BRAND_SUBTITLE}}': BRAND.subtitle,
  '{{BRAND_NETWORK_REASON}}': BRAND.networkReason,
  '{{BRAND_LOGO_SVG}}': brandMarkSVG({ variant: 'reverse', size: 30, className: 'brand-symbol' }),
});

const UNRESOLVED = /\{\{BRAND_[A-Z_]+\}\}/;

export function applyBrandTokens(text) {
  let out = String(text);
  for (const [token, value] of Object.entries(BRAND_TOKENS)) out = out.split(token).join(value);
  if (UNRESOLVED.test(out)) throw new Error('Unresolved brand token in build input');
  return out;
}

export function brandAllowsName(name) {
  return name === BRAND.pluginName;
}
