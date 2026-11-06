import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPlatform } from '../平台/服务.mjs';

// Process termination exercises the entire publish catalog, not only a project row.
const root = new URL('../', import.meta.url).href;
const program = `
import {openVault} from ${JSON.stringify(new URL('平台/仓库.mjs',root).href)};
import {createPublishing,fingerprint} from ${JSON.stringify(new URL('平台/发布.mjs',root).href)};
import {createPermissions} from ${JSON.stringify(new URL('平台/权限.mjs',root).href)};
import {createHash} from 'node:crypto';
let armed=false; const hash=b=>createHash('sha256').update(b).digest('hex');
const vault=await openVault({dataDir:process.argv[1],limits:{fault(point){if(armed && point===process.argv[2])process.exit(73);}}});
await vault.transact(d=>{d.add('users',{id:'u',username:'fixture',role:'designer',status:'active',sessionVersion:0});d.add('projects',{id:'p',ownerId:'u',name:'Crash fixture',unknownFuture:{retained:[1,2,3]}});});
const req={headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}},auth={actor:()=>({id:'u',sessionVersion:0})};
const pub=createPublishing({vault,auth,permissions:createPermissions({vault})});
const source={kind:'figma-file',fileKey:'CrashFixture'};
const resolved=await pub.publishSource(req,'p',{source,frameIds:['1:1','1:2']});
const docs=['1:1','1:2'].map((id,i)=>Buffer.from(JSON.stringify({contractVersion:1,frame:{id,type:'FRAME',name:id,absoluteBoundingBox:{x:i,y:0,width:2,height:2},children:[]}})));
const frames=docs.map((bytes,i)=>{const f={figmaNodeId:'1:'+(i+1),figmaPageId:'0:1',name:'fixture '+i,x:i,y:0,width:2,height:2,layerDocSha256:hash(bytes),layerDocBytes:bytes.length,exports:[],baseRevisionId:null};return {...f,hash:fingerprint(f)};});
const prepared=await pub.prepare(req,{projectId:'p',designFile:{designFileId:resolved.designFileId},source,requireBaseRevision:true,frames});
for(const bytes of docs)await pub.upload(req,prepared.sessionId,hash(bytes),bytes);
await new Promise(resolve=>process.stdout.write(JSON.stringify({sid:prepared.sessionId}),resolve));
armed=true;await pub.commit(req,prepared.sessionId);throw Error('fault not reached');
`;
function crash(dir, point) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',program,dir,point],{env:{...process.env,NODE_OPTIONS:'',NODE_USE_ENV_PROXY:''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
}
for(const point of ['beforeRename','afterRename'])test('[REAL-CRASH/HTTP] publish '+point+' recovers exact SID and all frames',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'handoff-publish-crash-'))),data=path.join(dir,'data');let app;
  t.after(async()=>{await app?.close();assert.equal(await fs.realpath(dir),dir);assert.match(path.basename(dir),/^handoff-publish-crash-/);await fs.rm(dir,{recursive:true});});
  const result=await crash(data,point);assert.equal(result.code,73,result.stderr);const {sid}=JSON.parse(result.stdout);
  app=await createPlatform({dataDir:data,secret:randomBytes(48),logger:{error(){}}});
  const committed=point==='afterRename';
  assert.equal(app.vault.catalog.frameRevisions.length,committed?2:0);
  assert.equal(app.vault.catalog.frames.filter(f=>f.state==='published').length,committed?2:0);
  const first=app.vault.catalog.publishSessions.find(s=>s.id===sid);assert.equal(first.status,committed?'committed':'open');
  const address=await app.listen(0),origin='http://127.0.0.1:'+address.port,token=app.auth.issueAccess({id:'u'});
  const request=async(route,method='GET')=>{const response=await fetch(origin+route,{method,headers:{Authorization:'Bearer '+token,Origin:'null'}});return {status:response.status,value:await response.json()};};
  const recovered=await request('/api/publish/sessions/'+sid+'/commit','POST');assert.equal(recovered.status,200);assert.equal(recovered.value.frames.length,2);
  assert.equal(Boolean(recovered.value.idempotent),committed);
  const again=await request('/api/publish/sessions/'+sid+'/commit','POST');assert.deepEqual(again.value.frames,recovered.value.frames);assert.equal(again.value.idempotent,true);
  assert.equal(app.vault.catalog.frameRevisions.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(app.vault.catalog.projects[0].unknownFuture)),{retained:[1,2,3]});
  for(const f of recovered.value.frames){const snapshot=await request('/api/inspector/frames/'+f.frameId+'/revisions/'+f.revisionId);assert.equal(snapshot.status,200);assert.equal(snapshot.value.layerDoc.frame.id,f.figmaNodeId);}
  for(const asset of app.vault.catalog.assets)assert.equal((await app.vault.readOriginal(asset)).length,asset.bytes);
  t.diagnostic(JSON.stringify({point,exit:result.code,recoveredFrames:2,idempotent:true,originalsVerified:app.vault.catalog.assets.length,unknownFieldsRetained:true}));
});
