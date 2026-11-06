// Owned temporary files only. Reproduces source-file races, not a live user directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { packageStandalonePlugin } from '../构建/打包交付插件.mjs';
import { inspectPluginRelease } from '../平台/插件发行.mjs';
import { SYNTHETIC_ORIGIN } from './插件发行测试工具.mjs';
import { syntheticPluginFiles } from './插件发行测试工具.mjs';
async function own(t){const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'heron-release-test-')),marker=randomBytes(16).toString('hex');assert.equal(await fs.realpath(root),root);await fs.chmod(root,0o700);await fs.writeFile(path.join(root,'OWNER'),marker,{flag:'wx',mode:0o600});const directory=path.join(root,'input');await fs.mkdir(directory,{mode:0o700});for(const [name,bytes]of Object.entries(syntheticPluginFiles()))await fs.writeFile(path.join(directory,name),bytes,{flag:'wx',mode:0o600});t.after(async()=>{assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^heron-release-test-/);assert.equal(await fs.readFile(path.join(root,'OWNER'),'utf8'),marker);await fs.rm(root,{recursive:true,force:false});});return {root,directory,output:path.join(root,'release.zip'),serviceOrigin:SYNTHETIC_ORIGIN,release:'C10',date:'2026-10-20'};}
test('PLUGIN RELEASE source packer writes a verified fresh archive and refuses overwrite',async t=>{const p=await own(t),info=await packageStandalonePlugin(p),bytes=await fs.readFile(p.output);assert.equal(info.sha256,inspectPluginRelease(bytes).sha256);assert.equal((await fs.stat(p.output)).mode&0o777,0o600);await assert.rejects(packageStandalonePlugin(p),{code:'EEXIST'});});
for(const kind of ['symlink','inode','growth'])test('PLUGIN RELEASE source packer rejects '+kind+' race using its pinned bounded FD',async t=>{
 const p=await own(t),target=path.join(p.directory,'main.js'),replacement=path.join(p.root,'replacement.js'),original=fs.open,bytes=await fs.readFile(target);await fs.writeFile(replacement,bytes,{flag:'wx',mode:0o600});let changed=false,readBytes=0,closed=false;
 const mock=t.mock.method(fs,'open',async function(file,flags,...rest){
  if(file===target&&!changed){changed=true;assert.equal(await fs.realpath(target),target);assert.equal(await fs.realpath(replacement),replacement);assert.equal(path.dirname(target),p.directory);assert.equal(path.dirname(replacement),p.root);assert.ok(flags&constants.O_NOFOLLOW);
   if(kind==='symlink'){const backup=target+'.old';assert.equal(path.dirname(backup),p.directory);await assert.rejects(fs.lstat(backup),{code:'ENOENT'});await fs.rename(target,backup);await fs.symlink(replacement,target);}
   if(kind==='inode')await fs.rename(replacement,target);
  }
  const handle=await original.call(this,file,flags,...rest);
  if(file===target){const read=handle.read.bind(handle),close=handle.close.bind(handle);handle.close=async()=>{await close();closed=true;};handle.read=async(...args)=>{const next=await read(...args);readBytes+=next.bytesRead;if(kind==='growth'&&readBytes===next.bytesRead){assert.equal(await fs.realpath(target),target);await fs.appendFile(target,Buffer.alloc(3*1024*1024));}return next;};}
  return handle;
 });
 try{await assert.rejects(packageStandalonePlugin(p));assert.equal(changed,true);assert.ok(readBytes<=bytes.length);if(kind!=='symlink')assert.equal(closed,true);await assert.rejects(fs.lstat(p.output),{code:'ENOENT'});}finally{mock.mock.restore();}
});
test('PLUGIN RELEASE source packer refuses oversized input before opening/allocating it',async t=>{const p=await own(t),target=path.join(p.directory,'main.js');await fs.readFile(target);await fs.writeFile(target,Buffer.alloc(2*1024*1024+1));let opened=false;const original=fs.open,mock=t.mock.method(fs,'open',async function(file,...args){if(file===target)opened=true;return original.call(this,file,...args);});try{await assert.rejects(packageStandalonePlugin(p));assert.equal(opened,false);}finally{mock.mock.restore();}});
