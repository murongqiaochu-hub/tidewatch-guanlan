// Contract/ZIP model only; real browser downloads and Figma import are separate evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionPluginManifest, inspectPluginRelease, readStoredPluginZIP, packagePluginRelease, MAX_PLUGIN_ARCHIVE_BYTES } from '../平台/插件发行.mjs';
import { storedZip, sha256 } from '../宿主/stored-zip.mjs';
import { syntheticPluginFiles, syntheticPluginRelease, SYNTHETIC_ORIGIN } from './插件发行测试工具.mjs';
const baseManifest=()=>JSON.parse(syntheticPluginFiles()['manifest.json']);
function forge(update){const files=readStoredPluginZIP(syntheticPluginRelease());update(files);const info=JSON.parse(files.get('发行信息.json'));for(const n of ['main.js','ui.html','manifest.json'])info.files[n]=sha256(files.get(n));files.set('发行信息.json',Buffer.from(JSON.stringify(info)));return storedZip([...files].map(([name,bytes])=>({name,bytes})));}
const mutations={
 'HTTP IP from actual error':m=>{m.networkAccess.allowedDomains=['http://192.168.1.50:4318'];},
 'mixed HTTPS and HTTP':m=>{m.networkAccess.allowedDomains.push('http://192.168.1.50:4318');},
 'HTTP alias':m=>{m.networkAccess.allowedDomains=['http://nas.example.test:4318'];},
 'HTTPS IP literal':m=>{m.networkAccess.allowedDomains=['https://192.168.1.50:4318'];},
 'wildcard':m=>{m.networkAccess.allowedDomains=['*'];},
 'none':m=>{m.networkAccess.allowedDomains=['none'];},
 'wrong HTTPS host':m=>{m.networkAccess.allowedDomains=['https://different.invalid'];},
 'empty domain list':m=>{m.networkAccess.allowedDomains=[];},
 'empty dev permissions still forbidden':m=>{m.networkAccess.devAllowedDomains=[];},
 'legacy dev HTTP forbidden':m=>{m.networkAccess.devAllowedDomains=['http://nas.example.test:4318'];},
 'private API':m=>{m.enablePrivatePluginApi=true;},
 'proposed API':m=>{m.enableProposedApi=true;},
 'numeric JSON id':m=>{m.id=123456;},
 'traversal main':m=>{m.main='../main.js';},
 'missing reasoning':m=>{delete m.networkAccess.reasoning;}
};
for(const [name,change]of Object.entries(mutations))test('PLUGIN RELEASE gate rejects '+name+' at contract, packaging and extracted ZIP',()=>{
 const m=baseManifest();change(m);assert.throws(()=>validateProductionPluginManifest(m,{serviceOrigin:SYNTHETIC_ORIGIN}));
 const files=syntheticPluginFiles();files['manifest.json']=Buffer.from(JSON.stringify(m));assert.throws(()=>packagePluginRelease(files,{release:'C10',date:'2026-10-20'}));
 const archive=forge(f=>f.set('manifest.json',Buffer.from(JSON.stringify(m))));assert.throws(()=>inspectPluginRelease(archive,{serviceOrigin:SYNTHETIC_ORIGIN}));
});
test('PLUGIN RELEASE exact HTTPS and explicit numeric identity are accepted; retained private API is builder-only opt-in',()=>{
 const m=baseManifest();assert.equal(validateProductionPluginManifest(m,{serviceOrigin:SYNTHETIC_ORIGIN}),SYNTHETIC_ORIGIN);m.id='123456789';assert.equal(validateProductionPluginManifest(m,{serviceOrigin:SYNTHETIC_ORIGIN}),SYNTHETIC_ORIGIN);m.enablePrivatePluginApi=true;assert.throws(()=>validateProductionPluginManifest(m,{serviceOrigin:SYNTHETIC_ORIGIN}));assert.equal(validateProductionPluginManifest(m,{serviceOrigin:SYNTHETIC_ORIGIN,allowRetainedPrivateAPI:true}),SYNTHETIC_ORIGIN);
});
test('PLUGIN RELEASE reproducible package contains instructions, release file bindings and unique public filename',()=>{
 const a=syntheticPluginRelease(),b=syntheticPluginRelease();assert.deepEqual(a,b);const info=inspectPluginRelease(a,{serviceOrigin:SYNTHETIC_ORIGIN});assert.equal(info.filename,'tidewatch.zip');assert.equal(info.sha256,sha256(a));assert.equal(info.files.size,5);assert.match(info.files.get('安装说明.txt').toString(),/新文件夹/);assert.match(info.files.get('安装说明.txt').toString(),/不要只替换单个文件/);
});
for(const [name,change]of [
 ['main origin',f=>f.set('main.js',Buffer.from(f.get('main.js').toString().replace(SYNTHETIC_ORIGIN,'http://192.168.1.50:4318')))],
 ['wrong origin list',f=>f.set('main.js',Buffer.from(f.get('main.js').toString().replace(/"serviceOrigins":\[[^\]]*\]/,'"serviceOrigins":["https://other.invalid"]')))],
 ['origin list type',f=>f.set('main.js',Buffer.from(f.get('main.js').toString().replace(/"serviceOrigins":\[[^\]]*\]/,'"serviceOrigins":{}')))],
 ['unexpected extra origin',f=>f.set('main.js',Buffer.from(f.get('main.js').toString().replace(/"serviceOrigins":\[[^\]]*\]/,'"serviceOrigins":["'+SYNTHETIC_ORIGIN+'","https://other.invalid"]')))],
 ['disabled UI',f=>f.set('ui.html',Buffer.from(f.get('ui.html').toString().replace('content="enabled"','content="disabled"')))],
 ['diagnostic payload',f=>f.set('main.js',Buffer.concat([f.get('main.js'),Buffer.from('HERON_QA_probe')]))]
])test('PLUGIN RELEASE rejects runtime mismatch even with matching fresh CRC and release hashes: '+name,()=>assert.throws(()=>inspectPluginRelease(forge(change),{serviceOrigin:SYNTHETIC_ORIGIN})));
test('PLUGIN RELEASE rejects mixed files instead of blessing a hand-edited manifest',()=>{
 const files=readStoredPluginZIP(syntheticPluginRelease());files.set('main.js',Buffer.concat([files.get('main.js'),Buffer.from('//changed')]));assert.throws(()=>inspectPluginRelease(storedZip([...files].map(([name,bytes])=>({name,bytes})))),/mixed_release_files/);
});
test('PLUGIN RELEASE old unversioned ZIP cannot be delivered even if its HTTPS manifest is valid',()=>{
 const files=syntheticPluginFiles(),old=storedZip(Object.entries(files).map(([name,bytes])=>({name,bytes})));assert.equal(readStoredPluginZIP(old).size,3);assert.throws(()=>inspectPluginRelease(old),/release_json_required/);
});
for(const name of ['empty','oversize','trailing','crc','local name','central type'])test('PLUGIN RELEASE strict bounded ZIP rejects '+name,()=>{
 let bytes=Buffer.from(syntheticPluginRelease());
 if(name==='empty')bytes=Buffer.alloc(22);
 if(name==='oversize')bytes=Buffer.alloc(MAX_PLUGIN_ARCHIVE_BYTES+1);
 if(name==='trailing')bytes=Buffer.concat([bytes,Buffer.from('x')]);
 if(name==='crc')bytes[38]^=1;
 if(name==='local name')bytes[30]=46;
 if(name==='central type'){const start=bytes.readUInt32LE(bytes.length-6);bytes.writeUInt16LE(8,start+10);}
 assert.throws(()=>inspectPluginRelease(bytes));
});
for(const [release,date]of [['C0','2026-10-20'],['C10\r\nBad','2026-10-20'],['C10\n','2026-10-20'],[['C10'],'2026-10-20'],['C10',['2026-10-20']],['C10','2026-02-30']])test('PLUGIN RELEASE rejects unsafe filename metadata '+JSON.stringify([release,date]),()=>assert.throws(()=>packagePluginRelease(syntheticPluginFiles(),{release,date})));
