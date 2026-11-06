// New independent HTTP composition. No legacy product modules or templates.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openVault, newId } from './仓库.mjs'
import { createAuthentication, hashPassword } from './认证.mjs'
import { createPermissions } from './权限.mjs'
import { installAccountsProjects } from './账户项目.mjs'
import { installPublishing } from './发布.mjs'
import { installAssets } from './资源.mjs'
import { installSlices } from './切图.mjs'
import { installProjectData } from './项目数据.mjs'
import { installWebPages } from './网页.mjs'
import { createRequestSourcePolicy, resolveOriginMode } from './请求来源.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra }
}
const error = (status, code, message, extra) => new ApiError(status, code, message, extra)
const mime = { '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const publicHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }
const validateObject = value => {
  const stack = [[value,0]]; let count = 0
  while (stack.length) {
    const [item,depth] = stack.pop()
    if (++count > 1000000 || depth > 128) throw error(400,'json_limit','数据结构过大或过深')
    if (!item || typeof item !== 'object') continue
    for (const key of Object.keys(item)) {
      if (['__proto__','constructor','prototype'].includes(key)) throw error(400,'unsafe_json','数据包含不支持的字段')
      stack.push([item[key],depth + 1])
    }
  }
  return value
}
async function readBody(req, { maxBytes, raw, signal }) {
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw error(413,'payload_too_large','请求体超过允许大小')
  const chunks = []; let size = 0
  for await (const chunk of req) {
    if (signal.aborted) throw error(499,'request_aborted','请求已经关闭')
    size += chunk.length; if (size > maxBytes) throw error(413,'payload_too_large','请求体超过允许大小'); chunks.push(chunk)
  }
  if (length !== undefined && size !== Number(length)) throw error(400,'body_length','请求体长度不完整')
  const body = Buffer.concat(chunks, size)
  if (raw) return body
  if (!size) return {}
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw error(415,'json_required','请使用JSON请求')
  try { return validateObject(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))) }
  catch (cause) { if (cause instanceof ApiError) throw cause; throw error(400,'invalid_json','JSON格式无效') }
}
function sendJSON(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body)); res.writeHead(status,{...publicHeaders,'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length}); res.end(bytes)
}
function errorData(cause) {
  const status = Number.isInteger(cause?.status) && cause.status >= 400 && cause.status <= 599 ? cause.status : 500
  return {status,code:status===500?'internal_error':String(cause.code||'request_failed'),message:status===500?'服务暂时无法完成请求':String(cause.message||'请求失败')}
}
function sendError(res, cause) {
  if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.destroy(); return }
  const {status,code,message}=errorData(cause)
  sendJSON(res,{error:{code,message,...(cause.extra && typeof cause.extra === 'object' ? cause.extra : {})}},status)
}

// A slot ends only after the handler settled AND its response physically ended.
export function createReadGate({ capacity = 4, waiting = 16 } = {}) {
  let active = 0; const queue = [], idle = new Set()
  const notify = () => { if (!active && !queue.length) for (const done of idle) { idle.delete(done); done() } }
  const drain = () => { while (active < capacity && queue.length) start(queue.shift()); notify() }
  function start(item) {
    item.res.off('close',item.cancelQueued)
    if (item.req.aborted || item.res.destroyed) { item.resolve(); drain(); return }
    active++; let settled = false, ended = item.res.writableFinished || item.res.destroyed, released = false
    const finish = () => { ended = true; release() }
    const release = () => {
      if (released || !settled || !ended) return
      released = true; item.res.off('finish',finish); item.res.off('close',finish); active--; item.resolve(); drain()
    }
    item.res.once('finish',finish); item.res.once('close',finish)
    Promise.resolve().then(item.task).catch(cause=>sendError(item.res,cause)).finally(()=>{settled=true;release()})
  }
  return {
    run(req,res,task) {
      if (active >= capacity && queue.length >= waiting) { res.setHeader('Retry-After','1'); sendError(res,error(503,'read_busy','读取任务较多，请稍后重试')); return Promise.resolve() }
      return new Promise(resolve=>{
        const item={req,res,task,resolve,cancelQueued:null}
        item.cancelQueued=()=>{const i=queue.indexOf(item);if(i>=0){queue.splice(i,1);resolve();notify()}}
        if(active<capacity)start(item);else{queue.push(item);res.once('close',item.cancelQueued)}
      })
    },
    get diagnostics(){return {active,queued:queue.length,capacity,waiting}},
    idle(){return !active&&!queue.length?Promise.resolve():new Promise(resolve=>idle.add(resolve))}
  }
}

export async function createPlatform({ dataDir, secret, host='127.0.0.1', publicOrigin=null, originMode: requestedOriginMode, clock=Date.now, limits={}, bootstrapAdmin=null, vault: suppliedVault, logger=console, codec=null, artifacts={} }={}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('Explicit absolute dataDir required')
  const originMode=resolveOriginMode(requestedOriginMode,publicOrigin)
  let existed = false
  try { existed = (await fs.lstat(path.join(dataDir,'catalog.json'))).isFile() } catch(cause){if(cause.code!=='ENOENT')throw cause}
  const vault = suppliedVault || await openVault({dataDir,clock,limits})
  if (!Buffer.isBuffer(secret) && typeof secret !== 'string') throw new TypeError('Explicit secret required')
  const auth = createAuthentication({vault,secret,clock}), permissions = createPermissions({vault,clock})
  if (bootstrapAdmin && !existed && vault.catalog.users.length === 0) {
    const credentials = await hashPassword(bootstrapAdmin.password)
    if (!credentials?.salt || !credentials?.passwordHash) throw new TypeError('Password encoder contract missing')
    await vault.transact(draft=>draft.add('users',{id:newId(),username:bootstrapAdmin.username || 'admin',...credentials,role:'admin',status:'active',ownerId:null,sessionVersion:0,createdAt:new Date(clock()).toISOString()}))
  }
  const routes = [], gate = createReadGate(), pending = new Set()
  const route=(method,pattern,handler,options={})=>{if(!(pattern instanceof RegExp)||typeof handler!=='function')throw new TypeError('Invalid route');routes.push({method,pattern,handler,options})}
  const sourcePolicy=createRequestSourcePolicy({mode:originMode,publicOrigin,deny:()=>error(403,'origin_denied','请求来源不允许'),denyCrossSite:()=>error(403,'origin_denied','跨站请求不允许')})
  const ctx={route,vault,auth,permissions,error,clock,limits,codec,artifacts,publicOrigin,originMode,isSecureRequest:sourcePolicy.isSecureRequest,logger,readGate:gate}
  const assertSameOrigin = (req,options) => sourcePolicy.assertSameOrigin(req,options)
  ctx.assertSameOrigin=assertSameOrigin
  await installAccountsProjects(ctx); await installPublishing({...ctx,publishIntentKey:crypto.createHmac('sha256',secret).update('heron-publish-intent-key-v1').digest()}); const assetServices = await installAssets(ctx); ctx.assetServices = assetServices; await installSlices(ctx); await installProjectData(ctx); await installWebPages(ctx)
  route('GET',/^\/api\/health$/,(req,res)=>({status:'ok',service:'independent-design-handoff',version:'0.2.0-development',time:new Date(clock()).toISOString(),storage:{assets:vault.catalog.assets.length,frames:vault.catalog.frames.filter(f=>f.state==='published').length,revisions:vault.catalog.frameRevisions.length,openSessions:vault.catalog.publishSessions.filter(s=>s.status==='open').length}}),{public:true,budget:false})
  for (const [prefix, directory, allow] of [
    ['/viewer/independent/',path.join(here,'..','查看器'),new Set(['index.mjs','core.mjs','resources.mjs','inspector.css'])],
    ['/ui/',path.join(here,'..','界面'),new Set(['app.mjs','base.css','画布.mjs'])],
    ['/viewer/independent/',path.join(here,'..','宿主'),new Set(['production-adapter.mjs','production-shell.css'])]
  ]) for (const name of allow) {
    const handler=async(req,res)=>{
      if(prefix.startsWith('/viewer/'))auth.actor(req)
      const dir=await fs.realpath(directory), filename=path.join(dir,name), stat=await fs.lstat(filename)
      if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(filename)!==filename||stat.size>2*1024*1024)throw error(404,'not_found','文件不存在')
      const bytes=await fs.readFile(filename);if(prefix.startsWith('/viewer/'))auth.actor(req)
      res.writeHead(200,{...publicHeaders,'Content-Type':mime[path.extname(name)],'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes)
    }
    const pattern=new RegExp('^'+(prefix+name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')
    route('GET',pattern,handler,{public:prefix==='/ui/'});route('HEAD',pattern,handler,{public:prefix==='/ui/'})
  }
  let writeChain=Promise.resolve(), stopping=false
  const server=http.createServer((req,res)=>{
    const controller=new AbortController(), signal=controller.signal
    req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableFinished)controller.abort()})
    let selected,url,pathname
    const failRequest=cause=>{
      const target=pathname||String(req.url||'').split('?')[0]
      const html=req.method==='GET'&&/text\/html/i.test(String(req.headers.accept||''))&&!/^\/api(?:\/|$)/.test(target)&&target!=='/plugin.zip'
      if(html&&!res.headersSent&&!res.destroyed&&typeof ctx.renderErrorPage==='function'){
        try{ctx.renderErrorPage(req,res,errorData(cause));if(res.headersSent||res.writableEnded)return}catch{}
      }
      sendError(res,cause)
    }
    try {
      sourcePolicy.validateHost(req)
      url=new URL(req.url,'http://'+req.headers.host)
      pathname=decodeURIComponent(url.pathname)
      if(/[\u0000-\u001f\u007f\\]/.test(pathname))throw error(400,'invalid_path','路径格式无效')
      selected=routes.find(item=>item.method===req.method&&item.pattern.test(pathname))
      const origin=req.headers.origin
      if(origin){try{assertSameOrigin(req,{opaque:true});res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}catch{}}
      if(req.method==='OPTIONS'){
        assertSameOrigin(req,{opaque:true});res.writeHead(204,{'Access-Control-Allow-Methods':'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Asset-Mime','Access-Control-Max-Age':'600'});res.end();return
      }
      if(!selected)throw error(404,'not_found','页面或接口不存在')
      if(stopping)throw error(503,'shutting_down','服务正在关闭')
      if(pending.size>=64)throw error(503,'service_busy','请求较多，请稍后重试')
    }catch(cause){failRequest(cause);req.resume();return}
    const writing=['POST','PUT','PATCH','DELETE'].includes(req.method)
    const transfer=['GET','HEAD'].includes(req.method)&&selected.options.budget!==false&&(/^\/api\/(assets|previews)\//.test(pathname)||/\/slices(?:\.zip|\/[^/]+\/(?:preview|download))$/.test(pathname)||pathname==='/plugin.zip')
    const timeout=setTimeout(()=>{controller.abort();failRequest(error(408,'request_timeout','请求超时'));if(res.headersSent&&!res.writableEnded)res.destroy()},transfer?300000:30000);timeout.unref()
    const execute=async()=>{
      try{
        if(signal.aborted||res.destroyed)return
        const params=selected.pattern.exec(pathname)?.groups||{}
        if(writing){
          const authEndpoint=/^\/api\/auth\/(login|refresh|logout|remembered-logout)$/.test(pathname)
          const publishEndpoint=/^\/api\/publish\/sessions(?:\/|$)/.test(pathname)||/^\/api\/projects\/[^/]+\/publish-source$/.test(pathname)
          if(authEndpoint)assertSameOrigin(req,{opaque:true})
          else if(publishEndpoint){const actor=auth.actor(req);assertSameOrigin(req,{opaque:Boolean(/^Bearer\s+/i.test(req.headers.authorization || ''))});if(!actor)throw error(401,'unauthenticated','需要登录')}
          else {assertSameOrigin(req,{opaque:Boolean(/^Bearer\s+/i.test(req.headers.authorization||''))});if(!selected.options.public)auth.actor(req)}
        }
        const body=writing?await readBody(req,{maxBytes:selected.options.maxBytes??(pathname.startsWith('/api/auth/')?16384:32*1024*1024),raw:selected.options.raw===true,signal}):undefined
        const value=await selected.handler(req,res,{params,url,body,signal})
        if(!res.headersSent&&!res.writableEnded&&!res.destroyed)sendJSON(res,value??{ok:true},selected.options.status??res.statusCode??200)
      }catch(cause){if(cause?.status===500||!cause?.status)logger.error?.('[independent-platform] request failed');failRequest(cause)}
    }
    const task=transfer?gate.run(req,res,execute):writing?(writeChain=writeChain.then(execute,execute)):execute()
    pending.add(task);Promise.resolve(task).finally(()=>{pending.delete(task);clearTimeout(timeout)})
  })
  server.headersTimeout=15000;server.requestTimeout=30000;server.setTimeout(30000,socket=>socket.destroy())
  return {server,vault,auth,permissions,context:ctx,diagnostics:()=>({read:gate.diagnostics,pending:pending.size}),async listen(port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});return server.address()},async close(){stopping=true;server.closeIdleConnections();const ended=new Promise(resolve=>server.close(resolve));await Promise.allSettled([...pending]);await gate.idle();await ended;await assetServices?.close?.();await vault.close()}}
}
