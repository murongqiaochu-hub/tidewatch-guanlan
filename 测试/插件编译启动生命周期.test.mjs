import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { compileESM } from '../构建/esm-compiler.mjs';
import { inlinePluginUI, pluginFiles } from '../构建/build.mjs';
import { createBridge, browserPeer, createFigmaTransport } from '../插件/bridge.mjs';
import { BRAND, applyBrandTokens } from '../品牌/identity.mjs';

// A constrained SDK/DOM model, not a claim of real Figma or visual acceptance.
class Element {
  constructor(tag = 'div', fragment = false) { this.tagName = tag.toUpperCase(); this.nodeType = fragment ? 11 : 1; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.events = new Map(); this.children = []; this.parentNode = null; }
  addEventListener(k, f) { this.events.set(k, [...(this.events.get(k) || []), f]); }
  removeEventListener() {}
  focus() {}
  contains(other) { return this === other || this.children.some(child => child.contains?.(other)); }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  removeChild(node) { const index = this.children.indexOf(node); if (index < 0) throw new Error('Node is not a child'); this.children.splice(index, 1); if (node.parentNode === this) node.parentNode = null; return node; }
  insertBefore(node, referenceNode = null) { if (referenceNode !== null && referenceNode.parentNode !== this) throw new Error('Reference node is not a child'); if (node === referenceNode) return node; if (node.nodeType === 11) { for (const child of [...node.children]) this.insertBefore(child, referenceNode); return node; } node.parentNode?.removeChild(node); const index = referenceNode === null ? this.children.length : this.children.indexOf(referenceNode); if (index < 0) throw new Error('Reference node is not a child'); this.children.splice(index, 0, node); node.parentNode = this; return node; }
  before(...nodes) { const parent = this.parentNode; if (!parent) return; for (const node of nodes) parent.insertBefore(node, this); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); if (this.tagName === 'SELECT' && !this.value) this.value = nodes[0]?.value || ''; }
  replaceChildren(...nodes) { for (const child of [...this.children]) this.removeChild(child); this.value = this.tagName === 'SELECT' ? '' : this.value; this.append(...nodes); }
  dispatch(k, extra = {}) { for (const f of this.events.get(k) || []) f({ isTrusted: true, preventDefault() {}, ...extra }); }
}
function verifyInsertionSemantics(makeNode) { const parent = makeNode('section'), oldParent = makeNode('aside'), first = Object.assign(makeNode('i'), { label: 'first' }), reference = Object.assign(makeNode('b'), { label: 'reference' }), tail = Object.assign(makeNode('i'), { label: 'tail' }), moved = Object.assign(makeNode('button'), { label: 'moved' }), other = Object.assign(makeNode('span'), { label: 'other' }); parent.append(first, reference, tail); oldParent.append(moved, other); parent.insertBefore(moved, reference); assert.deepEqual(parent.children.map(node => node.label), ['first', 'moved', 'reference', 'tail']); assert.deepEqual(oldParent.children.map(node => node.label), ['other']); assert.equal(moved.parentNode, parent); parent.insertBefore(tail, first); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'reference']); parent.insertBefore(reference, reference); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'reference']); oldParent.append(moved); reference.before(moved, other); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'other', 'reference']); assert.deepEqual(oldParent.children, []); assert.equal(moved.parentNode, parent); assert.equal(other.parentNode, parent); const last = Object.assign(makeNode('i'), { label: 'last' }); parent.insertBefore(last, null); assert.deepEqual(parent.children.map(node => node.label), ['tail', 'first', 'moved', 'other', 'reference', 'last']); }
test('MODEL DOM fixture: insertBefore/before preserve order and reparent nodes', () => verifyInsertionSemantics(tag => new Element(tag)));
function attachQuotaAnchors(nodes) { const page = nodes.get('production-project-page'), searchParent = new Element('label'), popover = nodes.get('production-create-popover'), errorParent = new Element('div'); page.append(searchParent); searchParent.append(nodes.get('production-project-search')); popover.append(errorParent); errorParent.append(nodes.get('production-create-error')); }
function assertQuotaPlacement($) { const page = $('production-project-page'), searchParent = $('production-project-search').parentNode, pageIndex = page.children.indexOf(searchParent), error = $('production-create-error'), errorIndex = error.parentNode.children.indexOf(error); assert.ok(searchParent && pageIndex > 0); assert.equal(page.children[pageIndex - 1].dataset.accountQuota, 'true'); assert.ok(error.parentNode && errorIndex > 0); assert.equal(error.parentNode.children[errorIndex - 1].dataset.accountQuota, 'true'); }
function documentModel(html) {
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[2], new Element(m[1])]));
  attachQuotaAnchors(nodes);
  nodes.get('scope').value = 'selection'; nodes.get('scale').value = '1';
  return { nodes, addEventListener() {}, removeEventListener() {}, getElementById: k => nodes.get(k) || null, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), querySelectorAll: () => [], querySelector(q) { if (q === 'meta[name="independent-production"]') return { content: 'enabled' }; if (q === 'meta[name="figma-parent-origin"]') return { content: 'https://www.figma.com' }; return q.startsWith('#') ? nodes.get(q.slice(1)) || null : null; } };
}
const wire = value => Array.isArray(value) ? value.map(wire) : value && typeof value === 'object' ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]))) : value;
const root = new URL('../', import.meta.url);
async function compiled() {
  const sources = new Map(await Promise.all(pluginFiles.map(async name => [name, applyBrandTokens(await fs.readFile(new URL(name, root), 'utf8'))])));
  const main = compileESM(sources, '插件/main.mjs').code;
  const html = inlinePluginUI(sources.get('插件/ui.html'), sources.get('插件/ui.css'), compileESM(sources, '插件/ui.mjs').code).replace('content="disabled"', 'content="enabled"');
  return { main, html, ui: [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n') };
}
const settle = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'lifecycle did not settle'); };

for (const { writeFails, dropHello, legacyLogin = false, pendingPhase = null, noSubtle = false, deleteFails = false } of [{ writeFails: false, dropHello: false, noSubtle: true }, { writeFails: false, dropHello: false }, { writeFails: true, dropHello: false }, { writeFails: false, dropHello: true }, { writeFails: false, dropHello: false, legacyLogin: true }, { writeFails: false, dropHello: false, legacyLogin: 'alias' }, ...['unknownPrepare','unknownCommit'].map(pendingPhase => ({writeFails:false,dropHello:false,legacyLogin:true,pendingPhase})), { writeFails: false, dropHello: false, pendingPhase: 'unknownCommit', deleteFails: true }]) test(`actual compiled auto-entry main + inline UI: opaque parent, startup race, remember/login; storage write fails=${writeFails}; drop first hello=${dropHello}; legacy IP login=${legacyLogin}; pending=${pendingPhase}; delete fails=${deleteFails}; missing subtle=${noSubtle}`, async () => {
  const bundle = await compiled(); const doc = documentModel(bundle.html); const storage = new Map(); const events = new Set(); const sent = []; const paths = []; const user = { id: 'usr_1', username: 'tester', role: 'admin' }; let callback; let shown = 0; let hellos = 0; let loginCalls = 0; const startupTimer = (fn, ms) => setTimeout(fn, ms === 4000 ? 1 : ms);
  const originalPending = pendingPhase ? {phase:pendingPhase,locked:true,sessionId:pendingPhase === 'unknownCommit' ? 'original-session' : null,operationId:`op_${'9'.repeat(32)}_${'a'.repeat(64)}`,service:{origin:'http://192.168.1.50:4318',allowLocalhost:false},completed:[]} : null;
  if (originalPending) storage.set('independent-inspector.publish.pending.v1.production', originalPending);
  // Opaque parent silently drops HTTPS-targeted messages, matching browser origin rules.
  const parent = { postMessage(data, target) { sent.push(target); if (target !== '*') return; if (data.pluginMessage.operation === 'hello' && ++hellos === 1 && dropHello) return; queueMicrotask(() => callback?.(wire(data.pluginMessage), { origin: 'null' })); } };
  const win = { parent, crypto: noSubtle ? {getRandomValues:webcrypto.getRandomValues.bind(webcrypto)} : webcrypto, AbortController, setTimeout, clearTimeout, addEventListener(_k, f) { events.add(f); }, removeEventListener(_k, f) { events.delete(f); }, async fetch(url) { const pathname = new URL(url).pathname; paths.push(pathname);
    if (originalPending) assert.ok([originalPending.sessionId, originalPending.operationId].filter(Boolean).every(id => !pathname.includes(id)), 'retired unknown-session identity must never be dispatched');
    if (legacyLogin) assert.equal(new URL(url).origin, 'https://service.example.test:49156');
    if (url.endsWith('/api/auth/login')) loginCalls++;
    const value = url.endsWith('/api/auth/login') ? { token: 'synthetic-access', user, refreshToken: 'synthetic-refresh', refreshExpiresAt: Date.now() + 86400000 } : url.endsWith('/api/auth/me') ? user : url.endsWith('/api/project-groups') || url.endsWith('/groups') ? {groups:[]} : {projects:[{id:'project_1',name:'Test project',groupId:null,permissions:{canPublish:true}}]};
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } };
  const sdk = { editorType: 'figma', root: { id: '0:0', name: 'Document' }, currentPage: { id: '1:1', name: 'Page', selection: [], children: [] }, clientStorage: { async keysAsync() { return [...storage.keys()]; }, async getAsync(k) { return wire(storage.get(k)); }, async setAsync(k, v) { if (writeFails) throw new Error('synthetic storage unavailable'); storage.set(k, v); }, async deleteAsync(k) { if (deleteFails) throw new Error('synthetic delete failure'); storage.delete(k); } }, ui: { onmessage: undefined, resize() {}, postMessage(data, options) { assert.equal(options.origin, '*'); queueMicrotask(() => { for (const f of events) f({ source: parent, origin: 'null', data: wire({ pluginMessage: data }) }); }); } }, showUI(html, options) {
    shown++; assert.equal(options.title, BRAND.pluginName); callback = sdk.ui.onmessage; assert.equal(typeof callback, 'function', 'listener must precede showUI');
    vm.runInNewContext(bundle.ui, { window: win, document: doc, Uint8Array, ArrayBuffer, DataView, URL, TextEncoder, TextDecoder, setTimeout: startupTimer, clearTimeout, __INDEPENDENT_PRODUCTION__: { serviceOrigin: 'https://service.example.test:49156', serviceOrigins: ['https://service.example.test:49156', 'http://nas.example.test:4318', 'http://192.168.1.50:4318'] } });
  } };
  const figmaEvents = new Map(); sdk.on = (name, fn) => figmaEvents.set(name, [...(figmaEvents.get(name) || []), fn]); sdk.off = (name, fn) => figmaEvents.set(name, (figmaEvents.get(name) || []).filter(listener => listener !== fn));
  const selectionChanged = () => { for (const listener of figmaEvents.get('selectionchange') || []) listener(); };
  const context = vm.createContext({ figma: sdk, __html__: bundle.html, __INDEPENDENT_PRODUCTION__: { serviceOrigin: 'https://service.example.test:49156', serviceOrigins: ['https://service.example.test:49156', 'http://nas.example.test:4318', 'http://192.168.1.50:4318'] }, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout });
  vm.runInContext(bundle.main, context);
  try { await settle(() => !doc.nodes.get('production-remember').disabled); } catch (error) { error.message += `; status=${doc.nodes.get('status').textContent}; auth=${doc.nodes.get('production-auth-status').textContent}`; throw error; }
  assert.equal(shown, 1); assert.ok(sent.length > 0); assert.ok(sent.every(target => target === '*')); assert.equal(vm.runInContext('typeof URL + ":" + typeof TextEncoder + ":" + typeof crypto', context), 'undefined:undefined:undefined');
  const $ = k => doc.nodes.get(k); assertQuotaPlacement($); $('production-remember').checked = true; $('production-remember').dispatch('change'); assert.equal($('production-remember').checked, true);
  if (legacyLogin) $('production-origin').value = legacyLogin === 'alias' ? 'HTTP://NAS.EXAMPLE.TEST:4318/' : 'http://192.168.1.50:4318/';
  $('production-username').value = 'tester'; $('production-password').value = 'synthetic-password-not-for-storage';
  $('production-login').dispatch('click', { isTrusted: false }); assert.equal(loginCalls, 0);
  if (dropHello) $('production-login-form').dispatch('keydown', { key: 'Enter' });
  else $('production-login').dispatch('click');
  // A following native submit or extra click must not duplicate the active login.
  $('production-login-form').dispatch('submit'); $('production-login').dispatch('click');
  if (pendingPhase) assert.equal(storage.has('independent-inspector.publish.pending.v1.production'), deleteFails, 'C34 startup retires the legacy publication journal; a failed delete leaves it but never activates it');
  try { await settle(() => $('app').dataset.productionStage === 'workspace' && !$('production-login').disabled); } catch (error) { error.message += `; status=${$('status').textContent}; auth=${$('production-auth-status').textContent}; paths=${paths.join(',')}; loginCalls=${loginCalls}`; throw error; }
  assert.equal(loginCalls, 1);
  assert.deepEqual(paths.filter(path => /(?:receipt|operations?|prepare|commit|abort|query)/i.test(path)), [], 'C34 login must not replay or reconcile a retired operation');
  assert.equal($('publish').disabled, true, 'initial empty selection cannot publish');
  const selectedFrame = {id:'2:1',type:'FRAME',name:'Eligible frame'};
  sdk.currentPage.children = [selectedFrame]; sdk.currentPage.selection = [selectedFrame];
  selectionChanged();
  await settle(() => $('selection-summary').textContent === '1 个画板' && !$('publish').disabled);
  sdk.currentPage.selection = [];
  selectionChanged();
  await settle(() => $('publish').disabled);
  assert.equal($('publish').disabled, true, 'handled change notification invalidates old eligibility');
  await settle(() => $('selection-summary').textContent === '0 个画板');
  assert.equal($('publish').disabled, true, 'zero current frames cannot publish');
  sdk.currentPage.selection = [selectedFrame]; selectionChanged();
  await settle(() => !$('publish').disabled);
  sdk.currentPage.selection = null; selectionChanged();
  await settle(() => $('publish').disabled);
  assert.equal($('publish').disabled, true, 'failed list cannot retain old publish eligibility');
  await settle(() => ['0 个画板', '画板暂不可用'].includes($('selection-summary').textContent));
  assert.equal($('publish').disabled, true);
  sdk.currentPage.selection = [];
  if (legacyLogin) { assert.equal($('production-origin').value, 'https://service.example.test:49156'); const saved = [...storage.values()].find(value => value?.refreshToken); assert.equal(saved.origin, 'https://service.example.test:49156'); assert.ok(!JSON.stringify([...storage]).includes('192.168.1.50')); }
  assert.equal($('production-password').value, ''); assert.equal($('production-login-form').hidden, true); assert.equal($('production-project-fields').hidden, false);
  const stored = JSON.stringify([...storage]); assert.equal(stored.includes('synthetic-refresh'), !writeFails); if (writeFails) assert.equal($('production-remember').disabled, true); assert.ok(!stored.includes('synthetic-password-not-for-storage')); assert.ok(!stored.includes('synthetic-access'));
});

test('hello alone may expire and retry safely; exact-parent checks reject forged opaque windows', async () => {
  const parent = {}; assert.equal(browserPeer({ source: {}, origin: 'null' }, { parentWindow: parent, parentOrigin: 'https://www.figma.com' }), false); assert.equal(browserPeer({ source: parent, origin: 'https://evil.example' }, { parentWindow: parent, parentOrigin: 'https://www.figma.com' }), false);
  let receiver; let drop = true;
  const bridge = createBridge({ channel: 'test', subscribe(fn) { receiver = fn; }, trustedPeer: peer => peer === parent, send(message) { if (!drop) queueMicrotask(() => receiver({ v: 1, channel: 'test', kind: 'terminalAck', requestId: message.requestId, physicalDone: true, ok: true, cancelled: false, result: {} }, parent)); }, makeRequestId: (() => { let n = 0; return () => `test-${++n}`; })() });
  await assert.rejects(bridge.request('hello', {}, { helloTimeoutMs: 5 }), { code: 'REQUEST_TIMEOUT' }); assert.equal(bridge.snapshot().outgoing, 0); drop = false; await bridge.request('hello', {}, { helloTimeoutMs: 50 }); await bridge.close();
});

test('SDK transport keeps nonopaque origins pinned and supports official onmessage-only API', () => {
  const sdk = { ui: { postMessage(_message, options) { assert.equal(options.origin, 'https://ui.example'); } } }; const transport = createFigmaTransport(sdk, 'https://ui.example'); let received = false; const off = transport.subscribe((_m, peer) => { received = transport.trustedPeer(peer); }); sdk.ui.onmessage({}, { origin: 'null' }); assert.equal(received, false); sdk.ui.onmessage({}, { origin: 'https://ui.example' }); assert.equal(received, true); transport.send({}); off(); assert.equal(sdk.ui.onmessage, undefined);
});
