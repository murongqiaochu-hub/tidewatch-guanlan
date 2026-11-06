// Actual Python packer/FS boundary cases; no downloads, Docker or production inputs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const packer=fileURLToPath(new URL('../构建/平台开发发行.py',import.meta.url))
test('[REAL PYTHON/FS] system lock validates explicit source, native reuse, integrity and private-code exclusion',()=>{
const program=String.raw`
import pathlib,tempfile,json,hashlib,importlib.util,os
spec=importlib.util.spec_from_file_location('packer',__import__('sys').argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='owned-system-lock-') as directory:
 root=pathlib.Path(directory).resolve();m.ROOT=root
 def write(name,data):
  p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return p
 def row(name,data):return {'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 write('系统第三方/notice.txt',b'own fixture notice');write('原生编码器/第三方源码/shared.orig.tar.xz',b'own fixture source');write('来源记录/系统第三方来源.md',b'own fixture record')
 base={'baseImage':m.BASE_IMAGE,'coverage':'TEST_FIXTURE_NOT_RELEASE','artifacts':[row('notice.txt',b'own fixture notice')],'requiredInputs':[row('原生编码器/第三方源码/shared.orig.tar.xz',b'own fixture source')]}
 def run(value):write('系统第三方/lock.json',json.dumps(value).encode());return m.system_locked_inputs('系统第三方/lock.json')
 names,info=run(base);assert '系统第三方/notice.txt' in names and '原生编码器/第三方源码/shared.orig.tar.xz' in names;assert info['legalClearance'] is False;checks=1
 write('原生编码器/dependencies.lock.json',b'{}');native_names,_=run({**base,'requiredInputs':[*base['requiredInputs'],row('原生编码器/dependencies.lock.json',b'{}')]});assert '原生编码器/dependencies.lock.json' in native_names;checks+=1
 def rejects(value):
  try:run(value)
  except ValueError:return
  raise AssertionError('Expected locked-input rejection')
 rejects({**base,'baseImage':'node@sha256:wrong'});checks+=1
 rejects({**base,'artifacts':[row('../平台/服务.mjs',b'never read')]});checks+=1
 rejects({**base,'requiredInputs':[row('平台/服务.mjs',b'never read')]});checks+=1
 rejects({**base,'artifacts':[{**base['artifacts'][0],'bytes':999}]});checks+=1
 rejects({**base,'artifacts':[base['artifacts'][0],base['artifacts'][0]]});checks+=1
 write('outside.txt',b'own fixture outside');os.symlink(root/'outside.txt',root/'系统第三方/link.txt');rejects({**base,'artifacts':[row('link.txt',b'own fixture outside')]});checks+=1
 try:m.system_locked_inputs('../lock.json')
 except ValueError:checks+=1
 else:raise AssertionError('Expected unsafe lock-name rejection')
 assert checks==9;print(json.dumps({'checks':checks,'privateCodeExposed':False,'networkUsed':False}))
`
const r=spawnSync('python3',['-B','-c',program,packer],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr||r.error?.message);const result=JSON.parse(r.stdout);assert.equal(result.checks,9);assert.equal(result.privateCodeExposed,false);assert.equal(result.networkUsed,false)
})
