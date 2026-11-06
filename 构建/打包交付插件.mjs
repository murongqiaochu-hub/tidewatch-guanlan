// Explicit release assembly. Fresh destination only; the served package is validated again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packagePluginRelease, inspectPluginRelease } from '../平台/插件发行.mjs';
export async function packageStandalonePlugin({directory,output,serviceOrigin,serviceMode,release,date}={}){
 if(!path.isAbsolute(directory||'')||!path.isAbsolute(output||''))throw new TypeError('Explicit absolute source/output required');
 if(await fs.realpath(directory)!==directory||!(await fs.lstat(directory)).isDirectory())throw new TypeError('Canonical source required');
 if(await fs.realpath(path.dirname(output))!==path.dirname(output))throw new TypeError('Canonical output parent required');
 const files={};for(const name of ['main.js','ui.html','manifest.json']){
  const p=path.join(directory,name),stat=await fs.lstat(p,{bigint:true});
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2n*1024n*1024n||await fs.realpath(p)!==p||typeof constants.O_NOFOLLOW!=='number')throw new TypeError('Regular bounded plugin source required');
  const handle=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=await handle.stat({bigint:true});if(!before.isFile()||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size||before.mtimeNs!==stat.mtimeNs)throw new TypeError('Plugin source changed');
   const bytes=Buffer.alloc(Number(before.size));let position=0;
   while(position<bytes.length){const next=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position);if(!next.bytesRead)throw new TypeError('Plugin source changed');position+=next.bytesRead;}
   const after=await handle.stat({bigint:true});if(after.size!==before.size||after.mtimeNs!==before.mtimeNs)throw new TypeError('Plugin source changed');files[name]=bytes;
  }finally{await handle.close();}
 }
 const bytes=packagePluginRelease(files,{serviceOrigin,serviceMode,release,date}),info=inspectPluginRelease(bytes,{serviceOrigin,serviceMode});
 const handle=await fs.open(output,'wx',0o600);try{await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 return {release:info.release,date:info.date,filename:info.filename,bytes:info.bytes,sha256:info.sha256,serviceOrigin:info.serviceOrigin,...(info.serviceMode?{serviceMode:info.serviceMode}:{})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={},keys={'--directory':'directory','--output':'output','--service-origin':'serviceOrigin','--service-mode':'serviceMode','--release':'release','--date':'date'};
 for(let i=0;i<args.length;i++){const key=keys[args[i]];if(!key||!args[i+1]||Object.hasOwn(options,key))throw new TypeError('Explicit unique packaging arguments required');options[key]=args[++i];}
 if(!['directory','output','release','date'].every(key=>typeof options[key]==='string') || (options.serviceMode!=='custom-https' && typeof options.serviceOrigin!=='string'))throw new TypeError('All release parameters required');
 console.log(JSON.stringify(await packageStandalonePlugin(options)));
}
