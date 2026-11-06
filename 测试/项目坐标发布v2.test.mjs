import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishing, fingerprint } from '../平台/发布.mjs';
import { inspectorSnapshot, selectedRevision } from '../平台/资源.mjs';
import { sha256, problem } from '../平台/下载.mjs';

const names=['users','projects','projectMembers','projectInvites','inviteClaims','designFiles','pages','sections','frames','frameRevisions','assets','revisionAssets','publishSessions','auditLogs','rememberedLogins'];
function fixture(){
  let catalog=Object.fromEntries(names.map(n=>[n,[]])),tail=Promise.resolve();catalog.projects.push({id:'p',name:'P'},{id:'other',name:'Other'});
  const bytes=new Map(),staged=new Map();const vault={get catalog(){return catalog},transact(fn){const run=tail.then(async()=>{const copy=Object.fromEntries(names.map(n=>[n,catalog[n].map(r=>structuredClone(r))]));const d={all:n=>copy[n],byId:(n,id)=>copy[n].find(r=>r.id===id),add:(n,r)=>copy[n].push(r),patch:(n,id,fields)=>Object.assign(copy[n].find(r=>r.id===id),fields)};const result=await fn(d);catalog=copy;return result});tail=run.catch(()=>{});return run},async stageAsset(s,d,b){staged.set(s+'/'+d.sha256,Buffer.from(b))},async readStaged(s,h){const b=staged.get(s+'/'+h);if(!b)throw problem(409,'missing');return b},async putOriginal(d){bytes.set(d.sha256,d.data);return {id:'a_'+d.sha256,sha256:d.sha256,mime:d.mime,bytes:d.bytes,relativePath:d.sha256+'.json'}},async readOriginal(a){return bytes.get(a.sha256)}};
  const req={headers:{'content-type':'application/octet-stream','x-asset-mime':'application/json'}},ctx={vault,clock:()=>1800000000000,auth:{actor:()=>({id:'u'})},permissions:{requireRead(u,p){if(p!=='p')throw problem(403,'forbidden')},requirePublish(u,p){if(p!=='p')throw problem(403,'forbidden')},project:()=>({})}};
  return {...ctx,req,service:createPublishing(ctx)};
}
function manifest(node,x,y,base=null){const doc={contractVersion:1,frame:{id:node,type:'FRAME',name:'Artboard',absoluteBoundingBox:{x,y,width:10,height:10},children:[]}},raw=Buffer.from(JSON.stringify(doc));const f={figmaNodeId:node,figmaPageId:'0:1',name:'Artboard',x,y,width:10,height:10,hash:'a'.repeat(64),layerDocSha256:sha256(raw),layerDocBytes:raw.length,exports:[],baseRevisionId:base};f.hash=fingerprint(f);return {f,raw};}
async function start(h,source,node,x,y,{v2=true}={}){const response=await h.service.publishSource(h.req,'p',{source,frameIds:[node],...(v2?{coordinates:[{frameId:node,x,y}]}:{})});return response;}
async function commit(h,file,m,{v2=true}={}){const body={projectId:'p',designFile:{designFileId:file.designFileId},source:file.source,requireBaseRevision:true,frames:[m.f],...(v2?{coordinateMode:'project-xy'}:{})};const p=await h.service.prepare(h.req,body);await h.service.upload(h.req,p.sessionId,m.f.layerDocSha256,m.raw);const result=await h.service.commit(h.req,p.sessionId);return {p,result};}
const first={kind:'figma-file',fileKey:'FigmaOne'},second={kind:'figma-file',fileKey:'FigmaTwo'};
test('v2 同项目坐标覆盖跨文件：保留旧 frame 身份、各版原始根节点和 +1 同内容版本',async()=>{
 const h=fixture(),a=await start(h,first,'1:1',12,34),m=manifest('1:1',12,34),one=await commit(h,a,m),old=one.result.frames[0];
 const b=await start(h,second,'2:2',12,34);assert.equal(b.coordinateMode,'project-xy');assert.equal(b.baseRevisions['2:2'],old.revisionId);
 const changed=await commit(h,b,manifest('2:2',12,34,b.baseRevisions['2:2']));const next=changed.result.frames[0];assert.equal(next.frameId,old.frameId);assert.notEqual(next.revisionId,old.revisionId);
 const frame=h.vault.catalog.frames.find(f=>f.id===old.frameId);assert.equal(frame.designFileId,a.designFileId);assert.equal(frame.figmaNodeId,'1:1');
 assert.equal(h.vault.catalog.frameRevisions.find(r=>r.id===next.revisionId).figmaNodeId,'2:2');
 for(const [revisionId,node] of [[old.revisionId,'1:1'],[next.revisionId,'2:2']]){const snapshot=await inspectorSnapshot(h,h.req,old.frameId,revisionId);assert.equal(snapshot.layerDoc.frame.id,node);assert.equal(snapshot.identity.figmaNodeId,node)}
 const again=await start(h,second,'2:2',12,34),identical=await commit(h,again,manifest('2:2',12,34,again.baseRevisions['2:2']));assert.notEqual(identical.result.frames[0].revisionId,next.revisionId);assert.equal(h.vault.catalog.frameRevisions.length,3);
});
test('v2 坐标严格不同即新 frame，v1 按原文件节点保持旧行为',async()=>{const h=fixture(),a=await start(h,first,'1:1',1,2),one=await commit(h,a,manifest('1:1',1,2));const moved=await start(h,first,'1:1',1,2.00001);assert.equal(moved.baseRevisions['1:1'],null);const two=await commit(h,moved,manifest('1:1',1,2.00001));assert.notEqual(one.result.frames[0].frameId,two.result.frames[0].frameId);assert.equal(h.vault.catalog.frames.length,2);const v1=await start(h,first,'1:1',1,2,{v2:false});assert.equal(v1.baseRevisions['1:1'],one.result.frames[0].revisionId)});
test('v2 重复坐标准备前拒绝且零写入；原图层坐标伪造无法上传；同坐标 CAS 竞态仅一个提交',async()=>{const h=fixture(),file=await start(h,first,'1:1',3,4),a=manifest('1:1',3,4),duplicate=manifest('1:2',3,4);await assert.rejects(h.service.prepare(h.req,{projectId:'p',designFile:{designFileId:file.designFileId},source:first,requireBaseRevision:true,coordinateMode:'project-xy',frames:[a.f,duplicate.f]}),e=>e.code==='duplicate_coordinates');assert.equal(h.vault.catalog.publishSessions.length,0);assert.equal(h.vault.catalog.frames.length,0);
 const bad=manifest('1:1',3,5);bad.f.y=4;const prep=await h.service.prepare(h.req,{projectId:'p',designFile:{designFileId:file.designFileId},source:first,requireBaseRevision:true,coordinateMode:'project-xy',frames:[bad.f]});await assert.rejects(h.service.upload(h.req,prep.sessionId,bad.f.layerDocSha256,bad.raw),e=>e.code==='layer_doc_coordinates');assert.equal(h.vault.catalog.frameRevisions.length,0);assert.equal((await h.service.abort(h.req,prep.sessionId)).status,'aborted');
 const next=await start(h,second,'2:2',3,4),b=manifest('2:2',3,4),one=await commit(h,file,a);const prepared=await h.service.prepare(h.req,{projectId:'p',designFile:{designFileId:next.designFileId},source:second,requireBaseRevision:true,coordinateMode:'project-xy',frames:[b.f]});await h.service.upload(h.req,prepared.sessionId,b.f.layerDocSha256,b.raw);await assert.rejects(h.service.commit(h.req,prepared.sessionId),e=>e.code==='revision_conflict');assert.equal(h.vault.catalog.frameRevisions.length,1);assert.ok(one.result.frames[0].revisionId);
});
test('C10 旧目录 frame 无 x/y：从当前修订权威坐标匹配，跨来源覆盖而非重复新建',async()=>{
 const h=fixture(),a=await start(h,first,'1:1',405,406),old=await commit(h,a,manifest('1:1',405,406)),frameId=old.result.frames[0].frameId;
 await h.vault.transact(d=>d.patch('frames',frameId,{x:undefined,y:undefined}));
 const b=await start(h,second,'2:2',405,406);assert.equal(b.baseRevisions['2:2'],old.result.frames[0].revisionId);
 const next=manifest('2:2',405,406,b.baseRevisions['2:2']),p=await h.service.prepare(h.req,{projectId:'p',designFile:{designFileId:b.designFileId},source:b.source,coordinateMode:'project-xy',requireBaseRevision:true,frames:[next.f]});
 assert.equal(p.frames[0].frameId,frameId);assert.equal(h.vault.catalog.frames.length,1);
 await h.service.upload(h.req,p.sessionId,next.f.layerDocSha256,next.raw);const newer=await h.service.commit(h.req,p.sessionId);assert.equal(newer.frames[0].frameId,frameId);assert.equal(h.vault.catalog.frames.length,1);
});
test('当前修订与 frame 双重坐标不一致时 fail closed，不覆盖任何旧记录',async()=>{
 const h=fixture(),a=await start(h,first,'1:1',1,2),old=await commit(h,a,manifest('1:1',1,2));
 await h.vault.transact(d=>d.patch('frames',old.result.frames[0].frameId,{x:999}));
 await assert.rejects(start(h,second,'2:2',1,2),e=>e.code==='coordinate_geometry_conflict');assert.equal(h.vault.catalog.frameRevisions.length,1);
});
test('历史资产权限隔离：跨项目不能借坐标或 revision ID 查看',async()=>{const h=fixture(),a=await start(h,first,'1:1',1,1),published=await commit(h,a,manifest('1:1',1,1));await assert.rejects(h.service.publishSource(h.req,'other',{source:second,frameIds:['2:2'],coordinates:[{frameId:'2:2',x:1,y:1}]}),e=>e.code==='forbidden');assert.throws(()=>selectedRevision(h,h.req,'nonexistent',published.result.frames[0].revisionId));});
