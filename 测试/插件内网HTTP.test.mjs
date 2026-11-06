import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { compileESM } from '../构建/esm-compiler.mjs';
import { pluginFiles } from '../构建/build.mjs';
import { productionServiceOrigin, normalizeProductionLoginOrigin, createProductionHTTP, validateProductionOperation } from '../插件/production-protocol.mjs';

// 地址不再内置，测试显式注入示例部署（TEST-NET 与 example 域）。
const injected = {
  serviceOrigin: 'https://service.example.test:49156',
  serviceOrigins: ['https://service.example.test:49156', 'http://nas.example.test:4318', 'http://192.168.1.50:4318'],
};
globalThis.__INDEPENDENT_PRODUCTION__ = injected;
for(const origin of ['http://10.0.0.2:4318','http://172.16.0.2:4318','http://172.31.255.254','http://192.168.1.50:4318','https://service.example.test:49156'])test('production canonical private HTTP / HTTPS: '+origin,()=>{assert.equal(productionServiceOrigin(origin),origin);validateProductionOperation('production-control',{action:'connect',service:{origin,allowLocalhost:false},namespace:'src_model_'+'a'.repeat(32)});});
for(const origin of ['http://example.com','http://8.8.8.8','http://172.32.0.1','http://192.169.0.1','http://127.0.0.1','http://localhost:4318','http://169.254.169.254','http://user:pass@192.168.1.50:4318','http://192.168.1.50:4318/path','http://192.168.1.50:4318#fragment','http://192.168.1.50:4318?query'])test('production rejects untrusted HTTP origin: '+origin,()=>{assert.throws(()=>productionServiceOrigin(origin),/BAD_ORIGIN/);});
const alias = 'http://nas.example.test:4318', legacy = 'http://192.168.1.50:4318';
const acceptedAliases = [alias, `${alias}/`, 'http://NAS.EXAMPLE.TEST:4318', 'HTTP://NAS.EXAMPLE.TEST:4318/'];
const deniedAliases = ['http://nas.example.test', 'http://nas.example.test:80', 'http://nas.example.test:4319', 'http://nas.example.test:04318', `${alias}/path`, `${alias}//`, `${alias}/.`, `${alias}?`, `${alias}#`, `${alias}?query`, `${alias}#fragment`, 'http://user:pass@nas.example.test:4318', 'http://@nas.example.test:4318', 'http://nas.example.test.:4318', 'http://nas.example.test.evil:4318', 'http://other.local:4318', 'http://*.local:4318', 'http://localhost:4318', 'http://example.com:4318'];
for (const origin of acceptedAliases) test('exact HTTP alias canonicalizes: '+origin, () => { assert.equal(productionServiceOrigin(origin), alias); });
for (const origin of deniedAliases) test('HTTP alias rejects nonexact origin: '+origin, () => { assert.throws(() => productionServiceOrigin(origin), /BAD_ORIGIN/); });
test('compiled production schema accepts only exact additional HTTP alias without URL in SDK sandbox', async () => {
  const modules = new Map(await Promise.all(pluginFiles.filter(name => name.endsWith('.mjs')).map(async name => [name, await fs.readFile(new URL('../'+name, import.meta.url), 'utf8')])));
  const context = vm.createContext({ Uint8Array, ArrayBuffer, __INDEPENDENT_PRODUCTION__: injected });
  const protocol = vm.runInContext(compileESM(modules, '插件/production-protocol.mjs').code, context);
  assert.equal(vm.runInContext('typeof URL', context), 'undefined');
  for (const origin of acceptedAliases) {
    assert.equal(protocol.productionServiceOrigin(origin), alias);
    vm.runInContext(`origin = ${JSON.stringify(origin)};`, context);
    const payload = vm.runInContext(`({action:'connect',service:{origin,allowLocalhost:false},namespace:'src_model_'+'a'.repeat(32)})`, context);
    protocol.validateProductionOperation('production-control', payload);
  }
  for (const origin of deniedAliases) assert.throws(() => protocol.productionServiceOrigin(origin), /BAD_ORIGIN/);
  assert.equal(protocol.productionServiceOrigin(legacy), legacy);
});
test('compiled main and UI include the visibility module from the explicit source allowlist', async () => {
  for (const name of ['插件/publication-visibility.mjs', '插件/publication-snapshot.mjs']) assert.ok(pluginFiles.includes(name));
  const modules = new Map(await Promise.all(pluginFiles.filter(name => name.endsWith('.mjs')).map(async name => [name, await fs.readFile(new URL('../' + name, import.meta.url), 'utf8')])));
  for (const entry of ['插件/main.mjs', '插件/ui.mjs']) {
    const output = compileESM(modules, entry);
    for (const name of ['插件/publication-visibility.mjs', '插件/publication-snapshot.mjs']) assert.ok(output.order.includes(name), `${entry} must compile ${name}`);
    assert.doesNotThrow(() => new vm.Script(output.code));
  }
});
const httpsOrigin = 'https://service.example.test:49156';
for (const origin of [legacy, ...acceptedAliases]) test('fresh login maps exact historical HTTP to existing HTTPS: '+origin, () => {
  assert.equal(normalizeProductionLoginOrigin(origin), httpsOrigin);
  assert.equal(normalizeProductionLoginOrigin(origin, {state:{phase:'idle',locked:false}}), httpsOrigin);
  for (const state of [{locked:true}, {sessionId:'original-session'}, {requestId:'original-request'}, {completed:[{sessionId:'original-session'}]}, {phase:'unknownPrepare'}, {phase:'unknownCommit'}, {phase:'committed'}]) {
    const before = structuredClone(state); assert.throws(() => normalizeProductionLoginOrigin(origin, {state}), /BAD_ORIGIN/); assert.deepEqual(state, before);
  }
  const remembered = {origin:productionServiceOrigin(origin),refreshToken:'original-device'}, before = structuredClone(remembered);
  assert.throws(() => normalizeProductionLoginOrigin(origin,{remembered}), /BAD_ORIGIN/); assert.deepEqual(remembered,before);
  const rawRemembered = {origin,refreshToken:'original-device'}, rawBefore = structuredClone(rawRemembered);
  assert.throws(() => normalizeProductionLoginOrigin(origin,{remembered:rawRemembered}), /BAD_ORIGIN/); assert.deepEqual(rawRemembered,rawBefore);
});
test('wire origins and other explicit services are never migrated', () => {
  assert.equal(productionServiceOrigin(legacy),legacy); assert.equal(productionServiceOrigin(alias),alias);
  assert.equal(normalizeProductionLoginOrigin('https://service.example'), 'https://service.example');
  assert.equal(normalizeProductionLoginOrigin('http://10.0.0.2:4318'), 'http://10.0.0.2:4318');
});
for (const origin of [legacy,alias]) test('fresh normalized HTTP login fetch pins existing HTTPS: '+origin, async () => {
  const urls = []; const client = createProductionHTTP({origin:normalizeProductionLoginOrigin(origin),fetchAPI:async url => {urls.push(url);return Response.json({projects:[]});}});
  client.setToken('test-only-token');await client.projects();assert.equal(new URL(urls[0]).origin,httpsOrigin);
});
test('production LAN HTTP keeps no-cookie no-redirect explicit origin transport',async()=>{const calls=[];const client=createProductionHTTP({origin:'http://192.168.1.50:4318',fetchAPI:async(url,options)=>{calls.push({url,options});return Response.json({projects:[]});}});client.setToken('test-only-token');await client.projects();assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).origin,'http://192.168.1.50:4318');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');});
