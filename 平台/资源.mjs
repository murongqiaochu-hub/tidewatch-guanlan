// Explicit revision-linked authorization and inspector DTOs. No 'latest' substitution.
import { demand, problem, cancelled, validId, openVerifiedAsset, sendOpenFile, validateBytes, sha256, MAX_JSON, receiptsFor, nativeBudget, finishReceipt, checkQuery } from './下载.mjs';
import { validateLayerDocValue, filePublishingSource } from './发布.mjs';
import { installPreviews } from './预览.mjs';

const all=(vault,table)=>vault.catalog[table] || [];
const fileSource=filePublishingSource;
// Optional role is a new extension, not a prerequisite for descriptor-bearing imported links.
const relationCache=new WeakMap();
export function revisionRelations(ctx) {
  const root=ctx.vault.catalog, cached=relationCache.get(root); if(cached) return cached;
  const revisions=new Map(all(ctx.vault,'frameRevisions').map(r=>[r.id,r])), assets=new Map(all(ctx.vault,'assets').map(a=>[a.id,a])), hashes=new Map(all(ctx.vault,'assets').map(a=>[a.sha256,a])), present=new Set();
  const ordinals=new Map();
  const result=all(ctx.vault,'revisionAssets').map(row=>{
    const ordinal=ordinals.get(row.revisionId) || 0;ordinals.set(row.revisionId,ordinal+1);
    const revision=revisions.get(row.revisionId),asset=row.assetId?assets.get(row.assetId):hashes.get(row.sha256);
    const role=row.role || (row.exportNodeId || row.fileName ? 'export' : revision?.layerDocAssetId===asset?.id ? 'layerDoc' : revision?.previewAssetId===asset?.id ? 'preview' : 'asset');
    const value={...row,id:row.id || (role==='export' ? 'ras_legacy_'+sha256(row.revisionId+'\0'+ordinal).slice(0,32) : undefined),frameId:row.frameId || revision?.frameId,assetId:asset?.id || row.assetId,role};present.add(JSON.stringify([value.revisionId,value.assetId,role]));return value;
  });
  for(const revision of revisions.values()) for(const [role,key] of [['layerDoc','layerDocAssetId'],['preview','previewAssetId']]) {
    const assetId=revision[key]; if(assetId && !present.has(JSON.stringify([revision.id,assetId,role]))) result.push({id:role+'_'+revision.id,revisionId:revision.id,frameId:revision.frameId,assetId,role});
  }
  if(Object.isFrozen(root)) relationCache.set(root,result);return result;
}
export function frameWithProject(ctx,frame) {
  demand(frame,404,'frame_not_found');const file=all(ctx.vault,'designFiles').find(f=>f.id===frame.designFileId);demand(file,409,'frame_file_missing');
  demand(!frame.projectId || frame.projectId===file.projectId,409,'frame_project_mismatch');return frame.projectId ? frame : {...frame,projectId:file.projectId};
}
export function selectedRevision(ctx,req,frameId,revisionId) {
  const user=ctx.auth.actor(req), frame=frameWithProject(ctx,all(ctx.vault,'frames').find(f=>f.id===frameId)); ctx.permissions.requireRead(user,frame.projectId);
  const revision=all(ctx.vault,'frameRevisions').find(r=>r.id===revisionId && r.frameId===frameId);
   const sourceFile=revision?.coordinateMode==='project-xy'?all(ctx.vault,'designFiles').find(f=>f.id===revision.designFileId && f.projectId===frame.projectId):null;
   const sourcePage=sourceFile && all(ctx.vault,'pages').find(p=>p.id===revision.pageId && p.designFileId===sourceFile.id);
   demand(revision && (!revision.projectId || revision.projectId===frame.projectId) && (revision.coordinateMode==='project-xy'?Boolean(sourcePage):!revision.designFileId || revision.designFileId===frame.designFileId),404,'revision_not_found');
  return {user,frame,revision};
}
export function authorizeAsset(ctx,req,assetId,{frameId,revisionId}={}) {
  demand(validId(assetId),400,'invalid_asset_id'); const user=ctx.auth.actor(req), asset=all(ctx.vault,'assets').find(a=>a.id===assetId); demand(asset,404,'asset_not_found');
  if (frameId || revisionId) demand(frameId && revisionId,400,'asset_scope_required');
  let denied=false;
  for (const relation of revisionRelations(ctx)) {
    if(relation.assetId!==assetId || frameId && relation.frameId!==frameId || revisionId && relation.revisionId!==revisionId) continue;
    const revision=all(ctx.vault,'frameRevisions').find(r=>r.id===relation.revisionId && r.frameId===relation.frameId), rawFrame=all(ctx.vault,'frames').find(f=>f.id===relation.frameId);
    if(!revision || !rawFrame) continue;const frame=frameWithProject(ctx,rawFrame);if(revision.projectId && revision.projectId!==frame.projectId) continue;
    try { ctx.permissions.requireRead(user,frame.projectId); return {user,asset,relation,revision,frame}; } catch(e) { if(e.status===403 || e.httpStatus===403) denied=true; else if(e.status!==404 && e.httpStatus!==404) throw e; }
  }
  throw problem(denied ? 403 : 404,denied ? 'asset_forbidden' : 'asset_reference_not_found');
}
export function contextFor(ctx,req,projectId,designFileId) {
  const user=ctx.auth.actor(req); ctx.permissions.requireRead(user,projectId);
  const project=all(ctx.vault,'projects').find(p=>p.id===projectId); demand(project,404,'project_not_found');
  const file=all(ctx.vault,'designFiles').find(f=>f.id===designFileId && f.projectId===projectId); demand(file,404,'design_file_not_found');
  return {projectId,designFileId,projectName:project.name,designFileName:file.name,source:fileSource(file),permissions:ctx.permissions.project(user,projectId),projectCanvasUrl:`/viewer/p/${encodeURIComponent(projectId)}`,projectSlicesUrl:`/viewer/p/${encodeURIComponent(projectId)}/slices`,files:all(ctx.vault,'designFiles').filter(f=>f.projectId===projectId).map(f=>({designFileId:f.id,name:f.name,source:fileSource(f),pages:all(ctx.vault,'pages').filter(p=>p.designFileId===f.id).map(p=>({pageId:p.id,name:p.name,order:p.order}))}))};
}
export function assetDTO(asset,relation,frame,revision,{dimensions}={}) {
  const d=dimensions || (Number.isSafeInteger(asset.width) && Number.isSafeInteger(asset.height) ? {width:asset.width,height:asset.height} : {});
  return {assetId:asset.id,frameId:frame.id,revisionId:revision.id,projectId:frame.projectId,designFileId:revision.designFileId || frame.designFileId,role:relation.role,mime:asset.mime,byteLength:asset.bytes,sha256:asset.sha256,...d,url:`/api/assets/${encodeURIComponent(asset.id)}`, ...(relation.role==='export' ? {id:relation.id,sliceId:relation.id,exportNodeId:relation.exportNodeId,nodeId:relation.exportNodeId,fileName:relation.fileName,exportName:relation.exportName,format:relation.format,pluginExportSetting:relation.pluginExportSetting} : {})};
}
export function sliceDTO(ctx,asset,relation,frame,revision,options={}) {
  const dto=assetDTO(asset,relation,frame,revision,options),file=all(ctx.vault,'designFiles').find(f=>f.id===(revision.coordinateMode==='project-xy'?revision.designFileId:frame.designFileId)),pageId=revision.pageId || frame.pageId,page=all(ctx.vault,'pages').find(p=>p.id===pageId),constraint=relation.pluginExportSetting?.constraint;
  const scale=constraint?.type==='SCALE' && Number.isFinite(constraint.value) && constraint.value>0?constraint.value:null;
  return {...dto,assetUrl:dto.url,fileId:file?.id || frame.designFileId,fileName:file?.name ?? null,designFileId:file?.id || frame.designFileId,pageId,pageName:page?.name ?? null,frameName:revision.name ?? revision.manifest?.name ?? null,name:relation.exportName || relation.fileName,originalFileName:relation.fileName,format:relation.format || {'image/png':'PNG','image/jpeg':'JPG','image/webp':'WEBP','image/svg+xml':'SVG'}[asset.mime] || null,byteSize:asset.bytes,scale,pluginExportSetting:relation.pluginExportSetting ?? null,publishedAt:revision.createdAt,downloadUrl:`/api/inspector/frames/${encodeURIComponent(frame.id)}/revisions/${encodeURIComponent(revision.id)}/slices/${encodeURIComponent(relation.id)}/download`,rasterPreviewSupported:['image/png','image/jpeg','image/webp'].includes(asset.mime)};
}
// Read-only description for this exact historical asset; never borrow a current frame/session manifest.
function historicalDocument(bytes,revision,relations) {
  let doc;try {doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch {throw problem(409,'invalid_layer_doc');}
  if(revision.manifest) return {description:revision.manifest,layerDoc:validateLayerDocValue(doc,revision.manifest)};
  const root=doc?.frame,bounds=root?.absoluteBoundingBox;
  demand(bounds && ['x','y','width','height'].every(k=>typeof bounds[k]==='number' && Number.isFinite(bounds[k])),409,'revision_geometry_missing');
  const number=key=>{if(Object.hasOwn(revision,key)) {demand(typeof revision[key]==='number' && Number.isFinite(revision[key]),409,'invalid_revision_geometry');return revision[key];}return bounds[key];};
  const description={figmaNodeId:revision.figmaNodeId || root.id,name:typeof revision.name==='string'?revision.name:root.name,x:number('x'),y:number('y'),width:number('width'),height:number('height'),exports:relations.filter(r=>r.role==='export')};
  return {description,layerDoc:validateLayerDocValue(doc,description)};
}
export async function inspectorSnapshot(ctx,req,frameId,revisionId,{signal}={}) {
  const selected=selectedRevision(ctx,req,frameId,revisionId), {frame,revision}=selected;
  const relations=revisionRelations(ctx).filter(a=>a.frameId===frameId && a.revisionId===revisionId);
  const docRelation=relations.find(r=>r.role==='layerDoc' || r.role==='layer-doc'), docAsset=all(ctx.vault,'assets').find(a=>a.id===(docRelation?.assetId || revision.layerDocAssetId)); demand(docAsset && docRelation,409,'layer_doc_missing');
  const bytes=await ctx.vault.readOriginal(docAsset,{maxBytes:MAX_JSON,signal}); validateBytes(docAsset,bytes);
  const {description:manifest,layerDoc}=historicalDocument(bytes,revision,relations); selectedRevision(ctx,req,frameId,revisionId);
  const assets=[], slices=[];
  for(const relation of relations) {
    cancelled(signal); const asset=all(ctx.vault,'assets').find(a=>a.id===relation.assetId); demand(asset,409,'revision_asset_missing');
    let dimensions;
    if(['image/png','image/jpeg','image/webp'].includes(asset.mime)) { const opened=await openVerifiedAsset(ctx.vault,asset,{signal}); try { dimensions=opened.dimensions; selectedRevision(ctx,req,frameId,revisionId); } finally { await opened.file.close(); } }
    if(relation.role==='export') slices.push(sliceDTO(ctx,asset,relation,frame,revision,{dimensions})); else if(relation.role==='preview') assets.push(assetDTO(asset,relation,frame,revision,{dimensions}));
  }
  selectedRevision(ctx,req,frameId,revisionId);
  const bounds={x:manifest.x,y:manifest.y,width:manifest.width,height:manifest.height};
  return {identity:{projectId:frame.projectId,designFileId:revision.designFileId || frame.designFileId,pageId:revision.pageId || frame.pageId,frameId,revisionId,figmaNodeId:manifest.figmaNodeId},frameId,revisionId,pageIdentitySource:revision.pageId?'revision':'published-frame-page',zipScope:'selected-revision',zipUrl:`/api/inspector/frames/${encodeURIComponent(frameId)}/revisions/${encodeURIComponent(revisionId)}/slices.zip`,frame:{frameId,revisionId,name:manifest.name,figmaNodeId:manifest.figmaNodeId,groupId:frame.groupId??null,bounds,...bounds},design:{spec:['web','ios','android'].includes(manifest.designSpec)?manifest.designSpec:'web',scale:Number.isFinite(manifest.designScale)&&manifest.designScale>=1?manifest.designScale:1},revision:{id:revisionId,frameId,publishedAt:revision.publishedAt || revision.createdAt,hash:revision.hash},layerDoc,assets,slices,previewAsset:assets.find(a=>a.role==='preview') || null,source:fileSource(all(ctx.vault,'designFiles').find(f=>f.id===(revision.designFileId || frame.designFileId))),context:contextFor(ctx,req,frame.projectId,revision.designFileId || frame.designFileId)};
}
export function installAssets(ctx) {
  const receipts=receiptsFor(ctx.vault,ctx.clock || Date.now);
  // A caller-supplied receipt is not trusted to identify work. Server issues random receipts.
  const original=async(req,res,{params,url,signal})=>{
    checkQuery(url?.searchParams,['frameId','revisionId']);const scope={frameId:url?.searchParams.get('frameId') || undefined,revisionId:url?.searchParams.get('revisionId') || undefined};
    const selection=authorizeAsset(ctx,req,params.assetId,scope); let opened,receipt,release=await nativeBudget.acquire({signal});
    try {
      opened=await openVerifiedAsset(ctx.vault,selection.asset,{signal}); authorizeAsset(ctx,req,params.assetId,scope);
      const headers={ETag:'"'+selection.asset.sha256+'"',...(opened.dimensions ? {'X-Heron-Source-Width':opened.dimensions.width,'X-Heron-Source-Height':opened.dimensions.height} : {})};
      if(req.method==='HEAD') { await opened.file.close(); opened=null; release();release=null;res.writeHead(200,{'Content-Type':selection.asset.mime,'Content-Length':selection.asset.bytes,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers});res.end();return; }
      receipt=receipts.start(selection.user.id); headers['X-Heron-Receipt-Id']=receipt; headers['X-Heron-Image-Request']=receipt;
      await sendOpenFile(req,res,opened,{mime:selection.asset.mime,signal,headers});
    } finally { try { await opened?.file.close(); } finally { try{await finishReceipt(res,receipts,receipt);}finally{release?.();} } }
  };
  for(const method of ['GET','HEAD']) ctx.route(method,/^\/api\/assets\/(?<assetId>[A-Za-z0-9_-]+)$/,original);
  const receiptHandler=(req,res,{params})=>{const user=ctx.auth.actor(req),receipt=receipts.get(params.receiptId,user.id); if(req.method==='HEAD') {res.writeHead(receipt.pending?202:204,{'Cache-Control':'no-store'});res.end();return;} return receipt;};
  for(const method of ['GET','HEAD']) { ctx.route(method,/^\/api\/download-receipts\/(?<receiptId>[A-Za-z0-9_-]+)$/,receiptHandler,{receipt:true,budget:false}); ctx.route(method,/^\/api\/image-terminal\/(?<receiptId>[A-Za-z0-9_-]+)$/,receiptHandler,{receipt:true,budget:false}); }
  ctx.route('GET',/^\/api\/inspector\/frames\/(?<frameId>[A-Za-z0-9_-]+)\/revisions\/(?<revisionId>[A-Za-z0-9_-]+)$/, async(req,res,{params,url,signal})=>{checkQuery(url?.searchParams);const catalogReadVersion=ctx.vault.readVersion;const snapshot=await inspectorSnapshot(ctx,req,params.frameId,params.revisionId,{signal});demand(catalogReadVersion===ctx.vault.readVersion,409,'catalog_changed_during_read');return {...snapshot,catalogReadVersion};});
  ctx.route('GET',/^\/api\/inspector\/projects\/(?<projectId>[A-Za-z0-9_-]+)\/directory$/, (req,res,{params,url})=>{
    checkQuery(url?.searchParams,['designFileId']);const user=ctx.auth.actor(req);ctx.permissions.requireRead(user,params.projectId);const fileId=url.searchParams.get('designFileId');if(fileId!==null)demand(validId(fileId),400,'invalid_file_id');
    const frames=all(ctx.vault,'frames').map(f=>frameWithProject(ctx,f)).filter(f=>f.state==='published' && f.projectId===params.projectId && f.currentRevisionId && !f.deletedAt).map(f=>{
      const revision=all(ctx.vault,'frameRevisions').find(r=>r.id===f.currentRevisionId && r.frameId===f.id); demand(revision,409,'revision_missing'); const sourceFileId=revision.coordinateMode==='project-xy'?revision.designFileId:f.designFileId,sourcePageId=revision.coordinateMode==='project-xy'?revision.pageId:f.pageId; if(fileId && sourceFileId!==fileId)return null; if(revision.coordinateMode==='project-xy')demand(all(ctx.vault,'designFiles').some(file=>file.id===sourceFileId && file.projectId===f.projectId) && all(ctx.vault,'pages').some(page=>page.id===sourcePageId && page.designFileId===sourceFileId),409,'revision_source_missing');
      const relation=revisionRelations(ctx).find(r=>r.frameId===f.id && r.revisionId===revision.id && r.role==='preview'), asset=relation && all(ctx.vault,'assets').find(a=>a.id===relation.assetId);
      const metadata=revision.manifest || revision,bounds={x:metadata.x ?? null,y:metadata.y ?? null,width:metadata.width ?? null,height:metadata.height ?? null};
      return {frameId:f.id,projectId:f.projectId,groupId:f.groupId??null,designFileId:sourceFileId,pageId:sourcePageId,revisionId:revision.id,currentRevisionId:revision.id,latestRevisionId:revision.id,figmaNodeId:revision.coordinateMode==='project-xy'?revision.figmaNodeId:f.figmaNodeId,name:metadata.name ?? null,...bounds,order:metadata.order ?? null,bounds,previewAsset:asset?{...assetDTO(asset,relation,f,revision),metadataPrecision:'directory-geometry-only'}:null};
    }).filter(Boolean);
    const groups=all(ctx.vault,'frameGroups').filter(group=>group.projectId===params.projectId).map(group=>({id:group.id,projectId:group.projectId,name:group.name,frameCount:frames.filter(frame=>frame.groupId===group.id).length}));return {catalogReadVersion:ctx.vault.readVersion,projectId:params.projectId,permissions:ctx.permissions.project(user,params.projectId),groups,frames,...(fileId?{context:contextFor(ctx,req,params.projectId,fileId)}:{})};
  });
  const previews=installPreviews(ctx,{authorizeAsset:(req,id)=>authorizeAsset(ctx,req,id)});
  return {authorizeAsset:(req,id,scope)=>authorizeAsset(ctx,req,id,scope),previews,receipts,close:()=>previews.close()};
}
