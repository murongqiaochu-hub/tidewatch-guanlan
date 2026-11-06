// Independent native codec bridge. No import of the previous raster codec or vips.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const lane = { active: 0, peak: 0, queue: [] };
function error(status, code) { return Object.assign(new Error(code), { status, httpStatus: status, code }); }
function requireValue(test, status, code) { if (!test) throw error(status, code); }
function cancelled(signal) { requireValue(!signal?.aborted, 499, 'request_closed'); }
function release() { lane.active--; pump(); }
function pump() { while (lane.active < 1 && lane.queue.length) { const task = lane.queue.shift(); task.signal?.removeEventListener('abort', task.abort); if (task.signal?.aborted || task.owner.closed) { task.reject(error(task.owner.closed ? 503 : 499, task.owner.closed ? 'codec_closing' : 'request_closed')); continue; } lane.active++; lane.peak = Math.max(lane.peak, lane.active); task.resolve(release); } }
function acquire(owner, signal) { cancelled(signal); requireValue(!owner.closed,503,'codec_closing'); requireValue(lane.queue.length < 32,503,'codec_queue_full'); return new Promise((resolve,reject) => { const task={owner,signal,resolve,reject}; task.abort=()=>{ const i=lane.queue.indexOf(task); if(i>=0){lane.queue.splice(i,1);reject(error(499,'request_closed'));} }; signal?.addEventListener('abort',task.abort,{once:true}); lane.queue.push(task); pump(); }); }
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && !value.split(/[\\/]/).includes('..') && path.resolve(value) === value; }
const libraries = ['libpng16.so.16','libjpeg.so.62','libwebp.so.7','libz.so.1'];

/** Explicit configuration only: createCodec() remains a 503 NOT_CONFIGURED codec.
 * binaryPath is the readable ELF produced by 原生编码器/build.mjs (mode0600).
 * The Linux system loader is used so no delivered file needs executable mode.
 * Source FD must be caller-opened O_RDONLY|O_NOFOLLOW and authorized; the caller
 * owns its lifetime and must recheck source SHA and access after render.
 */
export function createCodec({ binaryPath, libraryPath, loaderPath = '/lib64/ld-linux-x86-64.so.2', timeoutMs = 30_000, spawnProcess = spawn } = {}) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000,500,'invalid_codec_timeout');
  const owner={closed:false}, children=new Set(), pending=new Set(); let completed=0, spawned=0, physicallyClosed=0;
  let identity='heron-native-not-configured';
  if(binaryPath !== undefined){
    requireValue(absolute(binaryPath) && absolute(loaderPath),500,'invalid_codec_configuration'); libraryPath ||= path.join(path.dirname(binaryPath),'lib'); requireValue(absolute(libraryPath),500,'invalid_codec_configuration');
    // Deployment configuration may name an existing ancestor mount alias; final
    // binary/library entries themselves must never be symlinks or public files.
    requireValue(!lstatSync(binaryPath).isSymbolicLink() && !lstatSync(libraryPath).isSymbolicLink(),500,'unsafe_codec_binary');
    binaryPath=realpathSync(binaryPath); libraryPath=realpathSync(libraryPath);
    const hash=createHash('sha256');
    try { for(const file of [binaryPath,...libraries.map(lib=>path.join(libraryPath,lib))]) { const st=lstatSync(file);requireValue(st.isFile() && !st.isSymbolicLink() && realpathSync(file)===file && !(st.mode&0o077),500,'unsafe_codec_binary');hash.update(readFileSync(file)); } }
    catch(e){if(e.code==='unsafe_codec_binary')throw e;throw error(503,'codec_binary_unavailable');}
    identity='heron-native-1-rgba-samples-white-q82-bilinear-'+hash.digest('hex');
  }
  async function physical(job){
    requireValue(binaryPath,503,'NOT_CONFIGURED'); cancelled(job.signal);
    requireValue(Number.isSafeInteger(job.sourceFd) && job.sourceFd >= 0,500,'verified_source_fd_required');
    requireValue(absolute(job.outputPath),500,'invalid_codec_output_path');
    for(const key of ['sourceWidth','sourceHeight','width','height'])requireValue(Number.isSafeInteger(job[key])&&job[key]>0,400,'invalid_codec_dimensions');
    requireValue(job.sourceWidth*job.sourceHeight<=64_000_000,413,'source_pixel_budget');
    requireValue(job.mode==='lod'||job.mode==='native',400,'invalid_codec_mode');
    const sliceAlpha=job.variant==='slice-alpha';
    requireValue(job.variant===undefined||sliceAlpha,400,'invalid_codec_variant');
    requireValue(!sliceAlpha||(job.mode==='lod'&&job.mime==='image/png'),400,'invalid_codec_variant');
    if(job.mode==='lod'){requireValue([64,256,1024,2048].includes(job.level),400,'invalid_preview_level');const scale=Math.min(1,job.level/Math.max(job.sourceWidth,job.sourceHeight));requireValue(job.width===Math.max(1,Math.round(job.sourceWidth*scale))&&job.height===Math.max(1,Math.round(job.sourceHeight*scale)),400,'invalid_codec_dimensions');}
    else requireValue(Number.isSafeInteger(job.x)&&Number.isSafeInteger(job.y)&&job.x>=0&&job.y>=0&&job.x%512===0&&job.y%512===0&&job.x<job.sourceWidth&&job.y<job.sourceHeight&&job.width===Math.min(512,job.sourceWidth-job.x)&&job.height===Math.min(512,job.sourceHeight-job.y),400,'invalid_native_tile');
    const parent=path.dirname(job.outputPath), st=await lstat(parent);requireValue(st.isDirectory()&&!st.isSymbolicLink()&&!(st.mode&0o077)&&await realpath(parent)===parent,500,'unsafe_codec_output_directory');
    const source=await open(`/proc/self/fd/${job.sourceFd}`,constants.O_RDONLY);try{const info=await source.stat();requireValue(info.isFile()&&info.size>0&&info.size<=64*1024*1024,413,'source_byte_budget');}finally{await source.close();}
    const relinquish=await acquire(owner,job.signal);
    try {
      cancelled(job.signal); requireValue(!owner.closed,503,'codec_closing');
      await new Promise((resolve,reject)=>{
        const args=['--library-path',libraryPath,binaryPath,'--input-fd','3','--output',job.outputPath,'--mode',sliceAlpha?'slice-alpha':job.mode,'--width',String(job.width),'--height',String(job.height),'--source-width',String(job.sourceWidth),'--source-height',String(job.sourceHeight)];
        if(job.mode==='native')args.push('--x',String(job.x),'--y',String(job.y));
        let child; try { child=spawnProcess(loaderPath,args,{shell:false,windowsHide:true,cwd:parent,env:{LANG:'C',LC_ALL:'C',TZ:'UTC'},stdio:['ignore','ignore','pipe',job.sourceFd]}); } catch { reject(error(503,'codec_start_failed'));return; }
        children.add(child);spawned++;let failed,timeout=false,stderrBytes=0;
        const abort=()=>child.kill('SIGKILL'),timer=setTimeout(()=>{timeout=true;abort();},timeoutMs);
        job.signal?.addEventListener('abort',abort,{once:true});if(job.signal?.aborted)abort();
        child.stderr?.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>8192){failed=error(422,'codec_stderr_budget');abort();}});
        child.once('error',()=>{failed=error(503,'codec_start_failed');});
        child.once('close',code=>{clearTimeout(timer);job.signal?.removeEventListener('abort',abort);children.delete(child);physicallyClosed++;if(failed)reject(failed);else if(timeout)reject(error(504,'codec_timeout'));else if(job.signal?.aborted)reject(error(499,'request_closed'));else if(owner.closed)reject(error(503,'codec_closing'));else if(code!==0)reject(error(422,'codec_failed'));else{completed++;resolve();}});
      });
    } finally { relinquish(); }
  }
  return {
    identity, exactNativeRGBA:true, sliceAlphaPNG:Boolean(binaryPath),
    render(job){const task=physical(job);pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;},
    diagnostics:()=>({configured:!!binaryPath,identity,active:children.size,globalActive:lane.active,globalPeak:lane.peak,queued:lane.queue.length,spawned,physicallyClosed,completed,licenseStatus:'third-party-notices-provided-not-legal-clearance',semantics:'unmanaged-source-samples; native PNG preserves 8/16-bit; JPEG alpha white; slice-alpha RGBA8 premultiplied bilinear PNG; EXIF not rotated'}),
    async close(){owner.closed=true;for(const task of [...lane.queue])if(task.owner===owner){task.signal?.removeEventListener('abort',task.abort);lane.queue.splice(lane.queue.indexOf(task),1);task.reject(error(503,'codec_closing'));}for(const child of children)child.kill('SIGKILL');await Promise.allSettled([...pending]);}
  };
}
