import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { D1Repository } from '../src/cloud/repository.js';
import type { Run } from '../src/contracts.js';
import { ADAPTER_VERSION, type Submission } from '../src/runtime/repository.js';
import { canonicalPayload, hash } from '../src/runtime/validation.js';
import { consumeBudget,claimBrowserSlot } from '../src/cloud/budget.js';

// Run the production adapter's SQL against real SQLite. This verifies SQL and
// atomic batch semantics locally; it is not a Cloudflare deployment receipt.
class SqliteD1 {
  readonly sql = new DatabaseSync(':memory:');
  beforeBatch?: () => void;
  constructor() { for (const file of ['001_initial.sql','002_resource_budget.sql','003_resource_window.sql']) this.sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8')); }
  prepare(query:string) {
    let values:any[]=[];
    const statement={
      bind:(...args:any[])=>{values=args;return statement;},
      first:async()=>this.sql.prepare(query).get(...values)??null,
      all:async()=>({results:this.sql.prepare(query).all(...values)}),
      run:async()=>{
        const info=this.sql.prepare(query).run(...values);
        return {success:true,results:[],meta:{changes:Number(info.changes)}};
      }
    };
    return statement;
  }
  async batch(statements:any[]) {
    this.beforeBatch?.();this.sql.exec('BEGIN IMMEDIATE');
    try { const result=[];for(const s of statements)result.push(await s.run());this.sql.exec('COMMIT');return result; }
    catch(error){this.sql.exec('ROLLBACK');throw error;}
  }
}
async function fixture(now=Date.now(),overrides:Partial<Run['plan']>={}) {
  const db=new SqliteD1(),repo=new D1Repository(db as unknown as D1Database);
  const tenant='synthetic-test';
  await repo.createSession({id:'session',tenantId:tenant,csrf:'synthetic-csrf',expiresAt:now+100000});
  const plan={requestId:'REQ-D1-001',department:'研发部' as const,item:'显示器' as const,quantity:2,reason:'合成采购需求登记',source:'bounded-rule' as const,...overrides};
  const planHash=await hash(canonicalPayload(plan));
  const run:Run={id:'run-d1',revision:1,plan,planHash,targetRevision:0,adapterVersion:ADAPTER_VERSION,status:'executing',effectStatus:'unknown',approvedHash:planHash,approvalExpiresAt:new Date(now+300000).toISOString(),executionKey:'synthetic-test:REQ-D1-001',events:[],epoch:2};
  await repo.createRun(tenant,run);
  await repo.issueCapability({tokenHash:'synthetic-cap-hash',tenantId:tenant,runId:run.id,revision:1,planHash,targetRevision:0,adapterVersion:ADAPTER_VERSION,expiresAt:now+30000});
  const input:Submission={tokenHash:'synthetic-cap-hash',runId:run.id,revision:1,planHash,targetRevision:0,adapterVersion:ADAPTER_VERSION,plan,now};
  return {db,repo,run,input,tenant};
}
test('D1 SQL atomic insert updates target once and records effect; duplicate is read only',async()=>{
  const f=await fixture();try {
    const first=await f.repo.submitDemand(f.input);
    assert.equal(first.executionKey,f.run.executionKey);
    assert.equal(await f.repo.getTargetRevision(f.tenant),1);
    assert.equal((await f.repo.getRun(f.tenant,f.run.id))!.effectStatus,'applied');
    assert.deepEqual(await f.repo.submitDemand(f.input),first);
    assert.equal(await f.repo.getTargetRevision(f.tenant),1);
    assert.equal((f.db.sql.prepare('SELECT count(*) AS n FROM demands').get()!).n,1);
  }finally{f.db.sql.close();}
});
test('D1 SQL rechecks live epoch after pre-read; concurrent cancel prevents all writes',async()=>{
  const f=await fixture();try {
    f.db.beforeBatch=()=>{f.db.beforeBatch=undefined;const next={...f.run,epoch:3,status:'cancelled'};f.db.sql.prepare('UPDATE runs SET epoch=3,status=?,body=? WHERE id=?').run('cancelled',JSON.stringify(next),f.run.id);};
    await assert.rejects(f.repo.submitDemand(f.input),(error:any)=>error.code==='TARGET_DRIFT');
    assert.equal(await f.repo.getDemand(f.tenant,f.run.plan.requestId),undefined);
    assert.equal(await f.repo.getTargetRevision(f.tenant),0);
  }finally{f.db.sql.close();}
});
test('D1 SQL rejects target change between validation and batch',async()=>{
  const f=await fixture();try {
    f.db.beforeBatch=()=>{f.db.beforeBatch=undefined;f.db.sql.prepare('UPDATE targets SET revision=1 WHERE tenant_id=?').run(f.tenant);};
    await assert.rejects(f.repo.submitDemand(f.input),(error:any)=>error.code==='TARGET_DRIFT');
    assert.equal(await f.repo.getDemand(f.tenant,f.run.plan.requestId),undefined);
    assert.equal((await f.repo.getRun(f.tenant,f.run.id))!.effectStatus,'unknown');
  }finally{f.db.sql.close();}
});
test('D1 SQL rejects revoked capability between validation and batch',async()=>{
  const f=await fixture();try {
    f.db.beforeBatch=()=>{f.db.beforeBatch=undefined;f.db.sql.exec('DELETE FROM capabilities');};
    await assert.rejects(f.repo.submitDemand(f.input),(error:any)=>error.code==='TARGET_DRIFT');
    assert.equal(await f.repo.getTargetRevision(f.tenant),0);
  }finally{f.db.sql.close();}
});
test('D1 SQL uses actual transaction clock even if pre-read time is stale',async()=>{
  const f=await fixture(Date.now()-60_000);try {
    await assert.rejects(f.repo.submitDemand(f.input),(error:any)=>error.code==='TARGET_DRIFT');
    assert.equal(await f.repo.getDemand(f.tenant,f.run.plan.requestId),undefined);
    assert.equal(await f.repo.getTargetRevision(f.tenant),0);
  }finally{f.db.sql.close();}
});
test('global free browser budget and launch spacing hold under concurrent isolates',async()=>{
  const db=new SqliteD1(),d1=db as unknown as D1Database,now=Date.now();
  try {
    assert.equal((await Promise.all(Array.from({length:20},()=>claimBrowserSlot(d1,now)))).filter(Boolean).length,1);
    assert.equal(await claimBrowserSlot(d1,now+29_999),false);
    for(let i=1;i<6;i++)assert.equal(await claimBrowserSlot(d1,now+i*30_000),true);
    assert.equal(await claimBrowserSlot(d1,now+6*30_000),false);
    assert.equal(db.sql.prepare("SELECT used FROM resource_budgets WHERE name='browser-launch'").get()!.used,6);
    assert.equal((await Promise.all(Array.from({length:20},()=>consumeBudget(d1,'model-test',12,now)))).filter(Boolean).length,12);
  }finally{db.sql.close();}
});

test('D1 rejects a unit change against approval and persists the original product specification and unit',async()=>{
 const f=await fixture(Date.now(),{item:'A4纸500张装',unit:'包'});try {
  await assert.rejects(f.repo.submitDemand({...f.input,plan:{...f.input.plan,unit:'张'}}),(error:any)=>error.code==='PAYLOAD_CONFLICT');
  assert.equal(await f.repo.getDemand(f.tenant,f.run.plan.requestId),undefined);
  const result=await f.repo.submitDemand(f.input);assert.equal(result.item,'A4纸500张装');assert.equal(result.unit,'包');assert.equal(result.quantity,2);
  assert.equal((await f.repo.getDemand(f.tenant,f.run.plan.requestId))!.unit,'包');assert.equal((await f.repo.getRun(f.tenant,f.run.id))!.result!.unit,'包');
  await f.repo.submitDemand(f.input);assert.equal(await f.repo.getTargetRevision(f.tenant),1);
 }finally{f.db.sql.close();}
});
