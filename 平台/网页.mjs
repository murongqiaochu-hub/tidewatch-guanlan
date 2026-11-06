// New independent page shells: all user-visible data is escaped or JSON-escaped.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { inspectPluginRelease, readStoredPluginZIP, MAX_PLUGIN_ARCHIVE_BYTES, DEFAULT_PLUGIN_ORIGIN } from './插件发行.mjs'
import { BRAND } from '../品牌/identity.mjs'
import { brandMarkSVG, faviconDataURI } from '../品牌/guanlan-logo.mjs'
const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
const safeID=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value)
export function safeLocalNext(value,fallback='/projects'){
  if(typeof value!=='string')return fallback
  let decoded=value
  for(let i=0;i<4;i++){if(!decoded.startsWith('/')||decoded.startsWith('//')||/[\u0000-\u0020\u007f\\]/.test(decoded))return fallback;let next;try{next=decodeURIComponent(decoded)}catch{return fallback}if(next===decoded)return value;decoded=next}
  return fallback
}
export function installWebPages(ctx){
  const {route,vault,auth,permissions,error}=ctx
  function shell(req,res,boot,status=200){
    const nonce=crypto.randomBytes(18).toString('base64'),actor=boot.user
    boot={...boot,user:actor?{id:actor.id,username:actor.username,role:actor.role,status:actor.status,ownerId:actor.ownerId??null,displayName:actor.displayName||'',createdAt:actor.createdAt??null}:null,artifacts:{pluginArchive:Boolean(ctx.artifacts?.pluginArchive)}};const user=boot.user
    // Presentation provenance: 01_设计方向与实施合同 / archived Taste Scan→Diagnose→Fix; handlers below stay byte-identical.
    const icon=path=>`<svg class="ui-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`
    const brand=brandMarkSVG({variant:'reverse',size:30,className:'brand-symbol'}),favicon=faviconDataURI()
    const brandLink=(ariaLabel,product,subtitle)=>`<a class="brand" href="/projects" aria-label="${html(ariaLabel)}">${brand}<span>${html(product)}<small>${html(subtitle)}</small></span></a>`
    const brandBar=brandLink(BRAND.pluginName,BRAND.product,BRAND.subtitle),canvasPage=boot.page==='canvas',workspace=Boolean(user)&&!canvasPage
    const current=page=>boot.page===page?' aria-current="page"':'',pageTitle=({projects:'项目',accounts:'账户',invites:'邀请',slices:'切图库',invite:'项目邀请'})[boot.page]||'工作空间'
    const initial=boot.page==='error'?`<section class="error-page card" role="alert"><h1>${html(status)} · 无法打开此页面</h1><p>${html(({401:'登录已失效，请重新登录。',403:'你没有访问此页面的权限，请联系项目管理员。',404:'页面不存在或已被移除，请返回项目列表重新打开。',410:'此链接已失效，请联系分享人获取新邀请。',429:'操作过于频繁，请稍后重试。'})[status]||'页面暂时无法打开，请稍后重试，或返回项目列表。')}</p><div class="actions"><a class="button" href="/projects">项目列表</a><a class="button" href="/login">登录</a></div></section>`:'<div class="page-loading" role="status"><span class="loading-line"></span><p class="muted">正在读取工作空间…</p></div>'
    const navigation=workspace?`<aside id="workspace-nav" class="workspace-nav" aria-label="工作空间"><div class="nav-brand">${brandBar}<button type="button" id="nav-close" class="icon-button quiet mobile-only" aria-label="关闭导航">${icon('M5 5l10 10M15 5L5 15')}</button></div><div class="nav-section-label">工作空间</div><nav class="workspace-links" aria-label="主导航"><a href="/projects"${current('projects')}>${icon('M3 6h5l2-2h7v12H3z')}<span>项目</span></a><a href="/accounts"${current('accounts')}>${icon('M12.5 6.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M4 16v-1a6 6 0 0 1 12 0v1')}<span>账户</span></a>${['admin','designer'].includes(user.role)?`<a href="/invites"${current('invites')}>${icon('M3 5h14v10H3zM3 5l7 6 7-6')}<span>邀请</span></a>`:''}</nav><div class="nav-bottom"><div class="nav-account"><div><strong title="${html(user.displayName||user.username)}">${html(user.displayName||user.username)}</strong><small>${html(({admin:'管理员',designer:'设计师',developer:'开发者'})[user.role]||user.role)}</small></div><button type="button" id="logout" class="quiet" aria-label="退出登录">退出</button></div></div></aside><button type="button" id="nav-scrim" class="nav-scrim" hidden aria-label="关闭导航"></button><header class="workspace-mobile"><button type="button" id="nav-toggle" class="quiet icon-button" aria-label="打开导航" aria-controls="workspace-nav" aria-expanded="false">${icon('M3 5h14M3 10h14M3 15h14')}</button><strong>${pageTitle}</strong></header>`:canvasPage?'':`<header class="auth-header">${brandBar}</header>`
    const body=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${html(pageTitle)} · ${html(BRAND.product)}</title><link rel="icon" href="${favicon}"><link rel="stylesheet" href="/ui/base.css"></head><body class="${workspace?'workspace-shell':canvasPage?'canvas-shell':'auth-shell'}" data-page="${html(boot.page)}"><a class="skip-link" href="#app">跳至内容</a>${navigation}<main id="app" tabindex="-1" aria-live="polite" aria-label="${html(pageTitle)}">${initial}</main><script type="application/json" id="app-context" nonce="${nonce}">${json(boot)}</script><script type="module" src="/ui/app.mjs" nonce="${nonce}"></script></body></html>`
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`});res.end(body)
  }
  // Installed after the core routes: the core validates the invite before calling this hook.
  ctx.renderInvitePage=(req,res,{token,invite,user})=>shell(req,res,{page:'invite',token,invite,user:user??null})
  ctx.renderErrorPage=(req,res,{status,code,message})=>{const safeStatus=Number.isInteger(status)&&status>=400&&status<=599?status:500;return shell(req,res,{page:'error',user:null,status:safeStatus,code:typeof code==='string'?code:'request_failed',message:typeof message==='string'?message:'页面暂时无法打开'},safeStatus)}
  function actor(req,res){try{return auth.actor(req)}catch(cause){if(cause.status!==401)throw cause;res.writeHead(302,{Location:'/login?next='+encodeURIComponent(safeLocalNext(req.url)),'Cache-Control':'no-store'});res.end();return null}}
  route('GET',/^\/$/,(req,res)=>{const user=auth.actor(req,{required:false});res.writeHead(302,{Location:user?'/projects':'/login','Cache-Control':'no-store'});res.end()},{public:true})
  route('GET',/^\/login$/,(req,res,{url})=>shell(req,res,{page:'login',user:null,next:safeLocalNext(url.searchParams.get('next'))}),{public:true})
  route('GET',/^\/projects$/,(req,res)=>{const user=actor(req,res);if(user)shell(req,res,{page:'projects',user})})
  route('GET',/^\/accounts$/,(req,res)=>{const user=actor(req,res);if(!user)return;if(!['admin','designer','developer'].includes(user.role))throw error(403,'forbidden','无权查看账户');shell(req,res,{page:'accounts',user})})
  route('GET',/^\/invites$/,(req,res)=>{const user=actor(req,res);if(!user)return;if(!['admin','designer'].includes(user.role))throw error(403,'forbidden','无权管理邀请');shell(req,res,{page:'invites',user})})
  for(const pattern of [/^\/projects\/(?<projectId>[\w-]+)\/canvas$/,/^\/viewer\/p\/(?<projectId>[\w-]+)$/])route('GET',pattern,(req,res,{params})=>{const user=actor(req,res);if(!user)return;permissions.requireRead(user,params.projectId);shell(req,res,{page:'canvas',user,projectId:params.projectId})})
  for(const pattern of [/^\/projects\/(?<projectId>[\w-]+)\/slices$/,/^\/viewer\/p\/(?<projectId>[\w-]+)\/slices$/])route('GET',pattern,(req,res,{params})=>{const user=actor(req,res);if(!user)return;permissions.requireRead(user,params.projectId);shell(req,res,{page:'slices',user,projectId:params.projectId})})
  route('GET',/^\/viewer\/r\/(?<frameId>[\w-]+)$/,(req,res,{params,url})=>{
    const user=actor(req,res);if(!user)return
    const frame=vault.catalog.frames.find(f=>f.id===params.frameId),file=frame&&vault.catalog.designFiles.find(f=>f.id===frame.designFileId)
    if(!frame||!file)throw error(404,'not_found','画板不存在');permissions.requireRead(user,file.projectId)
    const requested=url.searchParams.get('revision'),revisionId=!requested||requested==='current'?frame.currentRevisionId:requested
    const revision=safeID(revisionId)&&vault.catalog.frameRevisions.find(r=>r.id===revisionId&&r.frameId===frame.id)
     if(!revision)throw error(404,'not_found','画板版本不存在')
     const sourceFile=revision.coordinateMode==='project-xy'?vault.catalog.designFiles.find(f=>f.id===revision.designFileId&&f.projectId===file.projectId):file
     if(!sourceFile || revision.coordinateMode==='project-xy'&&!vault.catalog.pages.some(p=>p.id===revision.pageId&&p.designFileId===sourceFile.id))throw error(404,'not_found','画板版本不存在')
    const project=vault.catalog.projects.find(p=>p.id===file.projectId),nonce=crypto.randomBytes(18).toString('base64')
    const context={projectId:project.id,projectName:project.name,designFileId:sourceFile.id,designFileName:sourceFile.name,frameId:frame.id,revisionId,figmaNodeId:revision.coordinateMode==='project-xy'?revision.figmaNodeId:frame.figmaNodeId,initialMode:'frame',permissions:permissions.project(user,project.id),projectCanvasUrl:'/viewer/p/'+encodeURIComponent(project.id),projectSlicesUrl:'/viewer/p/'+encodeURIComponent(project.id)+'/slices'}
    const body=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${html(BRAND.product)} · 设计标注</title><link rel="stylesheet" href="/viewer/independent/production-shell.css"><link rel="icon" href="${faviconDataURI()}"></head><body><main id="inspector-root" aria-label="设计标注"></main><script id="inspector-context" type="application/json" nonce="${nonce}">${json(context)}</script><script type="module" nonce="${nonce}" src="/viewer/independent/production-adapter.mjs"></script></body></html>`
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self';script-src 'self' 'nonce-${nonce}';style-src 'self';img-src 'self' data: blob:;connect-src 'self';object-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'self'`});res.end(body)
  })
  for(const [url,key,type,downloadName]of [['/plugin.zip','pluginArchive','application/zip','plugin.zip']]){
    const transfer=async(req,res,{signal})=>{
      auth.actor(req);const filename=ctx.artifacts[key];if(!filename)throw error(404,'artifact_not_built','发布物尚未构建')
      const resolved=await fs.realpath(filename),stat=await fs.lstat(filename,{bigint:true});if(resolved!==filename||!stat.isFile()||stat.isSymbolicLink()||typeof fsConstants.O_NOFOLLOW!=='number')throw error(409,'artifact_invalid','发布物无效')
      let handle;try{handle=await fs.open(filename,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW)}catch(cause){if(['ELOOP','ENOENT'].includes(cause.code))throw error(409,'artifact_changed','发布物已变动，请重新确认');throw cause}
      let closed=false
      try{const current=await handle.stat({bigint:true});if(!current.isFile()||current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size||current.mtimeNs!==stat.mtimeNs)throw error(409,'artifact_changed','发布物已变动，请重新确认');auth.actor(req)
        if(current.size<=0n||current.size>BigInt(MAX_PLUGIN_ARCHIVE_BYTES))throw error(409,'artifact_invalid','插件安装包校验失败，已阻止下载。')
        const bytes=Buffer.alloc(Number(current.size));let position=0
        while(position<bytes.length){if(signal?.aborted)throw error(499,'request_closed','请求已关闭');const next=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position);if(!next.bytesRead)throw error(409,'artifact_changed','发布物已变动，请重新确认');position+=next.bytesRead}
        let release;try{const metadata=JSON.parse(readStoredPluginZIP(bytes).get('发行信息.json')?.toString('utf8'));const options=metadata?.schema===2&&metadata.serviceMode==='custom-https'?{serviceMode:'custom-https',serviceOrigin:null}:{serviceOrigin:ctx.publicOrigin||DEFAULT_PLUGIN_ORIGIN};release=inspectPluginRelease(bytes,options)}catch{throw error(409,'artifact_invalid','插件安装包校验失败，已阻止下载；请联系服务维护者。')}
        const after=await handle.stat({bigint:true});if(after.size!==current.size||after.mtimeNs!==current.mtimeNs)throw error(409,'artifact_changed','发布物已变动，请重新确认');auth.actor(req)
        const headers={'Content-Type':type,'Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="${release.filename}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':`"sha256-${release.sha256}"`,'X-Heron-Plugin-Release':release.release+'-'+release.date}
        await handle.close();closed=true
        if(signal?.aborted)throw error(499,'request_closed','请求已关闭')
        auth.actor(req)
        res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:bytes)
      }finally{if(!closed)await handle.close().catch(()=>{})}
    }
    const pattern=new RegExp('^'+url.replace('.','\\.')+'$');route('GET',pattern,transfer);route('HEAD',pattern,transfer)
  }
}
