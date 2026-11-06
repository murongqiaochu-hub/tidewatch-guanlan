// Local Chromium + synthetic SDK/HTTP only. No service, production data, publish,
// session mutation or real Figma is used. Network is blocked and fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileESM } from '../构建/esm-compiler.mjs';
import { inlinePluginUI, pluginFiles } from '../构建/build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/usr/bin/chromium';

async function browser() {
  const base = await realpath(tmpdir());
  const profile = await mkdtemp(path.join(base, 'heron-ui-fixture-'));
  const process = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-default-apps', '--no-first-run', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let serial = 0, buffer = '', stderr = '';
  const pending = new Map(), network = [], errors = [];
  process.stderr.on('data', chunk => { stderr += chunk.toString(); });
  process.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf('\0')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      const message = JSON.parse(line);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
      else request.resolve(message.result);
    }
  });
  process.on('exit', code => { for (const request of pending.values()) request.reject(new Error(`Chromium exited (${code}): ${stderr.slice(-2000)}`)); pending.clear(); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    process.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width:480, height:640, deviceScaleFactor:1, mobile:false });
  await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const close = async () => {
    const running = process.exitCode === null && process.signalCode === null;
    const exited = running ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
    if (running) { try { await send('Browser.close'); } catch { /* exit can precede the response */ } }
    await exited;
    const canonical = await realpath(profile);
    if (canonical !== profile || path.dirname(canonical) !== base || !path.basename(canonical).startsWith('heron-ui-fixture-')) throw new Error('Unexpected Chromium profile path');
    // Preserve the isolated profile, even on test failure; never delete data.
    console.info(`Preserved isolated Chromium profile: ${canonical}`);
  };
  return { call, evaluate, close, network, errors };
}

async function fixtureHTML() {
  const modules = new Map();
  for (const name of pluginFiles.filter(name => name.endsWith('.mjs'))) modules.set(name, await readFile(path.join(root, name), 'utf8'));
  const html = await readFile(path.join(root, '插件/ui.html'), 'utf8');
  const css = await readFile(path.join(root, '插件/ui.css'), 'utf8');
  const compiled = compileESM(modules, '插件/ui.mjs').code;
  const ui = inlinePluginUI(html, css, compiled).replace('content="disabled"', 'content="enabled"')
    .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'none\'"><script>window.fetch=(...args)=>parent.fixture.fetch(...args)</script>');
  const encoded = JSON.stringify(ui).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{position:fixed;left:0;top:0;width:480px;height:640px;border:0}</style><body><script>
    const state = { production:true, phase:'idle', locked:false, sessionId:null, completed:[], mappingAvailable:false, total:0, done:0, exportTotal:0, exportDone:0, config:{origin:'https://fixture.invalid',allowLocalhost:false}, rememberSupported:false };
    const fixture = window.fixture = { state, requests:[], actions:[], projects:[{id:'project-fixture',name:'已有项目',permissions:{canPublish:true}}], groups:[], pendingNotices:new Map(), serial:0 };
    const response = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
    fixture.fetch = async (url, options) => {
      const path = new URL(url).pathname, method = options.method;
      fixture.requests.push({path,method});
      const user = {id:'user-fixture',username:'fixture',role:'designer'};
      if (path === '/api/auth/login') return response({token:'fixture.token',user});
      if (path === '/api/auth/me') return response(user);
      if (path === '/api/projects' && method === 'GET') return response({projects:fixture.projects});
      if (path === '/api/projects' && method === 'POST') {
        const name = JSON.parse(new TextDecoder().decode(options.body)).name;
        await new Promise(resolve => {fixture.releaseCreate = resolve;});
        const project = {id:'project-'+fixture.projects.length,name,permissions:{canPublish:true}}; fixture.projects.push(project); return response(project);
      }
      if (/^\\/api\\/projects\\/[^/]+\\/groups$/.test(path)) {
        const projectId = path.split('/')[3];
        if (method === 'GET') return response({groups:fixture.groups.filter(g => g.projectId === projectId)});
        if (method === 'POST') {
          const name = JSON.parse(new TextDecoder().decode(options.body)).name;
          await new Promise(resolve => {fixture.releaseCreate = resolve;});
          const group = {id:'group-'+fixture.groups.length,projectId,name}; fixture.groups.push(group); return response({group});
        }
      }
      throw new Error('Unexpected synthetic request: '+method+' '+path);
    };
    function ack(message, result, error) { frame.contentWindow.postMessage({pluginMessage:{v:1,channel:message.channel,kind:'terminalAck',requestId:message.requestId,physicalDone:true,ok:!error,cancelled:false,...(error?{error:{code:error}}:{result})}},'*'); }
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data?.pluginMessage; if (!m) return;
      if (m.kind === 'terminalAck') { fixture.pendingNotices.get(m.requestId)?.(); fixture.pendingNotices.delete(m.requestId); return; }
      if (m.kind !== 'request') return;
      if (m.operation === 'hello') return ack(m,{product:'Independent Inspector · Development',height:640,state:fixture.state,verification:'DEVICE_VALIDATION_PENDING'});
      if (m.operation === 'list') return ack(m,{scope:m.payload.scope,pageId:'1:1',frames:[{id:'2:1',name:'测试画板'}],excluded:[]});
      if (m.operation === 'production-control') {
        const action=m.payload.action; fixture.actions.push(action);
        if (action === 'remember-read') return ack(m,{remembered:null,supported:false});
        if (action === 'query') { fixture.releaseQuery = error => ack(m,{state:fixture.state},error); return; }
        if (action === 'recoverCommit') { fixture.releaseRecover = error => ack(m,{state:fixture.state},error); return; }
        if (action === 'status' && fixture.statusError) return ack(m,{},fixture.statusError);
        if (['connect','status'].includes(action)) return ack(m,{state:fixture.state});
        throw Error('Forbidden synthetic control action: '+action);
      }
      throw Error('Unexpected synthetic SDK operation: '+m.operation);
    });
    fixture.sendState = next => new Promise(resolve => { fixture.state=next; const requestId='notice-'+(++fixture.serial); fixture.pendingNotices.set(requestId,resolve); frame.contentWindow.postMessage({pluginMessage:{v:1,channel:'independent-inspector-v1',kind:'request',requestId,operation:'notice',payload:{state:next}}},'*'); });
    const frame = document.createElement('iframe'); frame.id='fixture'; document.body.append(frame); frame.srcdoc=${encoded};
  </script>`;
}

const doc = "document.getElementById('fixture').contentDocument";
const el = id => `${doc}.getElementById(${JSON.stringify(id)})`;
const wait = condition => `new Promise((resolve,reject)=>{let n=0;function check(){try{if(${condition})return resolve(true)}catch{}if(++n>300)return reject(Error('fixture wait timed out: '+${JSON.stringify(condition)}));setTimeout(check,10)}check()})`;

async function click(b, id) {
  const position = await b.evaluate(`(()=>{const r=${el(id)}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await b.call('Input.dispatchMouseEvent', { type:'mouseMoved', ...position });
  await b.call('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...position });
  await b.call('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...position });
}
async function key(b, key, code, virtualKey, character = '') {
  await b.call('Input.dispatchKeyEvent', { type:'keyDown', key, code, windowsVirtualKeyCode:virtualKey, nativeVirtualKeyCode:virtualKey });
  if (character) await b.call('Input.dispatchKeyEvent', { type:'char', text:character, unmodifiedText:character, key, code, windowsVirtualKeyCode:virtualKey, nativeVirtualKeyCode:virtualKey });
  await b.call('Input.dispatchKeyEvent', { type:'keyUp', key, code, windowsVirtualKeyCode:virtualKey, nativeVirtualKeyCode:virtualKey });
}

async function openFixture(b) {
  const html = await fixtureHTML();
  const tree = await b.call('Page.getFrameTree');
  await b.call('Page.setDocumentContent', { frameId:tree.frameTree.frame.id, html });
  try { await b.evaluate(wait(`${el('production-login')} && !${el('production-login')}.disabled`)); }
  catch (error) { const details = await b.evaluate(`(()=>{const f=document.getElementById('fixture'),d=f?.contentDocument;return {frame:!!f,ready:d?.readyState,html:d?.documentElement?.outerHTML.slice(0,800),status:d?.getElementById('status')?.textContent,actions:window.fixture?.actions}})()`); throw Error(`${error.message}\n${JSON.stringify({details,errors:b.errors,network:b.network})}`); }
  await b.evaluate(`${el('production-username')}.value='fixture';${el('production-password')}.value='fixture-password'`);
  await click(b, 'production-login');
  await b.evaluate(wait(`${el('app')}.dataset.productionPage==='workspace' && !${el('production-project-open')}.disabled`));
}

// No production flow or security-regression test is executed here: all control
// responses and project/group requests below exist only in this isolated page.
test('Chromium: 项目/分组弹窗、IME/Enter、真实悬停与上传状态（隔离模型）', { skip: !existsSync(chrome), timeout:60000 }, async () => {
  const b = await browser();
  try {
    await openFixture(b);
    const modalStyles = [];
    for (const kind of ['project','group']) {
      const isProject = kind === 'project';
      if (!isProject) { await b.call('Emulation.setDeviceMetricsOverride', {width:360,height:640,deviceScaleFactor:1,mobile:false}); await b.evaluate("document.getElementById('fixture').style.width='360px'"); }
      const open = isProject ? 'production-project-open' : 'production-group-open';
      const create = isProject ? 'production-page-create-project' : 'production-page-create-group';
      const popover = isProject ? 'production-create-popover' : 'production-group-popover';
      const name = isProject ? 'production-create-name' : 'production-group-name';
      const submit = isProject ? 'production-create-submit' : 'production-group-submit';
      const cancel = isProject ? 'production-create-cancel' : 'production-group-cancel';
      const error = isProject ? 'production-create-error' : 'production-group-error';
      const path = isProject ? '/api/projects' : '/groups';
      const count = `fixture.requests.filter(r=>r.method==='POST'&&r.path.endsWith(${JSON.stringify(path)})).length`;
      await click(b, open);
      await b.evaluate(wait(`${el('app')}.dataset.productionPage===${JSON.stringify(isProject ? 'projects':'groups')}&&!${el(create)}.disabled`));
      await click(b, create);
      await b.evaluate(wait(`!${el(popover)}.hidden`));
      modalStyles.push(await b.evaluate(`(()=>{const p=${el(popover)},d=p.querySelector('[role=dialog]'),s=getComputedStyle(d),heading=getComputedStyle(d.querySelector('.modal-heading')),actions=getComputedStyle(d.querySelector('.modal-actions'));return {position:s.position,padding:s.padding,border:s.border,borderRadius:s.borderRadius,background:s.backgroundColor,heading:heading.display,actions:actions.display}})()`));
      await click(b, submit);
      assert.equal(await b.evaluate(`${el(error)}.hidden`), false, 'empty name reports an error');
      assert.equal(await b.evaluate(count), 0);

      await b.evaluate(`${el(name)}.focus()`);
      await b.call('Input.insertText',{text:'English'});
      await key(b,'Enter','Enter',13);
      assert.equal(await b.evaluate(`${el(name)}.value`), 'English');
      assert.equal(await b.evaluate(count), 0, 'ordinary input Enter must not submit');
      await b.evaluate(`${el(name)}.value='';${el(name)}.addEventListener('keydown',e=>{if(e.key==='Enter')${doc}.defaultView.fixtureIME={isComposing:e.isComposing,keyCode:e.keyCode}},{once:true})`);
      await b.call('Input.imeSetComposition',{text:'abc',selectionStart:3,selectionEnd:3});
      await key(b,'Enter','Enter',13);
      assert.equal(await b.evaluate(`${doc}.defaultView.fixtureIME.isComposing`), true, 'trusted Enter was delivered during real browser composition');
      await b.call('Input.insertText',{text:'abc'});
      assert.equal(await b.evaluate(`${el(name)}.value`), 'abc', 'English under composition remains intact');
      assert.equal(await b.evaluate(count), 0);
      await b.evaluate(`${el(name)}.value=''`);
      await b.call('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
      await key(b,'Enter','Enter',13);
      await b.call('Input.insertText',{text:'中文'});
      assert.equal(await b.evaluate(`${el(name)}.value`), '中文', 'Chinese composition remains intact');
      assert.equal(await b.evaluate(count), 0);
      assert.equal(await b.evaluate(`(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});${el(name)}.dispatchEvent(e);return e.defaultPrevented})()`), false, 'IME Enter is not cancelled');

      await b.evaluate(`${el(submit)}.focus()`);
      await key(b,'Enter','Enter',13);
      assert.equal(await b.evaluate(count), 0, 'trusted Enter on focused button does not submit');
      await b.evaluate(`(()=>{const t=${doc}.createElement('textarea');t.id='fixture-textarea';${el(popover)}.querySelector('[role=dialog]').append(t);t.focus()})()`);
      await b.call('Input.insertText',{text:'first'}); await key(b,'Enter','Enter',13,'\r'); await b.call('Input.insertText',{text:'second'});
      assert.equal(await b.evaluate(`${el('fixture-textarea')}.value`), 'first\nsecond', 'textarea newline is not globally intercepted');
      await b.evaluate(`${el(name)}.focus()`); await key(b,'Escape','Escape',27);
      assert.equal(await b.evaluate(`${el(popover)}.hidden`), true);
      assert.equal(await b.evaluate(`${el('app')}.dataset.productionPage`), isProject ? 'projects' : 'groups', 'Escape closes only the dialog');
      await click(b, create); assert.equal(await b.evaluate(`${el(name)}.value`), '中文', 'closing does not discard input');

      const geometry = await b.evaluate(`(()=>{const b=${el(cancel)}, r=b.getBoundingClientRect(), t=${doc}.createRange();t.selectNodeContents(b);const a=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,tx:a.left+a.width/2,ty:a.top+a.height/2,bg:getComputedStyle(b).backgroundColor}})()`);
      await b.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:geometry.x,y:geometry.y});
      await b.evaluate(wait(`getComputedStyle(${el(cancel)}).backgroundColor!==${JSON.stringify(geometry.bg)}`));
      const hovered = await b.evaluate(`getComputedStyle(${el(cancel)}).backgroundColor`);
      assert.notEqual(hovered, geometry.bg, 'close button shows hover');
      assert.ok(Math.abs(geometry.x-geometry.tx) < 2 && Math.abs(geometry.y-geometry.ty) < 2, `close glyph centered ${JSON.stringify(geometry)}`);
      await click(b, cancel); assert.equal(await b.evaluate(`${el(popover)}.hidden`), true);
      await click(b, create);
      await b.evaluate(`${el(name)}.value=${JSON.stringify(isProject ? '团队项目' : 'Team Group')}`);
      await click(b, submit);
      await b.evaluate(wait(`typeof fixture.releaseCreate==='function'`));
      await click(b, submit); assert.equal(await b.evaluate(count), 1, 'duplicate click cannot start a second request');
      await b.evaluate('fixture.releaseCreate();fixture.releaseCreate=null');
      await b.evaluate(wait(`${el('app')}.dataset.productionPage==='workspace' && !${el('production-group-open')}.disabled && ${el(isProject ? 'production-project-current':'production-group-current')}.textContent===${JSON.stringify(isProject ? '团队项目':'Team Group')}`));
      assert.equal(await b.evaluate(count), 1, 'one explicit click creates once');

      // Exercise both English and Chinese through each actual create path.
      const secondName = isProject ? 'Project English' : '中文分组';
      await click(b, open);
      await b.evaluate(wait(`${el('app')}.dataset.productionPage===${JSON.stringify(isProject ? 'projects':'groups')}&&!${el(create)}.disabled`));
      await click(b, create);
      await b.evaluate(`${el(name)}.value=${JSON.stringify(secondName)}`);
      await click(b, submit);
      await b.evaluate(wait(`typeof fixture.releaseCreate==='function'`));
      assert.equal(await b.evaluate(count), 2);
      await b.evaluate('fixture.releaseCreate();fixture.releaseCreate=null');
      await b.evaluate(wait(`${el('app')}.dataset.productionPage==='workspace' && !${el('production-group-open')}.disabled && ${el(isProject ? 'production-project-current':'production-group-current')}.textContent===${JSON.stringify(secondName)}`));
    }

    assert.deepEqual(modalStyles[0], modalStyles[1], 'project and group dialogs use the same component styling');
    const states = [
      [{phase:'committed',verified:true,total:3,done:3},'上传完成',true],
      [{phase:'committed',verified:false,total:3,done:3},'上传结果待确认',false],
      [{phase:'committed',verified:true,total:3,done:2},'部分上传未完成',false],
      [{phase:'committed',verified:true,total:0,done:0},'上传结果待确认',false],
      [{phase:'committed',verified:true,total:3,done:4},'上传结果待确认',false],
      [{phase:'committed',verified:true,total:3,done:'3'},'上传结果待确认',false],
      [{phase:'committed',total:3,done:3},'上传结果待确认',false],
      [{phase:'verifying',total:3,done:3},'正在核对',false],
      [{phase:'verificationPending',locked:true,total:3,done:3,error:'VISIBILITY_UNCONFIRMED'},'页面显示待确认',false],
      [{phase:'partial',locked:true,total:3,done:1,error:'HTTP_FAILED',httpStatus:403},'部分上传未完成',false],
      [{phase:'unknownCommit',locked:true,total:3,done:0,error:'HTTP_FAILED',httpStatus:504},'提交结果待确认',false],
      [{phase:'unknownPrepare',locked:true,sessionId:null,error:'REQUEST_TIMEOUT'},'准备结果待确认',false]
    ];
    const base = {production:true,sessionId:'session-fixture',locked:false,completed:[],mappingAvailable:true,exportTotal:3,exportDone:3};
    for (const [patch,label,success] of states) {
      await b.evaluate(`fixture.sendState(${JSON.stringify({...base,...patch})})`);
      assert.equal(await b.evaluate(`${el('progress-ring-phase')}.textContent`), label);
      const title = await b.evaluate(`${el('production-progress-title')}.textContent`);
      const status = await b.evaluate(`${el('status')}.textContent`);
      assert.equal(title === '上传完成',success,JSON.stringify(patch));
      if (!success) assert.doesNotMatch(status,/上传完成/);
      assert.doesNotMatch(status,/session-fixture|project-fixture|UNKNOWN_COMMIT|HTTP_FAILED|VISIBILITY_UNCONFIRMED/, 'do not expose internal identities or diagnostic codes');
      if (patch.locked) assert.equal(await b.evaluate(`${el('publish')}.disabled`), true, 'uncertain and partial states stay locked');
      assert.equal(await b.evaluate(`getComputedStyle(${el('status')}.parentElement).display`), 'flex', 'reason is actually visible');
      if (patch.httpStatus) assert.match(status, new RegExp('HTTP '+patch.httpStatus));
      if (patch.error === 'VISIBILITY_UNCONFIRMED') assert.match(status,/画板或分组尚未核对一致/);
      if (patch.phase === 'partial') { assert.equal(await b.evaluate(`${el('abort')}.disabled`),true); assert.match(status,/其余未完成/); }
      if (patch.sessionId === null) assert.equal(await b.evaluate(`${el('query')}.disabled`),true);
    }
    // A new-protocol operation can explicitly cancel its remaining work; it is
    // not the legacy partial state without an operation identity tested above.
    const operationPartial = {...base,phase:'partial',locked:true,operationId:'operation-fixture',total:3,done:1};
    await b.evaluate(`fixture.sendState(${JSON.stringify(operationPartial)})`);
    assert.equal(await b.evaluate(`${el('abort')}.disabled`),false,'partial operation offers explicit cancellation');
    assert.equal(await b.evaluate(`${el('publish')}.disabled`),true,'partial operation remains locked');
    assert.equal(await b.evaluate("fixture.actions.filter(a=>a==='abort').length"),0,'no automatic cancellation');
    const missingMapping = {...base,phase:'committed',verified:false,total:3,done:3,mappingAvailable:false};
    await b.evaluate(`fixture.sendState(${JSON.stringify(missingMapping)})`);
    assert.equal(await b.evaluate(`${el('production-recover-mapping')}.hidden`),false);
    assert.equal(await b.evaluate(`${el('production-recover-mapping')}.disabled`),false);
    const pending = {...base,phase:'verificationPending',locked:true,total:3,done:3,error:'HTTP_FAILED',httpStatus:503};
    await b.call('Emulation.setDeviceMetricsOverride', {width:360,height:480,deviceScaleFactor:1,mobile:false});
    await b.evaluate("document.getElementById('fixture').style.height='480px'");
    await b.evaluate(`fixture.sendState(${JSON.stringify(pending)})`);
    assert.equal(await b.evaluate(`${el('abort')}.disabled`),true);
    assert.equal(await b.evaluate(`getComputedStyle(${el('production-progress-page')}).overflowY`),'auto', 'short plugin window can scroll to recovery');
    assert.equal(await b.evaluate(`${el('progress-ring-caption')}.textContent`),'画板导出', '100% identifies export only, not completion');
    await b.evaluate(`${el('query')}.scrollIntoView({block:'nearest'})`);
    await click(b,'query');
    try { await b.evaluate(wait(`typeof fixture.releaseQuery==='function'`)); }
    catch (error) { const details=await b.evaluate(`(()=>{const q=${el('query')},r=q.getBoundingClientRect(),p=${el('production-progress-page')}.getBoundingClientRect();return {page:${el('app')}.dataset.productionPage,disabled:q.disabled,hidden:${el('recovery')}.hidden,query:{x:r.x,y:r.y,width:r.width,height:r.height},container:{y:p.y,height:p.height,scrollHeight:${el('production-progress-page')}.scrollHeight},hit:${doc}.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500),actions:fixture.actions,status:${el('status')}.textContent}})()`);throw Error(`${error.message}\n${JSON.stringify(details)}`); }
    let status = await b.evaluate(`${el('status')}.textContent`);
    assert.match(status,/正在查询/); assert.match(status,/HTTP 503/);
    await b.evaluate(`fixture.releaseQuery('REQUEST_TIMEOUT');fixture.releaseQuery=null`);
    await b.evaluate(wait(`${el('status')}.textContent.includes('连接超时') && !${el('query')}.disabled`));
    status = await b.evaluate(`${el('status')}.textContent`);
    assert.match(status,/HTTP 503/); assert.match(status,/连接超时/);
    assert.equal(await b.evaluate("fixture.actions.filter(a=>a==='publish').length"),0);
    assert.deepEqual(b.network.filter(url => /^https?:/.test(url)), [], 'no real HTTP(S) requests');
  } finally { await b.close(); }
});

test('Chromium: run 出错后保留待核对、部分提交、未验证及读取失败的状态和原因', { skip: !existsSync(chrome), timeout:60000 }, async () => {
  const b = await browser();
  try {
    await openFixture(b);
    const base = {production:true,sessionId:'session-fixture',locked:true,completed:[],mappingAvailable:true,verified:false,total:3,done:3,exportTotal:3,exportDone:3};
    const cases = [
      {state:{...base,phase:'verificationPending',error:'VISIBILITY_UNCONFIRMED'},button:'query',release:'releaseQuery',expected:[/项目页面是否显示尚未确认/,/画板或分组尚未核对一致/,/连接超时/]},
      {state:{...base,phase:'verificationPending',error:'HTTP_FAILED',httpStatus:503},button:'query',release:'releaseQuery',expected:[/项目页面是否显示尚未确认/,/连接未完成/,/HTTP 503/,/连接超时/]},
      {state:{...base,phase:'partial',done:1,error:'HTTP_FAILED',httpStatus:403,failureStage:'uploading'},button:'query',release:'releaseQuery',expected:[/已提交 1\/3 个画板，其余未完成/,/上传资源/,/连接未完成/,/HTTP 403/,/连接超时/]},
      {state:{...base,phase:'committed',mappingAvailable:false,error:'HTTP_FAILED',httpStatus:502},button:'production-recover-mapping',release:'releaseRecover',expected:[/上传是否全部完成尚未确认/,/连接未完成/,/HTTP 502/,/连接超时/]},
      {state:{...base,phase:'partial',done:1,error:'HTTP_FAILED',httpStatus:403,failureStage:'uploading'},button:'query',release:'releaseQuery',statusError:'BAD_SCHEMA',expected:[/上次已知状态/,/已提交 1\/3 个画板，其余未完成/,/HTTP 403/,/最新状态读取未完成/,/输入或服务响应无法确认/,/连接超时/]}
    ];
    for (const item of cases) {
      await b.evaluate(`fixture.statusError=null;fixture.sendState(${JSON.stringify(item.state)})`);
      await b.evaluate(`${el(item.button)}.scrollIntoView({block:'nearest'})`);
      const before = await b.evaluate("fixture.actions.filter(a=>a==='status').length");
      await click(b,item.button);
      await b.evaluate(wait(`typeof fixture.${item.release}==='function'`));
      assert.equal(await b.evaluate(`${el(item.button)}.disabled`),true,'actual run is busy while the synthetic request is held');
      await b.evaluate(`fixture.statusError=${JSON.stringify(item.statusError || null)};fixture.${item.release}('REQUEST_TIMEOUT');fixture.${item.release}=null`);
      await b.evaluate(wait(`fixture.actions.filter(a=>a==='status').length>${before} && !${el(item.button)}.disabled && ${el('status')}.textContent.includes('连接超时')`));
      const status = await b.evaluate(`${el('status')}.textContent`);
      for (const part of item.expected) assert.match(status,part,JSON.stringify(item.state));
      assert.doesNotMatch(status,/上传完成|session-fixture|HTTP_FAILED|VISIBILITY_UNCONFIRMED/);
      assert.equal(await b.evaluate(`${el('publish')}.disabled`),true);
      assert.equal(await b.evaluate(`getComputedStyle(${el('status')}.parentElement).display`),'flex');
    }
    assert.equal(await b.evaluate("fixture.actions.filter(a=>a==='publish').length"),0);
    assert.deepEqual(b.network.filter(url => /^https?:/.test(url)), [], 'no real HTTP(S) requests');
  } finally { await b.close(); }
});
