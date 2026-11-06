// MODEL-DOM only: synthetic contractVersion:1 data. Not Chrome, Figma or visual acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountInspector } from '../查看器/index.mjs';
const all = n => [n, ...n.children.flatMap(all)];
const cls = (d, name) => all(d.container).find(n => n.className.split(/\s+/).includes(name));
const control = (d, label) => { const nodes = all(d.container).filter(n => n.getAttribute('aria-label') === label); assert.equal(nodes.length, 1, label); return nodes[0]; };
const tick = () => new Promise(resolve => setImmediate(resolve));
class Node {
  constructor(document, tag, fragment = false) { Object.assign(this, { ownerDocument: document, tagName: tag.toUpperCase(), nodeType: fragment ? 11 : 1, children: [], parentNode: null, attributes: new Map(), events: new Map(), style: {}, dataset: {}, className: '', hidden: false, disabled: false, inert: false, open: false, _text: '' }); this.classList = { add: c => this.className += ' ' + c }; }
  append(...nodes) { for (const n of nodes) { if (n.nodeType === 11) { this.append(...[...n.children]); n.children = []; continue; } n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); } }
  removeChild(n) { this.children = this.children.filter(c => c !== n); n.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) { for (const n of this.children) n.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(v) { this._text = String(v); for (const n of this.children) n.parentNode = null; this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set value(v) { this._value = String(v); }
  get value() { return this._value ?? (this.tagName === 'SELECT' ? (this.children.find(n => n.selected) ?? this.children[0])?.value ?? '' : ''); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  addEventListener(k, fn) { const list = this.events.get(k) ?? []; list.push(fn); this.events.set(k, list); }
  fire(k, event = {}) { let result; for (const fn of this.events.get(k) ?? []) result = fn({ target: this, type: k, preventDefault() {}, ...event }); return result; }
  click() { if (this.disabled) return; if (this.tagName === 'A') this.ownerDocument.anchors.push({ href: this.href, download: this.download }); if (this.tagName === 'SUMMARY') { this.parentNode.open = !this.parentNode.open; this.parentNode.fire('toggle'); } return this.fire('click'); }
  contains(n) { return all(this).includes(n); }
  focus() { this.ownerDocument.activeElement = this; }
  compareDocumentPosition(n) { return all(this.ownerDocument.container).indexOf(this) < all(this.ownerDocument.container).indexOf(n) ? 4 : 2; }
  querySelectorAll(selector) { const [tag, c] = selector.split('.'); return all(this).slice(1).filter(n => (!tag || n.tagName === tag.toUpperCase()) && (!c || n.className.split(/\s+/).includes(c))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: this.ownerDocument.width, bottom: 824, width: this.ownerDocument.width, height: 824 }; }
  getContext() { const labels = this.ownerDocument.labels; return new Proxy({ measureText: t => ({ width: String(t).length * 6 }), fillText: t => labels.push(t) }, { get: (o, k) => o[k] ?? (() => {}), set: (o, k, v) => (o[k] = v, true) }); }
  setPointerCapture() {} releasePointerCapture() {}
}
function dom(width = 1440, language = 'zh-CN') {
  const raf = new Map(), writes = [], events = new Map(); let count = 0;
  const document = { width, anchors: [], labels: [], baseURI: 'https://noise-model.example.test/viewer/r/unset', createElement(t) { return new Node(this, t); }, createElementNS(ns, t) { return new Node(this, t); }, createDocumentFragment() { return new Node(this, 'fragment', true); } };
  const location = { href: document.baseURI };
  const window = { devicePixelRatio: 1, navigator: {}, location, localStorage: { getItem: () => JSON.stringify({ language }), setItem() {} }, history: { replaceState: (state, _, url) => { writes.push({ state, url, replace: true }); location.href = url; }, pushState: (state, _, url) => { writes.push({ state, url, replace: false }); location.href = url; } }, matchMedia: () => ({ matches: width <= 900 }), requestAnimationFrame: fn => (raf.set(++count, fn), count), cancelAnimationFrame: i => raf.delete(i), addEventListener: (k, fn) => { const list = events.get(k) ?? []; list.push(fn); events.set(k, list); }, removeEventListener: (k, fn) => events.set(k, (events.get(k) ?? []).filter(v => v !== fn)), ResizeObserver: class { observe() {} disconnect() {} } };
  document.defaultView = window; document.container = document.createElement('div');
  return { container: document.container, document, window, writes, flush() { const tasks = [...raf.values()]; raf.clear(); tasks.forEach(fn => fn()); }, async emit(k) { await Promise.all((events.get(k) ?? []).map(fn => fn())); } };
}
const ids = Object.freeze({ project: 'prj_NoiseFixture', file: 'fil_NoiseFixture', page: 'pag_NoiseFixture', frame: 'frm_LkRRQzdinhNL', current: 'rev_sy4LKAZvnci6', old: 'rev_HistoricalNoise', asset: 'ast_NoiseFixture', slice: 'slice_NoiseFixture', node: '77:12', child: '77:13', text: '77:14', style: 'sty_NoiseFixture', component: 'cmp_NoiseFixture', session: 'ses_NoiseFixture', hash: 'a4e6c8b09d3f172560a4e6c8b09d3f172560a4e6c8b09d3f172560a4e6c8b09d3f' });
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function fixture({ missingNames = false, frameName = '07.传奇★凤凰' } = {}) {
  const noise = { id: ids.asset, projectId: ids.project, designFileId: ids.file, pageId: ids.page, frameId: ids.frame, revisionId: ids.current, assetId: ids.asset, sliceId: ids.slice, nodeId: ids.node, styleId: ids.style, componentId: ids.component, sessionId: ids.session, hash: ids.hash, imageHash: ids.hash };
  const context = { projectId: ids.project, projectName: '合成项目', designFileId: ids.file, ...(!missingNames ? { designFileName: '真实文件', files: [{ designFileId: ids.file, name: '真实文件', pages: [{ pageId: ids.page, name: '真实页面' }] }] } : {}), projectCanvasUrl: `/viewer/p/${ids.project}`, projectSlicesUrl: `/viewer/p/${ids.project}/slices` };
  const frame = { projectId: ids.project, designFileId: ids.file, pageId: ids.page, frameId: ids.frame, figmaNodeId: ids.node, name: frameName, revisionId: ids.current, currentRevisionId: ids.current, ...(!missingNames ? { designFileName: '真实文件', pageName: '真实页面' } : {}), bounds: { x: -12.25, y: 20.5, width: 100.25, height: 80.5 } };
  const calls = { loads: [], downloads: [] }, snapshots = [];
  const adapter = { context, listFrames: async () => ({ frames: [frame], context }), listRevisions: async () => [{ revisionId: ids.current, current: true, name: '真实发布名', label: frameName + ' · ' + ids.current, publishedAt: '2026-10-16T16:25:00+08:00' }, { revisionId: ids.old, label: frameName + ' · ' + ids.old, createdAt: '2026-10-15T12:00:00+08:00' }], loadRevision: async (frameId, revisionId) => {
    calls.loads.push({ frameId, revisionId });
    const shadow = { ...noise, type: 'INNER_SHADOW', offset: { x: -2, y: -2, nodeId: ids.node }, radius: 2, spread: 0, color: { r: 1, g: 1, b: 1, a: .05, hash: ids.hash } };
    const value = { identity: { projectId: ids.project, designFileId: ids.file, pageId: ids.page, frameId, revisionId, figmaNodeId: ids.node }, context, layerDoc: { contractVersion: 1, frame: { ...noise, id: ids.node, type: 'FRAME', name: revisionId === ids.old ? '历史实际画板' : frameName, width: 100.25, height: 80.5, absoluteBoundingBox: frame.bounds, children: [{ ...noise, id: ids.child, type: 'INSTANCE', name: '真实按钮', width: 30.5, height: 20.25, absoluteBoundingBox: { x: 1.25, y: 2.5, width: 30.5, height: 20.25 }, componentId: ids.component, fillStyleId: ids.style, opacity: .75, fills: [{ ...noise, type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 1, b: 0, a: 1 } }] }], effects: [shadow, { ...shadow, offset: { x: 2, y: 2 }, color: { r: 0, g: 0, b: 0, a: .15 } }], futureRaw: noise }, { ...noise, id: ids.text, type: 'TEXT', name: '真实文本', characters: '甲😀乙', width: 40, height: 20, style: { ...noise, fontSize: { state: 'unknown', reason: ids.style } }, textRuns: [{ start: 0, end: 3, characters: '甲😀', style: { ...noise, fontSize: 12, fontFamily: '本地系统' } }, { start: 3, end: 4, characters: '乙', style: { ...noise, fontSize: 17 } }] }] }, styles: { TEXT: [], FILL: [{ ...noise, id: ids.style, name: '真实填充样式', description: '真实样式描述', fills: [{ ...noise, type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] }], EFFECT: [], GRID: [] }, components: [{ ...noise, id: ids.component, name: '真实组件', description: '真实组件描述', variants: [{ componentId: ids.component }] }] }, slices: [{ ...noise, frameId, revisionId, sliceId: ids.slice, assetId: ids.asset, exportNodeId: ids.child, exportName: '实际导出', originalFileName: '实际导出@2x.png', format: 'PNG', mime: 'image/png', scale: 2, width: 61, height: 41, byteLength: 12, pluginExportSetting: { ...noise, format: 'PNG', constraint: { type: 'SCALE', value: 2, nodeId: ids.child } } }] };
    snapshots.push({ value, raw: JSON.stringify(value) }); return freeze(value);
  }, getSliceDownloadUrl: async (frameId, revisionId, options) => { calls.downloads.push({ frameId, revisionId, kind: options.kind, sliceId: options.sliceId }); return { url: `/authorized/${frameId}/${revisionId}/${options.sliceId ?? 'all'}`, frameId, revisionId, originalFileName: options.kind === 'zip' ? '历史实际导出.zip' : '实际导出@2x.png', mime: options.kind === 'zip' ? 'application/zip' : 'image/png', byteLength: 12 }; } };
  return { adapter, context, calls, snapshots };
}
function assertClean(d) {
  for (const n of all(d.container)) if (n.tagName === 'DETAILS') n.open = true;
  // Includes hidden panels, every expanded detail, options, titles and accessible names; values/URLs/data are intentionally excluded.
  const rendered = all(d.container).flatMap(n => [n._text, n.title, n.placeholder, n.getAttribute('title'), n.getAttribute('aria-label'), n.getAttribute('placeholder')]).filter(Boolean).join('\n') + '\n' + d.document.labels.join('\n');
  for (const value of Object.values(ids)) assert.ok(!rendered.includes(value), `UI leaked ${value}`);
  assert.doesNotMatch(rendered, /画板ID|平台节点|高级 \/ (?:目录身份|版本身份)|所选节点原始字段|引用详情 · \w+StyleId/);
  assert.equal(cls(d, 'ii-directory-advanced'), undefined); assert.equal(cls(d, 'ii-identity-details'), undefined);
  return rendered;
}
for (const width of [1440, 375]) for (const language of ['zh-CN', 'en']) test(`MODEL-DOM ${width}px ${language}: all details/aria/title/options clean, exact identity/history/URL/download retained`, async () => {
  const d = dom(width, language), f = fixture(), savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { assert.equal(options.method, 'HEAD'); return new Response(null, { headers: { 'content-type': String(url).endsWith('/all') ? 'application/zip' : 'image/png', 'content-length': '12' } }); };
  const view = mountInspector(d.container, { adapter: f.adapter, initialFrameId: ids.frame, initialMode: 'frame' });
  try {
    assertClean(d); await view.ready; d.flush(); assertClean(d);
    assert.equal(view.diagnostics.identity.frameId, ids.frame); assert.equal(view.diagnostics.identity.revisionId, ids.current);
    assert.equal(view.diagnostics.identity.projectId, ids.project); assert.equal(view.diagnostics.identity.designFileId, ids.file); assert.equal(view.diagnostics.identity.pageId, ids.page); assert.equal(view.diagnostics.identity.figmaNodeId, ids.node);
    assert.equal(new URL(d.writes.at(-1).url).searchParams.get('revision'), ids.current); assert.ok(d.writes.at(-1).url.includes(ids.frame));
    assert.ok(all(d.container).some(n => n.dataset.frameId === ids.frame)); assert.ok(all(d.container).some(n => n.tagName === 'A' && n.href?.includes(ids.project)));
    const search = control(d, language === 'en' ? 'Search all frames' : '搜索全部画板目录'); search.value = ids.frame; search.fire('input'); assert.equal(all(cls(d, 'ii-frame-list')).filter(n => n.className === 'ii-frame-row').length, 1); assertClean(d); search.value = ''; search.fire('input');
    cls(d, 'ii-tree').children[1].click(); d.flush(); let rendered = assertClean(d);
    assert.match(rendered, /真实组件描述/); assert.match(rendered, /真实填充样式/); assert.equal(view.diagnostics.selectedNodeId, ids.child);
    assert.equal(all(d.container).filter(n => n.className === 'ii-effect-card').length, 2);
    assert.match(cls(d, 'ii-code').textContent, /box-shadow: inset -2px -2px 2px 0px #ffffff0d, inset 2px 2px 2px 0px #00000026/);
    cls(d, 'ii-tree').children[2].click(); const run = cls(d, 'ii-text-controls').querySelectorAll('select')[0]; run.value = '0'; run.fire('change'); assertClean(d); assert.match(cls(d, 'ii-code').textContent, /font-size: 12px/); assert.equal(cls(d, 'ii-text-value').textContent, '甲😀');
    await view.navigate({ frameId: ids.frame, revisionId: ids.old }); d.flush(); rendered = assertClean(d); assert.match(rendered, /历史实际画板/); assert.match(rendered, /2026-10-15T12:00:00\+08:00/); assert.match(rendered, language === 'en' ? /History entry 2/ : /历史记录第2项/);
    const select = control(d, language === 'en' ? 'Frame revision history' : '当前画板历史版本'); assert.deepEqual(select.children.map(n => n.value), [ids.current, ids.old]);
    cls(d, 'ii-tree').children[1].click();  const download = all(d.container).find(n => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === (language === 'en' ? 'Download original format' : '下载原格式')); download.click(); await tick();
    assert.deepEqual(f.calls.downloads.at(-1), { frameId: ids.frame, revisionId: ids.old, kind: 'slice', sliceId: ids.slice }); assert.equal(d.document.anchors.at(-1).download, '实际导出@2x.png'); assert.ok(d.document.anchors.at(-1).href.includes(ids.slice)); assert.equal(view.diagnostics.download.getRequests, 0); assertClean(d);
    control(d, language === 'en' ? 'I checked browser downloads' : '已检查浏览器下载列表').click(); control(d, language === 'en' ? 'Download all exports from this historical revision (ZIP)' : '下载此历史版本全部ZIP').click(); await tick(); assert.deepEqual(f.calls.downloads.at(-1), { frameId: ids.frame, revisionId: ids.old, kind: 'zip', sliceId: null }); assertClean(d);
    const count = d.writes.length; d.window.location.href = `https://noise-model.example.test/viewer/r/${ids.frame}?revision=${ids.current}`; await d.emit('popstate'); assert.equal(d.writes.length, count); assert.equal(view.diagnostics.identity.revisionId, ids.current); assertClean(d);
    for (const { value, raw } of f.snapshots) assert.equal(JSON.stringify(value), raw, 'DTO/geometry/raw values remain unchanged');
  } finally { view.dispose(); globalThis.fetch = savedFetch; }
});
test('MODEL-DOM errors, retry, empty and unnamed file/page do not echo upstream identities', async () => {
  const d = dom(), f = fixture({ missingNames: true }), original = f.adapter.loadRevision; f.context.files = [];
  f.adapter.loadRevision = async () => { throw new Error(`HTTP 403 ${Object.values(ids).join(' ')}`); };
  const view = mountInspector(d.container, { adapter: f.adapter, initialFrameId: ids.frame });
  try { await view.ready; d.flush(); assertClean(d); assert.ok(view.diagnostics.error.includes(ids.hash)); assert.match(cls(d, 'ii-stage-message').textContent, /HTTP 403/); f.adapter.loadRevision = original; await control(d, '重试读取').click(); d.flush(); const rendered = assertClean(d); assert.match(rendered, /未分组/); assert.equal(view.diagnostics.identity.revisionId, ids.current); } finally { view.dispose(); }
  const empty = dom(375, 'en'), emptyView = mountInspector(empty.container, { adapter: { listFrames: async () => [], listRevisions: async () => [], loadRevision: async () => null } }); try { await emptyView.ready; empty.flush(); assertClean(empty); assert.match(cls(empty, 'ii-stage-message').textContent, /No frames/); } finally { emptyView.dispose(); }
});
for (const language of ['zh-CN', 'en']) test(`MODEL-DOM ${language}: preview/download failures keep precise diagnostics, never echo their IDs`, async () => {
  const d = dom(375, language), f = fixture(), original = f.adapter.loadRevision, rawError = Object.values(ids).join(' ');
  f.adapter.loadRevision = async (frameId, revisionId) => ({ ...await original(frameId, revisionId), previewAsset: { assetId: ids.asset, frameId, revisionId, mime: 'image/png', width: 100, height: 80, byteLength: 12 } });
  f.adapter.getPreview = async () => { throw new Error(rawError); };
  f.adapter.getSliceDownloadUrl = async () => { throw new Error(rawError); };
  const view = mountInspector(d.container, { adapter: f.adapter, initialFrameId: ids.frame, initialMode: 'frame' });
  try {
    await view.ready; d.flush(); await tick(); d.flush(); assert.ok(view.diagnostics.imageErrors.includes(rawError)); assertClean(d);
    cls(d, 'ii-tree').children[1].click();  d.flush(); await tick(); d.flush();
    control(d, language === 'en' ? 'Download original format' : '下载原格式').click(); await tick(); assert.equal(view.diagnostics.download.state, 'error'); assert.equal(view.diagnostics.download.message, rawError); assert.equal(view.diagnostics.download.frameId, ids.frame); assert.equal(view.diagnostics.download.revisionId, ids.current); assertClean(d);
    const languageSelect = control(d, language === 'en' ? 'Language' : '语言'); languageSelect.value = language === 'en' ? 'zh-CN' : 'en'; languageSelect.fire('change'); assertClean(d);
  } finally { view.dispose(); }
});
test('MODEL-DOM genuine names are never globally stripped or translated', async () => {
  const name = '复制 · rev_ 是设计名 / 77:99 参考 #abc123', d = dom(), f = fixture({ frameName: name }), view = mountInspector(d.container, { adapter: f.adapter, initialFrameId: ids.frame });
  try { await view.ready; assert.equal(cls(d, 'ii-context-title').textContent, name); assert.equal(cls(d, 'ii-frame-name').textContent, name); const language = control(d, '语言'); language.value = 'en'; language.fire('change'); assert.equal(cls(d, 'ii-context-title').textContent, name); assert.equal(cls(d, 'ii-frame-name').textContent, name); assertClean(d); } finally { view.dispose(); }
});
