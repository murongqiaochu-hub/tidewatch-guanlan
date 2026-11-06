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
  for(const [,id] of baseline.toString().matchAll(/\bid="([^"]+)"/g))if(!['production-localhost','production-details','production-source','production-project-refresh','refresh','frame-details','frame-identities','production-raw-source','close','recovery','recovery-note','session-details','session','production-recover-mapping','query','abort'].includes(id) && !id.startsWith('production-source-') && !id.startsWith('production-bind') && !id.startsWith('production-binding-'))assert.ok(ids.includes(id),id);for(const id of ['production-localhost','production-details','production-source'])assert.ok(!ids.includes(id),id);
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
test('C34 candidate source byte pins re-baselined on 2026-11-06',async()=>{
  const raw=await source('测试/夹具/视觉基线源哈希.json');
  assert.equal(sha(raw),'160deb47cff6495317d250092256ba6c6f0d013584dbd5874a0415218c910fd3','fixture must be the reviewed C34 candidate baseline');
  const baseline=JSON.parse(raw);
  assert.equal(baseline.baseline,'C34-candidate-20261106');
  assert.equal(Object.keys(baseline.files).length,37);
  for(const [name,expected] of Object.entries(baseline.files)){
    assert.equal(sha(await source(name)),expected,`${name} pinned byte mismatch`);
  }
});

test('C34 retires exactly the documented legacy UI identities and no future deletion silently passes',async()=>{
  const baseline=(await source('测试/夹具/上线基线插件.html')).toString();
  const ids=text=>[...new Set([...text.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]))];
  const baselineIds=ids(baseline),currentIds=new Set(ids(html));
  // The complete C34 retirement set, including the source-binding/session widgets that
  // preceded the current task workflow. Pinning it (instead of an open-ended exemption
  // list) means a future removal of any *other* baseline ID fails this gate again.
  const retired=['abort','close','frame-details','frame-identities','production-bind-key','production-bind-source','production-binding-error','production-binding-note','production-binding-state','production-details','production-localhost','production-project-refresh','production-raw-source','production-recover-mapping','production-source','production-source-binding','production-source-confirm','production-source-key','production-source-title','production-source-url','query','recovery','recovery-note','refresh','session','session-details'];
  const missing=baselineIds.filter(id=>!currentIds.has(id)).sort();
  assert.deepEqual(missing,[...retired].sort(),'only the documented C34 retirement may remove baseline identities');
  for(const id of retired)assert.ok(!currentIds.has(id),`${id} must be absent, not merely exempted`);
  for(const id of baselineIds.filter(id=>!retired.includes(id)))assert.ok(currentIds.has(id),`${id} must remain present`);
});
