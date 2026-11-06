// 观澜品牌与墨绿主题的定向断言（2026-10-27）。
// 范围：显示名称、标志几何/配色、可见品牌入口、暗色主题 tokens 与对比度。
// 不覆盖认证、权限、发布事务、CAS 或任何安全回归；本文件不启动服务、不发起网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { BRAND, BRAND_TOKENS, applyBrandTokens } from '../品牌/identity.mjs';
import { LOGO_COLORS, LOGO_PATHS, brandMarkSVG, faviconDataURI } from '../品牌/guanlan-logo.mjs';

const read = name => fs.readFile(new URL('../' + name, import.meta.url), 'utf8');
const hexLum = hex => {
  const m = String(hex).replace('#', '').match(/../g);
  if (!m || m.length !== 3) throw new TypeError('not a 6-digit hex colour: ' + hex);
  return m.map(s => parseInt(s, 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
};
const ratio = (a, b) => {
  const [hi, lo] = [hexLum(a), hexLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// 只在 :root 的 token 块里取值，避免误读选择器或注释。
function tokenBlock(css) {
  const match = css.match(/(?::root|\.ii-root)\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'missing :root token block');
  return match[1];
}
function tokenValue(block, name) {
  const match = block.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{6})'));
  assert.ok(match, 'missing token --' + name);
  return match[1].toLowerCase();
}

test('名称决策：Tidewatch 观澜显示名与可移植记录已对齐', () => {
  assert.equal(BRAND.product, '观澜');
  assert.equal(BRAND.pluginName, 'Tidewatch 观澜');
  assert.equal(BRAND.subtitle, 'Tidewatch 设计交付');
  assert.equal(BRAND.status, 'NAME_DECIDED_20261102');
  assert.equal(BRAND.decisionRecord, 'BRANDING.md');
  assert.doesNotMatch(BRAND.networkReason, /(?:Heron|Handoff)/i);
  assert.equal(BRAND.releaseFileName, 'tidewatch.zip');
});

test('名称决策：运行身份与协议面未被改写', async () => {
  const release = await read('平台/插件发行.mjs');
  const web = await read('平台/网页.mjs');
  assert.match(release, /'heron-sync-stage0-local'/);
  assert.match(release, /BRAND\.releaseFileName/);
  assert.match(web, /X-Heron-Plugin-Release/);
  assert.match(await read('插件/production-protocol.mjs'), /request\(|fetch\(|call\(/);
  assert.match(await read('平台/插件发行.mjs'), /validateProductionPluginManifest|inspectPluginRelease/);
});

test('标志几何：与已批准的隔离母版逐路径一致，未重画', async () => {
  const master = await read('品牌/观澜参考还原_20261027/logo.mjs');
  for (const d of LOGO_PATHS) assert.ok(master.includes(d), 'geometry drift: ' + d.slice(0, 24));
  assert.equal(LOGO_PATHS.length, 4);
  assert.deepEqual({ ...LOGO_COLORS }, { teal: '#064852', jade: '#19A98C', white: '#FFFFFF' });
});

test('标志组件：深底反白、浅底双色、单色 currentColor 与可访问名称', () => {
  const reverse = brandMarkSVG({ variant: 'reverse', size: 30 });
  assert.match(reverse, /class="brand-symbol"/);
  assert.match(reverse, /viewBox="0 0 544 544"/);
  assert.match(reverse, /width="30"/);
  assert.match(reverse, /aria-hidden="true"/);
  assert.doesNotMatch(reverse, /role="img"/);
  assert.equal((reverse.match(/#FFFFFF/g) || []).length >= 2, true);
  const duotone = brandMarkSVG({ variant: 'duotone', size: 24 });
  assert.match(duotone, /#064852/);
  assert.match(duotone, /#19A98C/);
  const mono = brandMarkSVG({ variant: 'mono', size: 24 });
  assert.match(mono, /currentColor/);
  const labelled = brandMarkSVG({ label: '观澜', size: 24 });
  assert.match(labelled, /role="img" aria-label="观澜"/);
  for (const svg of [reverse, duotone, mono, labelled]) {
    assert.doesNotMatch(svg, /\sstyle=/, 'no inline style (CSP style-src is self-only)');
    for (const d of LOGO_PATHS) assert.ok(svg.includes(d));
  }
});

test('插件可见品牌入口：标题与页头使用观澜标志，无外部资源', async () => {
  const html = await read('插件/ui.html');
  assert.match(html, /<title>\{\{BRAND_PLUGIN_NAME\}\}<\/title>/);
  assert.match(html, /<div class="plugin-brand">\{\{BRAND_LOGO_SVG\}\}<div><h1>\{\{BRAND_PRODUCT\}\}<\/h1>/);
  const built = applyBrandTokens(html);
  assert.doesNotMatch(built, /\{\{BRAND_[A-Z_]+\}\}/);
  assert.match(built, /<title>Tidewatch 观澜<\/title>/);
  assert.match(built, /<h1>观澜<\/h1>/);
  const mark = built.match(/<svg class="brand-symbol"[\s\S]*?<\/svg>/);
  assert.ok(mark, 'header logo missing');
  for (const d of LOGO_PATHS) assert.ok(mark[0].includes(d));
  assert.match(mark[0], /aria-hidden="true"/);
  assert.doesNotMatch(built, /(?:src|href)\s*=\s*["'](?:https?:|\/\/)/, 'plugin UI must stay self-contained');
  assert.ok(BRAND_TOKENS['{{BRAND_LOGO_SVG}}'].includes('viewBox="0 0 544 544"'));
});

test('平台网页可见入口：页头标志、标题与内联 favicon 均为观澜', async () => {
  const source = await read('平台/网页.mjs');
  assert.match(source, /import \{ brandMarkSVG, faviconDataURI \} from '\.\.\/品牌\/guanlan-logo\.mjs'/);
  assert.match(source, /brandMarkSVG\(\{variant:'reverse',size:30,className:'brand-symbol'\}\)/);
  assert.match(source, /<link rel="icon" href="\$\{favicon\}">/);
  assert.match(source, /<link rel="icon" href="\$\{faviconDataURI\(\)\}">/);
  assert.doesNotMatch(source, /href="data:,"/, 'blank favicon must be replaced, not left behind');
  assert.match(source, /<title>\$\{html\(pageTitle\)\} · \$\{html\(BRAND\.product\)\}<\/title>/);
  assert.match(source, /<title>\$\{html\(BRAND\.product\)\} · 设计标注<\/title>/);
  assert.match(source, /aria-label="\$\{html\(ariaLabel\)\}">\$\{brand\}<span>/);
  const uri = faviconDataURI();
  assert.ok(uri.startsWith('data:image/svg+xml,'));
  const decoded = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
  for (const d of LOGO_PATHS) assert.ok(decoded.includes(d));
  assert.match(decoded, new RegExp(LOGO_COLORS.jade, 'i'));
  assert.doesNotMatch(decoded, /<script|onload=/i);
});

test('主题 tokens：四类表面统一为 #0B2026 墨绿层级并保留语义色', async () => {
  const files = {
    '界面/base.css': ['p-ink-950', 'p-ink-900', 'p-ink-850', 'p-ink-800', 'p-ink-700', 'p-ink-650', 'p-line', 'p-line-strong', 'p-control-border', 'p-white', 'p-secondary', 'p-muted', 'p-sage', 'p-button', 'p-button-ink', 'p-danger', 'p-warning'],
    '插件/ui.css': ['tone-950', 'tone-925', 'tone-900', 'tone-875', 'tone-850', 'tone-800', 'tone-750', 'tone-600', 'tone-control', 'ink-100', 'ink-200', 'ink-300', 'sage-300', 'red-300', 'sand-300', 'paper-100', 'paper-ink'],
    '查看器/inspector.css': ['ii-p-canvas', 'ii-p-base', 'ii-p-navigation', 'ii-p-panel', 'ii-p-raised', 'ii-p-hover', 'ii-p-line', 'ii-p-edge', 'ii-p-control', 'ii-p-ink', 'ii-p-secondary', 'ii-p-muted', 'ii-p-accent', 'ii-p-primary', 'ii-p-primary-ink', 'ii-p-danger', 'ii-p-warning'],
    '宿主/production-shell.css': ['host-bg', 'host-panel', 'host-raised', 'host-border', 'host-border-strong', 'host-text', 'host-secondary', 'host-muted', 'host-accent'],
  };
  const legacy = ['#0d0f12', '#101214', '#14171a', '#181c20', '#20252b', '#272e35', '#2e353e', '#4b5665', '#64717f', '#9bc8bd', '#edf0f3', '#bbc3ce', '#929eac', '#efa6ad', '#e6c38c'];
  for (const [file, names] of Object.entries(files)) {
    const css = await read(file);
    const block = tokenBlock(css);
    for (const name of names) tokenValue(block, name); // 每个 token 仍以 6 位十六进制声明
    assert.match(css, /color-scheme:\s*dark/);
    for (const colour of legacy) assert.ok(!css.includes(colour), `${file} still contains legacy colour ${colour}`);
    assert.match(css, /#0b2026/);
  }
  const blockOf = async file => tokenBlock(await read(file));
  assert.equal(tokenValue(await blockOf('界面/base.css'), 'p-ink-900'), '#0b2026');
  assert.equal(tokenValue(await blockOf('插件/ui.css'), 'tone-925'), '#0b2026');
  assert.equal(tokenValue(await blockOf('查看器/inspector.css'), 'ii-p-base'), '#0b2026');
  assert.equal(tokenValue(await blockOf('宿主/production-shell.css'), 'host-bg'), '#0b2026');
  // 语义色保留（红/黄不并入墨绿）。
  assert.equal(tokenValue(await blockOf('界面/base.css'), 'p-danger'), '#f5b3ba');
  assert.equal(tokenValue(await blockOf('界面/base.css'), 'p-warning'), '#e8cb92');
  assert.equal(tokenValue(await blockOf('查看器/inspector.css'), 'ii-p-danger'), '#f5b3ba');
});

test('主题层级与对比度：面板分层、玉绿强调、AA 文字与可辨焦点', async () => {
  const base = tokenBlock(await read('界面/base.css'));
  const value = name => tokenValue(base, name);
  const canvas = value('p-ink-950'), bg = value('p-ink-900'), nav = value('p-ink-850');
  const panel = value('p-ink-800'), raised = value('p-ink-700'), hover = value('p-ink-650');
  // 明暗层级：画布最深 → 悬浮最亮。
  const order = [canvas, bg, nav, panel, raised, hover].map(hexLum);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1] + 0.002, `layer ${i} must be lighter than ${i - 1}`);
  // 分割线在面板背景上可辨。
  assert.ok(ratio(value('p-line'), panel) >= 1.35);
  assert.ok(hexLum(value('p-line-strong')) > hexLum(value('p-line')));
  // 文字/语义色对三种表面均达 AA（4.5:1）。
  for (const surface of [bg, panel, raised]) {
    for (const name of ['p-white', 'p-secondary', 'p-muted', 'p-sage', 'p-danger', 'p-warning']) {
      assert.ok(ratio(value(name), surface) >= 4.5, `${name} on ${surface} below AA: ${ratio(value(name), surface).toFixed(2)}`);
    }
  }
  // 主按钮与反白文字。
  assert.ok(ratio(value('p-button-ink'), value('p-button')) >= 4.5);
  assert.ok(hexLum(value('p-button')) > 0.8, 'primary button stays light on the dark surface');
  // 焦点与强调同源，避免出现蓝色残留焦点环。
  const root = await read('界面/base.css');
  assert.match(root, /--accent:var\(--p-sage\)/);
  assert.match(root, /--focus:var\(--p-sage\)/);
  assert.ok(ratio(value('p-sage'), bg) >= 4.5);
  // 选中态与分割线不共用颜色。
  assert.notEqual(value('p-selection-surface'), value('p-line'));
  // 插件与查看器使用同一套玉绿强调与墨绿基色。
  const plugin = tokenBlock(await read('插件/ui.css'));
  assert.equal(tokenValue(plugin, 'sage-300'), '#8fd9c4');
  const viewer = tokenBlock(await read('查看器/inspector.css'));
  assert.equal(tokenValue(viewer, 'ii-p-accent'), '#8fd9c4');
  assert.match(await read('查看器/inspector.css'), /background:#16463d/);
});
