import test from 'node:test';
import assert from 'node:assert/strict';
import { packagePluginRelease } from '../平台/插件发行.mjs';
import { pluginServiceOrigins, legacyLanOrigins } from '../平台/服务地址.mjs';
import { BRAND } from '../品牌/identity.mjs';
const origin='https://service.example.test';
const prefix=config=>`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify(config)});\n`;
const config={serviceOrigin:origin,serviceOrigins:[origin],allowLocalhost:false};
function files(mainConfig=config,uiConfig=mainConfig){
 const manifest={name:BRAND.pluginName,id:'heron-sync-stage0-local',api:'1.0.0',main:'main.js',ui:'ui.html',editorType:['figma'],documentAccess:'dynamic-page',networkAccess:{allowedDomains:[origin],reasoning:BRAND.networkReason}};
 return {'main.js':Buffer.from(prefix(mainConfig)+'void 0;'),'ui.html':Buffer.from('<meta name="independent-production" content="enabled"><script>\n'+prefix(uiConfig)+'void 0;</script>'),'manifest.json':Buffer.from(JSON.stringify(manifest))};
}
const pack=f=>packagePluginRelease(f,{serviceOrigin:origin,release:'C999',date:'2026-10-27'});
for(const legacy of ['HTTP://OLD-SERVICE.EXAMPLE.TEST:4318','http://OLD-SERVICE.EXAMPLE.TEST:4318','http://old-service.example.test:80','http://old-service.example.test:4318/path?x=1','http://user:pass@old.example.test','http://[::1]:4318','http://public.example.com']){
 test(`noncanonical or nonprivate runtime origins must not ship: ${legacy}`,()=>{
   assert.throws(()=>legacyLanOrigins({},legacy));
   assert.throws(()=>pack(files({...config,serviceOrigins:[origin,legacy]})));
 });
}
test('main/UI bootstrap origin, allowLocalhost and ordered list must agree before packaging',()=>{
 for(const override of [{serviceOrigin:'https://different.example.test'},{allowLocalhost:true},{serviceOrigins:[origin,'http://old.example.test:4318']}])assert.throws(()=>pack(files(config,{...config,...override})));
 assert.doesNotThrow(()=>pack(files()));
});
test('legacy config trims trailing slash, deduplicates and limits explicit origins',()=>{
 assert.deepEqual(pluginServiceOrigins(origin,{env:{},legacy:' http://old.example.test:4318/,http://old.example.test:4318 '}),[origin,'http://old.example.test:4318']);
 assert.throws(()=>pluginServiceOrigins(origin,{env:{},legacy:Array.from({length:8},(_,i)=>'http://old'+i+'.example.test').join(',')}));
});
