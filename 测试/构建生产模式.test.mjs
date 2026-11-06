import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildProject } from '../构建/build.mjs'
import { BRAND } from '../品牌/identity.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const legacyOrigins = ['http://nas.example.test:4318', 'http://192.168.1.50:4318']
const options = { mode: 'release', production: true, serviceOrigin: 'https://service.example.test:49156', localDevelopmentId: 'heron-sync-stage0-local', retainExistingPrivateApi: true, legacyOrigins }

test('production build fails closed without exact origin/identity; no fake registered local IDs', async () => {
  await assert.rejects(buildProject({ production: true }))
  await assert.rejects(buildProject({ production: true, serviceOrigin: options.serviceOrigin }))
  await assert.rejects(buildProject({ ...options, localDevelopmentId: 'new-fake-registration' }))
  await assert.rejects(buildProject({ ...options, serviceOrigin: 'https://user:password@host.invalid' }))
  await assert.rejects(buildProject({ retainExistingPrivateApi: true }))
  await assert.rejects(buildProject({ localDevelopmentId: options.localDevelopmentId }))
})
test('explicit production build preserves existing local identity/settings, enables real UI once and has exact scoped network', async () => {
  const result = await buildProject(options), folder = path.join(root, '构建产物/生产兼容包')
  const manifest = JSON.parse(await fs.readFile(path.join(folder, '插件/manifest.json'), 'utf8'))
  assert.equal(manifest.id, options.localDevelopmentId); assert.equal(result.pluginIdPlaceholder, false)
  assert.equal(manifest.name,BRAND.pluginName);assert.deepEqual(manifest.networkAccess.allowedDomains, [options.serviceOrigin]);assert.ok(manifest.networkAccess.allowedDomains.every(value=>new URL(value).protocol==='https:')); assert.ok(manifest.networkAccess.reasoning.includes(BRAND.product)&&manifest.networkAccess.reasoning.includes('账户认证')&&manifest.networkAccess.reasoning.includes('设计稿发布')); assert.equal(Object.hasOwn(manifest.networkAccess,'devAllowedDomains'),false); assert.doesNotMatch(JSON.stringify(manifest),/localhost|127\.0\.0\.1/); assert.equal(manifest.enablePrivatePluginApi, true)
  const declaration = JSON.parse(await fs.readFile(path.join(folder, '构建声明.json'), 'utf8'))
  assert.equal(declaration.syntheticOnly, false); assert.equal(declaration.productionCompatibility, true)
  assert.equal(declaration.registeredPluginIdentityVerified, false); assert.equal(declaration.commercialLicenseCleared, false)
  const main = await fs.readFile(path.join(folder, '插件/main.js'), 'utf8'), ui = await fs.readFile(path.join(folder, '插件/ui.html'), 'utf8')
  assert.match(main, /const __INDEPENDENT_PRODUCTION__ = Object\.freeze\(/)
  assert.deepEqual(JSON.parse(main.split('\n')[0].match(/Object\.freeze\((.*)\);/)[1]).serviceOrigins, [options.serviceOrigin, ...legacyOrigins])
  assert.match(ui, /<meta name="independent-production" content="enabled"/)
  assert.doesNotMatch(ui, /<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/)
  const inline = ui.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]; assert.ok(inline); new vm.Script(inline)
  const calls = [], events = new Map(), memory = new Map()
  const page = { type: 'PAGE', id: 'own:page', name: '自造页面', selection: [], children: [] }
  const sdk = { editorType: 'figma', apiVersion: '1.0.0', mixed: Symbol('mixed'), fileKey: 'OwnRun07A', currentPage: page, root: { id: '0:0', type: 'DOCUMENT', name: '自造文件', children: [page] },
    showUI(...args) { calls.push(args) }, getNodeByIdAsync: async () => null, loadAllPagesAsync: async () => {},
    ui: { postMessage() {}, resize() {}, on(event, fn) { events.set('ui:' + event, fn) }, off(event) { events.delete('ui:' + event) } },
    on(event, fn) { events.set(event, fn) }, off(event) { events.delete(event) }, notify() {}, closePlugin() {},
    clientStorage: { async getAsync(key) { return memory.get(key) }, async setAsync(key, value) { memory.set(key, value) }, async deleteAsync(key) { memory.delete(key) } } }
  const context = vm.createContext({ figma: sdk, __html__: ui, console, setTimeout, clearTimeout, Uint8Array, ArrayBuffer })
  assert.equal('TextEncoder' in context, false); assert.equal('crypto' in context, false); assert.equal('URL' in context, false)
  try {
    const entry = vm.runInContext(main, context, { timeout: 1000 })
    assert.equal(typeof entry.startProductionPlugin, 'function'); assert.equal(calls.length, 1); assert.equal(calls[0][0], ui)
    await new Promise(resolve => setImmediate(resolve))
  } finally { events.get('close')?.() }
  for (const name of ['index.mjs', 'core.mjs', 'resources.mjs', 'inspector.css', 'production-adapter.mjs', 'production-shell.css']) assert.ok((await fs.stat(path.join(folder, '查看器', name))).isFile())
})
test('retaining private API is explicit, not implied by using production mode', async () => {
  await buildProject({ ...options, retainExistingPrivateApi: false })
  const manifest = JSON.parse(await fs.readFile(path.join(root, '构建产物/生产兼容包/插件/manifest.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'enablePrivatePluginApi'), false)
})
