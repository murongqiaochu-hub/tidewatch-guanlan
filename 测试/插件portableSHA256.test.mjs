import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createDigestProvider } from '../插件/portable-sha256.mjs';
import { createProductionHTTP } from '../插件/production-protocol.mjs';
const hex = bytes => Buffer.from(bytes).toString('hex');
const expected = bytes => createHash('sha256').update(bytes).digest('hex');
const noSubtle = {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)};
for (const size of [0,1,3,55,56,63,64,65,127,128,129,4096,65536,1000000]) test('portable FIPS SHA-256 matches node:crypto, bytes='+size, async () => {
  const bytes = new Uint8Array(size); bytes.fill(97);
  const output = await createDigestProvider(noSubtle).subtle.digest('SHA-256', bytes);
  assert.ok(output instanceof ArrayBuffer); assert.equal(output.byteLength,32); assert.equal(hex(output),expected(bytes));
});
test('published empty and abc SHA-256 vectors',async () => {
  const provider=createDigestProvider(noSubtle);
  assert.equal(hex(await provider.subtle.digest('SHA-256',new Uint8Array())), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(await provider.subtle.digest('SHA-256',new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('deterministic random bytes and nonzero byteOffset subviews; input is not mutated/copied',async () => {
  let seed=0x12345678; const parent=new Uint8Array(262281);
  for(let i=0;i<parent.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;parent[i]=seed&255;}
  const bytes=parent.subarray(19,parent.length-37),before=parent.slice();
  bytes.slice=()=>{throw new Error('input copy forbidden');};
  assert.equal(hex(await createDigestProvider(noSubtle).subtle.digest('SHA-256',bytes)),expected(bytes));assert.deepEqual(parent,before);
});
test('large hashing crosses real event-loop tasks periodically',async () => {
  let yields=0,ticks=0; const bytes=new Uint8Array(1024*1024);
  const provider=createDigestProvider(noSubtle,{yieldTask:()=>new Promise(resolve=>setTimeout(()=>{yields++;resolve();},0))});
  const timer=setInterval(()=>ticks++,0);
  try{assert.equal(hex(await provider.subtle.digest('SHA-256',bytes)),expected(bytes));}finally{clearInterval(timer);}
  assert.equal(yields,16);assert.ok(ticks>0);
});
test('native digest is preferred, bound to native subtle, and its exception never falls back',async () => {
  let calls=0,yields=0;const failure=new Error('native failed');const subtle={async digest(algorithm,bytes){assert.equal(this,subtle);assert.equal(algorithm,'SHA-256');calls++;if(calls===2)throw failure;return webcrypto.subtle.digest(algorithm,bytes);}};
  const provider=createDigestProvider({subtle},{yieldTask:async()=>{yields++;}}),bytes=new Uint8Array(100000);
  assert.equal(hex(await provider.subtle.digest('SHA-256',bytes)),expected(bytes));await assert.rejects(provider.subtle.digest('SHA-256',bytes),error=>error===failure);assert.equal(calls,2);assert.equal(yields,0);
});
test('only SHA-256 and Uint8Array accepted; no entropy substitute',async()=>{
  const provider=createDigestProvider(noSubtle);
  for(const algorithm of ['SHA-1','SHA-512','sha256',{name:'SHA-256'},null])await assert.rejects(provider.subtle.digest(algorithm,new Uint8Array()),TypeError);
  for(const bytes of [new ArrayBuffer(3),new DataView(new ArrayBuffer(3)),[1,2,3],'abc',null])await assert.rejects(provider.subtle.digest('SHA-256',bytes),TypeError);
  let called=false;const native={getRandomValues(bytes){assert.equal(this,native);called=true;return bytes.fill(123);}};const view=new Uint8Array(8);assert.equal(createDigestProvider(native).getRandomValues(view),view);assert.ok(called);assert.equal(createDigestProvider({}).getRandomValues,undefined);
});
test('HTTP upload secondary byte hash uses portable provider and mismatch never dispatches',async()=>{
  const bytes=new Uint8Array([1,2,3]),sha256=expected(bytes),calls=[];
  const client=createProductionHTTP({origin:'https://service.example',cryptoAPI:createDigestProvider(noSubtle),fetchAPI:async(url,options)=>{calls.push({url,options});return Response.json({ok:true,sha256,bytes:bytes.length,mime:'image/png'});}});
  client.setToken('synthetic-token');
  await client.upload('session-original',{sha256,bytes:bytes.length,mime:'image/png',data:bytes});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].options.body,bytes);
  await assert.rejects(client.upload('session-original',{sha256:'0'.repeat(64),bytes:bytes.length,mime:'image/png',data:bytes}),/BAD_BYTES/);assert.equal(calls.length,1);
});
