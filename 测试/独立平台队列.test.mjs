import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadGate, createPlatform } from '../平台/服务.mjs'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
class Response extends EventEmitter{constructor(){super();this.destroyed=false;this.writableFinished=false;this.writableEnded=false;this.headersSent=false;this.headers={}}setHeader(k,v){this.headers[k]=v}writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);this.headersSent=true}end(data){this.data=data;this.writableEnded=true;this.writableFinished=true;this.emit('finish')}destroy(){this.destroyed=true;this.emit('close')}}
const request=()=>({aborted:false})
test('[MODEL lifecycle] closed response retains slot until physical handler settles',async()=>{const gate=createReadGate({capacity:1,waiting:2}),r1=new Response(),r2=new Response(),physical=deferred();let next=false;const first=gate.run(request(),r1,async()=>physical.promise);await turn();const second=gate.run(request(),r2,async()=>{next=true;r2.end()});r1.destroy();await turn();assert.equal(gate.diagnostics.active,1);assert.equal(gate.diagnostics.queued,1);assert.equal(next,false);physical.resolve();await Promise.all([first,second]);assert.equal(next,true);assert.equal(gate.diagnostics.active,0)})
test('[MODEL lifecycle] settled handler retains slot until response finishes',async()=>{const gate=createReadGate({capacity:1,waiting:2}),res=new Response(),run=gate.run(request(),res,async()=>{});await turn();assert.equal(gate.diagnostics.active,1);let idle=false;const wait=gate.idle().then(()=>idle=true);await turn();assert.equal(idle,false);res.end();await run;await wait;assert.equal(idle,true)})
test('[MODEL lifecycle] queued cancel removes only that waiter without invoking work',async()=>{const gate=createReadGate({capacity:1,waiting:2}),physical=deferred(),active=new Response(),queued=new Response();let invoked=false;const one=gate.run(request(),active,async()=>physical.promise);await turn();const two=gate.run(request(),queued,async()=>{invoked=true});queued.destroy();await two;assert.equal(gate.diagnostics.queued,0);assert.equal(gate.diagnostics.active,1);assert.equal(invoked,false);physical.resolve();active.end();await one})
test('[MODEL lifecycle] bounded queue gives503 without stealing active capacity',async()=>{const gate=createReadGate({capacity:1,waiting:1}),physical=deferred(),a=new Response(),b=new Response(),c=new Response();const one=gate.run(request(),a,async()=>physical.promise);await turn();const two=gate.run(request(),b,async()=>b.end());await gate.run(request(),c,async()=>assert.fail('overflow work invoked'));assert.equal(c.status,503);assert.equal(c.headers['Retry-After'],'1');assert.equal(gate.diagnostics.active,1);assert.equal(gate.diagnostics.queued,1);physical.resolve();a.end();await Promise.all([one,two])})
test('[MODEL lifecycle] thrown handler finishes safe error response and leaves no slot',async()=>{const gate=createReadGate(),res=new Response();await gate.run(request(),res,async()=>{throw new Error('must-not-leak-private-details')});assert.equal(res.status,500);const body=JSON.parse(res.data);assert.equal(body.error.code,'internal_error');assert.equal(res.data.toString().includes('must-not-leak'),false);assert.equal(gate.diagnostics.active,0)})
test('[MODEL lifecycle] headers already sent close instead of emitting second JSON',async()=>{const gate=createReadGate(),res=new Response();await gate.run(request(),res,async()=>{res.writeHead(200,{});throw new Error('fail')});assert.equal(res.status,200);assert.equal(res.destroyed,true);assert.equal(res.data,undefined);assert.equal(gate.diagnostics.active,0)})

test('[REAL TCP/REAL FD] four open files occupy read budget; client cancel does not release before close; health stays readable',async t=>{
  const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'owned-read-budget-')),nonce=crypto.randomBytes(20).toString('hex');await fs.chmod(directory,0o700);await fs.writeFile(path.join(directory,'OWNER'),nonce,{mode:0o600});await fs.chmod(path.join(directory,'OWNER'),0o600);const filename=path.join(directory,'owned-bytes');await fs.writeFile(filename,'self-generated-data',{mode:0o600});await fs.chmod(filename,0o600)
  const releases=[],started=deferred();let opened=0,closed=0,app
  t.after(async()=>{for(const item of releases)item.resolve();await app?.close();assert.equal(await fs.realpath(directory),directory);assert.equal(path.dirname(directory),parent);assert.equal(await fs.readFile(path.join(directory,'OWNER'),'utf8'),nonce);await fs.rm(directory,{recursive:true})})
  app=await createPlatform({dataDir:path.join(directory,'data'),secret:crypto.randomBytes(48),logger:{error(){}}})
  app.context.route('GET',/^\/api\/assets\/own-read-gate\/(?<id>\d+)$/,async(req,res)=>{const file=await fs.open(filename,'r'),release=deferred();releases.push(release);opened++;res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('a');if(opened===4)started.resolve();try{await release.promise;if(!res.destroyed)res.end('b')}finally{await file.close();closed++}},{public:true})
  const address=await app.listen(),origin='http://127.0.0.1:'+address.port,responses=await Promise.all([0,1,2,3].map(n=>fetch(origin+'/api/assets/own-read-gate/'+n)));await started.promise
  assert.equal(app.diagnostics().read.active,4);assert.equal(opened,4);assert.equal(closed,0)
  const health=await fetch(origin+'/api/health');assert.equal(health.status,200);await health.arrayBuffer()
  await responses[0].body.cancel();await turn();await turn();assert.equal(closed,0);assert.equal(app.diagnostics().read.active,4)
  for(const release of releases)release.resolve();for(const response of responses.slice(1))await response.arrayBuffer();await app.context.readGate.idle();assert.equal(closed,4);assert.equal(app.diagnostics().read.active,0)
})
