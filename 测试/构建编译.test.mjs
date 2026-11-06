import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileESM } from '../构建/esm-compiler.mjs';
import { buildProject, inlinePluginUI, validateServiceOrigin, readAllowedFile } from '../构建/build.mjs';
import { privateFixtureDirectory, privateFile } from './宿主测试工具.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Own static compiler flattens named imports/aliases and keeps isolated local declarations',()=>{
  const modules=new Map([
    ['插件/a.mjs','export const n=6; export function twice(x){return x*2;} const same=99;'],
    ['插件/main.mjs',"import { n as number, twice } from './a.mjs'; const same=1; export function startPlugin(sdk,html){sdk.showUI(html,{width:480,height:720});return twice(number)+same;} if(typeof figma!=='undefined'&&typeof __html__!=='undefined')startPlugin(figma,__html__);"]
  ]);
  const result=compileESM(modules,'插件/main.mjs');assert.deepEqual(result.order,['插件/a.mjs','插件/main.mjs']);
  const calls=[],context=vm.createContext({figma:{showUI:(...a)=>calls.push(a)},__html__:'own-ui'});
  assert.equal('TextEncoder' in context,false);assert.equal('crypto' in context,false);
  const entry=vm.runInContext(result.code,context);assert.equal(typeof entry.startPlugin,'function');assert.equal(calls.length,1);assert.equal(entry.startPlugin({showUI(){}},''),13);assert.doesNotMatch(result.code,/\bimport\s*\{|\bexport\s+(?:const|function)/);
});
test('Compiler stable topology is independent of allowlist map insertion order',()=>{
  const pairs=[['m/a.mjs','export const alpha=1;'],['m/z.mjs','export const omega=2;'],['m/main.mjs',"import {omega} from './z.mjs';import {alpha} from './a.mjs';export const sum=alpha+omega;"]];
  const a=compileESM(new Map(pairs),'m/main.mjs'),b=compileESM(new Map(pairs.reverse()),'m/main.mjs');assert.equal(a.code,b.code);assert.deepEqual(a.order,['m/a.mjs','m/z.mjs','m/main.mjs']);assert.equal(vm.runInNewContext(a.code).sum,3);
});
test('Compiler namespace and named reexports preserve public values',()=>{
  const modules={ 'm/a.mjs':'export const value=7;', 'm/b.mjs':"export { value as renamed } from './a.mjs';", 'm/main.mjs':"import * as api from './b.mjs';export const result=api.renamed;" };
  assert.equal(vm.runInNewContext(compileESM(modules,'m/main.mjs').code).result,7);
});
test('Compiler ignores import/export words in comments, strings, regex and template content',()=>{
  const modules={'main.mjs':'// import nope from "bad";\n/* export bad */\nexport const text="export const {"; export function value(){const re=/export\\s+import/;return `import ${re.test("export import")}`;}' };
  const entry=vm.runInNewContext(compileESM(modules,'main.mjs').code);assert.equal(entry.text,'export const {');assert.equal(entry.value(),'import true');
});
for(const [name,modules] of [
  ['outside graph',{'main.mjs':"import {secret} from '../forbidden.mjs';export const x=secret;"}],
  ['bare dependency',{'main.mjs':"import {x} from 'npm-package';export const y=x;"}],
  ['dynamic import',{'main.mjs':"export function x(){return import('./a.mjs');}",'a.mjs':'export const a=1;'}],
  ['cycle',{'main.mjs':"import {a} from './a.mjs';export const x=a;",'a.mjs':"import {x} from './main.mjs';export const a=x;"}],
  ['default syntax',{'main.mjs':'export default 1;'}],
  ['missing named export',{'main.mjs':"import {b} from './a.mjs';export const x=b;",'a.mjs':'export const a=1;'}]
]) test('Compiler rejects '+name+' rather than copying unknown dependencies',()=>assert.throws(()=>compileESM(modules,'main.mjs')));
test('UI includes own ESM and CSS inline only, with raw text/network injection guards',()=>{
  const html='<!doctype html><head><link rel="stylesheet" href="./ui.css"></head><body><script type="module" src="./ui.mjs"></script></body>';
  const result=inlinePluginUI(html,'body {color:#172637}','(function(){return 1;})();');
  assert.match(result,/<style>/);assert.match(result,/<script type="module">/);assert.doesNotMatch(result,/<script[^>]+src=|<link/);
  assert.throws(()=>inlinePluginUI(html,'a{}','</script><script>alert(1)</script>'));
  assert.throws(()=>inlinePluginUI(html,'</style><img>','1;'));
  assert.throws(()=>inlinePluginUI(html.replace('</body>','<img src="https://external.example/a.png"></body>'),'a{}','1;'));
});
test('Manifest allows no network by default and only explicit exact HTTPS service origins',()=>{
  assert.equal(validateServiceOrigin(),null);assert.equal(validateServiceOrigin('https://explicit.example'),'https://explicit.example');
  for(const value of ['http://explicit.example','https://*.example','https://user:pass@example.com','https://a.example/path','https://a.example/?query=1','https://localhost','https://192.168.1.1','https://[::1]']) assert.throws(()=>validateServiceOrigin(value));
});
test('Source allowlist rejects traversal, symlinks and credentials paths, never directory recursion',async t=>{
  const directory=await privateFixtureDirectory(t,'.构建-');await privateFile(path.join(directory,'own.mjs'),'export const fresh=1;');
  assert.equal((await readAllowedFile(directory,'own.mjs')).toString(),'export const fresh=1;');
  await fs.symlink('./own.mjs',path.join(directory,'alias.mjs'));await assert.rejects(readAllowedFile(directory,'alias.mjs'));
  for(const name of ['../own.mjs','/etc/passwd','nested/../own.mjs','credential.mjs','backup.mjs','private-key.pem']) await assert.rejects(readAllowedFile(directory,name));
});
test('Actual own-source build is reproducible, packaged Main auto-starts once without TextEncoder/WebCrypto, UI parses and manifests/hashes are exact',async()=>{
  const first=await buildProject(),second=await buildProject();assert.equal(first.sourceZipSHA,second.sourceZipSHA);assert.deepEqual(first.outputFileHashes,second.outputFileHashes);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'开发包/插件/manifest.json'),'utf8'));assert.deepEqual(manifest.networkAccess.allowedDomains,['none']);assert.match(manifest.id,/REPLACE/);assert.equal(manifest.documentAccess,'dynamic-page');assert.equal(manifest.main,'main.js');assert.equal(manifest.ui,'ui.html');
  const main=await fs.readFile(path.join(root,'开发包/插件/main.js'),'utf8'),ui=await fs.readFile(path.join(root,'开发包/插件/ui.html'),'utf8');
  const calls=[],events=new Map(),storage=new Map();
  const sdk={getNodeByIdAsync:async()=>null,loadAllPagesAsync:async()=>{},mixed:Symbol('mixed'),fileKey:'own-design',editorType:'figma',apiVersion:'1.0.0',showUI:(...args)=>calls.push(args),ui:{postMessage(){},resize(){},on:(event,fn)=>events.set('ui:'+event,fn),off:event=>events.delete('ui:'+event)},on:(event,fn)=>events.set(event,fn),off:(event)=>events.delete(event),currentPage:{id:'own-page',selection:[],children:[],type:'PAGE'},root:{children:[]},clientStorage:{async getAsync(k){return storage.get(k);},async setAsync(k,v){storage.set(k,v);},async deleteAsync(k){storage.delete(k);}},notify(){},closePlugin(){}};
  const context=vm.createContext({figma:sdk,__html__:ui,console,setTimeout,clearTimeout,Uint8Array,ArrayBuffer,URL});
  assert.equal('TextEncoder' in context,false);assert.equal('crypto' in context,false);
  const entry=vm.runInContext(main,context,{timeout:1000});assert.equal(typeof entry.startPlugin,'function');assert.equal(calls.length,1);assert.equal(calls[0][0],ui);
  const script=ui.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];assert.ok(script);new vm.Script(script);assert.doesNotMatch(ui,/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/);
  if(events.has('close')) events.get('close')();
  for(const name of Object.keys(first.outputFileHashes)) {
    const stat=await fs.lstat(path.join(root,'开发包',name));assert.equal(stat.isSymbolicLink(),false);assert.equal(stat.mode&0o777,0o600);
    const bytes=await fs.readFile(path.join(root,name)).catch(()=>null);
    if(name.startsWith('查看器/')) assert.deepEqual(await fs.readFile(path.join(root,'开发包',name)),bytes);
  }
  const zip=await fs.readFile(path.join(root,'构建产物/独立开发源码.zip'));
  const check=spawnSync('python3',['-c',"import sys,io,zipfile,json,hashlib\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; p=json.loads(z.read('SourceParams.json')); assert set(z.namelist())==set(p['allowedFileHashes'])|{'SourceParams.json'}\nfor n,h in p['allowedFileHashes'].items(): assert hashlib.sha256(z.read(n)).hexdigest()==h; assert (z.getinfo(n).external_attr>>16)&0o777==0o600\nassert all(not n.startswith(('开发包/','构建产物/')) and not n.endswith('.txt') for n in z.namelist()); print('OK')"],{input:zip,encoding:'utf8'});assert.equal(check.status,0,check.stderr);assert.equal(check.stdout.trim(),'OK');
});
test('Release source excludes synthetic fixtures/tests, writes separate artifact directory, and rejects hash pin mismatch',async()=>{
  const release=await buildProject({mode:'release'});assert.ok(!release.sourceEntries.some(n=>n.startsWith('测试/')));assert.ok(!release.sourceEntries.includes('宿主/synthetic-fixtures.mjs'));assert.ok(!release.sourceEntries.includes('宿主/demo-server.mjs'));assert.ok(release.sourceEntries.includes('宿主/stored-zip.mjs'));
  assert.ok((await fs.lstat(path.join(root,'构建产物/发布包/插件/main.js'))).isFile());
  await assert.rejects(buildProject({expectedFileHashes:{'插件/main.mjs':'0'.repeat(64)}}),/hash mismatch/);
  await assert.rejects(buildProject({pluginId:'fake-published-id'}));
});
