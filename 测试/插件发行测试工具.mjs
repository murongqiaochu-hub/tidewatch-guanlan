process.env.HANDOFF_PUBLIC_ORIGIN ||= 'https://service.example.test:49156';
// Small synthetic production-shaped archive fixtures; never Figma/business evidence.
import { packagePluginRelease } from '../平台/插件发行.mjs';
import { BRAND } from '../品牌/identity.mjs';
export const SYNTHETIC_ORIGIN = 'https://service.example.test:49156';
export function syntheticPluginFiles({origin=SYNTHETIC_ORIGIN}={}){
 const manifest={name:BRAND.pluginName,id:'heron-sync-stage0-local',api:'1.0.0',main:'main.js',ui:'ui.html',editorType:['figma'],documentAccess:'dynamic-page',networkAccess:{allowedDomains:[origin],reasoning:'Synthetic release contract fixture'}};
 return {'main.js':Buffer.from(`const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify({serviceOrigin:origin,serviceOrigins:[origin],allowLocalhost:false})});\nthrow new Error('SYNTHETIC_FIXTURE_NOT_A_REAL_PLUGIN');\n`),'ui.html':Buffer.from(`<html><head><meta name="independent-production" content="enabled"></head><body>Synthetic fixture only<script>const __INDEPENDENT_PRODUCTION__ = Object.freeze(${JSON.stringify({serviceOrigin:origin,serviceOrigins:[origin],allowLocalhost:false})});\nthrow new Error('SYNTHETIC_FIXTURE_NOT_A_REAL_PLUGIN');</script></body></html>`),'manifest.json':Buffer.from(JSON.stringify(manifest)+'\n')};
}
export function syntheticPluginRelease({origin=SYNTHETIC_ORIGIN}={}){return packagePluginRelease(syntheticPluginFiles({origin}),{serviceOrigin:origin,release:'C10',date:'2026-10-20'});}
