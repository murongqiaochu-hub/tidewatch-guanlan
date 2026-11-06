import test from 'node:test';
import assert from 'node:assert/strict';
import {installProjectData} from '../平台/项目数据.mjs';
import {installAssets, selectedRevision, sliceDTO} from '../平台/资源.mjs';
import {installWebPages} from '../平台/网页.mjs';

function fixture(){
 const routes=[];const route=(method,pattern,handler)=>routes.push({method,pattern,handler});
 const catalog={projects:[{id:'p',name:'Project'},{id:'q',name:'Other'}],designFiles:[{id:'fa',projectId:'p',name:'File A'},{id:'fb',projectId:'p',name:'File B'},{id:'fq',projectId:'q',name:'Other'}],pages:[{id:'pa',designFileId:'fa',name:'Page A'},{id:'pb',designFileId:'fb',name:'Page B'}],frames:[{id:'f',designFileId:'fa',pageId:'pa',figmaNodeId:'nodeA',state:'published',currentRevisionId:'rb'}],frameRevisions:[{id:'ra',frameId:'f',designFileId:'fa',pageId:'pa',figmaNodeId:'nodeA',coordinateMode:'project-xy',name:'Before',createdAt:'2026-01-01'},{id:'rb',frameId:'f',designFileId:'fb',pageId:'pb',figmaNodeId:'nodeB',coordinateMode:'project-xy',name:'After',createdAt:'2026-01-02'}],assets:[],revisionAssets:[]};
 const ctx={route,vault:{catalog},auth:{actor:()=>({id:'u'})},permissions:{requireRead(_,id){if(id!=='p')throw Error('denied')},project:()=>({})},error:(status,code)=>Object.assign(new Error(code),{status,code})};
 installProjectData(ctx);installAssets(ctx);installWebPages(ctx);
 const call=(method,path,options={})=>{const url=new URL(path,'http://localhost'),match=routes.find(r=>r.method===method&&r.pattern.test(url.pathname));assert.ok(match,`missing ${method} ${path}`);return match.handler({url:path,headers:{},...options.req},options.res??{writeHead(){},end(){}},{params:url.pathname.match(match.pattern).groups,url})};
 return {catalog,ctx,call};
}
test('当前目录、树、canvas 均归最新来源文件/页面，文件过滤不会漏画板',()=>{
 const h=fixture();assert.deepEqual(h.call('GET','/api/design-files/fa/pages').pages.map(p=>p.frameCount),[0]);assert.deepEqual(h.call('GET','/api/design-files/fb/pages').pages.map(p=>p.frameCount),[1]);assert.deepEqual(h.call('GET','/api/pages/pa/frames').frames,[]);
 const page=h.call('GET','/api/pages/pb/frames').frames;assert.equal(page[0].designFileId,'fb');assert.equal(page[0].pageId,'pb');assert.equal(page[0].figmaNodeId,'nodeB');
 assert.deepEqual(h.call('GET','/api/inspector/projects/p/directory?designFileId=fa').frames,[]);
 const [current]=h.call('GET','/api/inspector/projects/p/directory?designFileId=fb').frames;assert.equal(current.frameId,'f');assert.equal(current.figmaNodeId,'nodeB');assert.equal(current.pageId,'pb');
 const canvas=h.call('GET','/api/projects/p/canvas');assert.equal(canvas.files.find(f=>f.id==='fa').pages[0].frames.length,0);assert.equal(canvas.files.find(f=>f.id==='fb').pages[0].frames[0].id,'f');assert.equal(h.call('GET','/api/projects/p').designFiles.find(f=>f.id==='fb').frameCount,1);
});
test('boot 当前/历史选中来源准确，历史切图与原文件关联，伪造跨项目来源拒绝',()=>{
 const h=fixture();for(const [revisionId,file,node] of [['rb','fb','nodeB'],['ra','fa','nodeA']]){let body='';h.call('GET',`/viewer/r/f?revision=${revisionId}`,{res:{writeHead(status){assert.equal(status,200)},end(data){body=data}}});const boot=JSON.parse(body.match(/<script id="inspector-context"[^>]*>(.*?)<\/script>/)[1]);assert.equal(boot.designFileId,file);assert.equal(boot.figmaNodeId,node);assert.equal(selectedRevision(h.ctx,{},'f',revisionId).revision.id,revisionId)}
 const slice=sliceDTO(h.ctx,{id:'a',mime:'image/png',bytes:1,sha256:'hash'}, {id:'slice',role:'export',exportNodeId:'nodeA'},h.catalog.frames[0],h.catalog.frameRevisions[0]);assert.equal(slice.designFileId,'fa');assert.equal(slice.pageId,'pa');
 h.catalog.frameRevisions[1].designFileId='fq';assert.throws(()=>selectedRevision(h.ctx,{},'f','rb'),e=>e.code==='revision_not_found');assert.throws(()=>h.call('GET','/viewer/r/f'),e=>e.code==='not_found');
});
test('v1 旧 revision 无坐标模式仍按 frame 归属',()=>{const h=fixture();delete h.catalog.frameRevisions[1].coordinateMode;h.catalog.frameRevisions[1].designFileId='fa';assert.equal(h.call('GET','/api/frames/f').designFileId,'fa');assert.equal(h.call('GET','/api/inspector/projects/p/directory?designFileId=fa').frames[0].pageId,'pa')});
