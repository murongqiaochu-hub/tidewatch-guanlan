// 隔离品牌母版：4 条手写 Bezier 路径。没有应用接入或全局副作用。
export const colors = Object.freeze({ teal: '#064852', jade: '#19A98C', white: '#FFFFFF' });
export const paths = Object.freeze([
  'M0 263V110C0 49 55 0 125 0H415C464 0 500 33 510 85H202C130 85 91 124 91 201C56 209 23 234 0 263Z',
  'M245 228C269 197 289 179 331 179H491Q507 179 507 195V273C507 311 487 336 455 351C443 357 429 359 415 354C420 325 425 294 411 269C397 241 368 228 332 228Z',
  'M0 387C6 351 39 334 83 334C177 334 252 422 349 422C415 422 469 391 509 344C502 419 446 479 381 479H115C62 479 14 445 0 387Z',
  'M0 323C5 277 53 231 112 231C213 231 307 358 415 354C430 355 444 354 455 351C420 374 383 386 349 386C251 386 175 297 84 297C50 297 22 307 0 323Z',
]);
const NS = 'http://www.w3.org/2000/svg';
function palette(variant) {
  if (!['duotone', 'mono', 'reverse'].includes(variant)) throw new TypeError('Unknown logo variant');
  return variant === 'duotone' ? [colors.teal, colors.jade] : Array(2).fill(variant === 'mono' ? 'currentColor' : colors.white);
}
/** 原生 DOM 组件；label 为 null 时显式装饰性。不要将用户文字拼接为 SVG markup。 */
export function createGuanlanLogo({ document = globalThis.document, variant = 'duotone', size = 32, label = '观澜' } = {}) {
  const fills = palette(variant);
  if (!Number.isFinite(size) || size <= 0) throw new TypeError('size must be positive');
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 544 544', width: size, height: size, focusable: 'false', preserveAspectRatio: 'xMidYMid meet' })) svg.setAttribute(key, String(value));
  if (label === null) svg.setAttribute('aria-hidden', 'true');
  else {
    if (typeof label !== 'string' || !label.trim()) throw new TypeError('label must be nonempty or null');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
    const title = document.createElementNS(NS, 'title'); title.textContent = label; svg.append(title);
  }
  const group = document.createElementNS(NS, 'g'); group.setAttribute('transform', 'translate(16 32)');
  paths.forEach((d, i) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', fills[i === 3 ? 1 : 0]); group.append(p); });
  svg.append(group); return svg;
}
/** 固定品牌名称的独立 SVG；单色文件作为 img 使用时 currentColor 不继承宿主 CSS。 */
export function standaloneSVG(variant = 'duotone') {
  const fills = palette(variant);
  return `<svg xmlns="${NS}" viewBox="0 0 544 544" width="544" height="544" role="img" aria-label="观澜" focusable="false"><title>观澜</title><g transform="translate(16 32)">${paths.map((d, i) => `<path fill="${fills[i === 3 ? 1 : 0]}" d="${d}"/>`).join('')}</g></svg>\n`;
}
