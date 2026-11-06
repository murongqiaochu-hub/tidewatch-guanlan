// Offline artifact reconstruction from the checked-in, SHA256-locked Debian payloads.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, chmod, readdir, lstat, realpath, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const lock=JSON.parse(await readFile(path.join(root,'dependencies.lock.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function run(binary,args){await new Promise((resolve,reject)=>{const child=spawn(binary,args,{shell:false,cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',SOURCE_DATE_EPOCH:'1792012800'},stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`build child exit ${code}`)));});}
for(const artifact of lock.artifacts){const file=path.join(root,artifact.path);if(path.dirname(file)!==path.join(root,'依赖包')&&path.dirname(file)!==path.join(root,'第三方源码'))throw Error('unsafe locked path');const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||await realpath(file)!==file)throw Error('unsafe artifact');const data=await readFile(file);if(data.length!==artifact.bytes||hash(data)!==artifact.sha256)throw Error(`locked artifact hash mismatch: ${artifact.path}`);}
const headers=path.join(root,'构建头文件'),runtime=path.join(root,'运行时'),libs=path.join(runtime,'lib');for(const d of[headers,runtime,libs]){await mkdir(d,{recursive:true,mode:0o700});await chmod(d,0o700);if(await realpath(d)!==d||(await lstat(d)).isSymbolicLink())throw Error('unsafe build directory');}
for(const artifact of lock.artifacts.filter(a=>a.path.endsWith('.deb')))await run('/usr/bin/dpkg-deb',['-x',path.join(root,artifact.path),headers]);
for(const lib of lock.runtimeLibraries){const prefix=lib==='libz.so.1'?'lib/x86_64-linux-gnu':'usr/lib/x86_64-linux-gnu';await copyFile(path.join(headers,prefix,lib),path.join(libs,lib));await chmod(path.join(libs,lib),0o600);}
const output=path.join(runtime,'heron-codec');await run('/usr/bin/cc',['-std=c11','-O2','-Wall','-Wextra','-Wno-misleading-indentation','-Wno-sign-compare','-fstack-protector-strong','-D_FORTIFY_SOURCE=2',`-I${headers}/usr/include`,`-I${headers}/usr/include/x86_64-linux-gnu`,path.join(root,'codec.c'),`-L${libs}`,'-Wl,-z,relro,-z,now','-l:libpng16.so.16','-l:libjpeg.so.62','-l:libwebp.so.7','-lm','-o',output]);await chmod(output,0o600);
async function modes(dir){await chmod(dir,0o700);for(const e of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await modes(file);else if(e.isFile())await chmod(file,0o600);}}
await modes(headers);await run('/lib64/ld-linux-x86-64.so.2',['--library-path',libs,output,'--version']);console.log(JSON.stringify({binarySha256:hash(await readFile(output)),compiler:'cc',lockArtifacts:lock.artifacts.length,network:false}));
