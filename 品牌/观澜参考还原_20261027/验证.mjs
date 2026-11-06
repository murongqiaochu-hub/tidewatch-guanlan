// 仅本目录离线 Chromium 验证，无服务器、无网络请求、无依赖安装。
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const here = new URL('./', import.meta.url);
const child = spawn('/usr/bin/chromium', ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--metrics-recording-only','--host-resolver-rules=MAP * ~NOTFOUND','--remote-debugging-pipe'], {stdio:['ignore','ignore','pipe','pipe','pipe']});
let serial=0,buffer='',sessionId; const pending=new Map(); const external=[]; let stderr='';
child.stderr.on('data',d=>{stderr+=d;});
child.stdio[4].on('data',d=>{buffer+=d.toString();let i;while((i=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!text)continue;const m=JSON.parse(text);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))external.push(m.params.request.url);}});
function cmd(method,params={},browser=false){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.stdio[3].write(JSON.stringify({id,method,params,...(!browser&&sessionId?{sessionId}: {})})+'\0');});}
const timeout=setTimeout(()=>{console.error('Chromium validation timed out',stderr.slice(-2000));child.kill('SIGTERM');process.exitCode=1;},30000);
try {
  const version=await cmd('Browser.getVersion',{},true);
  const {targetId}=await cmd('Target.createTarget',{url:'about:blank'},true);
  ({sessionId}=await cmd('Target.attachToTarget',{targetId,flatten:true},true));
  await cmd('Page.enable');await cmd('Network.enable');
  await cmd('Emulation.setDeviceMetricsOverride',{width:1200,height:1320,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:new URL('preview.html',here).href});
  // Browser-side load promise, not polling or arbitrary sleep.
  await cmd('Runtime.evaluate',{expression:'new Promise(resolve=>document.readyState==="complete"?resolve():addEventListener("load",resolve,{once:true}))',awaitPromise:true});
  const source=(await readFile(new URL('logo.mjs',here),'utf8')).replaceAll('export ','');
  const expression=`(()=>{${source}\nconst checks=JSON.parse(document.querySelector('#checks').textContent);const named=createGuanlanLogo({label:'观澜 <测试>',size:24});const decorative=createGuanlanLogo({label:null,variant:'mono',size:16});const host=document.createElement('div');host.style.color='rgb(123, 45, 67)';host.append(named,decorative);document.body.append(host);checks.componentName=named.getAttribute('aria-label')==='观澜 <测试>'&&named.querySelector('title').textContent==='观澜 <测试>';checks.decorative=decorative.getAttribute('aria-hidden')==='true'&&!decorative.hasAttribute('role')&&!decorative.querySelector('title');checks.currentColor=getComputedStyle(decorative.querySelector('path')).fill==='rgb(123, 45, 67)';checks.bounds=[...document.querySelectorAll('.hero>svg path')].map(p=>{const b=p.getBBox();return {x:b.x,y:b.y,width:b.width,height:b.height};});checks.insideViewBox=checks.bounds.every(b=>b.x+16>=0&&b.y+32>=0&&b.x+b.width+16<=544&&b.y+b.height+32<=544);host.remove();return checks;})()`;
  const evaluated=await cmd('Runtime.evaluate',{expression,returnByValue:true});
  if(evaluated.exceptionDetails)throw new Error(JSON.stringify(evaluated.exceptionDetails));
  const checks=evaluated.result.value;
  const shot=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(new URL('preview.png',here),Buffer.from(shot.data,'base64'));
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const mobile=await cmd('Runtime.evaluate',{expression:'({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,pass:document.documentElement.scrollWidth<=innerWidth})',returnByValue:true});
  const report={browser:version.product,scope:'isolated file:// assets only',externalRequests:external,checks,mobile:mobile.result.value};
  if(external.length||Object.values(checks).includes(false)||!report.mobile.pass)throw new Error(JSON.stringify(report));
  await writeFile(new URL('验证结果.json',here),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {clearTimeout(timeout);await cmd('Browser.close',{},true).catch(()=>child.kill('SIGTERM'));}
