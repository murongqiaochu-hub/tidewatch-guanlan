// Independently authored against sanitized contract 02 and the new Vault API; original bytes stay immutable.
import { newId, sha256, isObject, validHash, validId, demand, problem, cancelled, validateBytes, readRaw, MAX_RAW, MAX_JSON, MiB } from './下载.mjs';
import { pendingPublishOperation, pendingPublishSession } from './仓库.mjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
function secretBytes(value){demand(typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value),403,'writer_secret_invalid');const bytes=Buffer.from(value,'base64url');demand(bytes.length===32 && bytes.toString('base64url')===value,403,'writer_secret_invalid');return bytes;}
function secretDigest(id,value){return createHash('sha256').update('heron-publish-writer-v1\0').update(id).update('\0').update(secretBytes(value)).digest('hex');}
function verifyWriter(op,value){const actual=Buffer.from(secretDigest(op.id,value),'hex');demand(typeof op.writerDigest==='string' && /^[a-f0-9]{64}$/.test(op.writerDigest) && timingSafeEqual(actual,Buffer.from(op.writerDigest,'hex')),403,'writer_secret_invalid');}
const TTL=120*60*1000;
const policy=Object.freeze({version:1,mode:'adaptive',maxConcurrentUploads:1,maxInFlightBytes:25*MiB});
const MIME={PNG:'image/png',JPG:'image/jpeg',JPEG:'image/jpeg',WEBP:'image/webp',SVG:'image/svg+xml'};
const finite=v=>typeof v==='number' && Number.isFinite(v);
const COORDINATE_MODE='project-xy';
const coordinateKey=(x,y)=>JSON.stringify([x,y]);
function projectCoordinateFrame(d,projectId,x,y){
  const fileIds=new Set(d.all('designFiles').filter(file=>file.projectId===projectId).map(file=>file.id));
  const revisions=new Map(d.all('frameRevisions').map(revision=>[revision.id,revision]));
  const matches=[];for(const frame of d.all('frames')){
    if(!fileIds.has(frame.designFileId))continue;
    const revision=frame.currentRevisionId?revisions.get(frame.currentRevisionId):null;
    const onFrame=finite(frame.x) && finite(frame.y),onRevision=revision && finite(revision.x) && finite(revision.y);
    // Legacy C10 frames often omit x/y; the selected revision owns the published source geometry.
    if(onFrame && onRevision)demand(frame.x===revision.x && frame.y===revision.y,409,'coordinate_geometry_conflict');
    const position=onRevision?revision:onFrame?frame:null;
    if(position && position.x===x && position.y===y)matches.push(frame);
  }
  demand(matches.length<=1,409,'coordinate_ambiguous');return matches[0] || null;
}
const nodeId=v=>typeof v==='string' && v.length>0 && v.length<=512 && !/[\x00-\x20\x7f]/.test(v);
const text=(v,max=512)=>typeof v==='string' && v.length<=max && !/[\x00-\x1f\x7f]/.test(v);
const nonblank=(v,max=512)=>text(v,max) && v.trim().length>0;
const rows=(root,table)=>root[table] || [];
const at=clock=>new Date(clock()).toISOString();
function exact(v,keys,required=keys){demand(isObject(v) && Object.keys(v).every(k=>keys.includes(k)) && required.every(k=>Object.hasOwn(v,k)),400,'invalid_request');}
function fault(status,code,extra){const e=problem(status,code);if(extra){e.extra=extra;Object.assign(e,extra);}return e;}
export function validateSource(source){
  if(source?.kind==='figma-file'){exact(source,['kind','fileKey']);demand(typeof source.fileKey==='string' && /^[A-Za-z0-9]{1,128}$/.test(source.fileKey),400,'invalid_source');}
  else{exact(source,['kind','namespace']);demand(source.kind==='plugin-launch' && typeof source.namespace==='string' && /^src_[a-z0-9]{1,16}_[a-f0-9]{32}$/.test(source.namespace),400,'invalid_source');}
  return source;
}
export const sourceKey=s=>{validateSource(s);return JSON.stringify([s.kind,s.kind==='figma-file'?s.fileKey:s.namespace]);};
export function filePublishingSource(file){
  if(file?.figmaFileKey)return {kind:'figma-file',fileKey:file.figmaFileKey};
  return file?.publishingSource || file?.source || null;
}
export const fingerprint=f=>sha256(Buffer.from(JSON.stringify([f.layerDocSha256,f.previewSha256 || null,f.exports,f.transform || null]),'utf8'));
export const sessionManifestHash=frames=>sha256(Buffer.from(JSON.stringify(frames.map(f=>({id:f.figmaNodeId,h:f.hash,n:f.name,x:f.x,y:f.y,w:f.width,hh:f.height,o:f.order,base:f.baseRevisionId || null}))),'utf8'));
// The legacy revision manifest hash omits assets and other request fields. It is
// deliberately NOT the prepare idempotency key. Bind the entire validated JSON,
// including explicit null versus omission, with object-key order canonicalized.
function requestHash(kind,value){return sha256(Buffer.from(kind+'\n'+JSON.stringify(value,(_key,item)=>{
  if(!isObject(item))return item;
  return Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]]));
}),'utf8'));}
export function declaredAssets(f){return [{sha256:f.layerDocSha256,bytes:f.layerDocBytes,mime:'application/json'},...(f.previewSha256?[{sha256:f.previewSha256,bytes:f.previewBytes,mime:f.previewMime}]:[]),...f.exports.map(e=>({sha256:e.sha256,bytes:e.bytes,mime:e.mime}))];}
function descriptor(d){demand(validHash(d.sha256) && Number.isSafeInteger(d.bytes) && d.bytes>0,400,'invalid_asset_descriptor');demand(d.bytes<=MAX_RAW,413,'asset_limit');demand(['application/json',...Object.values(MIME)].includes(d.mime),415,'unsupported_mime');if(d.mime==='application/json')demand(d.bytes<=MAX_JSON,413,'json_limit');}
export function validatePrepare(body){
  exact(body,['projectId','designFile','source','requireBaseRevision','frames','coordinateMode','groupId','groupAssignment','operationId','batchIndex','writerSecret'],['projectId','designFile','requireBaseRevision','frames']);demand(validId(body.projectId));demand(body.groupId===undefined || body.groupId===null || validId(body.groupId),400,'invalid_group_id');
  demand(!Object.hasOwn(body,'groupAssignment') || body.groupAssignment==='set' && Object.hasOwn(body,'groupId') && body.groupId!==undefined,400,'invalid_group_assignment');
  demand(Object.hasOwn(body,'operationId')===Object.hasOwn(body,'batchIndex') && (!Object.hasOwn(body,'operationId') || validId(body.operationId) && Number.isSafeInteger(body.batchIndex) && body.batchIndex>=0 && body.batchIndex<10000),400,'invalid_operation_batch');
  demand(body.coordinateMode===undefined || body.coordinateMode===COORDINATE_MODE,400,'invalid_coordinate_mode');
  exact(body.designFile,['designFileId','figmaFileKey','sourceUrl','name'],[]);
  const df=body.designFile;demand(df.designFileId || df.figmaFileKey || df.sourceUrl,400,'missing_file_identity');
  if(df.designFileId!==undefined)demand(validId(df.designFileId));if(df.figmaFileKey!==undefined && df.figmaFileKey!==null)demand(typeof df.figmaFileKey==='string' && /^[A-Za-z0-9]{1,128}$/.test(df.figmaFileKey),400,'invalid_source');
  if(df.sourceUrl!==undefined && df.sourceUrl!==null)demand(nonblank(df.sourceUrl,2048),400,'invalid_source');if(df.name!==undefined)demand(nonblank(df.name),400,'invalid_source');if(body.source!==undefined)validateSource(body.source);
  demand(body.requireBaseRevision===true && Array.isArray(body.frames) && body.frames.length>0 && body.frames.length<=1000,400,'invalid_manifest');
  const seen=new Set(),coordinates=new Set(),assets=new Map();
  for(const f of body.frames){
    exact(f,['figmaNodeId','figmaPageId','name','pageName','pageOrder','x','y','width','height','order','hash','layerDocSha256','layerDocBytes','previewSha256','previewBytes','previewMime','exports','transform','designSpec','designScale','baseRevisionId'],['figmaNodeId','figmaPageId','name','x','y','width','height','hash','layerDocSha256','layerDocBytes','exports','baseRevisionId']);
    demand(f.designSpec===undefined || ['web','ios','android'].includes(f.designSpec),400,'invalid_design_spec');
    demand(f.designScale===undefined || finite(f.designScale) && f.designScale>=1 && f.designScale<=8,400,'invalid_design_scale');
    demand(nodeId(f.figmaNodeId) && nodeId(f.figmaPageId) && nonblank(f.name) && (f.pageName===undefined || nonblank(f.pageName)),400,'invalid_manifest');demand(!seen.has(f.figmaNodeId),400,'duplicate_frame');seen.add(f.figmaNodeId);
    demand(['x','y','width','height'].every(k=>finite(f[k])) && f.width>0 && f.height>0 && ['order','pageOrder'].every(k=>f[k]===undefined || finite(f[k])),400,'invalid_dimensions');demand(f.baseRevisionId===null || validId(f.baseRevisionId),400,'invalid_base_revision');
    if(body.coordinateMode===COORDINATE_MODE){const key=coordinateKey(f.x,f.y);demand(!coordinates.has(key),400,'duplicate_coordinates');coordinates.add(key);}
    demand(validHash(f.hash) && Array.isArray(f.exports) && f.exports.length<=1000,400,'invalid_manifest');if(f.transform!==undefined && f.transform!==null)demand(Array.isArray(f.transform) && f.transform.length===2 && f.transform.every(r=>Array.isArray(r) && r.length===3 && r.every(finite)),400,'invalid_transform');
    for(const e of f.exports){exact(e,['sha256','bytes','mime','exportNodeId','fileName','exportName','format','pluginExportSetting'],['sha256','bytes','mime','exportNodeId','fileName']);demand(nodeId(e.exportNodeId) && nonblank(e.fileName) && !/[\\/]/.test(e.fileName) && (e.exportName===undefined || nonblank(e.exportName)),400,'invalid_export');demand(Object.values(MIME).includes(e.mime) && (e.format===undefined || MIME[e.format]===e.mime) && (e.pluginExportSetting===undefined || e.pluginExportSetting===null || isObject(e.pluginExportSetting)),400,'unsupported_export');descriptor(e);}
    demand(f.previewSha256===undefined && f.previewBytes===undefined && f.previewMime===undefined || validHash(f.previewSha256) && ['image/png','image/jpeg','image/webp'].includes(f.previewMime),400,'invalid_preview');
    for(const d of declaredAssets(f)){descriptor(d);const prior=assets.get(d.sha256);demand(!prior || prior.mime===d.mime && prior.bytes===d.bytes,400,'asset_descriptor_conflict');assets.set(d.sha256,d);}
  }
  demand(Buffer.byteLength(JSON.stringify(body),'utf8')<=MAX_JSON,413,'json_limit');return assets;
}
export function validateLayerDoc(bytes,frame,coordinateMode){demand(bytes.length<=MAX_JSON,413,'json_limit');let doc;try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw problem(400,'invalid_layer_doc');}const result=validateLayerDocValue(doc,frame);if(coordinateMode===COORDINATE_MODE)demand(doc.frame.absoluteBoundingBox.x===frame.x && doc.frame.absoluteBoundingBox.y===frame.y,400,'layer_doc_coordinates');return result;}
export function validateLayerDocValue(doc,frame){
  const root=doc?.frame;demand(doc?.contractVersion===1 && isObject(root) && root.type==='FRAME' && root.id===frame.figmaNodeId && Array.isArray(root.children) && (doc.styles===undefined || isObject(doc.styles) && Object.values(doc.styles).every(Array.isArray)) && (doc.components===undefined || Array.isArray(doc.components)),400,'invalid_layer_doc');
  const b=root.absoluteBoundingBox;demand(isObject(b) && ['x','y','width','height'].every(k=>finite(b[k])) && b.width===frame.width && b.height===frame.height && b.width>0 && b.height>0,400,'layer_doc_dimensions');
  const ids=new Set(),pending=[[root,0]];let count=0;while(pending.length){const [node,depth]=pending.pop();demand(++count<=200000 && depth<=128 && isObject(node) && nodeId(node.id) && !ids.has(node.id) && typeof node.type==='string' && typeof node.name==='string',400,'invalid_layer_subtree');ids.add(node.id);if(node.children!==undefined){demand(Array.isArray(node.children),400,'invalid_layer_subtree');for(const child of node.children)pending.push([child,depth+1]);}if(node.absoluteBoundingBox!==undefined && node.absoluteBoundingBox!==null)demand(isObject(node.absoluteBoundingBox) && ['x','y','width','height'].every(k=>finite(node.absoluteBoundingBox[k])) && node.absoluteBoundingBox.width>=0 && node.absoluteBoundingBox.height>=0,400,'invalid_layer_geometry');if(node.absoluteTransform!==undefined && node.absoluteTransform!==null)demand(Array.isArray(node.absoluteTransform) && node.absoluteTransform.length===2 && node.absoluteTransform.every(r=>Array.isArray(r) && r.length===3 && r.every(finite)),400,'invalid_layer_geometry');}
  demand(frame.exports.every(e=>ids.has(e.exportNodeId)),400,'export_outside_subtree');return doc;
}
const items=s=>s.items || s.frames || [];
function budgetDescriptors(s){if(Array.isArray(s.descriptors))return s.descriptors;const result=new Map();for(const item of items(s))for(const d of declaredAssets(item.manifest))result.set(d.sha256,d);return [...result.values()];}
function checkBytes(d,bytes){try{return validateBytes(d,bytes);}catch(e){if(e.code==='asset_length_mismatch')throw problem(400,'size_mismatch');if(e.code==='asset_sha_mismatch')throw problem(400,'sha256_mismatch');if(e.status===413)throw e;if(d.mime!=='application/json')throw problem(415,'invalid_signature');throw e;}}
function revisionDependencies(draft,revision){
  if(validHash(revision.assetHash))return revision.assetHash;
  if(revision.manifest)return fingerprint(revision.manifest);
  const layer=draft.byId('assets',revision.layerDocAssetId),preview=revision.previewAssetId?draft.byId('assets',revision.previewAssetId):null;
  if(!layer || revision.previewAssetId && !preview)return null;
  const exports=draft.all('revisionAssets').filter(a=>a.revisionId===revision.id && (!a.role || a.role==='export')).map(r=>{const a=draft.byId('assets',r.assetId);return a?{sha256:a.sha256,bytes:a.bytes,mime:a.mime,exportNodeId:r.exportNodeId,fileName:r.fileName,...(r.exportName!==undefined?{exportName:r.exportName}:{}),...(r.format!==undefined?{format:r.format}:{}),...(r.pluginExportSetting!==undefined?{pluginExportSetting:r.pluginExportSetting}:{})}:null;});
  if(exports.includes(null))return null;return fingerprint({layerDocSha256:layer.sha256,previewSha256:preview?.sha256,exports,transform:revision.transform});
}
function statusFor(draft,current,revision,m,expected=m.baseRevisionId){
  if((current?.currentRevisionId || null)!==expected)return 'conflict';if(!current?.currentRevisionId)return 'new';
  if(!revision || revisionDependencies(draft,revision)!==fingerprint(m))return 'changed';
  const previous=revision.manifest || revision,page=draft.byId('pages',revision.pageId || current.pageId);
  const before=[previous.name,previous.x,previous.y,previous.width,previous.height,previous.order ?? 0,previous.figmaPageId ?? page?.figmaPageId,previous.pageName ?? page?.name ?? null,previous.pageOrder ?? page?.order ?? null];
  const after=[m.name,m.x,m.y,m.width,m.height,m.order ?? 0,m.figmaPageId,m.pageName ?? page?.name ?? null,m.pageOrder ?? page?.order ?? null];return JSON.stringify(before)===JSON.stringify(after)?'unchanged':'metadata-only';
}
export function createPublishing({vault,auth,permissions,clock=Date.now,publishIntentKey}={}){
  demand(vault && auth && permissions,500,'publishing_not_configured');const actor=req=>auth.actor(req);
  function intentMac(user,projectId,nonce){demand(typeof publishIntentKey==='string' || Buffer.isBuffer(publishIntentKey),500,'intent_not_configured');return createHmac('sha256',publishIntentKey).update('heron-publish-intent-v1\0').update(JSON.stringify([user.id,projectId,nonce])).digest('hex');}
  function validIntent(user,projectId,id){const match=/^op_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(id);if(!match)return false;const expected=Buffer.from(intentMac(user,projectId,match[1]),'hex');return timingSafeEqual(expected,Buffer.from(match[2],'hex'));}
  function authorize(req,p,read=false,draft){const user=actor(req);(read?permissions.requireRead:permissions.requirePublish).call(permissions,user,p,{draft});return user;}
  const sessionRoot=d=>({publishSessions:d.all('publishSessions'),publishOperations:d.all('publishOperations') || [],designFiles:d.all('designFiles')});
  const sessionProject=(root,s)=>s.projectId || rows(root,'designFiles').find(f=>f.id===s.designFileId)?.projectId;
  function operation(req,id,root=vault.catalog,read=false,draft){
    const user=actor(req),op=rows(root,'publishOperations').find(o=>o.id===id);
    demand(op && op.createdBy===user.id,404,'not_found');authorize(req,op.projectId,read,draft);return op;
  }
  function activeOperation(root,p){return rows(root,'publishOperations').find(o=>o.projectId===p&&pendingPublishOperation(o));}
  function unlocked(root,p){demand(!activeOperation(root,p),409,'publish_operation_active');}
  function writableOperation(op){demand(['open','partial'].includes(op.status),409,'operation_not_open');}
  function session(req,id,root=vault.catalog,read=false,draft,writerSecret){
    const user=actor(req),s=rows(root,'publishSessions').find(s=>s.id===id);
    // A SID is not a capability, including on old routes and /result. Legacy
    // rows without provable ownership remain stored but cannot be claimed.
    demand(s && s.createdBy===user.id,404,'not_found');const projectId=sessionProject(root,s);authorize(req,projectId,read,draft);
    if(s.operationId){const op=operation(req,s.operationId,root,read,draft);demand(op.projectId===s.projectId,409,'operation_project_mismatch');if(!read){verifyWriter(op,writerSecret);if(pendingPublishSession(s))writableOperation(op);}}
    else if(!read&&pendingPublishSession(s))unlocked(root,projectId);
    return s.projectId?s:{...s,projectId};
  }
  // A global content hash is not a read capability. Reuse only live readable
  // revision links; otherwise require independently uploaded, verified bytes.
  function readableAssetIds(req){
    const user=actor(req),root=vault.catalog,files=new Map(rows(root,'designFiles').map(f=>[f.id,f])),frames=new Map(rows(root,'frames').map(f=>[f.id,f])),readable=new Map(),revisions=new Set(),assets=new Set();
    for(const revision of rows(root,'frameRevisions')){
      const frame=frames.get(revision.frameId),projectId=frame && (frame.projectId || files.get(frame.designFileId)?.projectId);if(!projectId || revision.projectId && revision.projectId!==projectId)continue;
      if(!readable.has(projectId)){try{permissions.requireRead(user,projectId);readable.set(projectId,true);}catch(e){if(![403,404].includes(e.status))throw e;readable.set(projectId,false);}}
      if(!readable.get(projectId))continue;revisions.add(revision.id);if(revision.layerDocAssetId)assets.add(revision.layerDocAssetId);if(revision.previewAssetId)assets.add(revision.previewAssetId);
    }
    const hashes=new Map(rows(root,'assets').map(a=>[a.sha256,a.id]));for(const relation of rows(root,'revisionAssets'))if(revisions.has(relation.revisionId))assets.add(relation.assetId || hashes.get(relation.sha256));return assets;
  }
  // The legacy deadline rejects new writes without changing state, releasing a
  // lock, or deleting staged data. Operation sessions have no automatic expiry.
  function open(s){
    demand(s.status==='open',409,s.status==='expired'?'session_expired':'session_closed');
    if(!s.operationId){const expires=Date.parse(s.expiresAt);demand(Number.isFinite(expires)&&expires>clock(),409,'session_expired');}
  }
  function verifyFile(file,p,source,identity={}){
    demand(file,404,'not_found');demand(file.projectId===p,403,'file_project_mismatch');const actual=filePublishingSource(file);
    if(source)demand(actual && sourceKey(actual)===sourceKey(source),409,'invalid_source');
    if(identity.figmaFileKey!==undefined && identity.figmaFileKey!==null)demand((file.figmaFileKey || (actual?.kind==='figma-file'?actual.fileKey:null))===identity.figmaFileKey,409,'file_identity_mismatch');
    if(identity.sourceUrl!==undefined && identity.sourceUrl!==null && file.sourceUrl)demand(file.sourceUrl===identity.sourceUrl,409,'file_identity_mismatch');return actual;
  }
  function pageFor(d,file,m){let page=d.all('pages').find(p=>p.designFileId===file.id && p.figmaPageId===m.figmaPageId);if(!page){page={id:newId(),designFileId:file.id,figmaPageId:m.figmaPageId,name:m.pageName || '',order:m.pageOrder ?? 0,createdAt:at(clock)};d.add('pages',page);}return page;}
  function queryDTO(s){return {sessionId:s.id,status:s.status,expiresAt:s.expiresAt,...(s.operationId?{automaticExpiry:false,operationId:s.operationId,batchIndex:s.batchIndex,requestHash:s.requestHash}:{}),uploaded:s.uploaded || [],uploadPolicy:policy,frames:items(s).map(i=>({figmaNodeId:i.figmaNodeId || i.manifest.figmaNodeId,frameId:i.frameId,status:s.status==='open'?i.status:s.status}))};}
  function operationDTO(op,root){
    const batches=rows(root,'publishSessions').filter(s=>s.operationId===op.id).sort((a,b)=>a.batchIndex-b.batchIndex).map(s=>({...queryDTO(s),prepareResult:s.prepareResult,...(s.status==='committed'?{commitResult:s.commitResult}:{})}));
    const committedFrames=batches.filter(b=>b.status==='committed').flatMap(b=>b.commitResult?.frames || []),done=new Set(committedFrames.map(f=>f.figmaNodeId));
    return {operationId:op.id,projectId:op.projectId,createdBy:op.createdBy,status:op.status,...(op.cancelTombstone===true?{cancelTombstone:true}:{}),frameIds:op.frameIds,...(Object.hasOwn(op,'groupId')?{groupId:op.groupId}:{}),createdAt:op.createdAt,updatedAt:op.updatedAt,finishedAt:op.finishedAt??null,lockScope:'service',automaticExpiry:false,batches,committedFrames,remainingFrameIds:op.frameIds.filter(id=>!done.has(id))};
  }
  async function cleanStage(_id){
    // Preserve both legacy and operation staging; any cleanup requires separate authorization.
  }
  return {
    async createIntent(req,projectId){
      demand(validId(projectId),400,'invalid_project_id');const user=authorize(req,projectId);const nonce=randomBytes(16).toString('hex');return {projectId,operationId:`op_${nonce}_${intentMac(user,projectId,nonce)}`};
    },
    async recoverCancel(req,id,body,{signal}={}){
      exact(body,['projectId']);demand(validId(id)&&validId(body.projectId),400,'invalid_request');authorize(req,body.projectId);
      return vault.transact(d=>{
        cancelled(signal);const user=authorize(req,body.projectId,false,d),root=sessionRoot(d),existing=rows(root,'publishOperations').find(o=>o.id===id);
        if(!existing){
          demand(validIntent(user,body.projectId,id),404,'not_found');
          const tombstone={id,projectId:body.projectId,frameIds:[],createdBy:user.id,requestHash:requestHash('publish-cancel-tombstone-v1',{id,projectId:body.projectId,actorId:user.id}),status:'cancelled',cancelTombstone:true,createdAt:at(clock),updatedAt:at(clock),finishedAt:at(clock)};
          d.add('publishOperations',tombstone);d.add('auditLogs',{id:newId(),actor:user.username || user.id,actorId:user.id,action:'publish.recover_cancel',target:id,projectId:body.projectId,createdAt:at(clock)});return operationDTO(tombstone,sessionRoot(d));
        }
        const op=operation(req,id,root,false,d);demand(op.projectId===body.projectId,404,'not_found');
        if(op.status==='cancelled')return operationDTO(op,root);demand(op.status!=='completed',409,'operation_completed');demand(['open','partial'].includes(op.status),409,'operation_state_unknown');
        const sessions=rows(root,'publishSessions').filter(s=>s.operationId===id);demand(sessions.every(s=>['open','committed','aborted','expired'].includes(s.status)),409,'session_state_unknown');
        for(const s of sessions)if(s.status==='open')d.patch('publishSessions',s.id,{status:'aborted',finishedAt:at(clock)});
        const done={...op,status:'cancelled',updatedAt:at(clock),finishedAt:at(clock)};d.patch('publishOperations',id,done);d.add('auditLogs',{id:newId(),actor:user.username || user.id,actorId:user.id,action:'publish.recover_cancel',target:id,projectId:body.projectId,createdAt:at(clock)});return operationDTO(done,sessionRoot(d));
      },{signal});
    },
    async createOperation(req,body,{signal}={}){
      body=structuredClone(body);exact(body,['operationId','projectId','frameIds','groupId','writerSecret','replacePrevious'],['operationId','projectId','frameIds','writerSecret']);
      demand(!Object.hasOwn(body,'replacePrevious') || body.replacePrevious===true,400,'invalid_replace_previous');
      const writerDigest=secretDigest(body.operationId,body.writerSecret);delete body.writerSecret;
      demand(validId(body.operationId)&&validId(body.projectId)&&Array.isArray(body.frameIds)&&body.frameIds.length>0&&body.frameIds.length<=10000&&body.frameIds.every(nodeId)&&new Set(body.frameIds).size===body.frameIds.length,400,'invalid_operation');
      demand(!Object.hasOwn(body,'groupId')||body.groupId===null||validId(body.groupId),400,'invalid_group_id');authorize(req,body.projectId);
      const hash=requestHash('publish-operation-v1',body);
      return vault.transact(d=>{
        cancelled(signal);const user=authorize(req,body.projectId,false,d),root=sessionRoot(d),prior=rows(root,'publishOperations').find(o=>o.id===body.operationId);
        if(prior){const op=operation(req,prior.id,root,false,d);demand(!op.cancelTombstone,409,'operation_cancelled');demand(op.projectId===body.projectId&&op.requestHash===hash && typeof op.writerDigest==='string' && /^[a-f0-9]{64}$/.test(op.writerDigest) && timingSafeEqual(Buffer.from(op.writerDigest,'hex'),Buffer.from(writerDigest,'hex')),409,'operation_request_mismatch');return operationDTO(op,root);}
        demand(validIntent(user,body.projectId,body.operationId),403,'invalid_operation_intent');
        if(body.replacePrevious===true){
          // Only an explicitly new claim supersedes this actor's pending work.
          // Keep committed batches, staging, design data and all audit history.
          // This shares the claim transaction: a foreign/unknown lock or failed
          // claim rolls back every cancellation. Idempotent claims returned above
          // must never cancel a newer operation on a delayed retry.
          const finishedAt=at(clock);
          for(const previous of rows(root,'publishOperations'))if(previous.projectId===body.projectId && previous.createdBy===user.id && ['open','partial'].includes(previous.status)){
            d.patch('publishOperations',previous.id,{status:'cancelled',updatedAt:finishedAt,finishedAt});
            d.add('auditLogs',{id:newId(),actor:user.username || user.id,actorId:user.id,action:'publish.replace_previous',target:previous.id,projectId:body.projectId,replacementOperationId:body.operationId,createdAt:finishedAt});
          }
          for(const previous of rows(root,'publishSessions'))if(sessionProject(root,previous)===body.projectId && previous.createdBy===user.id && previous.status==='open'){
            d.patch('publishSessions',previous.id,{status:'aborted',finishedAt});
            d.add('auditLogs',{id:newId(),actor:user.username || user.id,actorId:user.id,action:'publish.replace_previous',target:previous.id,projectId:body.projectId,replacementOperationId:body.operationId,createdAt:finishedAt});
          }
        }
        const claimedRoot=sessionRoot(d);
        unlocked(claimedRoot,body.projectId);
        demand(!rows(claimedRoot,'publishSessions').some(s=>sessionProject(claimedRoot,s)===body.projectId&&pendingPublishSession(s)),409,'publish_session_active');
        if(body.groupId)demand(d.all('frameGroups').some(g=>g.id===body.groupId&&g.projectId===body.projectId),404,'group_not_found');
        const op={id:body.operationId,projectId:body.projectId,frameIds:body.frameIds,...(Object.hasOwn(body,'groupId')?{groupId:body.groupId}:{}),projectOwnerId:d.byId('projects',body.projectId)?.ownerId??null,createdBy:user.id,requestHash:hash,writerDigest,status:'open',createdAt:at(clock),updatedAt:at(clock)};
        d.add('publishOperations',op);return operationDTO(op,root);
      },{signal});
    },
    async queryOperation(req,id){const root=vault.catalog;return operationDTO(operation(req,id,root,true),root);},
    async operationReceipt(req,id){
      // A narrow, read-only terminal receipt. Deleted projects cannot authorize
      // design reads, but the original actor may still confirm their own task ended.
      const user=actor(req),root=vault.catalog,op=rows(root,'publishOperations').find(o=>o.id===id);
      demand(op && op.createdBy===user.id,404,'not_found');
      const project=rows(root,'projects').find(p=>p.id===op.projectId),terminal=['completed','cancelled'].includes(op.status);
      if(project)authorize(req,op.projectId,true);else demand(terminal,404,'not_found');
      return {operationId:op.id,projectId:op.projectId,status:op.status,terminal,projectDeleted:!project};
    },
    async listOperations(req,projectId){
      demand(validId(projectId),400,'invalid_project_id');const user=authorize(req,projectId,true),root=vault.catalog;
      return {projectId,operations:rows(root,'publishOperations').filter(o=>o.projectId===projectId&&o.createdBy===user.id&&pendingPublishOperation(o)).map(o=>operationDTO(o,root)),legacySessions:rows(root,'publishSessions').filter(s=>sessionProject(root,s)===projectId&&s.createdBy===user.id&&!s.operationId&&pendingPublishSession(s)).map(queryDTO)};
    },
    async finishOperation(req,id,body,{signal}={}){
      exact(body,['writerSecret','catalogReadVersion']);demand(typeof body.catalogReadVersion==='string' && body.catalogReadVersion.length>0 && body.catalogReadVersion.length<=256,400,'invalid_catalog_version');operation(req,id);return vault.transact(d=>{
        cancelled(signal);const root=sessionRoot(d),op=operation(req,id,root,false,d);verifyWriter(op,body.writerSecret);
        if(op.status==='completed')return operationDTO(op,root);writableOperation(op);
        demand(typeof vault.readVersion==='string' && vault.readVersion===body.catalogReadVersion,409,'catalog_version_conflict');
        demand(!rows(root,'publishSessions').some(s=>sessionProject(root,s)===op.projectId&&pendingPublishSession(s)),409,'operation_sessions_open');
        const sessions=rows(root,'publishSessions').filter(s=>s.operationId===id),expected=new Set(op.frameIds),seen=new Set(),targets=new Set();
        for(const s of sessions){
          demand(s.status==='committed'&&s.commitResult?.sessionId===s.id&&s.commitResult.status==='committed'&&s.commitResult.frames?.length===items(s).length,409,'operation_incomplete');
          for(const item of items(s)){
            const result=s.commitResult.frames.find(f=>f.figmaNodeId===item.figmaNodeId),frame=result&&d.byId('frames',result.frameId),revision=result&&d.byId('frameRevisions',result.revisionId);
            demand(expected.has(item.figmaNodeId)&&!seen.has(item.figmaNodeId)&&result&&result.frameId===item.frameId&&!targets.has(result.frameId)&&frame?.currentRevisionId===result.revisionId&&revision?.frameId===result.frameId&&d.byId('designFiles',frame.designFileId)?.projectId===op.projectId,409,'operation_incomplete');
            if(Object.hasOwn(op,'groupId'))demand((frame.groupId??null)===op.groupId,409,'operation_incomplete');
            seen.add(item.figmaNodeId);targets.add(result.frameId);
          }
        }
        demand(seen.size===expected.size,409,'operation_incomplete');
        const done={...op,status:'completed',updatedAt:at(clock),finishedAt:at(clock)};d.patch('publishOperations',id,done);return operationDTO(done,root);
      },{signal});
    },
    async cancelOperation(req,id,body,{signal}={}){
      exact(body,['writerSecret']);operation(req,id);return vault.transact(d=>{
        cancelled(signal);const root=sessionRoot(d),op=operation(req,id,root,false,d);verifyWriter(op,body.writerSecret);
        if(op.status==='cancelled')return operationDTO(op,root);demand(op.status!=='completed',409,'operation_completed');
        demand(['open','partial'].includes(op.status),409,'operation_state_unknown');
        const sessions=rows(root,'publishSessions').filter(s=>s.operationId===id);
        demand(sessions.every(s=>['open','committed','aborted','expired'].includes(s.status)),409,'session_state_unknown');
        // This explicit request closes known open work atomically. It never rolls
        // back committed batches, deletes staging, or silently starts a retry.
        for(const s of sessions)if(s.status==='open')d.patch('publishSessions',s.id,{status:'aborted',finishedAt:at(clock)});
        const done={...op,status:'cancelled',updatedAt:at(clock),finishedAt:at(clock)};d.patch('publishOperations',id,done);return operationDTO(done,sessionRoot(d));
      },{signal});
    },
    async publishSource(req,p,body,{signal}={}){
      body=structuredClone(body);exact(body,['source','name','frameIds','coordinates','operationId','writerSecret'],['source','frameIds']);demand(body.operationId!==undefined || body.writerSecret===undefined,400,'invalid_request');validateSource(body.source);demand(validId(p) && (body.operationId===undefined||validId(body.operationId)) && Array.isArray(body.frameIds) && body.frameIds.length>0 && body.frameIds.length<=1000 && body.frameIds.every(nodeId) && new Set(body.frameIds).size===body.frameIds.length && (body.name===undefined || nonblank(body.name)),400,'invalid_source_request');
      if(body.coordinates!==undefined){demand(Array.isArray(body.coordinates) && body.coordinates.length===body.frameIds.length,400,'invalid_coordinates');const ids=new Set(),positions=new Set();for(const c of body.coordinates){exact(c,['frameId','x','y'],['frameId','x','y']);demand(nodeId(c.frameId) && body.frameIds.includes(c.frameId) && !ids.has(c.frameId) && finite(c.x) && finite(c.y),400,'invalid_coordinates');const key=coordinateKey(c.x,c.y);demand(!positions.has(key),400,'duplicate_coordinates');ids.add(c.frameId);positions.add(key);}}authorize(req,p);
      return vault.transact(d=>{cancelled(signal);const user=authorize(req,p,false,d),root=sessionRoot(d);
        if(body.operationId){const op=operation(req,body.operationId,root,false,d);demand(op.projectId===p,409,'operation_project_mismatch');verifyWriter(op,body.writerSecret);writableOperation(op);const allowed=new Set(op.frameIds);demand(body.frameIds.every(id=>allowed.has(id)),409,'operation_frames_mismatch');if(op.source)demand(sourceKey(op.source)===sourceKey(body.source),409,'operation_source_mismatch');else d.patch('publishOperations',op.id,{source:body.source,updatedAt:at(clock)});}else {unlocked(root,p);demand(!rows(root,'publishSessions').some(s=>sessionProject(root,s)===p&&pendingPublishSession(s)),409,'publish_session_active');}
        let file=d.all('designFiles').find(f=>f.projectId===p && (body.source.kind==='figma-file'?f.figmaFileKey===body.source.fileKey || filePublishingSource(f)?.kind==='figma-file' && filePublishingSource(f).fileKey===body.source.fileKey:!f.figmaFileKey && filePublishingSource(f)?.kind==='plugin-launch' && filePublishingSource(f).namespace===body.source.namespace));
        if(!file){file={id:newId(),projectId:p,figmaFileKey:body.source.kind==='figma-file'?body.source.fileKey:null,sourceUrl:null,publishingSource:body.source,source:body.source,name:body.name || 'Design file',createdBy:user.id,createdAt:at(clock)};d.add('designFiles',file);}else d.patch('designFiles',file.id,{publishingSource:body.source,...(body.name!==undefined?{name:body.name}:{}),updatedAt:at(clock)});
        const baseRevisions=Object.create(null);for(const fid of body.frameIds){const position=body.coordinates?.find(c=>c.frameId===fid);baseRevisions[fid]=(position?projectCoordinateFrame(d,p,position.x,position.y):d.all('frames').find(f=>f.designFileId===file.id && f.figmaNodeId===fid))?.currentRevisionId || null;}return {projectId:p,designFileId:file.id,source:body.source,baseRevisions,...(body.coordinates?{coordinateMode:COORDINATE_MODE}:{})};
      },{signal});
    },
    async prepare(req,body,{signal}={}){
      body=structuredClone(body);const descriptors=validatePrepare(body);authorize(req,body.projectId);
      const writerSecret=body.writerSecret;delete body.writerSecret;demand(body.operationId!==undefined || writerSecret===undefined,400,'invalid_request');
      const hash=body.operationId?requestHash('publish-prepare-v1',body):null;
      return vault.transact(d=>{cancelled(signal);const user=authorize(req,body.projectId,false,d),df=body.designFile,groupId=body.groupId??null,root=sessionRoot(d);let op;
        if(body.operationId){
          op=operation(req,body.operationId,root,false,d);demand(op.projectId===body.projectId,409,'operation_project_mismatch');verifyWriter(op,writerSecret);demand(op.source && body.source && sourceKey(op.source)===sourceKey(body.source),409,'operation_source_mismatch');
          const prior=rows(root,'publishSessions').find(s=>s.operationId===op.id&&s.batchIndex===body.batchIndex);
          if(prior){demand(prior.requestHash===hash,409,'batch_request_mismatch');return {...prior.prepareResult,status:prior.status};}
          writableOperation(op);
          demand(Object.hasOwn(body,'groupId')===Object.hasOwn(op,'groupId')&&body.groupId===op.groupId,409,'operation_group_mismatch');
          const used=new Set(rows(root,'publishSessions').filter(s=>s.operationId===op.id).flatMap(s=>items(s).map(i=>i.figmaNodeId))),allowed=new Set(op.frameIds);
          demand(body.frames.every(f=>allowed.has(f.figmaNodeId)&&!used.has(f.figmaNodeId)),409,'operation_frames_mismatch');
        }else {unlocked(root,body.projectId);demand(!rows(root,'publishSessions').some(s=>sessionProject(root,s)===body.projectId&&pendingPublishSession(s)),409,'publish_session_active');}
        if(groupId)demand(d.all('frameGroups').some(g=>g.id===groupId&&g.projectId===body.projectId),404,'group_not_found');
        let file=df.designFileId?d.byId('designFiles',df.designFileId):d.all('designFiles').find(f=>f.projectId===body.projectId && (df.figmaFileKey?f.figmaFileKey===df.figmaFileKey:f.sourceUrl===df.sourceUrl));
        if(!file && !df.designFileId){file={id:newId(),projectId:body.projectId,figmaFileKey:df.figmaFileKey || null,sourceUrl:df.sourceUrl || null,name:df.name || 'Design file',createdAt:at(clock),...(body.source?{publishingSource:body.source,source:body.source}:{})};d.add('designFiles',file);}
        const source=verifyFile(file,body.projectId,body.source,df);
        if(op){
          const context={designFileId:file.id,source,coordinateMode:body.coordinateMode??null},hash=requestHash('publish-context-v1',context);
          demand(!op.contextHash||op.contextHash===hash,409,'operation_source_mismatch');d.patch('publishOperations',op.id,{...context,contextHash:hash,updatedAt:at(clock)});
        }
        const assets=d.all('assets'),readable=readableAssetIds(req);for(const a of descriptors.values()){const existing=assets.find(x=>x.sha256===a.sha256 && readable.has(x.id));demand(!existing || existing.mime===a.mime && existing.bytes===a.bytes,409,'asset_descriptor_conflict');}
        const missing=new Set(),prepared=body.frames.map(manifest=>{
          const page=pageFor(d,file,manifest),coordinateMode=body.coordinateMode===COORDINATE_MODE;let current=coordinateMode?projectCoordinateFrame(d,body.projectId,manifest.x,manifest.y):d.all('frames').find(f=>f.designFileId===file.id && f.figmaNodeId===manifest.figmaNodeId);
          if(!current){const occupied=coordinateMode && d.all('frames').some(f=>f.designFileId===file.id && f.figmaNodeId===manifest.figmaNodeId);current={id:newId(),projectId:body.projectId,designFileId:file.id,pageId:page.id,figmaNodeId:occupied?newId():manifest.figmaNodeId,...(coordinateMode?{x:manifest.x,y:manifest.y}:{}),currentRevisionId:null,state:'pending',createdAt:at(clock)};d.add('frames',current);}
          const revision=current.currentRevisionId?d.byId('frameRevisions',current.currentRevisionId):null,missingAssetSha256=declaredAssets(manifest).filter(a=>!assets.some(x=>x.sha256===a.sha256 && readable.has(x.id))).map(a=>a.sha256);missingAssetSha256.forEach(h=>missing.add(h));
          return {frameId:current.id,figmaNodeId:manifest.figmaNodeId,pageId:page.id,status:coordinateMode && current.currentRevisionId && current.currentRevisionId===manifest.baseRevisionId?'changed':statusFor(d,current,revision,manifest),missingAssetSha256,expectedRevisionId:manifest.baseRevisionId,manifest};
        });
        if(op){const targets=new Set(rows(root,'publishSessions').filter(s=>s.operationId===op.id).flatMap(s=>items(s).map(i=>i.frameId)));demand(prepared.every(i=>!targets.has(i.frameId)),409,'operation_frame_overlap');}
        const uploadBudget=Object.fromEntries([...descriptors].map(([h,a])=>[h,{mime:a.mime,bytes:a.bytes}]));
        const s={id:newId(),projectId:body.projectId,designFileId:file.id,source,...(op?{operationId:op.id,batchIndex:body.batchIndex,requestHash:hash}:{}),...(Object.hasOwn(body,'groupAssignment')?{groupAssignment:body.groupAssignment}:{}),...((op?Object.hasOwn(body,'groupId'):body.groupAssignment==='set'||groupId!==null)?{groupId}:{}),...(body.coordinateMode?{coordinateMode:COORDINATE_MODE}:{}),requireBaseRevision:true,status:'open',createdBy:user.id,actor:user.username || user.id,createdAt:at(clock),expiresAt:op?null:new Date(clock()+TTL).toISOString(),manifestHash:sessionManifestHash(body.frames),items:prepared,uploadBudget,uploaded:[]};
        const result={sessionId:s.id,status:'open',expiresAt:s.expiresAt,...(op?{automaticExpiry:false,operationId:op.id,batchIndex:body.batchIndex,requestHash:hash}:{}),designFileId:file.id,maxUploadBytes:MAX_RAW,uploadPolicy:policy,missingAssetSha256:[...missing],frames:prepared.map(i=>({figmaNodeId:i.figmaNodeId,frameId:i.frameId,status:i.status,missingAssetSha256:i.missingAssetSha256}))};
        if(op)s.prepareResult=result;d.add('publishSessions',s);return result;
      },{signal});
    },
    async upload(req,id,hash,body,{signal}={}){
      demand(validId(id) && validHash(hash),400,'invalid_asset_request');const initial=session(req,id,vault.catalog,true);const descriptor=budgetDescriptors(initial).find(a=>a.sha256===hash);demand(descriptor,400,'undeclared_asset');
      const mime=req.headers?.['x-asset-mime'],content=req.headers?.['content-type']?.split(';')[0].trim().toLowerCase();demand(content==='application/octet-stream' && mime===descriptor.mime,415,'mime_mismatch');let bytes=await readRaw(req,body,initial.operationId?MAX_RAW:(descriptor.mime==='application/json'?MAX_JSON:MAX_RAW),signal),writerSecret;
      if(initial.operationId){demand(bytes.length>=36 && bytes.subarray(0,4).equals(Buffer.from('GLP1')),403,'writer_secret_invalid');writerSecret=bytes.subarray(4,36).toString('base64url');bytes=bytes.subarray(36);}
      const s=await vault.transact(d=>session(req,id,sessionRoot(d),false,d,writerSecret),{signal});open(s);checkBytes(descriptor,bytes);for(const i of items(s))if(i.manifest.layerDocSha256===hash)validateLayerDoc(bytes,i.manifest,s.coordinateMode);authorize(req,s.projectId);
      await vault.stageAsset(id,descriptor,bytes,{signal});authorize(req,s.projectId);cancelled(signal);
      return vault.transact(d=>{const current=session(req,id,sessionRoot(d),false,d,writerSecret);open(current);cancelled(signal);if(!(current.uploaded || []).includes(hash))d.patch('publishSessions',id,{uploaded:[...(current.uploaded || []),hash]});return {ok:true,sha256:hash,bytes:descriptor.bytes,mime:descriptor.mime};},{signal});
    },
    async query(req,id){return queryDTO(session(req,id,vault.catalog,true));},
    async committedResult(req,id){const s=session(req,id,vault.catalog,true);demand(s.status==='committed' && s.commitResult && s.commitResult.sessionId===id,409,'result_not_committed');return s.commitResult;},
    async abort(req,id,{writerSecret}={}){session(req,id,vault.catalog,false,undefined,writerSecret);const result=await vault.transact(d=>{const s=session(req,id,sessionRoot(d),false,d,writerSecret);demand(['open','committed','aborted','expired'].includes(s.status),409,'session_state_unknown');if(s.status==='open'){d.patch('publishSessions',id,{status:'aborted',finishedAt:at(clock)});return {sessionId:id,status:'aborted'};}return {sessionId:id,status:s.status};});if(result.status!=='open')await cleanStage(id).catch(()=>{});return result;},
    async commit(req,id,{signal,writerSecret}={}){
      session(req,id,vault.catalog,false,undefined,writerSecret);const initial=await vault.transact(d=>session(req,id,sessionRoot(d),false,d,writerSecret),{signal});if(initial.status==='committed')return {...initial.commitResult,idempotent:true};open(initial);
      const candidates=new Map(),missing=[],possessed=new Set(),readable=readableAssetIds(req);
      for(const a of budgetDescriptors(initial)){
        cancelled(signal);const known=rows(vault.catalog,'assets').find(x=>x.sha256===a.sha256),reuse=known && !(initial.uploaded || []).includes(a.sha256) && readable.has(known.id);let bytes;try{bytes=reuse?await vault.readOriginal(known,{maxBytes:a.mime==='application/json'?MAX_JSON:MAX_RAW,signal}):await vault.readStaged(id,a.sha256,{maxBytes:a.mime==='application/json'?MAX_JSON:MAX_RAW,signal});}catch(e){if(e.status===499)throw e;missing.push(a.sha256);continue;}
        if(!reuse)possessed.add(a.sha256);
        const dimensions=checkBytes(a,bytes);for(const i of items(initial))if(i.manifest.layerDocSha256===a.sha256)validateLayerDoc(bytes,i.manifest,initial.coordinateMode);authorize(req,initial.projectId);cancelled(signal);
        if(known){demand(known.mime===a.mime && known.bytes===a.bytes,409,'asset_descriptor_conflict');candidates.set(a.sha256,known);}else{const saved=await vault.putOriginal({...a,data:bytes});authorize(req,initial.projectId);const asset={...saved,id:saved.id || newId(),...a,...(dimensions || {}),createdAt:at(clock),createdBy:actor(req).id};demand(typeof asset.relativePath==='string',500,'vault_asset_contract');candidates.set(a.sha256,asset);}
      }
      if(missing.length)throw fault(409,'assets_missing',{missingAssetSha256:[...new Set(missing)]});
      const result=await vault.transact(d=>{
        const s=session(req,id,sessionRoot(d),false,d,writerSecret);if(s.status==='committed')return {...s.commitResult,idempotent:true};open(s);cancelled(signal);verifyFile(d.byId('designFiles',s.designFileId),s.projectId,s.source || undefined);const user=authorize(req,s.projectId,false,d);
        const conflicts=[];for(const i of items(s)){const f=s.coordinateMode===COORDINATE_MODE?projectCoordinateFrame(d,s.projectId,i.manifest.x,i.manifest.y):d.all('frames').find(f=>f.designFileId===s.designFileId && f.figmaNodeId===i.manifest.figmaNodeId);if((f?.currentRevisionId || null)!==(Object.hasOwn(i,'expectedRevisionId')?i.expectedRevisionId:i.manifest.baseRevisionId) || f && f.id!==i.frameId)conflicts.push(i.manifest.figmaNodeId);}if(conflicts.length)throw fault(409,'revision_conflict',{frames:conflicts});
        const readable=readableAssetIds(req),unproven=budgetDescriptors(s).filter(a=>!possessed.has(a.sha256) && !d.all('assets').some(x=>x.sha256===a.sha256 && readable.has(x.id)));if(unproven.length)throw fault(409,'assets_missing',{missingAssetSha256:unproven.map(a=>a.sha256)});
        const promoted=new Map();for(const a of budgetDescriptors(s)){const existing=d.all('assets').find(x=>x.sha256===a.sha256);if(existing){demand(existing.mime===a.mime && existing.bytes===a.bytes,409,'asset_descriptor_conflict');promoted.set(a.sha256,existing);}else{const candidate=candidates.get(a.sha256);demand(candidate,409,'assets_missing');d.add('assets',candidate);promoted.set(a.sha256,candidate);}}
        if(s.groupId)demand(d.all('frameGroups').some(g=>g.id===s.groupId&&g.projectId===s.projectId),409,'group_not_found');const frames=[];for(const i of items(s)){
          const m=i.manifest,current=d.byId('frames',i.frameId),previous=current?.currentRevisionId?d.byId('frameRevisions',current.currentRevisionId):null,baseStatus=statusFor(d,current,previous,m,Object.hasOwn(i,'expectedRevisionId')?i.expectedRevisionId:m.baseRevisionId),status=s.coordinateMode===COORDINATE_MODE && baseStatus==='unchanged'?'changed':baseStatus;demand(status!=='conflict',409,'revision_conflict');const page=pageFor(d,d.byId('designFiles',s.designFileId),m);d.patch('pages',page.id,{...(m.pageName!==undefined?{name:m.pageName}:{}),...(m.pageOrder!==undefined?{order:m.pageOrder}:{})});let revisionId=current?.currentRevisionId;
          if(s.coordinateMode===COORDINATE_MODE || status!=='unchanged'){
            revisionId=newId();const layer=promoted.get(m.layerDocSha256),preview=m.previewSha256?promoted.get(m.previewSha256):null;
            d.add('frameRevisions',{id:revisionId,frameId:i.frameId,projectId:s.projectId,...(s.coordinateMode===COORDINATE_MODE?{coordinateMode:COORDINATE_MODE}:{}),designFileId:s.designFileId,pageId:page.id,figmaNodeId:m.figmaNodeId,hash:m.hash,assetHash:fingerprint(m),manifestHash:s.manifestHash || sessionManifestHash(items(s).map(i=>i.manifest)),name:m.name,x:m.x,y:m.y,width:m.width,height:m.height,transform:m.transform || null,order:m.order ?? 0,layerDocAssetId:layer.id,previewAssetId:preview?.id || null,manifest:m,createdAt:at(clock),publishedAt:at(clock),createdBy:user.id,previousRevisionId:current?.currentRevisionId || null});
            for(const e of m.exports)d.add('revisionAssets',{id:newId(),revisionId,assetId:promoted.get(e.sha256).id,...e,pluginExportSetting:e.pluginExportSetting ?? null});
          }
          const fields={state:'published',projectId:s.projectId,...(s.coordinateMode===COORDINATE_MODE?{}:{designFileId:s.designFileId,pageId:page.id,figmaNodeId:m.figmaNodeId}),name:m.name,x:m.x,y:m.y,width:m.width,height:m.height,order:m.order ?? 0,designSpec:m.designSpec ?? 'web',designScale:m.designScale ?? 1,...((s.operationId?Object.hasOwn(s,'groupId'):s.groupAssignment==='set'||s.groupId!=null)?{groupId:s.groupId}:{}),currentRevisionId:revisionId,updatedAt:at(clock)};if(current)d.patch('frames',i.frameId,fields);else d.add('frames',{id:i.frameId,...fields,createdAt:at(clock)});
          frames.push({figmaNodeId:m.figmaNodeId,frameId:i.frameId,revisionId,previousRevisionId:current?.currentRevisionId || null,status});
        }
        const result={sessionId:id,status:'committed',frames};d.patch('publishSessions',id,{status:'committed',committedAt:at(clock),finishedAt:at(clock),commitResult:result});
        if(s.operationId)d.patch('publishOperations',s.operationId,{status:'partial',updatedAt:at(clock)});
        d.add('auditLogs',{id:newId(),actor:user.username || user.id,actorId:user.id,action:'publish.commit',target:id,projectId:s.projectId,createdAt:at(clock),count:frames.length});return result;
      },{signal});await cleanStage(id).catch(()=>{});return result;
    }
  };
}
export function installPublishing(ctx){
  const service=createPublishing(ctx);
  ctx.route('GET',/^\/api\/publish\/intent$/,(req,res,{url})=>service.createIntent(req,url.searchParams.get('projectId')));
  ctx.route('POST',/^\/api\/publish\/operations$/,(req,res,{body,signal})=>service.createOperation(req,body,{signal}));
  ctx.route('GET',/^\/api\/publish\/operations$/,(req,res,{url})=>service.listOperations(req,url.searchParams.get('projectId')));
  ctx.route('GET',/^\/api\/publish\/operations\/(?<operationId>[A-Za-z0-9_-]+)$/,(req,res,{params})=>service.queryOperation(req,params.operationId));
  ctx.route('GET',/^\/api\/publish\/operations\/(?<operationId>[A-Za-z0-9_-]+)\/receipt$/,(req,res,{params})=>service.operationReceipt(req,params.operationId));
  ctx.route('POST',/^\/api\/publish\/operations\/(?<operationId>[A-Za-z0-9_-]+)\/finish$/,(req,res,{params,body,signal})=>service.finishOperation(req,params.operationId,body,{signal}));
  ctx.route('POST',/^\/api\/publish\/operations\/(?<operationId>[A-Za-z0-9_-]+)\/cancel$/,(req,res,{params,body,signal})=>service.cancelOperation(req,params.operationId,body,{signal}));
  ctx.route('POST',/^\/api\/publish\/operations\/(?<operationId>[A-Za-z0-9_-]+)\/recover-cancel$/,(req,res,{params,body,signal})=>service.recoverCancel(req,params.operationId,body,{signal}));
  ctx.route('POST',/^\/api\/projects\/(?<projectId>[A-Za-z0-9_-]+)\/publish-source$/,(req,res,{params,body,signal})=>service.publishSource(req,params.projectId,body,{signal}));
  ctx.route('POST',/^\/api\/publish\/sessions$/,(req,res,{body,signal})=>service.prepare(req,body,{signal}),{maxBytes:MAX_JSON});
  ctx.route('PUT',/^\/api\/publish\/sessions\/(?<sessionId>[A-Za-z0-9_-]+)\/assets\/(?<sha256>[a-f0-9]{64})$/,(req,res,{params,body,signal})=>service.upload(req,params.sessionId,params.sha256,body,{signal}),{raw:true,maxBytes:MAX_RAW});
  ctx.route('GET',/^\/api\/publish\/sessions\/(?<sessionId>[A-Za-z0-9_-]+)$/,(req,res,{params})=>service.query(req,params.sessionId));
  ctx.route('GET',/^\/api\/publish\/sessions\/(?<sessionId>[A-Za-z0-9_-]+)\/result$/,(req,res,{params})=>service.committedResult(req,params.sessionId));
  ctx.route('POST',/^\/api\/publish\/sessions\/(?<sessionId>[A-Za-z0-9_-]+)\/commit$/,(req,res,{params,body,signal})=>service.commit(req,params.sessionId,{signal,writerSecret:body?.writerSecret}));
  ctx.route('POST',/^\/api\/publish\/sessions\/(?<sessionId>[A-Za-z0-9_-]+)\/abort$/,(req,res,{params,body})=>service.abort(req,params.sessionId,{writerSecret:body?.writerSecret}));return service;
}
