// Explicit standalone service entry. No implicit production paths, secrets or server replacement.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatform } from './服务.mjs'
import { loadAuthenticationSecret } from './认证.mjs'
import { createCodec } from './编码器适配.mjs'

async function privateText(filename,{trim=true}={}){
  if(!filename||!path.isAbsolute(filename))throw new TypeError('Explicit absolute secret file required')
  const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size<1||stat.size>16384)throw new TypeError('Secret must be a private regular file')
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(filename));return trim?text.trim():text
}
export async function createConfiguredPlatform(env=process.env){
  const root=env.HANDOFF_DATA_DIR;if(!root||!path.isAbsolute(root)||root==='/'||root.includes('\0')||path.resolve(root)!==root)throw new TypeError('HANDOFF_DATA_DIR must be explicit, absolute and lexically canonical')
  const originMode=env.HANDOFF_ORIGIN_MODE??'auto';if(originMode!=='auto'&&originMode!=='fixed')throw new TypeError('HANDOFF_ORIGIN_MODE must be auto or fixed')
  const parent=await fs.realpath(path.dirname(root)),dataDir=path.join(parent,path.basename(root));if(path.basename(root)==='.'||path.basename(root)==='..')throw new TypeError('Invalid data directory')
  if(env.HANDOFF_JWT_SECRET_FILE&&env.JWT_SECRET_FILE&&env.HANDOFF_JWT_SECRET_FILE!==env.JWT_SECRET_FILE)throw new TypeError('Conflicting explicit secret file configuration')
  const secret=await loadAuthenticationSecret({mode:'FILE',path:env.HANDOFF_JWT_SECRET_FILE||env.JWT_SECRET_FILE})
  let catalogExists=false;try{catalogExists=(await fs.lstat(path.join(dataDir,'catalog.json'))).isFile()}catch(cause){if(cause.code!=='ENOENT')throw cause}
  if(!catalogExists&&!env.HANDOFF_ADMIN_PASSWORD_FILE)throw new TypeError('Explicit bootstrap password FILE required for new data directory')
  const bootstrapAdmin=!catalogExists&&env.HANDOFF_ADMIN_PASSWORD_FILE?{username:env.HANDOFF_ADMIN_USER||'admin',password:await privateText(env.HANDOFF_ADMIN_PASSWORD_FILE)}:null
  const publicOrigin=env.HANDOFF_PUBLIC_ORIGIN||null
  if(publicOrigin){const u=new URL(publicOrigin);if(!['http:','https:'].includes(u.protocol)||u.origin!==publicOrigin||u.username||u.password)throw new TypeError('Public origin must be an exact HTTP(S) origin')}
  const codec=env.HANDOFF_CODEC_BINARY?createCodec({binaryPath:env.HANDOFF_CODEC_BINARY,libraryPath:env.HANDOFF_CODEC_LIBRARIES||undefined}):null
  const canonicalArtifact=async value=>{if(!value)return undefined;if(!path.isAbsolute(value))throw new TypeError('Artifact path must be absolute');return fs.realpath(value)}
  const artifacts={pluginArchive:await canonicalArtifact(env.HANDOFF_PLUGIN_ARCHIVE)}
  return createPlatform({dataDir,secret,host:env.HANDOFF_HOST||env.HOST||'127.0.0.1',publicOrigin,originMode,bootstrapAdmin,codec,artifacts})
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===fileURLToPath(import.meta.url)){
  let app
  try{
    const port=Number(process.env.HANDOFF_PORT||process.env.PORT||4318);if(!Number.isInteger(port)||port<1||port>65535)throw new TypeError('Invalid explicit port')
    app=await createConfiguredPlatform();await app.listen(port)
    console.log(JSON.stringify({status:'listening',port,development:true,commercialClearance:false}))
    let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close()};process.once('SIGTERM',close);process.once('SIGINT',close)
  }catch{await app?.close().catch(()=>{});console.error('Independent platform startup failed; sensitive configuration details withheld');process.exitCode=1}
}
