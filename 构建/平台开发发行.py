#!/usr/bin/env python3
"""Deterministic DEVELOPMENT packaging for the independently implemented platform.
Not a commercial-rights certificate. Never packages data, credentials or directory scans.
"""
import argparse, hashlib, json, os, pathlib, stat, subprocess, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_IMAGE = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
LEGACY_SHA = 'ff7895c26d46b4af56171d2b8d2bc6a934102c66dff5cb9a26ba6f96b44ea12f'
PLATFORM = ['仓库','认证','权限','账户项目','发布','资源','切图','预览','下载','服务','项目数据','网页','启动','编码器适配','插件发行']
WEB = ['app.mjs','base.css','画布.mjs']
ADDITIONAL_TESTS = ['暗色精简','平台仓库','平台认证权限','平台账户项目','平台发布','平台资源切图','平台预览','平台生产协议HTTP','独立平台整合','独立原生预览HTTP','独立编码器','构建独立平台','平台暗色网页','独立平台队列','插件公开来源绑定','独立平台启动','平台系统锁','视觉工作台','视觉标注器','插件视觉','项目交互改进','蓝湖式标注界面','标注器无技术噪声','门户插件无技术噪声','右栏有效属性','插件portableSHA256','插件发行防回归','插件发行读取','插件内网HTTP','插件编译启动生命周期','画板目录缩略图','预览取消共享','插件坐标续版','插件项目与目录交互','跨文件目录与历史切图','项目坐标发布v2','项目分组','设计倍数与排布','插件建项目权限']
ADDITIONAL_RECORDS = ['暗色精简来源','平台内核来源','平台发布资源来源','独立编码器来源','平台暗色网页来源','平台整合来源','插件公开SDK来源','视觉重构来源','蓝湖式交互来源','全界面去噪来源','右栏有效属性来源']
NATIVE_FILES = ['codec.c','build.mjs','CMakeLists.txt','Dockerfile','dependencies.lock.json','SBOM.cdx.json','THIRD_PARTY_NOTICES.md']

def digest(data): return hashlib.sha256(data).hexdigest()
def valid_name(name):
    p = pathlib.PurePosixPath(name)
    return name and not p.is_absolute() and '..' not in p.parts and '.' not in p.parts and '\\' not in name and str(p) == name

def read_source(name):
    if not valid_name(name): raise ValueError('Unsafe allowlist name')
    p = ROOT / name
    for item in [p, *p.parents]:
        if item == ROOT: break
        if item.is_symlink(): raise ValueError('Source symlink denied: ' + name)
    if p.resolve() != p or not p.is_file(): raise ValueError('Not exact regular source: ' + name)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'rb') as f: return f.read()
    except BaseException: raise

def system_locked_inputs(name):
    if not valid_name(name) or pathlib.PurePosixPath(name).parent.as_posix()!='系统第三方': raise ValueError('System lock must be an explicit portable source-root name')
    raw=read_source(name); lock=json.loads(raw)
    if lock.get('baseImage')!=BASE_IMAGE: raise ValueError('System source lock does not match pinned Node base')
    artifacts=lock.get('artifacts'); required=lock.get('requiredInputs',[])
    if not isinstance(artifacts,list) or not artifacts or len(artifacts)>4096 or not isinstance(required,list) or len(required)>128: raise ValueError('Invalid system locked input list')
    names={name}; seen=set()
    for item,reused in [*( (item,False) for item in artifacts ),*( (item,True) for item in required )]:
        path_name=item.get('path') if isinstance(item,dict) else None
        if not isinstance(path_name,str) or not valid_name(path_name): raise ValueError('Unsafe system artifact name')
        if reused:
            if not path_name.startswith(('原生编码器/第三方源码/','原生编码器/第三方许可/')) and path_name!='原生编码器/dependencies.lock.json': raise ValueError('System source reuse cannot expose private application code')
            full=path_name
        else: full='系统第三方/'+path_name
        if full in seen: raise ValueError('Duplicate system locked input')
        seen.add(full);data=read_source(full)
        if type(item.get('bytes')) is not int or item['bytes']<0 or len(data)!=item['bytes'] or digest(data)!=item.get('sha256'): raise ValueError('System locked artifact mismatch: '+full)
        names.add(full)
    names.add('来源记录/系统第三方来源.md')
    return names,{'lockPath':name,'lockSHA256':digest(raw),'artifacts':len(artifacts),'reusedInputs':len(required),'coverage':lock.get('coverage'),'baseImage':BASE_IMAGE,'legalClearance':False}

def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    parent = path.parent.resolve()
    if parent != path.parent or path.is_symlink(): raise ValueError('Unsafe output path')
    os.chmod(parent, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f: os.fchmod(f.fileno(),0o600); f.write(data); f.flush(); os.fsync(f.fileno())

def file_digest(source):
    h=hashlib.sha256();fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('Expected regular input')
        for block in iter(lambda:f.read(65536),b''): h.update(block)
    return h.hexdigest()

def copy_private_file(target,source):
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.parent.resolve()!=target.parent or target.is_symlink(): raise ValueError('Unsafe output path')
    os.chmod(target.parent,0o700)
    source_fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(source_fd,'rb') as src:
        if not stat.S_ISREG(os.fstat(src.fileno()).st_mode): raise ValueError('Expected regular input')
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            os.fchmod(out.fileno(),0o600)
            for block in iter(lambda:src.read(65536),b''): out.write(block)
            out.flush();os.fsync(out.fileno())
    return file_digest(target)

def zip_bytes(target, entries):
    fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,0o600)
    with os.fdopen(fd, 'w+b') as handle:
        os.fchmod(handle.fileno(),0o600)
        with zipfile.ZipFile(handle,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=False) as archive:
            for name,data in sorted(entries.items()):
                if not valid_name(name): raise ValueError('Unsafe ZIP name')
                info=zipfile.ZipInfo(name,(1980,1,1,0,0,0)); info.create_system=3; info.external_attr=(stat.S_IFREG|0o600)<<16; info.compress_type=zipfile.ZIP_DEFLATED
                archive.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
        handle.flush(); os.fsync(handle.fileno())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None: raise ValueError('Produced CRC failure')
    return file_digest(target)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True)
    parser.add_argument('--service-origin',required=True)
    parser.add_argument('--plugin-release',required=True,help='Explicit public release label, e.g. C10')
    parser.add_argument('--release-date',required=True,help='Explicit reproducible YYYY-MM-DD release date')
    identity=parser.add_mutually_exclusive_group(required=True)
    identity.add_argument('--plugin-id'); identity.add_argument('--local-plugin-id')
    parser.add_argument('--legacy-source-archive',required=True)
    parser.add_argument('--system-lock',help='Explicit portable 系统第三方/*.json lock for audited OS/Node materials')
    args=parser.parse_args()
    output=pathlib.Path(args.output)
    if not output.is_absolute() or output.parent.resolve()!=output.parent or output.exists(): raise ValueError('Use fresh absolute output under a canonical existing parent')
    legacy=pathlib.Path(args.legacy_source_archive)
    if not legacy.is_absolute() or legacy.is_symlink() or not legacy.is_file(): raise ValueError('Explicit historical source archive required')
    legacy_data=legacy.read_bytes()
    if digest(legacy_data)!=LEGACY_SHA: raise ValueError('Historical AGPL source must match preserved verified archive')
    baseline_name='来源记录/历史独立源基线.json' if (ROOT/'来源记录/历史独立源基线.json').is_file() else 'SourceParams.json'
    baseline_bytes=read_source(baseline_name)
    baseline=json.loads(baseline_bytes)
    names=set(baseline['allowedFileHashes'])
    if len(names)!=65: raise ValueError('Expected frozen 65-file provenance baseline')
    names.update('平台/'+n+'.mjs' for n in PLATFORM)
    names.update('界面/'+n for n in WEB)
    names.update('测试/'+n+'.test.mjs' for n in ADDITIONAL_TESTS)
    names.update('来源记录/'+n+'.md' for n in ADDITIONAL_RECORDS)
    names.update(['构建/生成独立插件.mjs','构建/打包交付插件.mjs','构建/平台开发发行.py','平台/README.md','插件/portable-sha256.mjs','测试/插件发行测试工具.mjs','测试/夹具/上线基线插件.html','测试/夹具/视觉基线源哈希.json'])
    names.update('原生编码器/'+n for n in NATIVE_FILES)
    system_info=None
    if args.system_lock:
        system_names,system_info=system_locked_inputs(args.system_lock); names.update(system_names)
    lock=json.loads(read_source('原生编码器/dependencies.lock.json'))
    for artifact in lock['artifacts']:
        name='原生编码器/'+artifact['path']; data=read_source(name)
        if len(data)!=artifact['bytes'] or digest(data)!=artifact['sha256']: raise ValueError('Native locked artifact mismatch: '+name)
        names.add(name)
    # License texts are an explicitly bounded directory; no recursive scan or data roots.
    for p in (ROOT/'原生编码器/第三方许可').iterdir():
        if not p.is_file() or p.is_symlink(): raise ValueError('Unexpected license entry')
        names.add(p.relative_to(ROOT).as_posix())
    runtime_native=['原生编码器/运行时/heron-codec', *['原生编码器/运行时/lib/'+name for name in ['libpng16.so.16','libjpeg.so.62','libwebp.so.7','libz.so.1']]]
    names.update(runtime_native)
    # A new regression must never silently disappear from the complete offline release.
    # Inspect names only; do not auto-include unreviewed files outside the explicit allowlist.
    required_tests={p.relative_to(ROOT).as_posix() for p in (ROOT/'测试').iterdir() if p.name.endswith('.test.mjs') and p.is_file()}
    if required_tests-names: raise ValueError('Tests missing from release allowlist: '+', '.join(sorted(required_tests-names)))
    sources={name:read_source(name) for name in sorted(names)}
    if digest(sources[runtime_native[0]])!='879f4313a7e652777ef1ea9c4778182a237783d8c6b7c98c1864daca640ef7ce': raise ValueError('Unexpected native CLI')
    output.mkdir(mode=0o700); os.chmod(output,0o700)
    plugin_args=['node',str(ROOT/'构建/生成独立插件.mjs'),'--service-origin',args.service_origin,'--output',str(output/'插件')]
    plugin_args += ['--plugin-id',args.plugin_id] if args.plugin_id else ['--local-plugin-id',args.local_plugin_id]
    subprocess.run(plugin_args,check=True,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    package_args=['node',str(ROOT/'构建/打包交付插件.mjs'),'--directory',str(output/'插件'),'--output',str(output/'独立平台开发插件.zip'),'--service-origin',args.service_origin,'--release',args.plugin_release,'--date',args.release_date]
    packaged=subprocess.run(package_args,check=True,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    plugin_release_info=json.loads(packaged.stdout)
    plugin_sha=file_digest(output/'独立平台开发插件.zip')
    if plugin_sha!=plugin_release_info['sha256']: raise ValueError('Plugin release byte mismatch')
    input_hashes={name:digest(data) for name,data in sources.items()}
    declaration={'schemaVersion':1,'runtimeKind':'independent-platform','developmentOnly':True,'commercialLicenseCleared':False,'registeredPluginIdentityVerified':False,'privatePluginAPIEnabled':False,'legacyAGPLRightsRetained':True,'nativeGlibcCorrespondingSourceVersion':'2.36-9+deb12u14','legacySourceSHA256':LEGACY_SHA,'sourceInputHashes':input_hashes,'systemThirdParty':system_info,'baselineSourceParamsHistoricalOnly':True,'nativeCodecELFSHA256':digest(sources[runtime_native[0]]),'publicSourceArchiveScope':'OFFLINE_EVIDENCE_ONLY_NOT_RUNTIME_HTTP','pluginRelease':plugin_release_info,'sourceDateEpoch':315532800}
    sources['来源记录/历史独立源基线.json']=baseline_bytes
    sources['历史版本/20261015_AGPL对应源码.zip']=legacy_data
    sources['BuildParams.json']=(json.dumps(declaration,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
    source_sha=zip_bytes(output/'独立平台完整开发源码.zip',sources)
    third={name:data for name,data in sources.items() if name.startswith('系统第三方/') or name.startswith('原生编码器/第三方源码/') or name.startswith('原生编码器/第三方许可/') or name in ['原生编码器/SBOM.cdx.json','原生编码器/THIRD_PARTY_NOTICES.md','原生编码器/dependencies.lock.json']}
    third_sha=zip_bytes(output/'第三方源码与许可.zip',third)
    context=output/'容器上下文'; context.mkdir(mode=0o700); os.chmod(context,0o700)
    runtime_names=['package.json', *['平台/'+name+'.mjs' for name in PLATFORM], *['界面/'+name for name in WEB], *['查看器/'+name for name in ['index.mjs','core.mjs','resources.mjs','inspector.css']], '宿主/production-adapter.mjs','宿主/production-shell.css','宿主/stored-zip.mjs',*runtime_native,'原生编码器/SBOM.cdx.json','原生编码器/THIRD_PARTY_NOTICES.md']
    runtime_hashes={}
    for name in runtime_names:
        data=sources[name];dest='应用/'+name;write_private(context/dest,data);runtime_hashes[dest]=digest(data)
    dest='应用/downloads/plugin.zip';runtime_hashes[dest]=copy_private_file(context/dest,output/'独立平台开发插件.zip')
    dockerfile=(f'FROM {BASE_IMAGE}\nWORKDIR /app\nCOPY --chown=1000:1001 ["应用/", "/app/"]\nENV NODE_ENV=production TZ=Asia/Shanghai HOST=0.0.0.0 PORT=4318 HANDOFF_DATA_DIR=/data HANDOFF_CODEC_BINARY=/app/原生编码器/运行时/heron-codec HANDOFF_PLUGIN_ARCHIVE=/app/downloads/plugin.zip\nUSER 1000:1001\nEXPOSE 4318\nHEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 CMD ["node","-e","fetch(\'http://127.0.0.1:4318/api/health\').then(r=>{{if(!r.ok)process.exit(1)}}).catch(()=>process.exit(1))"]\nCMD ["node","平台/启动.mjs"]\n').encode()
    write_private(context/'Dockerfile',dockerfile);runtime_hashes['Dockerfile']=digest(dockerfile)
    # Refuse a release if any source changed while compiling/packing.
    for name,expected in input_hashes.items():
        if digest(read_source(name))!=expected: raise ValueError('Source changed during build: '+name)
    result={**declaration,'pluginSHA256':plugin_sha,'privateSourceSHA256':source_sha,'thirdPartySourceSHA256':third_sha,'sourceEntries':len(sources),'runtimeFileHashes':runtime_hashes,'privateDevelopmentSourceZipIncludedInHTTPDownloads':False,'runtimeIncludesPlaintextApplicationModules':True}
    write_private(output/'01_独立平台开发构建清单.json',(json.dumps(result,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode())
    print(json.dumps({'status':'DEVELOPMENT_BUILD_ONLY','sourceEntries':len(sources),'privateSourceSHA256':source_sha,'pluginSHA256':plugin_sha,'thirdPartySourceSHA256':third_sha,'commercialLicenseCleared':False},ensure_ascii=False))
if __name__=='__main__': main()
