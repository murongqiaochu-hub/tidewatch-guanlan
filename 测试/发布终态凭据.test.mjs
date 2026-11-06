import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishing, installPublishing } from '../平台/发布.mjs';

function fixture(status='completed',project=true) {
  const catalog={projects:project?[{id:'p'}]:[],publishOperations:[{id:'op_a',projectId:'p',createdBy:'alice',status}],publishSessions:[]};
  let reads=0;
  const service=createPublishing({vault:{catalog,transact(){assert.fail('receipt must not mutate');}},auth:{actor(req){if(!req.user)throw Object.assign(new Error('unauthenticated'),{status:401});return req.user;}},permissions:{requireRead(user){reads++;if(user.revoked)throw Object.assign(new Error('revoked'),{status:403});}}});
  return {service,catalog,reads:()=>reads,req:{user:{id:'alice'}}};
}
for(const status of ['completed','cancelled']) test(`original actor can read narrow ${status} receipt after project deletion`,async()=>{
  const f=fixture(status,false),before=JSON.stringify(f.catalog),r=await f.service.operationReceipt(f.req,'op_a');
  assert.deepEqual(r,{operationId:'op_a',projectId:'p',status,terminal:true,projectDeleted:true});
  assert.equal(f.reads(),0);assert.equal(JSON.stringify(f.catalog),before);
});
test('receipt preserves live project permission and task ownership checks',async()=>{
  const f=fixture();await assert.rejects(f.service.operationReceipt({user:{id:'bob'}},'op_a'),{status:404});
  await assert.rejects(f.service.operationReceipt({user:{id:'alice',revoked:true}},'op_a'),{status:403});
  await assert.rejects(f.service.operationReceipt({},'op_a'),{status:401});
  assert.equal((await f.service.operationReceipt(f.req,'op_a')).terminal,true);
});
test('missing project never closes pending or absent operations',async()=>{
  const f=fixture('partial',false);await assert.rejects(f.service.operationReceipt(f.req,'op_a'),{status:404});await assert.rejects(f.service.operationReceipt(f.req,'unknown'),{status:404});
  const live=fixture('partial');assert.equal((await live.service.operationReceipt(live.req,'op_a')).terminal,false);
});
test('receipt is registered as GET only',()=>{
  const routes=[];installPublishing({route(method,pattern,handler){routes.push({method,pattern,handler});},vault:{},auth:{},permissions:{}});
  const matching=routes.filter(r=>r.pattern.test('/api/publish/operations/op_a/receipt'));assert.equal(matching.length,1);assert.equal(matching[0].method,'GET');
});
