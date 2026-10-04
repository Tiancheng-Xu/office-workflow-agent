import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserEvidence, Plan, Run } from '../src/contracts.js';
import { SqliteRepository } from '../src/runtime/sqlite.js';
import { createHandler } from '../src/runtime/handler.js';
import { ADAPTER_VERSION, DomainError } from '../src/runtime/repository.js';
import { BrowserExecutionError, createBrowserExecutor, type BrowserExecution } from '../src/browser/executor.js';
import { canonicalPayload, hash } from '../src/runtime/validation.js';

const origin='http://127.0.0.1:9182',secret='runtime-test-only-secret-of-at-least-32-characters';
const defaultPlan:Plan={requestId:'REQ-TEST-001',department:'研发部',item:'显示器',quantity:12,reason:'合成测试',source:'bounded-rule'};
async function harness(execute?:(input:BrowserExecution,h:Harness)=>Promise<void|BrowserEvidence>) {
  const dir=await mkdtemp(join(tmpdir(),'office-runtime-')),repository=new SqliteRepository(join(dir,'test.sqlite'));
  let timestamp=Date.now(),calls=0,plan={...defaultPlan};
  const h={} as Harness;
  const handler=createHandler({repository,sessionSecret:secret,publicOrigin:origin,now:()=>timestamp,proposePlan:async()=>({...plan}),executor:{execute:async input=>{calls++;if(execute)return execute(input,h);else await h.submit(input);}}});
  async function request(path:string,method='GET',payload?:unknown,session?:Client,customHeaders:Record<string,string>={}) {
    return handler(new Request(origin+path,{method,headers:{...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...(method==='GET'?{}:{origin,'content-type':'application/json'}),...customHeaders},...(payload===undefined?{}:{body:JSON.stringify(payload)})}));
  }
  Object.assign(h,{repository,handler,request,setPlan:(value:Plan)=>{plan=value;},advance:(ms:number)=>{timestamp+=ms;},calls:()=>calls,
    client:async()=>{const response=await request('/api/session');const value=await response.json() as any;return {cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:value.data.csrf};},
    propose:async(client:Client)=>{const response=await request('/api/propose','POST',{text:'为研发部登记12台显示器，需求编号REQ-TEST-001'},client);assert.equal(response.status,201);return (await response.json() as any).data as Run;},
    approve:async(client:Client,run:Run)=>{const response=await request(`/api/runs/${run.id}/approve`,'POST',{revision:run.revision,planHash:run.planHash,targetRevision:run.targetRevision},client);assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).data as Run;},
    action:async(client:Client,run:Run,action:string)=>{const response=await request(`/api/runs/${run.id}/${action}`,'POST',{},client);return {response,body:await response.json() as any};},
    submit:async(input:BrowserExecution)=>{
      const form=new URLSearchParams({run:input.run.id,cap:input.capability,revision:String(input.run.revision),planHash:input.run.planHash,targetRevision:String(input.run.targetRevision),adapterVersion:input.run.adapterVersion,requestId:input.run.plan.requestId,department:input.run.plan.department,item:input.run.plan.item,quantity:String(input.run.plan.quantity),reason:input.run.plan.reason});
      const response=await handler(new Request(origin+'/legacy/submit',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:form}));
      assert.equal(response.status,200,await response.clone().text());
    },close:async()=>{repository.close();await rm(dir,{recursive:true,force:true});}});
  return h;
}
interface Client {cookie:string;csrf:string;}
interface Harness {
  repository:SqliteRepository;handler:(request:Request)=>Promise<Response>;
  request:(path:string,method?:string,payload?:unknown,session?:Client,headers?:Record<string,string>)=>Promise<Response>;
  client:()=>Promise<Client>;propose:(client:Client)=>Promise<Run>;approve:(client:Client,run:Run)=>Promise<Run>;
  action:(client:Client,run:Run,action:string)=>Promise<{response:Response;body:any}>;
  submit:(input:BrowserExecution)=>Promise<void>;calls:()=>number;setPlan:(plan:Plan)=>void;advance:(ms:number)=>void;close:()=>Promise<void>;
}

test('signed opaque session, derived tenant and CSRF enforce tenant isolation',async()=>{
  const h=await harness();try {
    const a=await h.client(),b=await h.client(),run=await h.propose(a);
    assert.equal((await h.request('/api/runs','GET',undefined,b)).status,200);
    assert.deepEqual((await (await h.request('/api/runs','GET',undefined,b)).json() as any).data,[]);
    assert.equal((await h.action(b,run,'approve')).response.status,404);
    assert.equal((await h.request('/api/propose','POST',{text:'test',tenant:'victim'},a)).status,400);
    assert.equal((await h.request('/api/propose','POST',{text:'test'},a,{'x-csrf-token':'wrong'})).status,403);
    assert.equal((await h.request('/api/propose','POST',{text:'test'},a,{origin:'https://evil.example'})).status,403);
    assert.equal((await h.request('/api/runs','GET',undefined,{...a,cookie:a.cookie.slice(0,-1)+(a.cookie.endsWith('a')?'b':'a')})).status,401);
    const cookie=(await h.request('/api/session')).headers.get('set-cookie')!;
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/tenant/);
    const sec=createHandler({repository:h.repository,sessionSecret:secret,publicOrigin:'https://office.test',proposePlan:async()=>defaultPlan,executor:{execute:async()=>{}}});
    assert.match((await sec(new Request('https://office.test/api/session'))).headers.get('set-cookie')!,/Secure/);
  }finally {await h.close();}
});

test('finite plan schema and JSON reject unsupported fields, types and quantities',async()=>{
  const h=await harness();try {
    const c=await h.client();
    for(const plan of [{...defaultPlan,quantity:0},{...defaultPlan,quantity:101},{...defaultPlan,quantity:1.5},{...defaultPlan,item:'退款'},{...defaultPlan,requestId:'../evil'},{...defaultPlan,url:'https://evil.example'}]) {
      h.setPlan(plan as Plan);const response=await h.request('/api/propose','POST',{text:'test'},c);assert.equal(response.status,400);
    }
    assert.equal((await h.handler(new Request(origin+'/api/propose',{method:'POST',headers:{origin,cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:'{'}))).status,400);
  }finally{await h.close();}
});

test('approval binds exact hash, revision, target, adapter and expiry; cap cannot approve',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.propose(c);
    assert.equal((await h.action(c,run,'execute')).response.status,409);
    for(const altered of [{revision:2,planHash:run.planHash,targetRevision:0},{revision:1,planHash:'0'.repeat(64),targetRevision:0},{revision:1,planHash:run.planHash,targetRevision:1}])
      assert.equal((await h.request(`/api/runs/${run.id}/approve`,'POST',altered,c)).status,409);
    await h.approve(c,run);
    assert.equal((await h.request(`/api/runs/${run.id}/approve`,'POST',{revision:1,planHash:run.planHash,targetRevision:0},undefined,{'x-execution-capability':'x'})).status,401);
    h.advance(300_001);assert.equal((await h.action(c,run,'execute')).response.status,409);assert.equal(h.calls(),0);
  }finally{await h.close();}
});

test('stable tenant + requestId key prevents repeated writes and conflicts on altered payload',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    assert.equal((await h.action(c,run,'execute')).body.data.status,'verified');
    assert.equal((await h.action(c,run,'execute')).body.data.status,'verified');assert.equal(h.calls(),1);
    const same=await h.approve(c,await h.propose(c));
    const duplicate=(await h.action(c,same,'execute')).body.data;
    assert.equal(duplicate.status,'verified');assert.equal(duplicate.executionKey,run.executionKey);assert.equal(h.calls(),1);
    h.setPlan({...defaultPlan,quantity:13});const changed=await h.approve(c,await h.propose(c));
    assert.equal((await h.action(c,changed,'execute')).body.data.status,'blocked');assert.equal(h.calls(),1);
    assert.equal((await h.repository.health()).demands,1);
    const b=await h.client(),other=await h.approve(b,await h.propose(b));
    assert.equal((await h.action(b,other,'execute')).body.data.status,'verified');assert.equal((await h.repository.health()).demands,2);
  }finally{await h.close();}
});

test('concurrent execution CAS claims one browser and concurrent reconcile cannot interrupt it',async()=>{
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const h=await harness(async(input,h)=>{entered();await gate;await h.submit(input);});
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    const first=h.action(c,run,'execute');await ready;
    const results=await Promise.all(Array.from({length:20},()=>h.action(c,run,'execute')));
    assert.ok(results.every(result=>result.body.data.status==='executing'));
    assert.equal((await h.action(c,run,'reconcile')).body.data.status,'executing');
    release();assert.equal((await first).body.data.status,'verified');assert.equal(h.calls(),1);assert.equal((await h.repository.health()).demands,1);
  }finally {release();await h.close();}
});

test('ambiguous effect may be found; absent UNKNOWN never reissues a write',async()=>{
  for(const applied of [true,false]) {
    const h=await harness(async(input,h)=>{if(applied)await h.submit(input);throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);});
    try {
      const c=await h.client(),run=await h.approve(c,await h.propose(c));
      const result=(await h.action(c,run,'execute')).body.data;
      assert.equal(result.status,applied?'verified':'unknown');
      for(let i=0;i<3;i++)assert.equal((await h.action(c,run,'execute')).body.data.status,applied?'verified':'unknown');
      assert.equal(h.calls(),1);assert.equal((await h.repository.health()).demands,applied?1:0);
      assert.equal((await h.action(c,run,'approve')).response.status,400);
    }finally{await h.close();}
  }
});

test('definite browser guard failure records blocked with no effect and requires new approval',async()=>{
  const h=await harness(async()=>{throw new BrowserExecutionError('DOM_DRIFT',false);});
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c)),result=(await h.action(c,run,'execute')).body.data;
    assert.equal(result.status,'blocked');assert.equal(result.effectStatus,'none');assert.equal(result.error,'DOM_DRIFT');
    assert.equal((await h.action(c,run,'execute')).response.status,409);assert.equal(h.calls(),1);
  }finally{await h.close();}
});

test('cancel before submit stops write; after applied effect and late failure never downgrade verified',async()=>{
  for(const applied of [false,true]) {
    let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const h=await harness(async(input,h)=>{if(applied)await h.submit(input);entered();await gate;if(!applied)await h.submit(input);throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);});
    try {
      const c=await h.client(),run=await h.approve(c,await h.propose(c));
      const pending=h.action(c,run,'execute');await ready;
      const cancellation=(await h.action(c,run,'cancel')).body.data;
      assert.equal(cancellation.status,applied?'verified':'cancelled');release();
      assert.equal((await pending).body.data.status,applied?'verified':'cancelled');
      assert.equal((await h.repository.health()).demands,applied?1:0);
    }finally{release();await h.close();}
  }
});

test('legacy submit independently enforces cap, claim, payload, target and cancellation in real transaction',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c)),session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    const tokenHash=await hash('cap');await h.repository.issueCapability({tokenHash,tenantId:session!.tenantId,runId:run.id,revision:1,planHash:run.planHash,targetRevision:0,adapterVersion:ADAPTER_VERSION,expiresAt:Date.now()+30_000});
    const input={tokenHash,runId:run.id,revision:1,planHash:run.planHash,targetRevision:0,adapterVersion:ADAPTER_VERSION,plan:run.plan,now:Date.now()};
    await assert.rejects(h.repository.submitDemand(input),(error:any)=>error.code==='EXECUTION_NOT_CLAIMED');
    const executing={...run,status:'executing' as const,effectStatus:'unknown' as const,epoch:run.epoch+1};assert.ok(await h.repository.saveRunCAS(session!.tenantId,executing,run.epoch));
    for(const bad of [{...input,tokenHash:'invalid'},{...input,revision:2},{...input,plan:{...run.plan,quantity:13}},{...input,adapterVersion:'future'}])await assert.rejects(h.repository.submitDemand(bad),DomainError);
    const another=new SqliteRepository(h.repository.path);
    try {
      const same=await Promise.all([h.repository.submitDemand(input),another.submitDemand(input),h.repository.submitDemand(input)]);
      assert.ok(same.every(d=>d.payloadHash===run.planHash));assert.equal((await h.repository.health()).demands,1);assert.equal(await h.repository.getTargetRevision(session!.tenantId),1);
    }finally{another.close();}
  }finally{await h.close();}
});

test('target drift denies stale approved run; hash ignores planner source while binding procurement fields',async()=>{
  const h=await harness();try {
    const c=await h.client(),stale=await h.approve(c,await h.propose(c));
    h.setPlan({...defaultPlan,requestId:'REQ-TEST-002'});const second=await h.approve(c,await h.propose(c));await h.action(c,second,'execute');
    assert.equal((await h.action(c,stale,'execute')).response.status,409);assert.equal(h.calls(),1);
    assert.equal(await hash(canonicalPayload({...defaultPlan,source:'ollama'})),await hash(canonicalPayload(defaultPlan)));
  }finally{await h.close();}
});

test('real SQLite crash recovery, migration and backup restore preserve keys and make in-flight run UNKNOWN',async()=>{
  const h=await harness();let restored:SqliteRepository|undefined;
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));await h.action(c,run,'execute');
    h.setPlan({...defaultPlan,requestId:'REQ-CRASH-001'});const crash=await h.approve(c,await h.propose(c));
    const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    await h.repository.saveRunCAS(session!.tenantId,{...crash,status:'executing',effectStatus:'unknown',epoch:crash.epoch+1},crash.epoch);
    const backup=join(h.repository.path,'..','backup.sqlite'),target=join(h.repository.path,'..','restore.sqlite');
    await h.repository.backup(backup);restored=SqliteRepository.restore(backup,target);
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,3);
    assert.equal((await restored.health()).demands,1);assert.equal((await restored.getDemand(session!.tenantId,run.plan.requestId))!.executionKey,run.executionKey);
    assert.equal(await restored.recoverExecuting(Date.now()),1);assert.equal((await restored.getRun(session!.tenantId,crash.id))!.status,'unknown');assert.equal(await restored.recoverExecuting(Date.now()),0);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    const report=await (await h.request(`/api/runs/${run.id}/report`,'GET',undefined,c)).text();
    assert.doesNotMatch(report,/office_session|csrf|tokenHash|capability/);assert.equal(report.includes(c.csrf),false);assert.equal(report.includes(c.cookie),false);
  }finally{restored?.close();await h.close();}
});

test('expired cloud-style execution lease becomes UNKNOWN by query, without startup or new browser',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    const claim={...run,status:'executing' as const,effectStatus:'unknown' as const,epoch:run.epoch+1,events:[...run.events,{at:new Date().toISOString(),type:'execution-claimed',message:'synthetic crash fixture'}]};
    await h.repository.saveRunCAS(session!.tenantId,claim,run.epoch);
    const observed=(await h.action(c,run,'reconcile')).body.data;assert.equal(observed.status,'executing');assert.equal(observed.epoch,claim.epoch);
    h.advance(35_100);
    const listed=(await (await h.request('/api/runs','GET',undefined,c)).json() as any).data;
    assert.equal(listed[0].status,'unknown');assert.equal(listed[0].effectStatus,'unknown');
    assert.equal((await h.action(c,run,'execute')).body.data.status,'unknown');assert.equal(h.calls(),0);
  }finally{await h.close();}
});

test('planner errors are actionable 400 and streamed oversized bodies are rejected before parsing',async()=>{
  const h=await harness();try {
    const c=await h.client();
    const handler=createHandler({repository:h.repository,sessionSecret:secret,publicOrigin:origin,proposePlan:async()=>{throw new Error('private planner trace');},executor:{execute:async()=>{}}});
    const response=await handler(new Request(origin+'/api/propose',{method:'POST',headers:{origin,cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:JSON.stringify({text:'缺少数量'})}));
    const result=await response.json() as any;assert.equal(response.status,400);assert.equal(result.error.code,'PLAN_UNSUPPORTED');assert.match(result.error.message,/改写/);assert.doesNotMatch(JSON.stringify(result),/private/);
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(13000)));controller.close();}});
    const oversized=new Request(origin+'/api/propose',{method:'POST',headers:{origin,cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    assert.equal((await h.handler(oversized)).status,413);
  }finally{await h.close();}
});

test('capability persistence failure after durable claim becomes UNKNOWN and never launches a browser',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    h.repository.issueCapability=async()=>{throw new Error('synthetic DB outage');};
    assert.equal((await h.action(c,run,'execute')).body.data.status,'unknown');
    assert.equal((await h.action(c,run,'execute')).body.data.status,'unknown');assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
  }finally{await h.close();}
});

test('cancel-check stale absence cannot downgrade a real effect committed before the live cancel CAS',async()=>{
  let release!:()=>void,entered!:()=>void,execution!:BrowserExecution;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await harness(async input=>{execution=input;entered();await gate;throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);});
  let pending:Promise<{response:Response;body:any}>|undefined;
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    pending=h.action(c,run,'execute');await ready;
    const query=h.repository.getDemand.bind(h.repository);let injected=false;
    h.repository.getDemand=async(tenantId,requestId)=>{
      const before=await query(tenantId,requestId);
      if(!injected&&requestId===run.plan.requestId&&!before) {
        injected=true;
        // Reproduce the reviewer interleaving: the stale result stays undefined, but the
        // authorized legacy POST commits demand + applied run epoch before this Promise returns.
        await h.submit(execution);
        assert.equal((await h.repository.health()).demands,1);
        return undefined;
      }
      return before;
    };
    const cancelled=(await h.action(c,run,'cancel')).body.data as Run;
    assert.equal(injected,true);assert.equal(cancelled.status,'verified');assert.equal(cancelled.effectStatus,'applied');assert.ok(cancelled.result);
    const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    const persisted=await h.repository.getRun(session!.tenantId,run.id);
    // This is the state that must survive immediate process termination before executor returns.
    assert.equal(persisted!.status,'verified');assert.equal(persisted!.effectStatus,'applied');assert.equal(persisted!.result!.executionKey,run.executionKey);
    release();assert.equal((await pending).body.data.status,'verified');assert.equal((await h.repository.health()).demands,1);
  }finally{release();await pending?.catch(()=>{});await h.close();}
});

test('cancel retains applied evidence as UNKNOWN when fresh query is unavailable; late failure cannot erase it',async()=>{
  let release!:()=>void,entered!:()=>void,execution!:BrowserExecution;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await harness(async input=>{execution=input;entered();await gate;throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);});
  let pending:Promise<{response:Response;body:any}>|undefined;
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));pending=h.action(c,run,'execute');await ready;
    const query=h.repository.getDemand.bind(h.repository);let injected=false;
    h.repository.getDemand=async(tenantId,requestId)=>{
      const before=await query(tenantId,requestId);
      if(!injected&&requestId===run.plan.requestId&&!before){injected=true;await h.submit(execution);}
      // The effect is real; independent readback is intentionally unavailable for this failure case.
      return undefined;
    };
    const cancelled=(await h.action(c,run,'cancel')).body.data as Run;
    assert.equal(cancelled.status,'unknown');assert.equal(cancelled.effectStatus,'applied');assert.ok(cancelled.result);assert.equal(cancelled.error,'EFFECT_QUERY_UNCONFIRMED');
    const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    assert.equal((await h.repository.getRun(session!.tenantId,run.id))!.effectStatus,'applied');assert.equal((await h.repository.health()).demands,1);
    release();const late=(await pending).body.data as Run;
    assert.equal(late.status,'unknown');assert.equal(late.effectStatus,'applied');assert.ok(late.result);
    assert.equal(h.calls(),1);assert.equal((await h.action(c,run,'execute')).body.data.effectStatus,'applied');assert.equal(h.calls(),1);
  }finally{release();await pending?.catch(()=>{});await h.close();}
});

test('optional workspace context detects signed-cookie rotation before authenticated reads or writes',async()=>{
  const h=await harness();try {
    const a=await h.client(),b=await h.client(),run=await h.propose(a);
    const headers={'x-officeflow-context':a.csrf};
    for(const [path,method,payload] of [['/api/runs','GET',undefined],[`/api/runs/${run.id}/report`,'GET',undefined],['/api/propose','POST',{text:'test'}],[`/api/runs/${run.id}/cancel`,'POST',{}]] as const) {
      const denied=await h.request(path,method,payload,b,headers);assert.equal(denied.status,403);assert.equal((await denied.json() as any).error.code,'SESSION_CHANGED');
    }
    assert.equal((await h.request('/api/runs','GET',undefined,b,{'x-officeflow-context':b.csrf})).status,200);
    assert.equal((await h.request('/api/runs','GET',undefined,b)).status,200);
    assert.equal((await h.request('/api/session','GET',undefined,b,headers)).status,200);
    assert.equal((await h.request('/api/propose','POST',{text:'test'},a,{'x-officeflow-context':a.csrf,'x-csrf-token':'wrong'})).status,403);
    assert.equal((await h.repository.health()).runs,1);assert.equal(h.calls(),0);
  }finally{await h.close();}
});

test('real plan revision preserves request key, shows prior plan, refreshes target and revokes prior approval and cap',async()=>{
  let priorExecution!:BrowserExecution;
  const h=await harness(async input=>{priorExecution=input;throw new BrowserExecutionError('DOM_DRIFT',false);});
  try {
    const c=await h.client(),approved=await h.approve(c,await h.propose(c));
    const blocked=(await h.action(c,approved,'execute')).body.data as Run;
    assert.equal(blocked.status,'blocked');assert.equal(blocked.effectStatus,'none');
    h.setPlan({...defaultPlan,quantity:15});
    const response=await h.request(`/api/runs/${blocked.id}/revise`,'POST',{revision:blocked.revision,planHash:blocked.planHash,text:'为研发部登记15台显示器，需求编号REQ-TEST-001'},c);
    assert.equal(response.status,200);const revised=(await response.json() as any).data as Run;
    assert.equal(revised.revision,2);assert.equal(revised.previousRevision,1);assert.equal(revised.previousPlan!.quantity,12);assert.equal(revised.plan.quantity,15);
    assert.equal(revised.executionKey,blocked.executionKey);assert.equal(revised.targetRevision,0);assert.equal(revised.status,'draft');assert.equal(revised.effectStatus,'none');
    assert.equal(revised.approvedHash,undefined);assert.equal(revised.approvalExpiresAt,undefined);assert.equal(revised.browserEvidence,undefined);assert.equal(revised.result,undefined);assert.equal(revised.error,undefined);
    assert.notEqual(revised.planHash,blocked.planHash);assert.equal((await h.action(c,revised,'execute')).response.status,409);assert.equal((await h.request(`/api/runs/${revised.id}/approve`,'POST',{revision:blocked.revision,planHash:blocked.planHash,targetRevision:blocked.targetRevision},c)).status,409);
    const form=new URLSearchParams({run:priorExecution.run.id,cap:priorExecution.capability,revision:String(priorExecution.run.revision),planHash:priorExecution.run.planHash,targetRevision:String(priorExecution.run.targetRevision),adapterVersion:priorExecution.run.adapterVersion,requestId:priorExecution.run.plan.requestId,department:priorExecution.run.plan.department,item:priorExecution.run.plan.item,quantity:String(priorExecution.run.plan.quantity),reason:priorExecution.run.plan.reason});
    const staleSubmit=await h.handler(new Request(origin+'/legacy/submit',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:form}));
    assert.equal(staleSubmit.status,409);assert.equal((await staleSubmit.json() as any).error.code,'STALE_APPROVAL');assert.equal((await h.repository.health()).demands,0);assert.equal(h.calls(),1);
    await h.approve(c,revised);assert.equal((await h.action(c,revised,'execute')).body.data.status,'blocked');assert.equal(h.calls(),2);
  }finally{await h.close();}
});

test('draft and approved revisions require same requestId and stale concurrent revisions have one CAS winner',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    h.setPlan({...defaultPlan,requestId:'REQ-CHANGED-001'});
    const changed=await h.request(`/api/runs/${run.id}/revise`,'POST',{revision:run.revision,planHash:run.planHash,text:'other'},c);
    assert.equal(changed.status,409);assert.equal((await changed.json() as any).error.code,'REQUEST_ID_CHANGED');
    h.setPlan({...defaultPlan,quantity:15});
    const attempts=await Promise.all(Array.from({length:8},()=>h.request(`/api/runs/${run.id}/revise`,'POST',{revision:run.revision,planHash:run.planHash,text:'synthetic revision'},c)));
    assert.equal(attempts.filter(r=>r.status===200).length,1);assert.equal(attempts.filter(r=>r.status===409).length,7);
    const winner=(await (await h.request('/api/runs','GET',undefined,c)).json() as any).data[0] as Run;
    assert.equal(winner.revision,2);assert.equal(winner.plan.quantity,15);assert.equal(winner.status,'draft');assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
    const next=await h.request(`/api/runs/${run.id}/revise`,'POST',{revision:winner.revision,planHash:winner.planHash,text:'same request again'},c);
    assert.equal(next.status,200);assert.equal((await next.json() as any).data.previousRevision,2);
  }finally{await h.close();}
});

test('executing, UNKNOWN, verified and cancelled plans cannot be revised or implicitly reapproved',async()=>{
  for(const state of ['executing','unknown','verified','cancelled'] as const) {
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const h=await harness(state==='executing'?async()=>{entered();await gate;throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);}:state==='unknown'?async()=>{throw new BrowserExecutionError('BROWSER_INTERRUPTED',true);}:undefined);
    let pending:Promise<{response:Response;body:any}>|undefined;
    try {
      const c=await h.client(),run=await h.approve(c,await h.propose(c));
      if(state==='executing'){pending=h.action(c,run,'execute');await ready;}
      else if(state==='cancelled')await h.action(c,run,'cancel');
      else await h.action(c,run,'execute');
      h.setPlan({...defaultPlan,quantity:15});
      const denied=await h.request(`/api/runs/${run.id}/revise`,'POST',{revision:run.revision,planHash:run.planHash,text:'change'},c);
      assert.equal(denied.status,409);assert.equal((await denied.json() as any).error.code,'REVISION_NOT_ALLOWED');
      const listed=(await (await h.request('/api/runs','GET',undefined,c)).json() as any).data[0] as Run;
      assert.equal(listed.revision,1);assert.equal(listed.plan.quantity,12);assert.equal(listed.status,state);
      assert.equal((await h.request(`/api/runs/${run.id}/approve`,'POST',{revision:run.revision,planHash:run.planHash,targetRevision:run.targetRevision},c)).status,409);
    }finally{release();await pending?.catch(()=>{});await h.close();}
  }
});

test('slow revision planner cannot overwrite a concurrently claimed and verified procurement effect',async()=>{
  const h=await harness();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  let pending:Promise<Response>|undefined;
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));
    const reviseHandler=createHandler({repository:h.repository,sessionSecret:secret,publicOrigin:origin,proposePlan:async()=>{entered();await gate;return {...defaultPlan,quantity:15};},executor:{execute:async()=>{throw new Error('should not execute');}}});
    pending=reviseHandler(new Request(`${origin}/api/runs/${run.id}/revise`,{method:'POST',headers:{origin,cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:JSON.stringify({revision:run.revision,planHash:run.planHash,text:'change 12 to 15'})}));await ready;
    const effect=(await h.action(c,run,'execute')).body.data as Run;assert.equal(effect.status,'verified');release();
    assert.equal((await pending).status,409);
    const listed=(await (await h.request('/api/runs','GET',undefined,c)).json() as any).data[0] as Run;
    assert.equal(listed.plan.quantity,12);assert.equal(listed.revision,1);assert.equal(listed.effectStatus,'applied');assert.equal((await h.repository.health()).demands,1);
  }finally{release();await pending?.catch(()=>{});await h.close();}
});

test('fresh report distinguishes unavailable readback from persisted result',async()=>{
  const h=await harness(async(input,h)=>{
    await h.submit(input);
    return undefined;
  });
  try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));await h.action(c,run,'execute');
    h.repository.getDemand=async()=>{throw new Error('private credentials in unavailable DB query');};
    const response=await h.request(`/api/runs/${run.id}/report`,'GET',undefined,c),report=(await response.json() as any).data;
    assert.equal(response.status,200);assert.equal(report.schema,'office-agent-execution-proof-v1');assert.equal(report.database.effectStatus,'applied');assert.equal(report.database.hasPersistedResult,true);assert.equal(report.api.status,'unknown');assert.equal(report.api.queryStatus,'unavailable');assert.equal(report.api.demand,null);
    assert.doesNotMatch(JSON.stringify(report),/private credentials|csrf|tokenHash|office_session/);
  }finally{await h.close();}
});

test('receipt persistence removes injected credentials and does not change a concurrent cancel status or effect',async()=>{
  for(const cancelled of [false,true]) {
    let entered!:()=>void,release!:()=>void,capability='';
    const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    const h=await harness(async(input,h)=>{
      capability=input.capability;
      if(!cancelled)await h.submit(input);
      entered();await gate;
      return {...{startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),elapsedMs:1,origin,adapterVersion:input.run.adapterVersion,planHash:input.run.planHash,domMatched:true,payloadMatched:!cancelled,postObserved:!cancelled,registeredMarker:!cancelled},capability:input.capability,cookie:'private-cookie-sentinel',csrf:'private-csrf-sentinel',rawForm:'private-raw-form'} as BrowserEvidence;
    });
    let pending:Promise<{response:Response;body:any}>|undefined;
    try {
      const c=await h.client(),run=await h.approve(c,await h.propose(c));pending=h.action(c,run,'execute');await ready;
      const cancellation=(await h.action(c,run,'cancel')).body.data as Run;
      assert.equal(cancellation.status,cancelled?'cancelled':'verified');release();
      const finished=(await pending).body.data as Run;
      assert.equal(finished.status,cancelled?'cancelled':'verified');assert.equal(finished.effectStatus,cancelled?'unknown':'applied');assert.ok(finished.browserEvidence);
      const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
      const persisted=JSON.stringify(await h.repository.getRun(session!.tenantId,run.id));
      assert.equal(persisted.includes(capability),false);assert.doesNotMatch(persisted,/private-cookie-sentinel|private-csrf-sentinel|private-raw-form/);
      const report=await (await h.request(`/api/runs/${run.id}/report`,'GET',undefined,c)).text();assert.equal(report.includes(capability),false);assert.doesNotMatch(report,/private-cookie-sentinel|private-csrf-sentinel|private-raw-form/);
    }finally{release();await pending?.catch(()=>{});await h.close();}
  }
});

test('reconciliation requires the persisted execution key as well as payload hash',async()=>{
  const h=await harness();try {
    const c=await h.client(),run=await h.approve(c,await h.propose(c));await h.action(c,run,'execute');
    h.setPlan({...defaultPlan,requestId:'REQ-KEY-CHECK'});const second=await h.propose(c);
    const session=await h.repository.getSession(c.cookie.split('=')[1]!.split('.')[0]!);
    const wrong={requestId:second.plan.requestId,department:second.plan.department,item:second.plan.item,quantity:second.plan.quantity,reason:second.plan.reason,payloadHash:second.planHash,executionKey:'f'.repeat(64),createdAt:new Date().toISOString()};
    h.repository.db.prepare('INSERT INTO demands(tenant_id,request_id,payload_hash,execution_key,body) VALUES(?,?,?,?,?)').run(session!.tenantId,wrong.requestId,wrong.payloadHash,wrong.executionKey,JSON.stringify(wrong));
    const result=(await h.action(c,second,'reconcile')).body.data as Run;
    assert.equal(result.status,'blocked');assert.equal(result.error,'PAYLOAD_CONFLICT');assert.equal(result.effectStatus,'none');assert.equal(result.result,undefined);assert.equal(h.calls(),1);
  }finally{await h.close();}
});

test('revision rereads a changed target ledger and registers only the newly approved quantity',async()=>{
  const h=await harness();try {
    const c=await h.client(),original=await h.approve(c,await h.propose(c));
    h.setPlan({...defaultPlan,requestId:'REQ-ADVANCE-001'});const advancing=await h.approve(c,await h.propose(c));assert.equal((await h.action(c,advancing,'execute')).body.data.status,'verified');
    h.setPlan({...defaultPlan,quantity:15});
    const response=await h.request(`/api/runs/${original.id}/revise`,'POST',{revision:original.revision,planHash:original.planHash,text:'为研发部登记15台显示器，需求编号REQ-TEST-001'},c);
    assert.equal(response.status,200);const revised=(await response.json() as any).data as Run;
    assert.equal(revised.targetRevision,1);assert.equal(revised.previousPlan!.quantity,12);assert.equal(revised.plan.quantity,15);assert.equal(revised.approvedHash,undefined);assert.equal(h.calls(),1);
    assert.equal((await h.action(c,revised,'execute')).response.status,409);
    const newApproval=await h.approve(c,revised),effect=(await h.action(c,newApproval,'execute')).body.data as Run;
    assert.equal(effect.status,'verified');assert.equal(effect.result!.quantity,15);assert.equal(effect.executionKey,original.executionKey);assert.equal((await h.repository.health()).demands,2);assert.equal(h.calls(),2);
  }finally{await h.close();}
});

test('cloud preflight policy stops produce partial receipt without a browser POST or backend effect',async()=>{
  for(const code of ['BROWSER_PLAN_NOT_CONFIRMED','FREE_BROWSER_BUDGET_OR_INTERVAL_EXHAUSTED']) {
    const executor=createBrowserExecutor({browserFactory:async()=>{throw new BrowserExecutionError(code,false);}});
    const h=await harness(input=>executor.execute(input));try {
      const c=await h.client(),run=await h.approve(c,await h.propose(c)),result=(await h.action(c,run,'execute')).body.data as Run;
      assert.equal(result.status,'blocked');assert.equal(result.effectStatus,'none');assert.equal(result.browserEvidence!.stopCode,code);assert.equal(result.browserEvidence!.domMatched,false);assert.equal(result.browserEvidence!.postObserved,false);assert.equal(result.browserEvidence!.payloadMatched,false);assert.equal(result.browserEvidence!.registeredMarker,false);assert.equal((await h.repository.health()).demands,0);
    }finally{await h.close();}
  }
});
