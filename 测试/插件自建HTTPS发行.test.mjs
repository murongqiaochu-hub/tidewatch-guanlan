// Synthetic packaging/compile contract only: never real Figma acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { productionPluginConfig, productionPluginManifest, buildProject } from '../构建/build.mjs';
import { packagePluginRelease, inspectPluginRelease, readStoredPluginZIP, exactPluginHTTPSOrigin, CUSTOM_HTTPS_REASON } from '../平台/插件发行.mjs';
import { storedZip, sha256 } from '../宿主/stored-zip.mjs';
const options={serviceMode:'custom-https',release:'C34',date:'2026-11-04'}, pluginId='1699730787876999241';
function fixture(config=productionPluginConfig(options),manifest=productionPluginManifest({...options,pluginId})) {
 const prefix=`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify(config)});\n`;
 return {'main.js':Buffer.from(prefix+'// synthetic main\n'),'ui.html':Buffer.from('<meta name="independent-production" content="enabled"><script>'+prefix+'// synthetic UI\n</script>'),'manifest.json':Buffer.from(JSON.stringify(manifest))};
}
function forge(change,rehash=true){const files=readStoredPluginZIP(packagePluginRelease(fixture(),options));change(files);if(rehash){const info=JSON.parse(files.get('发行信息.json'));for(const n of ['main.js','ui.html','manifest.json'])info.files[n]=sha256(files.get(n));files.set('发行信息.json',Buffer.from(JSON.stringify(info)));}return storedZip([...files].map(([name,bytes])=>({name,bytes})));}
function runtimeChange(files,filename,change){let text=files.get(filename).toString();text=text.replace(/Object\.freeze\((\{[^\n]+\})\)/,(_,json)=>{const c=JSON.parse(json);change(c);return 'Object.freeze('+JSON.stringify(c)+')';});files.set(filename,Buffer.from(text));}
test('custom pure helpers: no env default/legacy leakage; fixed remains strict',()=>{
 assert.deepEqual(productionPluginConfig(options),{serviceMode:'custom-https',serviceOrigin:null,serviceOrigins:[],allowLocalhost:false});
 const manifest=productionPluginManifest({...options,pluginId});assert.equal(manifest.id,pluginId);assert.deepEqual(manifest.networkAccess,{allowedDomains:['*'],reasoning:CUSTOM_HTTPS_REASON});assert.equal('enablePrivatePluginApi' in manifest,false);
 for(const serviceOrigin of ['http://192.168.1.2','https://192.168.1.2','https://a.invalid/path','https://u:p@a.invalid','https://*.invalid'])assert.throws(()=>exactPluginHTTPSOrigin(serviceOrigin));
 for(const extra of [{serviceOrigin:'https://a.invalid'},{serviceOrigin:''},{legacyOrigins:[]},{legacyOrigins:'http://nas.local'},{serviceMode:'auto'},{serviceMode:'fixed-https'}])assert.throws(()=>productionPluginConfig({...options,...extra}));
 for(const id of ['heron-sync-stage0-local','1234','12x345',1699730787876999241])assert.throws(()=>productionPluginManifest({...options,pluginId:id}));
 assert.throws(()=>productionPluginManifest({...options,localDevelopmentId:'heron-sync-stage0-local'}));
 assert.throws(()=>productionPluginManifest({...options,localDevelopmentId:'heron-sync-stage0-local',retainExistingPrivateApi:true}));
});
test('fixed schema1 still uses exact single HTTPS domain and legacy runtime contract',()=>{
 const serviceOrigin='https://fixed.example.test',fixed={serviceOrigin,release:'C33',date:'2026-11-04'};
 const config=productionPluginConfig({...fixed,legacyOrigins:['http://nas.local']});
 const manifest=productionPluginManifest({...fixed,localDevelopmentId:'heron-sync-stage0-local'});
 assert.deepEqual(manifest.networkAccess.allowedDomains,[serviceOrigin]);
 const bytes=packagePluginRelease(fixture(config,manifest),fixed),info=inspectPluginRelease(bytes,fixed);
 assert.equal(JSON.parse(info.files.get('发行信息.json')).schema,1);assert.equal('serviceMode' in info,false);
 assert.throws(()=>inspectPluginRelease(bytes,options));
 manifest.networkAccess.allowedDomains=['*'];assert.throws(()=>packagePluginRelease(fixture(config,manifest),fixed));
});
test('custom schema2 requires explicit mode; reproducible ZIP and SHA binds all runtime files',()=>{
 const bytes=packagePluginRelease(fixture(),options),info=inspectPluginRelease(bytes,options);assert.deepEqual(bytes,packagePluginRelease(fixture(),options));assert.equal(info.sha256,sha256(bytes));assert.equal(info.serviceOrigin,null);assert.equal(info.serviceMode,'custom-https');const release=JSON.parse(info.files.get('发行信息.json'));assert.equal(release.schema,2);assert.equal(release.serviceMode,'custom-https');assert.match(info.files.get('安装说明.txt').toString(),/自己的 HTTPS 自建服务器/);
 assert.throws(()=>inspectPluginRelease(bytes));assert.throws(()=>inspectPluginRelease(bytes,{serviceOrigin:'https://a.invalid'}));assert.throws(()=>inspectPluginRelease(bytes,{...options,serviceOrigin:'https://a.invalid'}));
 const bad=Buffer.from(bytes);bad[40]^=1;assert.throws(()=>inspectPluginRelease(bad,options),/zip_crc/);
 assert.throws(()=>inspectPluginRelease(forge(f=>f.set('main.js',Buffer.concat([f.get('main.js'),Buffer.from('// changed')])),false),options),/mixed_release_files/);
});
for(const [name,change] of [
 ['fixed main config',f=>runtimeChange(f,'main.js',c=>{delete c.serviceMode;c.serviceOrigin='https://a.invalid';c.serviceOrigins=[c.serviceOrigin];})],
 ['main UI mode mismatch',f=>runtimeChange(f,'ui.html',c=>delete c.serviceMode)],
 ['default origin',f=>runtimeChange(f,'main.js',c=>c.serviceOrigin='https://a.invalid')],
 ['legacy list',f=>runtimeChange(f,'main.js',c=>c.serviceOrigins=['http://nas.local'])],
 ['localhost enabled',f=>runtimeChange(f,'main.js',c=>c.allowLocalhost=true)],
 ['unknown mode',f=>runtimeChange(f,'main.js',c=>c.serviceMode='custom-http')],
 ['unknown config',f=>runtimeChange(f,'main.js',c=>c.legacyOrigins=[])],
 ['disabled marker',f=>f.set('ui.html',Buffer.from(f.get('ui.html').toString().replace('content="enabled"','content="disabled"')))],
 ['release legacy list',f=>{const c=JSON.parse(f.get('发行信息.json'));c.serviceOrigins=[];f.set('发行信息.json',Buffer.from(JSON.stringify(c)));}],
 ...['wildcard+fixed','fixed','missing reasoning','vague reasoning','private API','dev domains','non-numeric ID'].map(name=>[name,f=>{const m=JSON.parse(f.get('manifest.json'));if(name==='wildcard+fixed')m.networkAccess.allowedDomains.push('https://a.invalid');if(name==='fixed')m.networkAccess.allowedDomains=['https://a.invalid'];if(name==='missing reasoning')delete m.networkAccess.reasoning;if(name==='vague reasoning')m.networkAccess.reasoning='network';if(name==='private API')m.enablePrivatePluginApi=true;if(name==='dev domains')m.networkAccess.devAllowedDomains=[];if(name==='non-numeric ID')m.id='heron-sync-stage0-local';f.set('manifest.json',Buffer.from(JSON.stringify(m)));}])
])test('custom rejects malicious freshly rehashed package: '+name,()=>assert.throws(()=>inspectPluginRelease(forge(change),options)));
test('invalid custom build rejected before any build output write',async()=>{
 for(const extra of [{production:false},{serviceOrigin:'https://a.invalid'},{legacyOrigins:[]},{pluginId:undefined,localDevelopmentId:'heron-sync-stage0-local'},{serviceMode:'auto'}])await assert.rejects(buildProject({production:true,pluginId,...options,...extra}));
});
test('standalone CLI explicitly propagates custom mode and official ID without service-origin',async t=>{
 const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'heron-custom-release-'));await fs.chmod(root,0o700);const input=path.join(root,'input');await fs.mkdir(input,{mode:0o700});for(const [name,bytes]of Object.entries(fixture()))await fs.writeFile(path.join(input,name),bytes,{mode:0o600});
 t.after(async()=>{assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^heron-custom-release-/);await fs.rm(root,{recursive:true});});
 const output=path.join(root,'plugin.zip'),result=spawnSync(process.execPath,['构建/打包交付插件.mjs','--directory',input,'--output',output,'--service-mode','custom-https','--release','C34','--date','2026-11-04'],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const info=inspectPluginRelease(await fs.readFile(output),options);assert.equal(info.manifest.id,pluginId);assert.equal(JSON.parse(result.stdout).serviceMode,'custom-https');assert.equal((await fs.stat(output)).mode&0o777,0o600);
});
