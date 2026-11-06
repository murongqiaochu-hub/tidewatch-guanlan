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
function documentModel(html) {
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[2], new Element(m[1])]));
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

for (const scenario of ['terminal','pending','invalid','denied']) test(`compiled C34 login clears retired journals without receipt or publish traffic: ${scenario}`,async()=>{
  const writeFails=false,dropHello=false;
  const bundle = await compiled(); const doc = documentModel(bundle.html); const storage = new Map(); const events = new Set(); const sent = []; const user = { id: 'usr_1', username: 'tester', role: 'admin' }; let callback; let shown = 0; let hellos = 0; let loginCalls = 0; const startupTimer = (fn, ms) => setTimeout(fn, ms === 4000 ? 1 : ms);
  const legacy='independent-inspector.publish.pending.v1.production';
  const refreshKey=`${legacy}-refresh`;
  // Baseline had four receipt outcomes (terminal/pending/invalid/denied). C34 retires the
  // journal before login, so every shape must be deleted without any receipt or recovery
  // request. `denied` is kept as a shape whose old receipt would have been 403.
  storage.set(legacy, scenario === 'terminal' ? {phase:'committed',sessionId:'retired-session',verified:false,mappingAvailable:false}
    : scenario === 'pending' ? {phase:'unknownPrepare',operationId:`op_${'9'.repeat(32)}_${'a'.repeat(64)}`,locked:true}
    : scenario === 'invalid' ? {phase:'not-a-phase',completed:'invalid'}
    : {phase:'unknownCommit',operationId:`op_${'8'.repeat(32)}_${'b'.repeat(64)}`,sessionId:'retired-session',locked:true});
  storage.set(refreshKey,null);storage.set('another-plugin',{keep:true});
  for(const name of ['a','b']) storage.set(legacy+'.journal.writer_'+name.repeat(20),scenario==='invalid'?{phase:'invalid'}:{phase:'unknownCommit',operationId:'retired_'+name,projectId:'project_1',service:{origin:'https://service.example.test:49156',allowLocalhost:false},locked:true,completed:[],done:0,total:1});
  const expectedStorageKeys=[refreshKey,'another-plugin'].sort();
  const paths=[];
  // Opaque parent silently drops HTTPS-targeted messages, matching browser origin rules.
  const parent = { postMessage(data, target) { sent.push(target); if (target !== '*') return; if (data.pluginMessage.operation === 'hello' && ++hellos === 1 && dropHello) return; queueMicrotask(() => callback?.(wire(data.pluginMessage), { origin: 'null' })); } };
  const win = { parent, crypto: webcrypto, AbortController, setTimeout, clearTimeout, addEventListener(_k, f) { events.add(f); }, removeEventListener(_k, f) { events.delete(f); }, async fetch(url) {
    if (url.endsWith('/api/auth/login')) loginCalls++;
    paths.push(new URL(url).pathname);
    if(url.endsWith('/receipt')) assert.fail('retired recovery request must not be sent');
    assert.equal(/retired-session|retired_|op_[89]/.test(new URL(url).pathname), false, 'retired identities must never be queried');
    const value=url.endsWith('/api/auth/login')?{token:'synthetic-access',user}:url.endsWith('/api/auth/me')?user:url.endsWith('/groups')||url.endsWith('/api/project-groups')?{groups:[]}:{projects:[{id:'project_1',name:'Test project',groupId:null,permissions:{canPublish:true}}]};
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  } };
  const sdk = { editorType: 'figma', root: { id: '0:0', name: 'Document' }, currentPage: { id: '1:1', name: 'Page', selection: [], children: [] }, clientStorage: { async keysAsync() { return [...storage.keys()]; }, async getAsync(k) { return wire(storage.get(k)); }, async setAsync(k, v) { if (writeFails) throw new Error('synthetic storage unavailable'); storage.set(k, v); }, async deleteAsync(k) { storage.delete(k); } }, ui: { onmessage: undefined, resize() {}, postMessage(data, options) { assert.equal(options.origin, '*'); queueMicrotask(() => { for (const f of events) f({ source: parent, origin: 'null', data: wire({ pluginMessage: data }) }); }); } }, showUI(html, options) {
    shown++; assert.equal(options.title, BRAND.pluginName); callback = sdk.ui.onmessage; assert.equal(typeof callback, 'function', 'listener must precede showUI');
    vm.runInNewContext(bundle.ui, { window: win, document: doc, Uint8Array, ArrayBuffer, DataView, URL, TextEncoder, TextDecoder, setTimeout: startupTimer, clearTimeout, __INDEPENDENT_PRODUCTION__: { serviceOrigin: 'https://service.example.test:49156', serviceOrigins: ['https://service.example.test:49156', 'http://nas.example.test:4318', 'http://192.168.1.50:4318'] } });
  } };
  const figmaEvents = new Map(); sdk.on = (name, fn) => figmaEvents.set(name, [...(figmaEvents.get(name) || []), fn]); sdk.off = (name, fn) => figmaEvents.set(name, (figmaEvents.get(name) || []).filter(listener => listener !== fn));
  const selectionChanged = () => { for (const listener of figmaEvents.get('selectionchange') || []) listener(); };
  const context = vm.createContext({ figma: sdk, __html__: bundle.html, __INDEPENDENT_PRODUCTION__: { serviceOrigin: 'https://service.example.test:49156', serviceOrigins: ['https://service.example.test:49156', 'http://nas.example.test:4318', 'http://192.168.1.50:4318'] }, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout });
  vm.runInContext(bundle.main, context);
  try { await settle(() => !doc.nodes.get('production-remember').disabled); } catch (error) { error.message += `; status=${doc.nodes.get('status').textContent}; auth=${doc.nodes.get('production-auth-status').textContent}`; throw error; }
  assert.equal(shown, 1); assert.ok(sent.length > 0); assert.ok(sent.every(target => target === '*')); assert.equal(vm.runInContext('typeof URL + ":" + typeof TextEncoder + ":" + typeof crypto', context), 'undefined:undefined:undefined');
  const $ = k => doc.nodes.get(k); $('production-remember').checked = false; $('production-remember').dispatch('change'); assert.equal($('production-remember').checked, false);
  
  $('production-username').value = 'tester'; $('production-password').value = 'synthetic-password-not-for-storage';
  $('production-login').dispatch('click', { isTrusted: false }); assert.equal(loginCalls, 0);
  if (dropHello) $('production-login-form').dispatch('keydown', { key: 'Enter' });
  else $('production-login').dispatch('click');
  // A following native submit or extra click must not duplicate the active login.
  $('production-login-form').dispatch('submit'); $('production-login').dispatch('click');
  await settle(() => $('production-auth-status').textContent?.startsWith('已登录') && !$('production-login').disabled);
  assert.equal(loginCalls,1);assert.equal($('app').dataset.productionStage,'workspace');
  assert.deepEqual([...storage.keys()].sort(),expectedStorageKeys);assert.equal(storage.get(refreshKey),null);assert.deepEqual(storage.get('another-plugin'),{keep:true});
  assert.equal($('production-pending-tasks'),undefined);assert.equal($('query'),undefined);assert.equal($('abort'),undefined);
  assert.equal($('package-recovery'),undefined);assert.equal($('recovery'),undefined);
  assert.ok(!paths.some(p=>/receipt|publish|operation|prepare|commit|cancel|query|abort/i.test(p)));
  // C34 has no phantom terminal to verify: a retired journal cannot keep publishing
  // disabled. Eligibility alone gates the action until a live unknown state re-locks it.
  assert.equal($('publish').disabled,true,'no selection is still not publishable');
  const selectedFrame={id:'2:1',type:'FRAME',name:'Eligible frame'};sdk.currentPage.children=[selectedFrame];sdk.currentPage.selection=[selectedFrame];selectionChanged();
  await settle(()=>$('selection-summary').textContent==='1 个画板');
  assert.equal($('publish').disabled,false);
});
