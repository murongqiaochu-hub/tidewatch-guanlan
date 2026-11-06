// 仅导出现有固定标志，不重绘、不改原矩阵或 QA，不运行项目构建。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { standaloneSVG, paths } from './logo.mjs';
const here = new URL('./', import.meta.url);
const logo = variant => standaloneSVG(variant).replace('width="544" height="544"', 'width="380" height="380"').replace('role="img" aria-label="观澜"', 'aria-hidden="true"');
await writeFile(new URL('showcase.html', here), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>观澜</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1600px;height:900px;overflow:hidden}main{display:flex;width:100%;height:100%}.panel{width:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px;background:#fff;color:#064852}.dark{background:#0c2026;color:#fff}svg{display:block;flex:none}.wordmark{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;font-size:88px;font-weight:600;line-height:1.2;letter-spacing:.08em;padding-left:.08em}
</style></head><body><main><section class="panel" aria-label="观澜双色标志">${logo('duotone')}<span class="wordmark">观澜</span></section><section class="panel dark" aria-label="观澜反白标志">${logo('reverse')}<span class="wordmark">观澜</span></section></main></body></html>\n`);
const child = spawn('/usr/bin/chromium', ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--metrics-recording-only','--host-resolver-rules=MAP * ~NOTFOUND','--remote-debugging-pipe'], {stdio:['ignore','ignore','pipe','pipe','pipe']});
let serial=0,buffer='',sessionId;const pending=new Map(),external=[];let stderr='';
child.stderr.on('data',d=>{stderr+=d;});
child.stdio[4].on('data',d=>{buffer+=d.toString();let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))external.push(m.params.request.url);}});
function cmd(method,params={},browser=false){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.stdio[3].write(JSON.stringify({id,method,params,...(!browser&&sessionId?{sessionId}: {})})+'\0');});}
const timeout=setTimeout(()=>{console.error('Showcase render timed out',stderr.slice(-2000));child.kill('SIGTERM');process.exitCode=1;},30000);
try {
  const version=await cmd('Browser.getVersion',{},true);
  const {targetId}=await cmd('Target.createTarget',{url:'about:blank'},true);
  ({sessionId}=await cmd('Target.attachToTarget',{targetId,flatten:true},true));
  await cmd('Page.enable');await cmd('Network.enable');
  await cmd('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:new URL('showcase.html',here).href});
  await cmd('Runtime.evaluate',{expression:'new Promise(resolve=>document.readyState==="complete"?resolve():addEventListener("load",resolve,{once:true})).then(()=>document.fonts.ready)',awaitPromise:true});
  const result=await cmd('Runtime.evaluate',{expression:`(()=>{const svgs=[...document.querySelectorAll('svg')];return {width:innerWidth,height:innerHeight,noOverflow:document.documentElement.scrollWidth===1600&&document.documentElement.scrollHeight===900,onlyWordmarks:document.body.innerText.replace(/\\s/g,'')==='观澜观澜',fixedGeometry:svgs.length===2&&svgs.every(s=>JSON.stringify([...s.querySelectorAll('path')].map(p=>p.getAttribute('d')))===${JSON.stringify(JSON.stringify(paths))}&&s.getAttribute('viewBox')==='0 0 544 544'),noRaster:!document.querySelector('image,img,canvas,foreignObject'),noRemoteResources:!document.querySelector('script,link,iframe')}})()`,returnByValue:true});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  const checks=result.result.value;
  if(Object.values(checks).includes(false)||external.length)throw new Error(JSON.stringify({checks,external}));
  const shot=await cmd('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1600,height:900,scale:1}});
  await writeFile(new URL('showcase.png',here),Buffer.from(shot.data,'base64'));
  const report={browser:version.product,scope:'showcase.html local file:// only; original QA and preview untouched',externalRequests:external,checks};
  await writeFile(new URL('展示图验证.json',here),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {clearTimeout(timeout);await cmd('Browser.close',{},true).catch(()=>child.kill('SIGTERM'));}
