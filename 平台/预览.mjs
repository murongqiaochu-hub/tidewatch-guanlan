// Derived cache only. No original rewriting, full-source Node RGBA decode, or bundled vendor binary.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sha256, newId, demand, problem, cancelled, nativeBudget, imageInfo, openVerifiedAsset, sendOpenFile, receiptsFor, finishReceipt, checkQuery, MiB } from './下载.mjs';

export function createCommandCodec({ executable, args, identity, timeoutMs = 30_000, exactNativeRGBA = false } = {}) {
  demand(typeof executable === 'string' && path.isAbsolute(executable) && typeof args === 'function' && typeof identity === 'string' && identity.length > 0 && timeoutMs > 0 && timeoutMs <= 300_000,500,'invalid_codec_configuration');
  const workers = new Set(); let closing = false;
  return {
    identity, exactNativeRGBA,
    async render(job) {
      demand(!closing,503,'codec_closing'); const argv = args(job); demand(Array.isArray(argv) && argv.every(a => typeof a === 'string' && !a.includes('\0')),500,'invalid_codec_arguments');
      cancelled(job.signal);
      return new Promise((resolve,reject) => {
        const child = spawn(executable,argv,{shell:false,stdio:['ignore','ignore','ignore'],windowsHide:true}); workers.add(child);
        let failed = null, timedOut = false;
        const abort = () => child.kill('SIGKILL'), timer = setTimeout(() => { timedOut=true; abort(); },timeoutMs);
        job.signal?.addEventListener('abort',abort,{once:true});
        child.once('error',() => { failed=problem(503,'codec_start_failed'); });
        // 'close', not AbortSignal or 'exit', is the physical-resource release point.
        child.once('close',code => { clearTimeout(timer); job.signal?.removeEventListener('abort',abort); workers.delete(child); if (failed) reject(failed); else if (timedOut) reject(problem(504,'codec_timeout')); else if (job.signal?.aborted) reject(problem(499,'request_closed')); else if (code !== 0) reject(problem(422,'codec_failed')); else resolve(); });
      });
    },
    async close() { closing=true; await Promise.all([...workers].map(child => new Promise(resolve => { child.once('close',resolve); child.kill('SIGKILL'); }))); },
    diagnostics: () => ({active:workers.size,identity,licenseStatus:'not-established-by-this-module'})
  };
}

async function ensureDirectory(directory) {
  const absolute = path.resolve(directory); await mkdir(absolute,{recursive:true,mode:0o700});
  const st=await lstat(absolute); demand(st.isDirectory() && !st.isSymbolicLink() && await realpath(absolute) === absolute && (st.mode & 0o077) === 0,500,'unsafe_preview_cache');
  return absolute;
}
async function deleteOwnedTemporary(directory,base,nonce) {
  const canonical=path.resolve(directory); demand(path.dirname(canonical)===base && path.basename(canonical)===`work-${process.getuid?.() ?? 0}-${nonce}` && await realpath(canonical)===canonical,500,'unsafe_temporary_cleanup');
  const st=await lstat(canonical); demand(st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== 'function' || st.uid===process.getuid()),500,'unsafe_temporary_cleanup');
  await rm(canonical,{recursive:true,force:false});
}
export function previewPlan(dimensions,request) {
  const {width:sw,height:sh}=dimensions;
  if (request.mode==='native') {
    demand(Number.isSafeInteger(request.x) && Number.isSafeInteger(request.y) && request.x>=0 && request.y>=0 && request.x%512===0 && request.y%512===0 && request.x<sw && request.y<sh,400,'invalid_native_tile');
    return {mode:'native',x:request.x,y:request.y,width:Math.min(512,sw-request.x),height:Math.min(512,sh-request.y),mime:'image/png'};
  }
  demand([64,256,1024,2048].includes(request.level),400,'invalid_preview_level'); const scale=Math.min(1,request.level/Math.max(sw,sh));
  demand(request.variant===undefined || request.variant==='slice-alpha',400,'invalid_preview_variant');
  const alpha=request.variant==='slice-alpha';
  return {mode:'lod',level:request.level,width:Math.max(1,Math.round(sw*scale)),height:Math.max(1,Math.round(sh*scale)),mime:alpha?'image/png':'image/jpeg',...(alpha?{variant:'slice-alpha'}:{})};
}
// Full-source pixels, not tile/output pixels. FIFO prevents a small newcomer bypassing an older large job.
function sourcePixelBudget(capacity) {
  const queue=[]; let used=0,peak=0,closed=false;
  function grant(ticket) { ticket.state='active';ticket.signal?.removeEventListener('abort',ticket.abort);used+=ticket.pixels;peak=Math.max(peak,used);ticket.resolve(); }
  function drain() { if(closed)return;while(queue.length && used+queue[0].pixels<=capacity)grant(queue.shift()); }
  function cancel(ticket,reason) { if(ticket.state!=='waiting')return;const index=queue.indexOf(ticket);if(index>=0)queue.splice(index,1);ticket.state='cancelled';ticket.signal?.removeEventListener('abort',ticket.abort);ticket.reject(reason);drain(); }
  return {
    acquire(pixels,signal) {
      demand(!closed,503,'preview_closing');cancelled(signal);demand(Number.isSafeInteger(pixels) && pixels>0 && pixels<=capacity,413,'preview_pixel_budget');
      const waiting=queue.length>0 || used+pixels>capacity;demand(!waiting || queue.length<16,429,'preview_pixel_budget');
      const ticket={pixels,signal,state:'waiting'};ticket.ready=new Promise((resolve,reject)=>{ticket.resolve=resolve;ticket.reject=reject;});ticket.ready.catch(()=>{});
      ticket.abort=()=>cancel(ticket,problem(499,'request_closed'));
      ticket.release=()=>{if(ticket.state==='active'){ticket.state='released';used-=pixels;drain();}else cancel(ticket,problem(499,'request_closed'));};
      ticket.waiting=waiting;if(waiting){queue.push(ticket);signal?.addEventListener('abort',ticket.abort,{once:true});if(signal?.aborted)ticket.abort();}else grant(ticket);return ticket;
    },
    diagnostics:()=>({used,queued:queue.length,peak,capacity,maxWaiting:16}),
    close(){closed=true;for(const ticket of [...queue])cancel(ticket,problem(503,'preview_closing'));}
  };
}
export function createPreviewStore({vault,cacheDir,codec=null,maxCacheBytes=512*MiB,maxWorkPixels=64_000_000,maxEncodedBytes=2*MiB} = {}) {
  maxEncodedBytes=Math.min(maxEncodedBytes,2*MiB);maxWorkPixels=Math.min(maxWorkPixels,64_000_000);demand(Number.isSafeInteger(maxWorkPixels) && maxWorkPixels>0,500,'invalid_preview_limits');
  const flights=new Map(), flightOwners=new WeakMap(), cache=new Map(),pixels=sourcePixelBudget(maxWorkPixels); let directoryPromise, closing=false, cacheBytes=0; const pending=new Set();
  const directory=() => directoryPromise ||= ensureDirectory(cacheDir || path.join(vault.dataDir,'derived-independent'));
  async function physical(asset,request,reauthorize,signal) {
    let release=await nativeBudget.acquire({signal}), source,workDir,nonce,pixelLease;
    try {
      demand(!closing,503,'preview_closing'); demand(codec && typeof codec.render==='function' && typeof codec.identity==='string' && codec.identity.length>0,503,'NOT_CONFIGURED');
      source=await openVerifiedAsset(vault,asset,{signal}); reauthorize(); demand(source.dimensions,400,'preview_raster_required');
      const plan=previewPlan(source.dimensions,request); if (plan.mode==='native') demand(codec.exactNativeRGBA===true,503,'NATIVE_RGBA_NOT_CONFIGURED');
      // Separate opt-in derivative; legacy JPEG covers and original downloads never change.
      if (plan.variant==='slice-alpha') demand(codec.sliceAlphaPNG===true,503,'SLICE_ALPHA_NOT_CONFIGURED');
      const sourceWidth=source.dimensions.width,sourceHeight=source.dimensions.height;
      pixelLease=pixels.acquire(sourceWidth*sourceHeight,signal);
      if(pixelLease.waiting) {
        // Do not pin a physical IO lane/FD while waiting for a decode reservation.
        await source.file.close();source=null;release();release=null;
        await pixelLease.ready;cancelled(signal);demand(!closing,503,'preview_closing');reauthorize();
        release=await nativeBudget.acquire({signal});source=await openVerifiedAsset(vault,asset,{signal});reauthorize();
        demand(source.dimensions?.width===sourceWidth && source.dimensions?.height===sourceHeight,409,'asset_integrity');
      } else await pixelLease.ready;
      cancelled(signal);demand(!closing,503,'preview_closing');
      const key=sha256(Buffer.from(JSON.stringify([asset.sha256,codec.identity,plan]),'utf8'));
      const existing=cache.get(key); if (existing) { cache.delete(key); cache.set(key,existing); return existing; }
      const base=await directory(); nonce=newId(); workDir=path.join(base,`work-${process.getuid?.() ?? 0}-${nonce}`); await mkdir(workDir,{mode:0o700});
      const output=path.join(workDir,'output.'+(plan.mime==='image/png'?'png':'jpg'));
      // Source FD stays open throughout render. /proc/self/fd is not inherited through shell.
      await codec.render({sourcePath:source.path,sourceFd:source.file.fd,sourceSha256:asset.sha256,sourceWidth:source.dimensions.width,sourceHeight:source.dimensions.height,outputPath:output,...plan,signal});
      reauthorize(); cancelled(signal);
      const st=await lstat(output); demand(st.isFile() && !st.isSymbolicLink() && st.size>0 && st.size<=maxEncodedBytes && await realpath(output)===output,422,'invalid_codec_output');
      const fh=await open(output,constants.O_RDONLY|constants.O_NOFOLLOW); let bytes;
      try { demand((await fh.stat()).size===st.size,422,'invalid_codec_output'); bytes=await fh.readFile(); } finally { await fh.close(); }
      demand(bytes.length<=maxEncodedBytes,413,'preview_encoded_budget'); const info=imageInfo(bytes,plan.mime,{complete:true}); demand(info.width===plan.width && info.height===plan.height,422,'codec_dimensions_mismatch');
      // Re-verify immutable input after codec IO, without decoding original pixels.
      const checked=await openVerifiedAsset(vault,asset,{signal}); await checked.file.close(); reauthorize();
      demand(cacheBytes+bytes.length<=maxCacheBytes,507,'preview_cache_budget');
      const hash=sha256(bytes), folder=path.join(base,hash.slice(0,2));
      try { await mkdir(folder,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
      const shard=await lstat(folder);
      demand(shard.isDirectory() && !shard.isSymbolicLink() && (shard.mode & 0o7777)===0o700 && (typeof process.getuid!=='function' || shard.uid===process.getuid()) && await realpath(folder)===folder,500,'unsafe_preview_cache');
      const target=path.join(folder,hash+(plan.mime==='image/png'?'.png':'.jpg')); const write=await open(output,constants.O_WRONLY|constants.O_NOFOLLOW); try { await write.chmod(0o600); await write.sync(); } finally { await write.close(); }
      // Both verified names are inside this independent cache; originals are never renamed.
      try { const old=await lstat(target); demand(old.isFile() && !old.isSymbolicLink(),500,'unsafe_preview_cache'); } catch(e) { if(e.code!=='ENOENT') throw e; }
      demand(path.dirname(output)===workDir && path.dirname(target)===folder,500,'unsafe_preview_cache'); await rename(output,target);
      const record={id:key,sha256:hash,mime:plan.mime,bytes:bytes.length,relativePath:hash.slice(0,2)+'/'+path.basename(target),width:plan.width,height:plan.height,sourceWidth:source.dimensions.width,sourceHeight:source.dimensions.height,sourceSha256:asset.sha256};
      demand(cacheBytes+record.bytes<=maxCacheBytes,507,'preview_cache_budget'); cache.set(key,record); cacheBytes+=record.bytes; return record;
    } finally {
      try { await source?.file.close(); } finally { try { if(workDir) await deleteOwnedTemporary(workDir,await directory(),nonce); } finally { pixelLease?.release(); release?.(); } }
    }
  }
  return {
    async get(asset,request,{signal,reauthorize=()=>{}}={}) {
      demand(!closing,503,'preview_closing'); const key=JSON.stringify([asset.sha256,request,codec?.identity || null]);
      for(let attempt=0;attempt<2;attempt++) {
        // Each caller, including a retry, authorizes independently before sharing work.
        demand(!closing,503,'preview_closing'); reauthorize(); cancelled(signal); let task=flights.get(key);
        if(!task) {
          task=physical(asset,request,reauthorize,signal); flights.set(key,task); flightOwners.set(task,signal); pending.add(task);
          task.finally(()=>{if(flights.get(key)===task)flights.delete(key);pending.delete(task);}).catch(()=>{});
        }
        let record;
        try { record=await task; }
        catch(cause) {
          // physical() settles only after its awaited FD/temp/lease finally completes.
          // Only another owner's cancellation may cause one fresh, still-deduplicated attempt.
          if(attempt!==0 || cause?.status!==499 || cause?.code!=='request_closed' || !flightOwners.get(task)?.aborted || signal?.aborted || closing) throw cause;
          continue;
        }
        reauthorize(); cancelled(signal); return record;
      }
    },
    async open(record,options={}) { return openVerifiedAsset({assetsDir:await directory()},record,{...options,maxBytes:maxEncodedBytes}); },
    diagnostics:()=>({inFlight:flights.size,workPixels:pixels.diagnostics().used,pixelQueued:pixels.diagnostics().queued,peakWorkPixels:pixels.diagnostics().peak,maxWorkPixels:pixels.diagnostics().capacity,maxPixelWaiting:16,cacheBytes,configured:!!codec,licenseStatus:'not-established-by-this-module',native:nativeBudget.diagnostics()}),
    async close() { closing=true;pixels.close(); await Promise.allSettled([...pending]); await codec?.close?.(); }
  };
}

export function installPreviews(ctx,{authorizeAsset}={}) {
  const store=createPreviewStore({vault:ctx.vault,cacheDir:ctx.previewCacheDir,codec:ctx.codec, ...(ctx.previewLimits || {})});
  const handle=async(req,res,{params,url,signal},request) => {
    checkQuery(url?.searchParams);const authorization=authorizeAsset(req,params.assetId),reauthorize=()=>authorizeAsset(req,params.assetId),receipts=receiptsFor(ctx.vault,ctx.clock || Date.now);let opened,receipt,release;
    try{
      const record=await store.get(authorization.asset,request,{signal,reauthorize});release=await nativeBudget.acquire({signal});opened=await store.open(record,{signal});reauthorize();
      const headers={'X-Heron-Preview-Width':record.width,'X-Heron-Preview-Height':record.height,'X-Heron-Source-Width':record.sourceWidth,'X-Heron-Source-Height':record.sourceHeight,'ETag':'"'+record.sha256+'"',...(request.mode==='native'?{'X-Heron-Tile-X':request.x,'X-Heron-Tile-Y':request.y,'X-Heron-Tile-Size':512}:{'X-Heron-Preview-Level':request.level})};
      if(req.method==='HEAD'){await opened.file.close();opened=null;release();release=null;res.writeHead(200,{'Content-Type':record.mime,'Content-Length':record.bytes,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers});res.end();return;}
      receipt=receipts.start(authorization.user.id);headers['X-Heron-Image-Request']=receipt;headers['X-Heron-Receipt-Id']=receipt;await sendOpenFile(req,res,opened,{mime:record.mime,signal,headers});
    }finally{try{await opened?.file.close();}finally{try{await finishReceipt(res,receipts,receipt);}finally{release?.();}}}
  };
  for(const method of ['GET','HEAD']) {
    ctx.route(method,/^\/api\/previews\/(?<assetId>[A-Za-z0-9_-]+)\/slice\/(?<level>64|256|1024|2048)\.png$/,(req,res,args)=>handle(req,res,args,{mode:'lod',variant:'slice-alpha',level:Number(args.params.level)}));
    ctx.route(method,/^\/api\/previews\/(?<assetId>[A-Za-z0-9_-]+)\/(?<level>64|256|1024|2048)\.jpg$/,(req,res,args)=>handle(req,res,args,{mode:'lod',level:Number(args.params.level)}));
    ctx.route(method,/^\/api\/previews\/(?<assetId>[A-Za-z0-9_-]+)\/native\/(?<x>\d+)_(?<y>\d+)\.png$/,(req,res,args)=>handle(req,res,args,{mode:'native',x:Number(args.params.x),y:Number(args.params.y)}));
  }
  return store;
}
