// Synthetic, isolated server. No deployed accounts, secrets, or user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPlatform} from '../平台/服务.mjs';
import {hashPassword} from '../平台/认证.mjs';
import {productionPluginConfig,productionPluginManifest} from '../构建/build.mjs';
import {packagePluginRelease,readStoredPluginZIP} from '../平台/插件发行.mjs';
import {storedZip} from '../宿主/stored-zip.mjs';
const site='https://download-owner.example.test',custom={serviceMode:'custom-https',release:'C34',date:'2026-11-04'};
function archive(options=custom){
 const config=productionPluginConfig(options),manifest=productionPluginManifest({...options,pluginId:'1699730787876999241'});
 const prefix=`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify(config)});\n`;
 return packagePluginRelease({'main.js':Buffer.from(prefix+'// synthetic fixture\n'),'ui.html':Buffer.from('<meta name="independent-production" content="enabled"><script>'+prefix+'// synthetic fixture\n</script>'),'manifest.json':Buffer.from(JSON.stringify(manifest))},options);
}
test('authenticated download explicitly handles self-hosted schema2, retains fixed enforcement, and rejects forged/mixed metadata',async t=>{
 const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'heron-selfhost-download-'));
 assert.equal(await fs.realpath(root),root);const plugin=path.join(root,'plugin.zip');
 const app=await createPlatform({dataDir:path.join(root,'vault'),secret:randomBytes(48),publicOrigin:site,artifacts:{pluginArchive:plugin},logger:{error(){}}});
 t.after(async()=>{await app.close();assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^heron-selfhost-download-/);await fs.rm(root,{recursive:true});});
 const credentials=await hashPassword('Synthetic-Selfhost-Download-2026');
 await app.vault.transact(d=>d.add('users',{id:'fixture_admin',username:'fixture-admin',role:'admin',status:'active',sessionVersion:0,...credentials}));
 const user=app.vault.catalog.users.find(u=>u.id==='fixture_admin'),token=app.auth.issueAccess(user),address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
 const get=(method='GET',authenticated=true)=>fetch(base+'/plugin.zip',{method,headers:authenticated?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(10000)});
 const initial=await fs.readFile(path.join(root,'vault/catalog.json'));
 const zip=archive();await fs.writeFile(plugin,zip,{mode:0o600});
 assert.equal((await get('GET',false)).status,401);
 const valid=await get();assert.equal(valid.status,200);assert.equal(valid.headers.get('x-heron-plugin-release'),'C34-2026-11-04');assert.deepEqual(Buffer.from(await valid.arrayBuffer()),zip);
 const head=await get('HEAD');assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),zip.length);assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const metadataChange of [m=>{m.serviceMode='fixed'},m=>{m.serviceOrigin='https://unselected.example.test'},m=>{m.schema=1;delete m.serviceMode},m=>{m.files['main.js']='0'.repeat(64)}]){
  const entries=readStoredPluginZIP(zip),metadata=JSON.parse(entries.get('发行信息.json'));metadataChange(metadata);entries.set('发行信息.json',Buffer.from(JSON.stringify(metadata)));await fs.writeFile(plugin,storedZip([...entries].map(([name,bytes])=>({name,bytes}))));
  const rejected=await get();assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'artifact_invalid');
 }
 await fs.writeFile(plugin,archive({serviceOrigin:site,release:'C33',date:'2026-11-04'}));assert.equal((await get()).status,200);
 await fs.writeFile(plugin,archive({serviceOrigin:'https://another-fixed.example.test',release:'C33',date:'2026-11-04'}));assert.equal((await get()).status,409);
 assert.deepEqual(await fs.readFile(path.join(root,'vault/catalog.json')),initial,'Read-only download must not change catalog');
});
