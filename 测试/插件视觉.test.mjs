// Structural and contrast checks only. Real Chrome MODEL-SDK screenshots are a separate gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = name => readFile(new URL('../'+name,import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const html = (await source('插件/ui.html')).toString(), css = (await source('插件/ui.css')).toString();
test('visual plugin preserves all actual deployed IDs and explicit non-commercial/local API boundaries',async()=>{
  const baseline=await source('测试/夹具/上线基线插件.html');assert.equal(sha(baseline),'0a0035dc6d06eb31afe3f6c750d1bf96a919805c4cd1c501f4815c7f6306626d');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);
  for(const [,id] of baseline.toString().matchAll(/\bid="([^"]+)"/g))if(!['production-localhost','production-details','production-source','production-project-refresh','refresh','frame-details','frame-identities','production-raw-source','close','recovery','recovery-note','session-details','session','production-recover-mapping','production-pending-tasks','query','abort'].includes(id) && !id.startsWith('production-source-') && !id.startsWith('production-bind') && !id.startsWith('production-binding-'))assert.ok(ids.includes(id),id);for(const id of ['production-localhost','production-details','production-source'])assert.ok(!ids.includes(id),id);
  assert.match(html,/name="independent-production" content="disabled"/);assert.match(html,/DRAFT · 新作者表达/);assert.match(html,/不代表已注册／发布的 Figma 插件/);assert.doesNotMatch(html,/https?:\/\/[^\s"<>]+\.(?:css|woff|ttf)/);
});
test('visual plugin introduces a real task hierarchy, compact selection and source disclosure instead of stacked generic cards',()=>{
  assert.match(html,/class="plugin-header"/);assert.match(html,/class="workflow-steps"/);assert.match(html,/class="selection-panel"/);assert.doesNotMatch(html,/id="production-source-binding"/);assert.match(html,/class="actions task-dock"/);
  assert.doesNotMatch(html,/class="card(?:["\s])/);assert.doesNotMatch(html,/id="production-source-confirm"/);assert.doesNotMatch(html,/id="(?:close|recovery|recovery-note|session-details|session|production-recover-mapping|production-pending-tasks|query|abort)"/);assert.match(html,/id="plugin-resize-edge"/);assert.match(html,/id="progress-ring"/);
  assert.match(css,/\.plugin-resize-edge:hover span/);assert.match(css,/\.progress-stages/);assert.match(css,/position: sticky/);assert.match(css,/min-height: 100dvh/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/focus-visible/);assert.match(css,/@media\(pointer:coarse\)/);assert.doesNotMatch(css,/@import|https?:\/\//);
});
test('visual plugin actual token aliases meet AA text, primary and 3:1 input-boundary contrast',()=>{
  const vars=new Map([...css.matchAll(/(--[\w-]+)\s*:\s*(#[a-f0-9]{6}|var\(--[\w-]+\))/g)].map(([,k,v])=>[k,v]));
  const resolve=(key,depth=0)=>{assert.ok(depth<8);const v=vars.get(key);assert.ok(v,key);return v.startsWith('#')?v.slice(1):resolve(v.slice(4,-1),depth+1)};
  const luminance=h=>h.match(/../g).map(s=>parseInt(s,16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
  for(const bg of ['--bg','--panel','--raised'])for(const fg of ['--ink','--muted','--accent','--danger'])assert.ok(contrast(resolve(fg),resolve(bg))>=4.5,fg+'/'+bg);
  assert.ok(contrast(resolve('--button-primary-bg'),resolve('--button-primary-fg'))>=4.5);assert.ok(contrast(resolve('--input-border'),resolve('--input-bg'))>=3);
});
test('C15 pins project-scoped groups and export corrections while retaining unrelated C11 physical code bytes',async()=>{
  const reviewedC12=new Map([['平台/账户项目.mjs','eca147c86ec999ab7a70814d4e346236fd50f315d6bb9f1c3d8bb39952fc7458'],['平台/仓库.mjs','8bcc677daad8e0d993069216ba45696990e0bcfb0f7134cb6a5be469bc4eb1ad'],['插件/exporter.mjs','ae9383f00d6855cf9e5cd8213492f379c1024aeb6f0920ffdedb201e8539e565'],['宿主/production-adapter.mjs','f7a1a325ab373b617227b56b8eb6d9370567c09c83e5fc1476f8ae28a9cfd47b']]);
  const raw=await source('测试/夹具/视觉基线源哈希.json');assert.equal(sha(raw),'f0fa33ae07700a93f42c953c18395466a2593b2c2e4611c847c7e1104a9f819d');const baseline=JSON.parse(raw);assert.equal(baseline.baselineArchiveSHA256,'dc9784331fed9dc45f6293fff3411159d7699d832b7c0f8cc28980ad782faf1b');assert.equal(Object.keys(baseline.files).length,37);
  for(const [name,expected]of Object.entries(baseline.files)){
    if(reviewedC12.has(name)){assert.equal(sha(await source(name)),reviewedC12.get(name),`${name} reviewed C12 byte pin`);continue;}
    if(['平台/启动.mjs','平台/服务.mjs','插件/bridge.mjs','插件/main.mjs','插件/production-protocol.mjs','插件/production-session.mjs','插件/protocol.mjs','插件/resize.mjs','平台/发布.mjs','平台/仓库.mjs','平台/项目数据.mjs','平台/资源.mjs'].includes(name))continue;
    const bytes=await source(name);
    if(name!=='平台/预览.mjs'){assert.equal(sha(bytes),expected,name);continue;}
    assert.equal(sha(bytes),'01f3209fa23523e3bf8ea766363fe895b69dfbaf702acbd7c34a5bcab80507ed','explicit reviewed C10 caller-only recovery');
    const text=bytes.toString(),start=text.indexOf('    async get(asset,request,{signal,reauthorize=()=>{}}={}) {'),end=text.indexOf('    async open(record,options={})',start);assert.ok(start>=0&&end>start);
    const historicalGet=`    async get(asset,request,{signal,reauthorize=()=>{}}={}) {
      demand(!closing,503,'preview_closing'); const key=JSON.stringify([asset.sha256,request,codec?.identity || null]);
      // Each caller authorizes independently even when work is deduplicated.
      reauthorize(); let task=flights.get(key);
      if(!task) { task=physical(asset,request,reauthorize,signal); flights.set(key,task); pending.add(task); task.finally(()=>{flights.delete(key);pending.delete(task);}).catch(()=>{}); }
      const record=await task; reauthorize(); cancelled(signal); return record;
    },
`;
    const normalized=(text.slice(0,start)+historicalGet+text.slice(end)).replace(', flightOwners=new WeakMap()','');
    assert.equal(sha(Buffer.from(normalized)),expected,'physical worker/FD/budgets/cache/header paths remain byte-identical');
  }
  const startup=(await source('平台/启动.mjs')).toString();assert.match(startup,/artifacts=\{pluginArchive:/);assert.doesNotMatch(startup,/HANDOFF_(?:SOURCE|LEGACY_SOURCE)_ARCHIVE/);
  const ui=(await source('插件/ui.mjs')).toString(),helper=ui.slice(ui.indexOf('function syncPluginPresentation'),ui.indexOf('function frameListIcon'));
  assert.match(helper,/dataset\.taskPhase/);assert.doesNotMatch(helper,/fetch|request\(|storage|publish\(/);assert.match(ui,/state\.locked === true/);assert.match(ui,/password.*value = ''/);
});
