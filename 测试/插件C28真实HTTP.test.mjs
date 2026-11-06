import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webcrypto, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createPlatform } from '../平台/服务.mjs';
import { createProductionHTTP } from '../插件/production-protocol.mjs';
import { createProductionSession } from '../插件/production-session.mjs';
import { crc32 } from '../平台/下载.mjs';
function png(){const chunk=(k,d)=>{const b=Buffer.alloc(d.length+12);b.writeUInt32BE(d.length);b.write(k,4);d.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;};const h=Buffer.alloc(13);h.writeUInt32BE(16);h.writeUInt32BE(12,4);h[8]=8;h[9]=6;return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(65*12))),chunk('IEND',Buffer.alloc(0))]));}
test('C28 real HTTP: extreme coordinates in sections, atomic selected overwrite and retry after lost commit',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'heron-c28-http-')),password=randomBytes(24).toString('hex');let app;
 try{
  app=await createPlatform({dataDir:path.join(dir,'data'),secret:randomBytes(48),bootstrapAdmin:{username:'test-admin',password},logger:{error(){}}});const address=await app.listen(0),origin=`http://127.0.0.1:${address.port}`;
  let lose=false;const methods=[];const adapter=createProductionHTTP({origin,allowLocalhost:true,cryptoAPI:webcrypto,fetchAPI:async(url,options)=>{methods.push([options.method,new URL(url).pathname]);const r=await fetch(url,options);if(lose&&url.endsWith('/commit')){lose=false;await r.arrayBuffer();throw Error('synthetic lost response');}return r;}});
  await adapter.login({username:'test-admin',password});const project=await adapter.createProject('C28 isolated');
  const bytes=png(),frames=[-1,1].map((sign,i)=>({id:`2:${i+1}`,type:'FRAME',name:`board-${i}`,width:16,height:12,x:0,y:0,absoluteBoundingBox:{x:sign*126320,y:sign*67904,width:16,height:12},absoluteTransform:[[1,0,sign*126320],[0,1,sign*67904]],children:[],exportSettings:[],exportAsync:async()=>bytes}));
  const section={id:'3:1',type:'SECTION',children:frames};const page={id:'1:1',name:'Page',children:[section],selection:[section]};const sdk={fileKey:'C28TestFile',root:{name:'C28',children:[page]},currentPage:page};const states=[];
  const session=createProductionSession({sdk,adapter,namespace:`src_window_${'a'.repeat(32)}`,cryptoAPI:webcrypto,discardHistory:true,onState:s=>states.push(s)});
  const payload={projectId:project.id,scope:'selection',includeSlices:false,coordinateMode:'project-xy'};
  const first=await session.publish(payload);assert.equal(first.state.verified,true);const before=app.vault.catalog.frames.map(f=>({id:f.id,revision:f.currentRevisionId}));assert.equal(before.length,2);
  page.selection=[frames[0]];frames[0].name='updated';lose=true;await assert.rejects(session.publish(payload));assert.equal(session.status().locked,false);
  assert.equal(app.vault.catalog.frames.find(f=>f.id===before[1].id).currentRevisionId,before[1].revision);
  const after=await session.publish(payload);assert.equal(after.state.verified,true);assert.equal(app.vault.catalog.frames.length,2);assert.equal(app.vault.catalog.frames.find(f=>f.id===before[1].id).currentRevisionId,before[1].revision);
  assert.equal(methods.filter(([,p])=>p.endsWith('/commit')).length,3);assert.ok(states.some(s=>s.phase==='uploading'&&s.uploadTotal>0));assert.ok(states.some(s=>s.uploadedBytes>0));
 }finally{await app?.close();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('heron-c28-http-'));await fs.rm(dir,{recursive:true,force:true});}
});
