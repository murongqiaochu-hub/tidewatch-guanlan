// 仅重建本目录静态资产和预览；不是项目构建，不读应用数据。
import { writeFile } from 'node:fs/promises';
import { standaloneSVG } from './logo.mjs';
const here = new URL('./', import.meta.url);
for (const variant of ['duotone', 'mono', 'reverse']) await writeFile(new URL(`${variant}.svg`, here), standaloneSVG(variant));
const icon = (variant, size, decorative = false) => standaloneSVG(variant).replace('width="544" height="544"', `width="${size}" height="${size}"`).replace(decorative ? 'role="img" aria-label="观澜"' : 'unused', decorative ? 'aria-hidden="true"' : 'unused');
const panels = ['light', 'dark'].map(bg => `<section class="panel ${bg}"><h2>${bg === 'light' ? '浅色背景' : '深色背景'}</h2>${['duotone', 'mono', 'reverse'].map(v => `<div class="row"><div class="caption">${{duotone:'深青 + 玉绿',mono:'单色 · currentColor',reverse:'反白 · 白色填充'}[v]}</div>${[16,24,32,64,128].map(s => `<figure>${icon(v,s)}<figcaption>${s}px</figcaption></figure>`).join('')}</div>`).join('')}</section>`).join('');
await writeFile(new URL('preview.html', here), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>观澜 · 隔离品牌预览</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:40px;background:#eef2f1;color:#123039;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1120px;margin:auto}h1{margin:0;font-size:32px;letter-spacing:.12em}header p{color:#53686c;line-height:1.7;margin:12px 0 28px}.hero{display:flex;gap:72px;align-items:center;padding:32px 64px;background:white;border-radius:20px;margin-bottom:24px}.lockup{display:flex;align-items:center;gap:20px;font-size:56px;font-weight:600;letter-spacing:.08em}.panel{border-radius:16px;padding:24px;margin:20px 0}.light{background:#fff;color:#064852}.dark{background:#0c2026;color:#fff}.panel h2{font-size:18px;margin:0 0 12px}.row{display:flex;align-items:center;gap:24px;min-height:160px;border-top:1px solid #80969b44}.caption{width:168px;font-size:14px}figure{display:flex;flex-direction:column;align-items:center;justify-content:end;gap:10px;margin:0;min-width:48px}svg{display:block;flex:none}figcaption{font-size:12px;color:inherit;opacity:.7}.note{font-size:13px;line-height:1.8;color:#53686c}#checks{font-family:monospace;font-size:12px;white-space:pre-wrap}@media(max-width:760px){body{padding:16px}.hero{padding:24px;gap:24px;flex-wrap:wrap}.hero>svg{width:180px;height:180px}.lockup{font-size:36px}.row{gap:14px;flex-wrap:wrap;padding:16px 0}.caption{width:100%}}
</style></head><body><main><header><h1>观澜</h1><p>沿已认可参考手写还原 · 原生矢量母版 · 未接入现有应用</p></header>
<div class="hero">${icon('duotone',280)}<div class="lockup">${icon('duotone',112,true)}<span>观澜</span></div></div>
${panels}<p class="note">浅底反白不可见、深底双色对比偏低均为故意保留的对照；推荐浅底双色、深底反白。单色随容器 color。16px 保留母版，推荐 24px 起；端点有意收尖，不要求整条留白等宽。字标使用本机系统字体，不复刻参考字形。</p><output id="checks" aria-label="隔离视觉检查结果"></output></main>
<script>
const logos=[...document.querySelectorAll('svg')];
const checks={svgCount:logos.length,viewBox:logos.every(s=>s.getAttribute('viewBox')==='0 0 544 544'),paths:logos.every(s=>s.querySelectorAll('path').length===4),names:logos.every(s=>s.getAttribute('aria-hidden')==='true'||(s.getAttribute('role')==='img'&&s.getAttribute('aria-label')==='观澜')),noEmbeddedRaster:!document.querySelector('image,foreignObject'),sizes:[16,24,32,64,128].every(n=>logos.some(s=>s.getBoundingClientRect().width===n))};
document.getElementById('checks').textContent=JSON.stringify(checks,null,2);
</script></body></html>\n`);
console.log('Generated three SVG files and preview.html in the isolated directory.');
