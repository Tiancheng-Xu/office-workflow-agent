import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteRepository} from '../src/runtime/sqlite.js';
import {createHandler} from '../src/runtime/handler.js';
import type {MaterialCase,MaterialInput} from '../src/materials/types.js';
import type {Run,Plan} from '../src/contracts.js';
import {importTextSource} from '../src/materials/sources.js';
import {procurementDraft} from '../src/materials/review.js';
import {canonicalMaterialJson} from '../src/materials/service.js';
import {canonicalPayload,hash} from '../src/runtime/validation.js';
import {ADAPTER_VERSION} from '../src/runtime/repository.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import type {D1Database} from '@cloudflare/workers-types';
import {D1Repository} from '../src/cloud/repository.js';

const origin='http://127.0.0.1:9182',secret='material-runtime-only-test-secret-32-characters';
async function harness(){
 const dir=await mkdtemp(join(tmpdir(),'materials-')),repository=new SqliteRepository(join(dir,'db.sqlite'));let calls=0;
 const handler=createHandler({repository,sessionSecret:secret,publicOrigin:origin,proposePlan:async()=>{throw Error('no proposal');},executor:{execute:async()=>{calls++;}}});
 const request=(path:string,method='GET',payload?:unknown,c?:{cookie:string;csrf:string},headers:Record<string,string>={})=>handler(new Request(origin+path,{method,headers:{...(c?{cookie:c.cookie,'x-csrf-token':c.csrf}:{}),...(method==='GET'?{}:{origin,'content-type':'application/json'}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})}));
 const client=async()=>{const response=await request('/api/session');return {cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:(await response.json() as any).data.csrf};};
 return {repository,handler,request,client,calls:()=>calls,dir,close:async()=>{repository.close();await rm(dir,{recursive:true,force:true});}};
}
const record=(id=crypto.randomUUID()):MaterialCase=>({id,revision:1,input:{mode:'procurement',sources:[],decisions:[]},outcome:{status:'needs-review',candidates:[],findings:[],pending:0,confirmed:0},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
test('material repository creates tenant records and enforces strict revision CAS and 30-row list',async()=>{
 const h=await harness();try{
  const c=record();await h.repository.createMaterialCase('tenant-a',c);
  assert.deepEqual(await h.repository.getMaterialCase('tenant-a',c.id),c);
  assert.equal(await h.repository.getMaterialCase('tenant-b',c.id),undefined);
  assert.deepEqual(await h.repository.listMaterialCases('tenant-b'),[]);
  assert.equal(await h.repository.saveMaterialCaseCAS('tenant-a',{...c,revision:2},1),true);
  assert.equal(await h.repository.saveMaterialCaseCAS('tenant-a',{...c,revision:2},1),false);
  await assert.rejects(h.repository.saveMaterialCaseCAS('tenant-a',{...c,revision:4},2),/版本/);
  assert.equal(await h.repository.saveMaterialCaseCAS('tenant-b',{...c,revision:3},2),false);
  for(let i=0;i<29;i++)await h.repository.createMaterialCase('tenant-a',record());
  await assert.rejects(h.repository.createMaterialCase('tenant-a',record()),(error:any)=>error.code==='MATERIAL_LIMIT_REACHED');
  assert.equal((await h.repository.listMaterialCases('tenant-a')).length,30);
  assert.equal((await h.repository.health()).demands,0);assert.equal(h.calls(),0);
 }finally{await h.close();}
});
test('material endpoints authenticate before reading or parsing an oversized mutation',async()=>{
 const h=await harness();try{
  const a=await h.client(),b=await h.client();
  assert.equal((await h.request('/api/material-cases')).status,401);
  assert.equal((await h.request('/api/material-cases','POST',{},a,{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await h.request('/api/material-cases','POST',{},a,{origin:'https://evil.test'})).status,403);
  assert.equal((await h.request('/api/material-cases','GET',undefined,b,{'x-officeflow-context':a.csrf})).status,403);
  assert.equal((await h.request('/api/material-cases','POST',{text:'x'.repeat(12001)},a)).status,413);
  assert.equal((await h.request('/api/material-cases','GET',undefined,a)).status,200);
  assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});

async function input(text='部门：行政部；物品：A4纸；数量：2；单位：包；需求编号：REQ-MATERIAL-001'):Promise<MaterialInput>{return {mode:'procurement',sources:[await importTextSource(text,{id:'procurement-1',label:'合成采购',role:'procurement'})],decisions:[]};}
async function data(response:Response,status=200){assert.equal(response.status,status,await response.clone().text());return (await response.json() as any).data;}
const confirmations=(c:MaterialCase)=>c.outcome.candidates.map(candidate=>({candidateId:candidate.id,value:candidate.value,action:'confirm' as const,reason:''}));
async function tenant(h:Awaited<ReturnType<typeof harness>>,client:{cookie:string;csrf:string}){return (await h.repository.getSession(client.cookie.split('=')[1]!.split('.')[0]!))!.tenantId;}
async function draftRun(h:Awaited<ReturnType<typeof harness>>,client:{cookie:string;csrf:string},c:MaterialCase,overrides:Partial<Plan>={}){
 const plan={...procurementDraft(c.input).plan,...overrides};const run:Run={id:crypto.randomUUID(),revision:1,plan,planHash:await hash(canonicalPayload(plan)),targetRevision:0,adapterVersion:ADAPTER_VERSION,status:'draft',effectStatus:'none',executionKey:'synthetic-only',events:[],epoch:0};await h.repository.createRun(await tenant(h,client),run);return run;
}
test('strict material creation and review preserve sources and reject invalid candidate protocols',async()=>{
 const h=await harness();try{
  const a=await h.client(),b=await h.client(),body=await input();
  for(const bad of [{...body,tenantId:'other'},{...body,decisions:[{candidateId:'x',value:'',action:'confirm',reason:''}]},{...body,sources:[]},{...body,sources:Array(4).fill(body.sources[0])},{...body,mode:'trade'},{...body,sources:[{...body.sources[0],session:'secret'}]}])assert.equal((await h.request('/api/material-cases','POST',bad,a)).status,400);
  const c=await data(await h.request('/api/material-cases','POST',body,a),201) as MaterialCase;
  assert.equal(c.revision,1);assert.equal(c.outcome.status,'needs-review');assert.equal(c.outcome.pending,5);
  assert.equal((await h.request(`/api/material-cases/${c.id}`,'GET',undefined,b)).status,404);
  assert.equal((await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,b)).status,404);
  assert.deepEqual(await data(await h.request('/api/material-cases','GET',undefined,b)),[]);
  const ds=confirmations(c);
  for(const bad of [{revision:1,decisions:ds,mode:'trade'},{revision:1,decisions:ds,sources:body.sources},{revision:1,decisions:[{...ds[0],candidateId:'invented'}]},{revision:1,decisions:[ds[0],ds[0]]},{revision:1,decisions:[{...ds[0],action:'execute'}]},{revision:1,decisions:[{...ds[0],value:'研发部'}]},{revision:1,decisions:[{...ds[0],action:'dismiss',reason:''}]}])assert.equal((await h.request(`/api/material-cases/${c.id}/review`,'POST',bad,a)).status,400);
  const partial=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:[ds[0]]},a)) as MaterialCase;
  assert.equal(partial.outcome.status,'needs-review');assert.equal(partial.revision,2);assert.deepEqual(partial.input.sources,body.sources);
  assert.equal((await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:ds},a)).status,409);
  const attempts=await Promise.all(Array.from({length:6},()=>h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:2,decisions:ds},a)));
  assert.equal(attempts.filter(r=>r.status===200).length,1);assert.equal(attempts.filter(r=>r.status===409).length,5);
  const reviewed=await data(await h.request(`/api/material-cases/${c.id}`,'GET',undefined,a));assert.equal(reviewed.outcome.status,'consistent');assert.equal(reviewed.revision,3);
  assert.equal(h.calls(),0);assert.equal((await h.repository.health()).runs,0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
test('missing values need reasoned completion; invalid business fields remain needs-review and cannot link',async()=>{
 const h=await harness();try{
  const a=await h.client();const c=await data(await h.request('/api/material-cases','POST',await input('部门：行政部；物品：A4纸；数量：2；需求编号：REQ-MATERIAL-001'),a),201) as MaterialCase;
  const ds=confirmations(c);ds.find(d=>d.candidateId.includes(':unit:'))!.value='包';
  assert.equal((await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:ds},a)).status,400);
  ds.find(d=>d.candidateId.includes(':unit:'))!.reason='人工确认';ds.find(d=>d.candidateId.includes(':quantity:'))!.value='101';ds.find(d=>d.candidateId.includes(':quantity:'))!.reason='人工改值';
  const pending=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:ds},a));assert.equal(pending.outcome.status,'needs-review');
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:pending.revision,runId:crypto.randomUUID()},a)).status,409);
  assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
test('link requires exact tenant payload including unit and reason; report hashes canonical body and tracks stale run',async()=>{
 const h=await harness();try{
  const a=await h.client(),b=await h.client();let c=await data(await h.request('/api/material-cases','POST',await input(),a),201) as MaterialCase;
  c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:c.revision,decisions:confirmations(c)},a));
  const good=await draftRun(h,a,c),foreign=await draftRun(h,b,c);
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:foreign.id},a)).status,404);
  for(const overrides of [{unit:'件'},{quantity:3},{reason:'different'},{requestId:'REQ-DIFFERENT-001'}] as Partial<Plan>[]){const bad=await draftRun(h,a,c,overrides);assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:bad.id},a)).status,overrides.requestId?400:409);}
  const tenantId=await tenant(h,a);const corrupt=await draftRun(h,a,c);await h.repository.saveRunCAS(tenantId,{...corrupt,planHash:'0'.repeat(64),epoch:1},0);
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:corrupt.id},a)).status,409);
  c=await data(await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:good.id},a));assert.equal(c.linkedRun!.caseRevision,c.revision);
  let report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'matched');assert.equal(report.syntheticOnly,true);
  const {digest,...reportBody}=report;assert.equal(digest.value,await hash(canonicalMaterialJson(reportBody)));
  assert.doesNotMatch(JSON.stringify(report),/csrf|tokenHash|office_session|executionKey|approvalExpiresAt/);
  await h.repository.saveRunCAS(tenantId,{...good,revision:2,plan:{...good.plan,quantity:3},planHash:await hash(canonicalPayload({...good.plan,quantity:3})),epoch:1},0);
  report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'stale');assert.equal(report.link.runRevision,2);
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision-1,runId:good.id},a)).status,409);
  const rereview=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:c.revision,decisions:c.input.decisions},a));assert.equal(rereview.linkedRun,undefined);
  report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'not-linked');assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
test('link atomically rejects a Run changed or made effective after validation; fresh query failure is unavailable',async()=>{
 const h=await harness();try{
  const a=await h.client();let c=await data(await h.request('/api/material-cases','POST',await input(),a),201) as MaterialCase;c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:confirmations(c)},a));
  const tenantId=await tenant(h,a),run=await draftRun(h,a,c),read=h.repository.getRun.bind(h.repository);let race=true;
  h.repository.getRun=async(t,id)=>{const snapshot=await read(t,id);if(race&&id===run.id){race=false;await h.repository.saveRunCAS(tenantId,{...run,status:'executing',effectStatus:'unknown',epoch:1},0);}return snapshot;};
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:run.id},a)).status,409);assert.equal((await h.repository.getMaterialCase(tenantId,c.id))!.linkedRun,undefined);
  for(const status of ['executing','unknown','verified','cancelled','blocked'] as const){const r=await draftRun(h,a,c);await h.repository.saveRunCAS(tenantId,{...r,status,epoch:1},0);assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:r.id},a)).status,409);}
  const r=await draftRun(h,a,c);c=await data(await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:r.id},a));
  h.repository.getRun=async()=>{throw Error('private-query-secret');};const report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'unavailable');assert.doesNotMatch(JSON.stringify(report),/private-query-secret/);
  assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
test('trade materials save reviewed issues and report without generating or linking procurement effects',async()=>{
 const h=await harness();try{
  const a=await h.client();const contract=await importTextSource('Item: SSD; Quantity: 2; Unit: pcs; Currency: USD; Unit price: 0.1; Total: 0.2',{id:'contract',label:'合成合同',role:'contract'}),order=await importTextSource('Item: SSD; Quantity: 3; Unit: pcs; Currency: USD; Unit price: 0.1; Total: 0.4',{id:'order',label:'合成订单',role:'order'});
  let c=await data(await h.request('/api/material-cases','POST',{mode:'trade',sources:[contract,order],decisions:[]},a),201) as MaterialCase;
  c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:c.revision,decisions:confirmations(c)},a));assert.equal(c.outcome.status,'reviewed-with-issues');
  assert.equal((await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:crypto.randomUUID()},a)).status,400);
  const report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.case.outcome.status,'reviewed-with-issues');assert.equal(report.link.status,'not-linked');assert.equal(h.calls(),0);assert.equal((await h.repository.health()).runs,0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
test('material records and signed session survive SQLite backup restore with source decisions and link intact',async()=>{
 const h=await harness();let restored:SqliteRepository|undefined;try{
  const a=await h.client();let c=await data(await h.request('/api/material-cases','POST',await input(),a),201) as MaterialCase;c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:confirmations(c)},a));const r=await draftRun(h,a,c);c=await data(await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:r.id},a));
  const backup=join(h.dir,'backup.sqlite');await h.repository.backup(backup);restored=SqliteRepository.restore(backup,join(h.dir,'restored.sqlite'));
  assert.deepEqual(await restored.getMaterialCase(await tenant(h,a),c.id),c);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,4);
  const handler=createHandler({repository:restored,sessionSecret:secret,publicOrigin:origin,proposePlan:async()=>{throw Error('no proposal');},executor:{execute:async()=>{throw Error('no browser');}}});const response=await handler(new Request(`${origin}/api/material-cases/${c.id}/report`,{headers:{cookie:a.cookie}}));assert.equal((await data(response)).link.status,'matched');
 }finally{restored?.close();await h.close();}
});
class MaterialSqliteD1{
 readonly sql=new DatabaseSync(':memory:');
 constructor(){for(const file of ['001_initial.sql','002_resource_budget.sql','003_resource_window.sql','004_material_cases.sql'])this.sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));}
 prepare(query:string){let values:any[]=[];const statement={bind:(...args:any[])=>{values=args;return statement;},first:async()=>this.sql.prepare(query).get(...values)??null,all:async()=>({results:this.sql.prepare(query).all(...values)}),run:async()=>{const result=this.sql.prepare(query).run(...values);return {success:true,results:[],meta:{changes:Number(result.changes)}};}};return statement;}
}
test('D1 material adapter executes new SQL on SQLite with tenant CAS and live Run linking guard',async()=>{
 const db=new MaterialSqliteD1(),repo=new D1Repository(db as unknown as D1Database);try{
  const c=record();await repo.createMaterialCase('tenant',c);assert.deepEqual(await repo.getMaterialCase('tenant',c.id),c);assert.equal(await repo.getMaterialCase('other',c.id),undefined);
  assert.equal(await repo.saveMaterialCaseCAS('tenant',{...c,revision:2},1),true);assert.equal(await repo.saveMaterialCaseCAS('tenant',{...c,revision:2},1),false);await assert.rejects(repo.saveMaterialCaseCAS('tenant',{...c,revision:4},2),/版本/);
  const plan:Plan={requestId:'REQ-MATERIAL-001',department:'行政部',item:'A4纸',quantity:2,unit:'包',reason:'合成采购需求登记',source:'bounded-rule'};const run:Run={id:crypto.randomUUID(),revision:1,plan,planHash:await hash(canonicalPayload(plan)),targetRevision:0,adapterVersion:ADAPTER_VERSION,status:'draft',effectStatus:'none',executionKey:'synthetic',events:[],epoch:0};await repo.createRun('tenant',run);
  const linked={...c,revision:3,linkedRun:{id:run.id,revision:1,planHash:run.planHash,caseRevision:3}};
  assert.equal(await repo.saveMaterialCaseCAS('other',linked,2),false);assert.equal(await repo.saveMaterialCaseCAS('tenant',linked,2),true);
  await repo.saveRunCAS('tenant',{...run,status:'executing',effectStatus:'unknown',epoch:1},0);
  assert.equal(await repo.saveMaterialCaseCAS('tenant',{...linked,revision:4,linkedRun:{...linked.linkedRun,caseRevision:4}},3),false);
  for(let i=0;i<29;i++)await repo.createMaterialCase('tenant',record());await assert.rejects(repo.createMaterialCase('tenant',record()),(error:any)=>error.code==='MATERIAL_LIMIT_REACHED');assert.equal((await repo.listMaterialCases('tenant')).length,30);assert.deepEqual(await repo.listMaterialCases('other'),[]);assert.equal(db.sql.prepare('SELECT count(*) AS n FROM demands').get()!.n,0);
 }finally{db.sql.close();}
});

test('material case limit atomically accepts 30 tenant records under concurrent creates',async()=>{
 const h=await harness();try{const a=await h.client(),b=await h.client(),body=await input();const responses=await Promise.all(Array.from({length:35},()=>h.request('/api/material-cases','POST',body,a)));assert.equal(responses.filter(r=>r.status===201).length,30);assert.equal(responses.filter(r=>r.status===429).length,5);assert.equal((await data(await h.request('/api/material-cases','GET',undefined,a))).length,30);assert.equal((await h.request('/api/material-cases','POST',body,b)).status,201);assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);}finally{await h.close();}
});
test('valid Chinese source identifier keeps encoded candidate IDs reviewable',async()=>{
 const h=await harness();try{const a=await h.client(),body=await input();body.sources[0]!.id='材'.repeat(80);let c=await data(await h.request('/api/material-cases','POST',body,a),201) as MaterialCase;assert(c.outcome.candidates.every(v=>v.id.length>256));c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:confirmations(c)},a));assert.equal(c.outcome.status,'consistent');}finally{await h.close();}
});
test('D1 material case limit is atomic across concurrent tenant creates',async()=>{
 const db=new MaterialSqliteD1(),repo=new D1Repository(db as unknown as D1Database);try{const results=await Promise.allSettled(Array.from({length:35},()=>repo.createMaterialCase('tenant',record())));assert.equal(results.filter(r=>r.status==='fulfilled').length,30);const denied=results.filter(r=>r.status==='rejected');assert.equal(denied.length,5);for(const result of denied)assert.equal((result as PromiseRejectedResult).reason.code,'MATERIAL_LIMIT_REACHED');assert.equal((await repo.listMaterialCases('tenant')).length,30);await repo.createMaterialCase('other',record());assert.equal((await repo.listMaterialCases('other')).length,1);}finally{db.sql.close();}
});
test('material report uses a case whitelist and separately detects hash or case revision drift',async()=>{
 const h=await harness();try{
  const a=await h.client();let c=await data(await h.request('/api/material-cases','POST',await input(),a),201) as MaterialCase;c=await data(await h.request(`/api/material-cases/${c.id}/review`,'POST',{revision:1,decisions:confirmations(c)},a));const run=await draftRun(h,a,c);c=await data(await h.request(`/api/material-cases/${c.id}/link`,'POST',{revision:c.revision,runId:run.id},a));
  const tenantId=await tenant(h,a);h.repository.db.prepare('UPDATE material_cases SET body=? WHERE tenant_id=? AND id=?').run(JSON.stringify({...c,sessionSecret:'private-sentinel',csrf:'private-csrf-sentinel',outcome:{...c.outcome,capability:'private-cap-sentinel'}}),tenantId,c.id);
  let report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'matched');assert.doesNotMatch(JSON.stringify(report),/private-sentinel|private-csrf-sentinel|private-cap-sentinel|capability|sessionSecret/);
  await h.repository.saveRunCAS(tenantId,{...run,planHash:'f'.repeat(64),epoch:1},0);report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'stale');assert.equal(report.link.runRevision,1);
  await h.repository.saveRunCAS(tenantId,{...run,epoch:2},1);h.repository.db.prepare('UPDATE material_cases SET body=? WHERE tenant_id=? AND id=?').run(JSON.stringify({...c,linkedRun:{...c.linkedRun,caseRevision:c.revision-1}}),tenantId,c.id);report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'stale');
  h.repository.db.prepare('DELETE FROM runs WHERE tenant_id=? AND id=?').run(tenantId,run.id);report=await data(await h.request(`/api/material-cases/${c.id}/report`,'GET',undefined,a));assert.equal(report.link.status,'unavailable');assert.equal(h.calls(),0);assert.equal((await h.repository.health()).demands,0);
 }finally{await h.close();}
});
