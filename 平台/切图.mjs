// Only current published rows in project routes. Historical routes never substitute a current revision.
import { demand, validId, openVerifiedAsset, sendOpenFile, disposition, planZip, streamZip, closeZipPlan, zipBudget, nativeBudget, receiptsFor, finishReceipt, responseSettled, checkQuery } from './下载.mjs';
import { selectedRevision, sliceDTO, revisionRelations, frameWithProject } from './资源.mjs';
const table=(ctx,key)=>ctx.vault.catalog[key] || [];
export function revisionSlices(ctx,req,frameId,revisionId){
  const {frame,revision}=selectedRevision(ctx,req,frameId,revisionId);
  return revisionRelations(ctx).filter(r=>r.frameId===frameId && r.revisionId===revisionId && r.role==='export').map(relation=>{const asset=table(ctx,'assets').find(a=>a.id===relation.assetId);demand(asset,409,'revision_asset_missing');return {...sliceDTO(ctx,asset,relation,frame,revision),asset};});
}
const publicRow=({asset,...row})=>row;
const FILTERS=['q','format','frameId','pageId','designFileId','fileId','file','page','frame','limit','offset'];
export function latestSlices(ctx,req,projectId,query=new URLSearchParams()){
  checkQuery(query,FILTERS);const user=ctx.auth.actor(req);ctx.permissions.requireRead(user,projectId);const result=[];
  for(const raw of table(ctx,'frames')){const frame=frameWithProject(ctx,raw);if(frame.projectId===projectId && frame.state==='published' && frame.currentRevisionId && !frame.deletedAt)for(const row of revisionSlices(ctx,req,frame.id,frame.currentRevisionId))result.push({...row,downloadUrl:`/api/projects/${encodeURIComponent(projectId)}/slices/${encodeURIComponent(row.id)}/download`});}
  let list=result;const get=(...keys)=>keys.map(k=>query.get(k)).find(v=>v!==null),q=get('q');demand(q===undefined || Buffer.byteLength(q,'utf8')<=512 && !/[\x00-\x1f\x7f]/.test(q),400,'invalid_slice_query');
  for(const [key,names] of [['designFileId',['designFileId','fileId','file']],['pageId',['pageId','page']],['frameId',['frameId','frame']]]){const values=names.map(k=>query.get(k)).filter(v=>v!==null);demand(values.length<=1,400,'invalid_query');if(values.length){demand(validId(values[0]),400,'invalid_slice_filter');list=list.filter(row=>row[key]===values[0]);}}
  const format=get('format');if(format!==undefined){const f=format.toUpperCase();demand(['PNG','JPG','JPEG','WEBP','SVG'].includes(f),400,'invalid_slice_format');list=list.filter(row=>(row.format==='JPEG'?'JPG':row.format)===(f==='JPEG'?'JPG':f));}
  if(q){const needle=q.toLocaleLowerCase();list=list.filter(row=>[row.name,row.originalFileName,row.fileName,row.frameName].some(v=>typeof v==='string' && v.toLocaleLowerCase().includes(needle)));}return list;
}
export function parseSliceIds(query,{required=false}={}){
  checkQuery(query,['ids']);const raw=query.get('ids');if(raw===null){demand(!required,400,'slice_ids_required');return null;}demand(raw.length>0,400,'empty_selection');demand(Buffer.byteLength(raw,'utf8')<=8192,400,'slice_ids_limit');const ids=[...new Set(raw.split(','))];demand(ids.every(validId),400,'invalid_slice_ids');demand(ids.length<=499,413,'zip_entry_limit');return ids;
}
function subset(list,ids){if(ids===null)return list;const map=new Map(list.map(row=>[row.id,row]));return ids.map(id=>{const row=map.get(id);demand(row,403,'slice_out_of_scope');return row;});}
export function installSlices(ctx){
  const receipts=receiptsFor(ctx.vault,ctx.clock || Date.now);
  async function transfer(req,res,row,{signal,reauthorize}){
    let opened,receipt,release=await nativeBudget.acquire({signal});try{
      opened=await openVerifiedAsset(ctx.vault,row.asset,{signal});reauthorize();const meta=opened.dimensions?{'X-Heron-Preview-Meta':'known','X-Heron-Preview-Width':opened.dimensions.width,'X-Heron-Preview-Height':opened.dimensions.height,'X-Heron-Preview-Pixels':opened.dimensions.width*opened.dimensions.height}:{'X-Heron-Preview-Meta':'unknown'};
      const filename=row.originalFileName || row.fileName;if(req.method==='HEAD'){await opened.file.close();opened=null;release();release=null;res.writeHead(200,{'Content-Type':row.asset.mime,'Content-Length':row.asset.bytes,...(!row.inline?{'Content-Disposition':disposition(filename)}:{}),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...meta});res.end();return;}
      receipt=receipts.start(ctx.auth.actor(req).id);await sendOpenFile(req,res,opened,{mime:row.asset.mime,filename:row.inline?undefined:filename,signal,headers:{'X-Heron-Image-Request':receipt,'X-Heron-Receipt-Id':receipt,...meta}});
    }finally{try{await opened?.file.close();}finally{try{await finishReceipt(res,receipts,receipt);}finally{release?.();}}}
  }
  async function zip(req,res,list,{signal,reauthorize,filename,historical=false}){
    demand(list.length>0,historical?409:400,historical?'no_exports':'empty_selection');let release=await nativeBudget.acquire({signal}),releaseZip,plan;
    try{releaseZip=await zipBudget.acquire({signal});plan=await planZip(ctx.vault,list,{signal,reauthorize,keepOpen:req.method!=='HEAD'});reauthorize();
      if(req.method==='HEAD'){await closeZipPlan(plan);releaseZip();releaseZip=null;release();release=null;res.writeHead(200,{'Content-Type':'application/zip','Content-Length':plan.bytes,'Content-Disposition':disposition(filename),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end();return;}
      await streamZip(req,res,ctx.vault,plan,{signal,filename,reauthorize});
    }finally{try{await closeZipPlan(plan);if(res.headersSent && !res.writableEnded && !res.destroyed)res.destroy();await responseSettled(res);}finally{releaseZip?.();release?.();}}
  }
  ctx.route('GET',/^\/api\/projects\/(?<projectId>[A-Za-z0-9_-]+)\/slices$/,(req,res,{params,url})=>{
    const list=latestSlices(ctx,req,params.projectId,url.searchParams),project=table(ctx,'projects').find(p=>p.id===params.projectId);demand(project,404,'project_not_found');const paged=url.searchParams.has('limit') || url.searchParams.has('offset'),rawLimit=url.searchParams.get('limit') || '200',rawOffset=url.searchParams.get('offset') || '0';demand(/^\d+$/.test(rawLimit) && /^\d+$/.test(rawOffset),400,'invalid_pagination');const limit=Number(rawLimit),offset=Number(rawOffset);demand(Number.isSafeInteger(limit) && limit>0 && limit<=200 && Number.isSafeInteger(offset),400,'invalid_pagination');return {project:{id:project.id,name:project.name},slices:(paged?list.slice(offset,offset+limit):list).map(publicRow),...(paged?{total:list.length,limit,offset}:{})};
  });
  for(const method of ['GET','HEAD']){
    ctx.route(method,/^\/api\/projects\/(?<projectId>[A-Za-z0-9_-]+)\/slices\/(?<sliceId>[A-Za-z0-9_-]+)\/(?<action>preview|download)$/,async(req,res,{params,url,signal})=>{checkQuery(url?.searchParams);const select=()=>{const row=latestSlices(ctx,req,params.projectId).find(r=>r.id===params.sliceId);demand(row,403,'slice_out_of_scope');return {...row,inline:params.action==='preview'};};return transfer(req,res,select(),{signal,reauthorize:select});});
    ctx.route(method,/^\/api\/slices\/(?<sliceId>[A-Za-z0-9_-]+)\/download$/,async(req,res,{params,url,signal})=>{checkQuery(url?.searchParams);const relation=revisionRelations(ctx).find(r=>r.id===params.sliceId && r.role==='export');demand(relation,404,'slice_not_found');const frame=table(ctx,'frames').find(f=>f.id===relation.frameId);const select=()=>{const current=table(ctx,'frames').find(f=>f.id===frame?.id);demand(current?.state==='published' && current.currentRevisionId===relation.revisionId,404,'slice_not_latest');const row=revisionSlices(ctx,req,current.id,relation.revisionId).find(r=>r.id===params.sliceId);demand(row,404,'slice_not_found');return row;};return transfer(req,res,select(),{signal,reauthorize:select});});
    ctx.route(method,/^\/api\/projects\/(?<projectId>[A-Za-z0-9_-]+)\/slices\.zip$/,async(req,res,{params,url,signal})=>{const ids=parseSliceIds(url.searchParams),select=()=>subset(latestSlices(ctx,req,params.projectId),ids);return zip(req,res,select(),{signal,reauthorize:select,filename:'project-slices.zip'});});
    ctx.route(method,/^\/api\/inspector\/frames\/(?<frameId>[A-Za-z0-9_-]+)\/revisions\/(?<revisionId>[A-Za-z0-9_-]+)\/slices\.zip$/,async(req,res,{params,url,signal})=>{checkQuery(url?.searchParams);const select=()=>revisionSlices(ctx,req,params.frameId,params.revisionId);return zip(req,res,select(),{signal,reauthorize:select,filename:'frame-revision-slices.zip',historical:true});});
    ctx.route(method,/^\/api\/inspector\/frames\/(?<frameId>[A-Za-z0-9_-]+)\/revisions\/(?<revisionId>[A-Za-z0-9_-]+)\/slices\/(?<sliceId>[A-Za-z0-9_-]+)\/download$/,async(req,res,{params,url,signal})=>{checkQuery(url?.searchParams);const select=()=>{const row=revisionSlices(ctx,req,params.frameId,params.revisionId).find(r=>r.id===params.sliceId);demand(row,404,'slice_not_found');return row;};return transfer(req,res,select(),{signal,reauthorize:select});});
  }
  ctx.route('GET',/^\/api\/inspector\/frames\/(?<frameId>[A-Za-z0-9_-]+)\/revisions\/(?<revisionId>[A-Za-z0-9_-]+)\/slices$/,(req,res,{params,url})=>{checkQuery(url?.searchParams);return {frameId:params.frameId,revisionId:params.revisionId,slices:revisionSlices(ctx,req,params.frameId,params.revisionId).map(publicRow)};});
  return {latestSlices:(req,p,q)=>latestSlices(ctx,req,p,q),revisionSlices:(req,f,r)=>revisionSlices(ctx,req,f,r)};
}
