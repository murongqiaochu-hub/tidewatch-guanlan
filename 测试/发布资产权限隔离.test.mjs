import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createPlatform } from '../平台/服务.mjs';
import { openVault } from '../平台/仓库.mjs';
import { makeProceduralPng } from '../宿主/synthetic-fixtures.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, hooks = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'handoff-asset-isolation-')));
  const backing = await openVault({dataDir:path.join(dir,'data')});
  const vault = {...backing, get catalog(){return backing.catalog;}, async readOriginal(...args){const bytes=await backing.readOriginal(...args);await hooks.afterRead?.();return bytes;}};
  const app = await createPlatform({dataDir: path.join(dir, 'data'), vault, secret: randomBytes(48), logger: {error(){}}});
  t.after(async () => { await app.close(); assert.equal(await realpath(dir), dir); assert.match(path.basename(dir), /^handoff-asset-isolation-/); await rm(dir, {recursive:true}); });
  await app.vault.transact(d => {
    for (const id of ['alice','bob']) {
      d.add('users', {id,username:id,role:'designer',status:'active',sessionVersion:0});
      d.add('projects', {id:'p_'+id,name:id,ownerId:id});
    }
  });
  const address = await app.listen(0), origin = 'http://127.0.0.1:' + address.port;
  const tokens = Object.fromEntries(app.vault.catalog.users.map(u => [u.id, app.auth.issueAccess(u)]));
  async function request(user, route, body, {method = body === undefined ? 'GET' : 'POST', raw = false} = {}) {
    const response = await fetch(origin + route, {method, headers:{Authorization:'Bearer '+tokens[user], Origin:'null', ...(body === undefined ? {} : {'Content-Type':raw?'application/octet-stream':'application/json'}), ...(raw?{'X-Asset-Mime':raw}:{})}, ...(body === undefined ? {} : {body:raw?body:JSON.stringify(body)})});
    const bytes = Buffer.from(await response.arrayBuffer());
    let value; try { value = JSON.parse(bytes); } catch {}
    return {status:response.status,value,bytes};
  }
  const png = await makeProceduralPng(2,2);
  const descriptor = {sha256:hash(png),bytes:png.length,mime:'image/png',exportNodeId:'1:1',fileName:'private.png',format:'PNG'};
  async function prepare(user, {base = null, exportDescriptor = descriptor} = {}) {
    const source = {kind:'figma-file',fileKey:'Fixture'+user};
    const resolved = await request(user, '/api/projects/p_'+user+'/publish-source', {source,frameIds:['1:1']});
    assert.equal(resolved.status,200);
    const doc = Buffer.from(JSON.stringify({contractVersion:1,frame:{id:'1:1',type:'FRAME',name:user,absoluteBoundingBox:{x:0,y:0,width:2,height:2},children:[]}}));
    const frame = {figmaNodeId:'1:1',figmaPageId:'0:1',name:user,x:0,y:0,width:2,height:2,hash:hash(doc),layerDocSha256:hash(doc),layerDocBytes:doc.length,exports:[exportDescriptor],baseRevisionId:base};
    const prepared = await request(user,'/api/publish/sessions',{projectId:'p_'+user,designFile:{designFileId:resolved.value.designFileId},source,requireBaseRevision:true,frames:[frame]});
    assert.equal(prepared.status,200);
    return {sid:prepared.value.sessionId,prepared:prepared.value,doc,frame};
  }
  const upload = (user,p,bytes,mime) => request(user,`/api/publish/sessions/${p.sid}/assets/${hash(bytes)}`,bytes,{method:'PUT',raw:mime});
  const commit = (user,p) => request(user,`/api/publish/sessions/${p.sid}/commit`,{});
  const first = await prepare('alice');
  assert.equal((await upload('alice',first,first.doc,'application/json')).status,200);
  assert.equal((await upload('alice',first,png,'image/png')).status,200);
  assert.equal((await commit('alice',first)).status,200);
  const asset = app.vault.catalog.assets.find(a=>a.sha256===descriptor.sha256);
  return {app,request,png,descriptor,prepare,upload,commit,asset};
}

test('[REAL-HTTP] foreign SHA is not proof of possession or permission to reuse an original', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('bob','/api/assets/'+h.asset.id)).status,403);
  const p = await h.prepare('bob');
  assert.equal((await h.upload('bob',p,p.doc,'application/json')).status,200);
  const failed = await h.commit('bob',p);
  const after = await h.request('bob','/api/assets/'+h.asset.id);
  t.diagnostic(JSON.stringify({foreignHashRequiresUpload:p.prepared.missingAssetSha256.includes(h.descriptor.sha256),commitWithoutForeignBytes:failed.status,foreignAssetReadAfter:after.status}));
  assert.equal(failed.status,409);
  assert.ok(p.prepared.missingAssetSha256.includes(h.descriptor.sha256),'foreign-only original must still require upload');
  assert.equal(failed.value.error.code,'assets_missing');
  assert.equal(h.app.vault.catalog.frameRevisions.length,1);
  assert.equal((await h.request('bob','/api/assets/'+h.asset.id)).status,403);
  assert.equal((await h.upload('bob',p,h.png,'image/png')).status,200);
  assert.equal((await h.commit('bob',p)).status,200,'same content remains physically deduplicated after proof');
  assert.deepEqual((await h.request('bob','/api/assets/'+h.asset.id)).bytes,h.png);
  assert.equal(h.app.vault.catalog.assets.filter(a=>a.sha256===h.descriptor.sha256).length,1);
});

test('[REAL-HTTP] authorized reuse stays upload-free, but revocation before commit rechecks live references', async t => {
  const h = await fixture(t);
  await h.app.vault.transact(d=>d.add('projectMembers',{projectId:'p_alice',userId:'bob'}));
  const p = await h.prepare('bob');
  assert.ok(!p.prepared.missingAssetSha256.includes(h.descriptor.sha256));
  assert.equal((await h.upload('bob',p,p.doc,'application/json')).status,200);
  await h.app.vault.transact(d=> { for (const member of d.all('projectMembers')) d.remove('projectMembers',member.id); });
  assert.equal((await h.commit('bob',p)).status,409,'prepare-time visibility must not survive revocation');
  await h.app.vault.transact(d=>d.add('projectMembers',{projectId:'p_alice',userId:'bob'}));
  assert.equal((await h.commit('bob',p)).status,200);
});

test('[REAL-HTTP] revocation during original read is checked again at the catalog commit point', async t => {
  const hooks = {}, h = await fixture(t,hooks);
  await h.app.vault.transact(d=>d.add('projectMembers',{projectId:'p_alice',userId:'bob'}));
  const p = await h.prepare('bob');
  assert.equal((await h.upload('bob',p,p.doc,'application/json')).status,200);
  hooks.afterRead = async () => {
    hooks.afterRead = null;
    await h.app.vault.transact(d=> {for(const member of d.all('projectMembers'))d.remove('projectMembers',member.id);});
  };
  assert.equal((await h.commit('bob',p)).status,409);
  assert.equal(h.app.vault.catalog.frameRevisions.length,1);
  assert.equal((await h.request('bob','/api/assets/'+h.asset.id)).status,403);
});

test('[REAL-HTTP] foreign descriptor mismatch does not expose global asset existence at prepare', async t => {
  const h = await fixture(t);
  const p = await h.prepare('bob',{exportDescriptor:{...h.descriptor,bytes:h.descriptor.bytes+1}});
  assert.ok(p.prepared.missingAssetSha256.includes(h.descriptor.sha256));
});

test('[REAL-HTTP] legacy frames/descriptors session without uploaded marker proves staged bytes', async t => {
  const h = await fixture(t), p = await h.prepare('bob');
  assert.equal((await h.upload('bob',p,p.doc,'application/json')).status,200);
  assert.equal((await h.upload('bob',p,h.png,'image/png')).status,200);
  await h.app.vault.transact(d=>d.set('publishSessions',d.all('publishSessions').map(s=>{
    if(s.id!==p.sid)return s;
    const {items,uploaded,...legacy}=s;
    return {...legacy,frames:items.map(item=>{const {expectedRevisionId,...prior}=item;return prior;}),descriptors:[{sha256:p.frame.layerDocSha256,bytes:p.doc.length,mime:'application/json'},{sha256:h.descriptor.sha256,bytes:h.png.length,mime:'image/png'}]};
  })));
  assert.equal((await h.commit('bob',p)).status,200);
  assert.deepEqual((await h.request('bob','/api/assets/'+h.asset.id)).bytes,h.png);
});
