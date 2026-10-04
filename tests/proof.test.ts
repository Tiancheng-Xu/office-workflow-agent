import test from 'node:test';
import assert from 'node:assert/strict';
import type { Demand, Run } from '../src/contracts.js';
import { createExecutionProof, verifyExecutionProof } from '../src/runtime/proof.js';

const planHash='7ad5afe4681d4b80ee4646bd2040e997346689a7708220ecdabdc543d4faa21c';
const executionKey='a'.repeat(64);
const checkedAt='2026-10-03T16:00:00.000Z';
function fixture():{run:Run;demand:Demand} {
  const demand:Demand={requestId:'REQ-PROOF-001',department:'研发部',item:'显示器',quantity:12,reason:'合成测试',payloadHash:planHash,executionKey,createdAt:'2026-10-03T15:58:01.000Z'};
  const run:Run={id:'c6e39d32-099b-4b50-a413-94447c79e5b3',revision:1,plan:{requestId:demand.requestId,department:demand.department,item:demand.item,quantity:demand.quantity,reason:demand.reason,source:'bounded-rule'},planHash,targetRevision:1,adapterVersion:'synthetic-procurement-v1',status:'verified',effectStatus:'applied',approvedHash:planHash,approvalExpiresAt:'2026-10-03T16:05:00.000Z',executionKey,events:[],epoch:3,result:{...demand},browserEvidence:{startedAt:'2026-10-03T15:58:00.000Z',completedAt:'2026-10-03T15:58:02.000Z',elapsedMs:2000,origin:'https://synthetic.example/legacy/form?run=secret&cap=private#receipt',adapterVersion:'synthetic-procurement-v1',planHash,domMatched:true,payloadMatched:true,postObserved:true,registeredMarker:true}};
  return {run,demand};
}

test('fresh API fields, hashes and execution key independently verify the accepted demand',async()=>{
  const {run,demand}=fixture();
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  assert.equal(proof.approval.status,'matched');
  assert.equal(proof.browser.status,'observed');
  assert.equal(proof.browser.sameAttempt,true);
  assert.equal(proof.browser.evidence?.origin,'https://synthetic.example');
  assert.equal(proof.browser.evidence?.postObserved,true);
  assert.equal(proof.browser.evidence?.registeredMarker,true);
  assert.equal(proof.database.effectStatus,'applied');
  assert.equal(proof.api.status,'verified');
  assert.deepEqual(proof.api.checks,{requestId:true,department:true,item:true,quantity:true,reason:true,payloadHash:true,canonicalHash:true,executionKey:true,planHash:true});
  assert.equal(proof.allowedNextAction,'query-only');
  assert.equal(await verifyExecutionProof(proof),true);
});

test('the first target revision is preserved when the valid storage revision is zero',async()=>{
  const {run,demand}=fixture();run.targetRevision=0;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  assert.equal(proof.run.targetRevision,0);
  assert.equal(proof.api.status,'verified');
});

test('every canonical field, stored hash and execution key must match instead of trusting a receipt',async()=>{
  const changes:Partial<Demand>[]=[{requestId:'REQ-PROOF-002'},{department:'运营部'},{item:'键盘'},{quantity:13},{reason:'不同需求'},{payloadHash:'b'.repeat(64)},{executionKey:'c'.repeat(64)}];
  for(const change of changes) {
    const {run,demand}=fixture();
    const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand:{...demand,...change}});
    assert.equal(proof.api.status,'mismatch',JSON.stringify(change));
    assert.equal(proof.allowedNextAction,'query-only');
    assert.equal(proof.database.effectStatus,'applied');
  }
});

test('changing the run payload while retaining an earlier hash cannot pass verification',async()=>{
  const {run,demand}=fixture();
  run.plan.quantity=13;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand:{...demand,quantity:13}});
  assert.equal(proof.api.status,'mismatch');
  assert.equal(proof.api.checks.planHash,false);
  assert.equal(proof.api.checks.canonicalHash,false);
});

test('UNKNOWN with no queried result stays query-only even after POST and a registered marker',async()=>{
  const {run}=fixture();run.status='unknown';run.effectStatus='unknown';delete run.result;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'not-found'});
  assert.equal(proof.browser.evidence?.registeredMarker,true);
  assert.equal(proof.database.effectStatus,'unknown');
  assert.equal(proof.api.status,'not-found');
  assert.equal(proof.allowedNextAction,'query-only');
});

test('UNKNOWN without a browser receipt or demand still does not authorize a repeated write',async()=>{
  const {run}=fixture();run.status='unknown';run.effectStatus='unknown';delete run.result;delete run.browserEvidence;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'not-found'});
  assert.equal(proof.browser.status,'not-observed');
  assert.equal(proof.database.hasPersistedResult,false);
  assert.equal(proof.api.status,'not-found');
  assert.equal(proof.allowedNextAction,'query-only');
});

test('a browser marker cannot promote an unconfirmed database effect or an absent API demand',async()=>{
  const {run}=fixture();run.status='unknown';run.effectStatus='none';delete run.result;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'not-found'});
  assert.equal(proof.browser.evidence?.postObserved,true);
  assert.equal(proof.browser.evidence?.registeredMarker,true);
  assert.equal(proof.database.effectStatus,'none');
  assert.equal(proof.api.status,'not-found');
  assert.equal(proof.allowedNextAction,'query-only');
});

test('action guidance requires a fresh approval before the first write and remains read-only during a query failure',async()=>{
  const {run}=fixture();run.effectStatus='none';delete run.result;delete run.browserEvidence;
  run.status='draft';delete run.approvedHash;delete run.approvalExpiresAt;
  assert.equal((await createExecutionProof(run,{checkedAt,queryStatus:'not-found'})).allowedNextAction,'approve');
  run.status='approved';run.approvedHash=planHash;run.approvalExpiresAt='2026-10-03T16:05:00.000Z';
  assert.equal((await createExecutionProof(run,{checkedAt,queryStatus:'not-found'})).allowedNextAction,'execute');
  assert.equal((await createExecutionProof(run,{checkedAt,queryStatus:'unavailable'})).allowedNextAction,'query-only');
  run.approvalExpiresAt=checkedAt;
  const expired=await createExecutionProof(run,{checkedAt,queryStatus:'not-found'});
  assert.equal(expired.approval.status,'expired');assert.equal(expired.allowedNextAction,'approve');
  run.status='cancelled';
  assert.equal((await createExecutionProof(run,{checkedAt,queryStatus:'not-found'})).allowedNextAction,'none');
});

test('a current query failure preserves persisted applied evidence without claiming current API verification',async()=>{
  const {run}=fixture();
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'unavailable'});
  assert.equal(proof.run.status,'verified');
  assert.equal(proof.database.effectStatus,'applied');
  assert.equal(proof.database.persistedResultMatchesPlan,true);
  assert.equal(proof.api.status,'unknown');
  assert.equal(proof.api.demand,null);
  assert.equal(proof.allowedNextAction,'query-only');
});

test('read deduplication verifies the API without inventing browser actions for the new run',async()=>{
  const {run,demand}=fixture();delete run.browserEvidence;
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  assert.equal(proof.api.status,'verified');
  assert.equal(proof.browser.status,'not-observed');
  assert.equal(proof.browser.evidence,null);
  assert.equal(proof.browser.sameAttempt,false);
  assert.equal(proof.browser.statement,'no-browser-action-recorded-for-this-run');
});

test('missing fresh demand cannot reuse the persisted result to verify the API',async()=>{
  const {run}=fixture();
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found'});
  assert.equal(proof.api.status,'unknown');
  assert.equal(proof.api.demand,null);
  assert.equal(proof.database.effectStatus,'applied');
  assert.equal(proof.allowedNextAction,'query-only');
});

test('the report whitelists every source and omits arbitrary properties and old capabilities',async()=>{
  const {run,demand}=fixture();
  Object.assign(run,{cookie:'COOKIE_SECRET',token:'TOKEN_SECRET',capability:'OLD_CAPABILITY',unexpected:{private:'RUN_SECRET'}});
  Object.assign(run.plan,{token:'PLAN_SECRET'});
  Object.assign(run.result!,{cap:'RESULT_SECRET'});
  Object.assign(run.browserEvidence!,{cookie:'BROWSER_SECRET',storage:{cap:'STORAGE_SECRET'},stopCode:'cap=STOP_SECRET'});
  run.events=[{at:checkedAt,type:'private',message:'EVENT_SECRET'}];run.error='ERROR_SECRET';
  Object.assign(demand,{cap:'DEMAND_SECRET',other:{cookie:'NESTED_SECRET'}});
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand,...{cap:'OBSERVATION_SECRET'}});
  const serialized=JSON.stringify(proof);
  assert.doesNotMatch(serialized,/SECRET|OLD_CAPABILITY|private#receipt|\?run=|\"cookie\"|\"token\"|\"cap\"|unexpected|storage/);
  assert.equal(proof.browser.evidence?.stopCode,'UNKNOWN_STOP');
  assert.equal(proof.api.status,'verified');
});

test('invalid or opaque browser origins never become usable browser evidence',async()=>{
  for(const origin of ['not a URL','javascript:alert(1)','data:text/plain,private']) {
    const {run,demand}=fixture();run.browserEvidence!.origin=origin;
    const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
    assert.equal(proof.browser.status,'invalid');
    assert.equal(proof.browser.evidence?.origin,null);
    assert.equal(proof.browser.sameAttempt,false);
    assert.equal(proof.api.status,'verified');
  }
});

test('browser evidence for an earlier plan or adapter is not proof of this execution',async()=>{
  const {run,demand}=fixture();run.browserEvidence!.planHash='d'.repeat(64);
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  assert.equal(proof.browser.sameAttempt,false);
  assert.equal(proof.browser.status,'invalid');
  assert.equal(proof.api.status,'verified');
});

test('the digest catches receipt, generated time and digest edits and ignores object key insertion order',async()=>{
  const {run,demand}=fixture();
  const proof=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  const changedReceipt=structuredClone(proof);changedReceipt.browser.evidence!.postObserved=false;
  assert.equal(await verifyExecutionProof(changedReceipt),false);
  const changedTime=structuredClone(proof);changedTime.generatedAt='2026-10-03T16:00:01.000Z';
  assert.equal(await verifyExecutionProof(changedTime),false);
  const changedDigest=structuredClone(proof);changedDigest.digest.value='0'.repeat(64);
  assert.equal(await verifyExecutionProof(changedDigest),false);
  const reordered=Object.fromEntries(Object.entries(proof).reverse());
  assert.equal(await verifyExecutionProof(reordered),true);
  assert.equal(await verifyExecutionProof(null),false);
  assert.equal(await verifyExecutionProof({...proof,digest:{algorithm:'unsigned',value:proof.digest.value}}),false);
});

test('proof generation uses the supplied observation time and does not mutate its inputs',async()=>{
  const {run,demand}=fixture(),beforeRun=structuredClone(run),beforeDemand=structuredClone(demand);
  const first=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  const second=await createExecutionProof(run,{checkedAt,queryStatus:'found',demand});
  assert.deepEqual(first,second);assert.deepEqual(run,beforeRun);assert.deepEqual(demand,beforeDemand);
  assert.equal(first.generatedAt,checkedAt);
});
