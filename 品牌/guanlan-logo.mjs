// 观澜品牌标志的唯一字符串事实源（2026-10-27 用户批准；几何与颜色取自
// 品牌/观澜参考还原_20261027/logo.mjs 的 4 条手写 Bezier 母版，不重画、不描摹）。
// 本文件只产出 HTML/SVG 字符串，不依赖 DOM，供平台网页与插件构建共用。
export const LOGO_COLORS = Object.freeze({ teal: '#064852', jade: '#19A98C', white: '#FFFFFF' });
export const LOGO_PATHS = Object.freeze([
  'M0 263V110C0 49 55 0 125 0H415C464 0 500 33 510 85H202C130 85 91 124 91 201C56 209 23 234 0 263Z',
  'M245 228C269 197 289 179 331 179H491Q507 179 507 195V273C507 311 487 336 455 351C443 357 429 359 415 354C420 325 425 294 411 269C397 241 368 228 332 228Z',
  'M0 387C6 351 39 334 83 334C177 334 252 422 349 422C415 422 469 391 509 344C502 419 446 479 381 479H115C62 479 14 445 0 387Z',
  'M0 323C5 277 53 231 112 231C213 231 307 358 415 354C430 355 444 354 455 351C420 374 383 386 349 386C251 386 175 297 84 297C50 297 22 307 0 323Z',
]);
const VARIANTS = Object.freeze(['duotone', 'mono', 'reverse']);
function fillsFor(variant) {
  if (!VARIANTS.includes(variant)) throw new TypeError('Unknown logo variant');
  if (variant === 'duotone') return [LOGO_COLORS.teal, LOGO_COLORS.jade];
  return Array(2).fill(variant === 'mono' ? 'currentColor' : LOGO_COLORS.white);
}
function paint(fills) {
  return LOGO_PATHS.map((d, i) => `<path fill="${fills[i === 3 ? 1 : 0]}" d="${d}"></path>`).join('');
}
/** 内联标志（深底用 reverse 反白，浅底用 duotone 双色）。装饰性时 label 为 null。 */
export function brandMarkSVG({ variant = 'reverse', size = 30, className = 'brand-symbol', label = null } = {}) {
  if (!Number.isFinite(size) || size <= 0) throw new TypeError('size must be positive');
  if (label !== null && (typeof label !== 'string' || !label.trim())) throw new TypeError('label must be nonempty or null');
  const a11y = label === null
    ? 'aria-hidden="true" focusable="false"'
    : `role="img" aria-label="${label.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}"`;
  return `<svg class="${className}" viewBox="0 0 544 544" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" ${a11y}><g transform="translate(16 32)">${paint(fillsFor(variant))}</g></svg>`;
}
/** 浏览器标签页图标：单色玉绿，以内联 data URI 提供，不新增静态路由。 */
export function faviconDataURI({ fill = LOGO_COLORS.jade, size = 64 } = {}) {
  if (typeof fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(fill)) throw new TypeError('fill must be a 6-digit hex colour');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 544 544" width="${size}" height="${size}"><g transform="translate(16 32)">${paint([fill, fill])}</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
