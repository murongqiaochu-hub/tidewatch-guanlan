// Standalone-platform plugin artifact builder. Uses only the independently authored ESM compiler.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compileESM } from './esm-compiler.mjs'
import { inlinePluginUI, validateServiceOrigin, pluginFiles } from './build.mjs'
import { validateProductionPluginManifest } from '../平台/插件发行.mjs'
import { BRAND, applyBrandTokens } from '../品牌/identity.mjs'
import { pluginServiceOrigins } from '../平台/服务地址.mjs'
const root=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'))
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
async function readSource(relative){
  if(path.posix.normalize(relative)!==relative||relative.startsWith('/')||relative.includes('\\')||relative.split('/').includes('..'))throw new TypeError('Unsafe source name')
  const filename=path.join(root,relative)
  for(let p=filename;p!==root;p=path.dirname(p))if((await fs.lstat(p)).isSymbolicLink())throw new TypeError('Source symlink denied')
  if(await fs.realpath(filename)!==filename||!(await fs.lstat(filename)).isFile())throw new TypeError('Source must be regular')
  return fs.readFile(filename)
}
async function writeExclusive(filename,bytes){const handle=await fs.open(filename,'wx',0o600);try{await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}}
export async function generateStandalonePlugin({serviceOrigin,pluginId,localDevelopmentId,outputDirectory,legacyOrigins}={}){
  const origin=validateServiceOrigin(serviceOrigin)
  if(!origin)throw new TypeError('Explicit HTTPS service origin required')
  const serviceOrigins=pluginServiceOrigins(origin,{legacy:legacyOrigins})
  if((pluginId===undefined)===(localDevelopmentId===undefined))throw new TypeError('Select one explicit registered ID or established local development identity')
  if(pluginId!==undefined&&!/^\d{5,40}$/.test(pluginId))throw new TypeError('Registered identity must be explicitly supplied, not synthesized')
  if(localDevelopmentId!==undefined&&localDevelopmentId!=='heron-sync-stage0-local')throw new TypeError('Only the existing local identity can be retained without registration evidence')
  if(!outputDirectory||!path.isAbsolute(outputDirectory))throw new TypeError('Explicit absolute fresh output directory required')
  const parent=await fs.realpath(path.dirname(outputDirectory));if(path.join(parent,path.basename(outputDirectory))!==outputDirectory)throw new TypeError('Output requires canonical parent')
  await fs.mkdir(outputDirectory,{mode:0o700});await fs.chmod(outputDirectory,0o700)
  const sources=new Map();for(const name of pluginFiles)sources.set(name,await readSource(name))
  const modules=new Map([...sources].filter(([name])=>name.endsWith('.mjs')).map(([name,bytes])=>[name,applyBrandTokens(bytes.toString('utf8'))]))
  const main=compileESM(modules,'插件/main.mjs'),ui=compileESM(modules,'插件/ui.mjs')
  const productionBootstrap=`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify({serviceOrigin:origin,serviceOrigins,allowLocalhost:false})});\n`
  let html=inlinePluginUI(applyBrandTokens(sources.get('插件/ui.html').toString('utf8')),sources.get('插件/ui.css').toString('utf8'),productionBootstrap+ui.code)
  const marker=/(<meta\s+name=["']independent-production["']\s+content=["'])disabled(["']\s*\/?>)/
  if(!marker.test(html))throw new TypeError('Explicit production UI activation marker required')
  html=html.replace(marker,'$1enabled$2')
  const mainBytes=Buffer.from(productionBootstrap+main.code)
  const manifest={name:BRAND.pluginName,id:pluginId||localDevelopmentId,api:'1.0.0',main:'main.js',ui:'ui.html',editorType:['figma'],documentAccess:'dynamic-page',networkAccess:{allowedDomains:[origin],reasoning:BRAND.networkReason}}
  validateProductionPluginManifest(manifest,{serviceOrigin:origin})
  // No private/proposed API flag, wildcard network, external UI script or fake registration.
  const outputs=new Map([['main.js',mainBytes],['ui.html',Buffer.from(html)],['manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]])
  for(const[name,bytes]of outputs)await writeExclusive(path.join(outputDirectory,name),bytes)
  const result={contractVersion:1,runtimeKind:'independent-platform',developmentOnly:true,nativeGlibcCorrespondingSourceVersion:'2.36-9+deb12u14',serviceOrigin:origin,localDevelopmentIdentity:localDevelopmentId??null,registeredPluginIdentitySupplied:pluginId!==undefined,registeredPluginIdentityVerified:false,privatePluginAPIEnabled:false,commercialLicenseCleared:false,oldAGPLGrantsRevoked:false,inputHashes:Object.fromEntries([...sources].map(([name,bytes])=>[name,sha(bytes)])),outputHashes:Object.fromEntries([...outputs].map(([name,bytes])=>[name,sha(bytes)])),topologicalOrder:{main:main.order,ui:ui.order}}
  await writeExclusive(path.join(outputDirectory,'构建声明.json'),Buffer.from(JSON.stringify(result,null,2)+'\n'))
  return result
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){const key={'--service-origin':'serviceOrigin','--plugin-id':'pluginId','--local-plugin-id':'localDevelopmentId','--output':'outputDirectory'}[args[i]];if(!key||!args[i+1]||Object.hasOwn(options,key))throw new TypeError('Explicit nonduplicated build options required');options[key]=args[++i]}
  const result=await generateStandalonePlugin(options);console.log(JSON.stringify({status:'DEVELOPMENT_ARTIFACT_BUILT',privatePluginAPIEnabled:false,registeredPluginIdentityVerified:false,commercialLicenseCleared:false,outputHashes:result.outputHashes}))
}
