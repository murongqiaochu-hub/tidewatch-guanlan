import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { mountProductionUI, pluginErrorText, productionProgress } from '../插件/ui.mjs';
import { createBridge } from '../插件/bridge.mjs';
import { CHANNEL } from '../插件/protocol.mjs';

// Adapted from 插件登录失败反馈.test.mjs's constrained DOM fixture.
// Import source directly: no build, bundles, browser or real-device acceptance.
class Element {
  constructor(tag = 'div', fragment = false) { this.tagName = tag.toUpperCase(); this.nodeType = fragment ? 11 : 1; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.events = new Map(); this.children = []; this.parentNode = null; }
  addEventListener(k, f) { this.events.set(k, [...(this.events.get(k) || []), f]); }
  removeEventListener() {}
  focus() {}
  setAttribute(k, v) { this[k] = v; }
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
const html = await fs.readFile(new URL('../插件/ui.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../插件/ui.mjs', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../插件/ui.css', import.meta.url), 'utf8');
const settle = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'lifecycle did not settle'); };
async function fixture({ canPublish = true } = {}) {
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[2], new Element(m[1])]));
  attachQuotaAnchors(nodes);
  const $ = k => nodes.get(k); $('scope').value = 'selection'; $('scale').value = '1';
  const doc = { addEventListener() {}, removeEventListener() {}, getElementById: k => nodes.get(k) || null, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), querySelectorAll: () => [], querySelector(q) { if (q === 'meta[name="figma-parent-origin"]') return { content: 'https://www.figma.com' }; return q.startsWith('#') ? nodes.get(q.slice(1)) || null : null; } };
  const events = new Set(), actions = [], fetches = []; let receiver, releasePublish, publishCount = 0;
  let state = { production: true, phase: 'idle', config: { origin: 'https://service.example' }, rememberSupported: false };
  const parent = { postMessage({ pluginMessage }) { queueMicrotask(() => receiver(pluginMessage, {})); } };
  const main = createBridge({ channel: CHANNEL, send(message) { queueMicrotask(() => { for (const f of events) f({ source: parent, origin: 'null', data: { pluginMessage: message } }); }); }, subscribe(fn) { receiver = fn; return () => {}; }, trustedPeer: () => true, handlers: {
    hello() { return { product: 'Independent Inspector · Development', verification: 'DEVICE_VALIDATION_PENDING', height: 640, state }; },
    list({ scope }) { return { scope, pageId: '1:1', frames: [{ id: '2:1', name: '超长画板名'.repeat(40) }], excluded: [] }; },
    async 'production-control'(payload) {
      actions.push(payload.action);
      if (payload.action === 'remember-read') return { remembered: null, supported: false };
      if (payload.action === 'publish') { publishCount++; await new Promise(resolve => { releasePublish = resolve; }); }
      return { state };
    }
  } });
  const win = { parent, crypto: webcrypto, AbortController, setTimeout, clearTimeout, addEventListener(_k, f) { events.add(f); }, removeEventListener(_k, f) { events.delete(f); }, async fetch(url) {
    fetches.push(url); const user = { id: 'usr_1', username: 'tester', role: 'designer' };
    return Response.json(url.endsWith('/api/auth/login') ? { token: 'fixture-token', user } : url.endsWith('/api/auth/me') ? user : url.endsWith('/groups') || url.endsWith('/api/project-groups') ? { groups: [] } : { projects: [{ id: 'project_1', name: '项目', groupId: null, permissions: { canPublish } }] });
  } };
  const ui = mountProductionUI(win, doc); await ui.ready;
  assertQuotaPlacement($);
  $('production-username').value = 'tester'; $('production-password').value = 'fixture-password'; $('production-login').dispatch('click');
  await settle(() => $('production-auth-status').textContent?.startsWith('已登录') && !$('production-login').disabled);
  return { $, actions, fetches, get publishCount() { return publishCount; }, release() { releasePublish?.(); }, async notice(next) { state = { ...state, ...next }; await main.request('notice', { state }); }, async dispose() { await ui.dispose(); await main.close(); } };
}

test('C28: production recovery DOM/handlers and own close button are removed, not hidden', () => {
  assert.doesNotMatch(html, /id="(?:close|recovery|recovery-note|query|abort|production-recover-mapping|production-pending-[^"]*)"/);
  const production = source.slice(source.indexOf('export function mountProductionUI'));
  assert.doesNotMatch(production, /reconcile|cancel-recovery|recoverCommit|recoveryPending|recoveryReadFailed|pendingForProject|查询状态|旧任务|恢复记录/);
  assert.match(css, /#production-progress-frames li > span:last-child[^}]*flex: 0 0 auto; white-space: nowrap/);
  assert.match(css, /#production-progress-frames li > span:first-child[^}]*min-width: 0;[^}]*text-overflow: ellipsis; white-space: nowrap/);
});

test('C28: error output is short and never echoes details or HTTP codes', () => {
  for (const code of ['SDK_EXPORT_FAILED', 'HTTP_FAILED', 'BAD_ORIGIN', 'CANCELLED']) assert.equal(pluginErrorText({ code, status: 403, message: 'sensitive-details' }), '上传失败，请联系开发者');
  for (const code of ['UNKNOWN_COMMIT', 'UNKNOWN_PREPARE', 'VISIBILITY_UNCONFIRMED']) assert.equal(pluginErrorText({ code, status: 503 }), '未能确认上传结果，请联系开发者');
});

test('C28: progress uses real per-stage counts, never export percentage for uploading/commit', () => {
  assert.deepEqual(productionProgress({ phase: 'exporting', exportDone: 1, exportTotal: 4, sourceBytes: 200 }), { caption: '画板导出', percent: 25, detail: '1/4 个画板 · 已导出 0.20 KB' });
  assert.equal(productionProgress({ phase: 'uploading', exportDone: 4, exportTotal: 4 }).percent, null);
  assert.deepEqual(productionProgress({ phase: 'uploading', uploadDone: 1, uploadTotal: 2, uploadedBytes: 100, uploadTotalBytes: 400 }), { caption: '本批资源上传', percent: 25, detail: '1/2 个资源 · 0.10/0.39 KB' });
  const commit = productionProgress({ phase: 'committing', done: 16, total: 32, exportDone: 32, exportTotal: 32 }, 125.9);
  assert.equal(commit.percent, null); assert.match(commit.detail, /16\/32.*125 秒/);
  assert.equal(productionProgress({ phase: 'committed', verified: false, done: 32, total: 32 }).percent, null);
  assert.equal(productionProgress({ phase: 'exporting', exportDone: 9, exportTotal: 4 }).percent, null);
});

test('C28: login never reconciles; normal work has no error card; failure permits explicit next attempt with current guard', async () => {
  const f = await fixture();
  try {
    assert.ok(!f.actions.includes('reconcile')); assert.ok(!f.fetches.some(url => /receipt|operations/.test(url)));
    for (const phase of ['exporting','preparing','uploading','committing']) {
      await f.notice({ phase, locked: true, exportDone: 1, exportTotal: 1, done: 0, total: 1, error: 'HTTP_FAILED', httpStatus: 503 });
      assert.doesNotMatch(f.$('status').textContent, /失败|HTTP|503|查询|保留/);
    }
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.match(f.$('progress').textContent, /已等待 [1-9]\d* 秒/);
    assert.equal(f.$('progress-ring-text').textContent, '—');
    await f.notice({ phase: 'unknownCommit', locked: true }); assert.equal(f.$('status').textContent, '未能确认上传结果，请联系开发者');
    await f.notice({ phase: 'failed', locked: true, failureStage: 'exporting' });
    assert.equal(f.$('status').textContent, '上传失败，请联系开发者'); assert.equal(f.$('publish').disabled, false);
    f.$('production-progress-back').dispatch('click'); f.$('publish').dispatch('click'); f.$('publish').dispatch('click');
    await settle(() => f.publishCount === 1); assert.equal(f.$('publish').disabled, true);
    assert.equal(f.$('app').dataset.taskPhase, 'authorizing', 'new explicit attempt clears the old failure presentation');
    f.release(); await settle(() => !f.$('publish').disabled);
    assert.equal(f.publishCount, 1);
    f.$('publish').dispatch('click', { isTrusted: false }); assert.equal(f.publishCount, 1);
  } finally { f.release(); await f.dispose(); }
});

test('C28: readonly permission remains enforced even for a forged trusted click', async () => {
  const f = await fixture({ canPublish: false });
  try { assert.equal(f.$('publish').disabled, true); f.$('publish').dispatch('click'); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.publishCount, 0); }
  finally { await f.dispose(); }
});
