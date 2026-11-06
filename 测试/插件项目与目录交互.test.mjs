import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionHTTP, validateProductionOperation } from '../插件/production-protocol.mjs';
import { validateOperation, validateOperationResult } from '../插件/protocol.mjs';
import { startProductionPlugin } from '../插件/main.mjs';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
test('创建项目经既有认证边界POST；不接受无效姓名和伪造响应，不伪造列表', async () => {
  const requests = [];
  const client = createProductionHTTP({ origin: 'https://service.example', fetchAPI: async (url, options) => {
    requests.push({ path: new URL(url).pathname, method: options.method, headers: options.headers, body: options.body && JSON.parse(new TextDecoder().decode(options.body)) });
    return reply({ id: 'server-project', name: '团队项目' }, 201);
  } });
  client.setToken('fixture.token');
  assert.deepEqual(await client.createProject('团队项目'), { id: 'server-project', name: '团队项目' });
  assert.deepEqual(requests.map(r => [r.path, r.method, r.body]), [['/api/projects', 'POST', { name: '团队项目' }]]);
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture.token');
  for (const bad of ['', '  ', ' 前空格', 'x'.repeat(129)]) await assert.rejects(client.createProject(bad), { code: 'BAD_SCHEMA' });
  assert.equal(requests.length, 1);
  const invalid = createProductionHTTP({ origin: 'https://service.example', fetchAPI: async () => reply({ id: 'fake', name: '其它项目' }, 201) });
  invalid.setToken('fixture.token'); await assert.rejects(invalid.createProject('团队项目'), { code: 'HTTP_RESPONSE_INVALID' });
});
test('刷新目录通知严格schema，生产协议不允许任意注入发布操作', () => {
  validateOperation('frames-changed', {});
  validateOperationResult('frames-changed', { accepted: true });
  assert.throws(() => validateOperation('frames-changed', { frames: [] }));
  assert.throws(() => validateOperationResult('frames-changed', { accepted: false }));
  validateProductionOperation('frames-changed', {});
  assert.throws(() => validateProductionOperation('publish', { projectId: 'x' }));
});
test('SDK selection/current page/current page nodechange 被订阅，dispose 清理，无全页加载', async () => {
  const registered = new Map(), removed = [], pageListeners = new Map(); let uiListener = null;
  const page = { id: '1:1', children: [], selection: [], on(type, fn) { pageListeners.set(type, fn); }, off(type, fn) { if (pageListeners.get(type) === fn) pageListeners.delete(type); } };
  const sdk = { editorType: 'figma', root: { name: 'Fixture' }, currentPage: page,
    on(type, fn) { registered.set(type, fn); }, off(type, fn) { removed.push(type); assert.equal(registered.get(type), fn); },
    showUI() {}, closePlugin() {}, ui: { on(type, fn) { if (type === 'message') uiListener = fn; }, off(type, fn) { if (type === 'message' && uiListener === fn) uiListener = null; }, postMessage(message) { if (message.kind === 'request' && message.operation === 'frames-changed') queueMicrotask(() => uiListener?.({ v: message.v, channel: message.channel, kind: 'terminalAck', requestId: message.requestId, physicalDone: true, ok: true, cancelled: false, result: { accepted: true } }, { origin: 'null' })); }, resize() {} },
    clientStorage: { async getAsync() { return null; } } };
  const plugin = startProductionPlugin(sdk, '<html></html>', { production: {} });
  assert.ok(registered.has('selectionchange'));
  assert.ok(registered.has('currentpagechange'));
  assert.ok(pageListeners.has('nodechange'));
  const next = { id: '1:2', children: [], selection: [], on: page.on, off: page.off };
  sdk.currentPage = next; registered.get('currentpagechange')();
  await plugin.dispose();
  assert.deepEqual(removed.sort(), ['currentpagechange', 'selectionchange']);
  assert.equal(pageListeners.has('nodechange'), false);
  assert.equal(sdk.loadAllPagesAsync, undefined);
});
