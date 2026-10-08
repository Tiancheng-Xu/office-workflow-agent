import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractDemand,demandText,demandKey} from '../src/demand-input.ts';
import {boundedRulePlan} from '../src/planner.ts';
import {canonicalPayload,hash} from '../src/runtime/validation.ts';
import {createExecutionProof,verifyExecutionProof} from '../src/runtime/proof.ts';
import {collectHandoff} from '../src/ui/handoff.ts';
import type {Plan,Run,Demand} from '../src/contracts.ts';
const cases=[
 ['给行政买一打a4纸','行政部','A4纸',1,'打'],
 ['行政需要两包A4复印纸','行政部','A4复印纸',2,'包'],
 ['B5复印纸三箱送到行政','行政部','B5复印纸',3,'箱'],
 ['研发买2块M.2硬盘','研发部','M.2硬盘',2,'块'],
 ['给前台买一套打印机墨盒','前台','打印机墨盒',1,'套'],
 ['运营需要三个屏幕支架','运营部','屏幕支架',3,'个'],
 ['物品：USB-C扩展坞；数量：两；部门：研发','研发部','USB-C扩展坞',2,undefined],
 ['研发买两块2.5英寸硬盘','研发部','2.5英寸硬盘',2,'块'],
 ['行政买三支笔','行政部','笔',3,'支'],
 ['运营买一台MacBook','运营部','MACBOOK',1,'台'],
 ['行政买一盒回形针','行政部','回形针',1,'盒'],
] as const;
test('item specifications and packaging units survive natural input and workflow normalization',()=>{
 for(const [raw,department,item,quantity,unit] of cases){
  const extracted=extractDemand(raw);assert.deepEqual(extracted.issues,[],raw);assert.deepEqual(extracted.fields,{department,item,quantity,...(unit?{unit}:{})},raw);
  const normalized=demandText({...extracted.fields,requestId:'REQ-MEASURE-001'} as any),plan=boundedRulePlan(normalized);
  assert.equal(plan.item,item);assert.equal(plan.quantity,quantity);assert.equal(plan.unit,unit);
 }
});
test('packaging amount is not silently converted and unit changes create different semantic keys',()=>{
 const pack=extractDemand('行政买2包A4纸').fields,pieces=extractDemand('行政买2张A4纸').fields;
 assert.equal(pack.quantity,2);assert.equal(pack.unit,'包');assert.notEqual(demandKey(pack),demandKey(pieces));
 for(const raw of ['行政买半打A4纸','行政买一包半A4纸','行政买约两包A4纸','行政买两到三包A4纸','行政买两包A4纸和一盒笔','行政买两包A4纸，每包500张','行政买A4纸2','行政买两包A4纸，冰箱'])assert(extractDemand(raw).issues.length,raw);
});
test('unit participates in approval hash while legacy canonical bytes are unchanged',async()=>{
 const legacy:Plan={requestId:'REQ-LEGACY-001',department:'行政部',item:'显示器',quantity:2,reason:'合成采购需求登记',source:'bounded-rule'};
 assert.equal(canonicalPayload(legacy),'{"requestId":"REQ-LEGACY-001","department":"行政部","item":"显示器","quantity":2,"reason":"合成采购需求登记"}');
 const pack={...legacy,item:'A4纸',unit:'包'} as Plan,sheet={...pack,unit:'张'} as Plan;
 assert.notEqual(await hash(canonicalPayload(pack)),await hash(canonicalPayload(sheet)));
});
test('fresh proof and handoff verify the unit and detect a different persisted packaging unit',async()=>{
 const plan=boundedRulePlan('行政买两包A4纸，REQ-PROOF-001'),planHash=await hash(canonicalPayload(plan));
 const result:Demand={...plan,payloadHash:planHash,executionKey:'e'.repeat(64),createdAt:'2026-10-08T12:00:00.000Z'};
 const run:Run={id:'ed8f31b9-c8c0-4e72-b5ea-68d0f36ad019',revision:1,targetRevision:0,adapterVersion:'synthetic-procurement-v2',plan,planHash,status:'verified',effectStatus:'applied',result,executionKey:result.executionKey,events:[],epoch:1};
 const proof=await createExecutionProof(run,{checkedAt:result.createdAt,queryStatus:'found',demand:result});
 assert.equal(proof.schema,'office-agent-execution-proof-v2');assert.equal(proof.api.status,'verified');assert.equal(proof.api.checks.unit,true);assert(await verifyExecutionProof(proof));
 const bundle=await collectHandoff([run],{search:'',department:'all',phase:'all'} as any,async()=>proof,()=>true);assert.equal(bundle.summary.apiVerified,1);
 const mismatch=await createExecutionProof(run,{checkedAt:result.createdAt,queryStatus:'found',demand:{...result,unit:'张'}});assert.equal(mismatch.api.status,'mismatch');assert.equal(mismatch.api.checks.unit,false);
});
test('department names embedded in product nouns are not consumed as the demand department',()=>{
 const a=extractDemand('买两包行政文件夹');assert.equal(a.fields.department,undefined);assert.equal(a.fields.item,'行政文件夹');
 const b=extractDemand('给行政买2块技术部件');assert.equal(b.fields.department,'行政部');assert.equal(b.fields.item,'技术部件');
});
test('product-internal department words and measurement-like model digits retain their noun spans',()=>{
 const internal=extractDemand('买两台前台1号排队机');assert.equal(internal.fields.department,undefined);assert.equal(internal.fields.item,'前台1号排队机');
 const model=extractDemand('给行政买一台A4打印机');assert.deepEqual(model.issues,[]);assert.equal(model.fields.item,'A4打印机');assert.equal(model.fields.quantity,1);assert.equal(model.fields.unit,'台');
 assert.equal(boundedRulePlan('为行政部登记1台A4打印机，REQ-MODEL-001').item,'A4打印机');
});
test('an invalid or approximate quantity preserves its explicit unit and the unambiguous item for completion',()=>{
 for(const raw of ['行政买A4纸，数量：一百零一包','给行政买约两包A4纸']){
  const extracted=extractDemand(raw);assert.equal(extracted.fields.quantity,undefined);assert.equal(extracted.fields.unit,'包');assert.equal(extracted.fields.item,'A4纸');assert(extracted.issues.some(i=>i.field==='quantity'));
 }
});
test('declared product fields and pack-size specifications are not reinterpreted as purchase counts',()=>{
 for(const item of ['A4纸500张装','24件套工具','行政采购手册']){
  const text=demandText({department:'行政部',item,quantity:2,unit:'包',requestId:'REQ-SPEC-001'});const parsed=extractDemand(text);assert.deepEqual(parsed.issues,[],item);assert.equal(parsed.fields.item,item);assert.equal(parsed.fields.quantity,2);assert.equal(parsed.fields.unit,'包');
 }
 const raw=extractDemand('给行政买2包A4纸500张装');assert.deepEqual(raw.issues,[]);assert.equal(raw.fields.item,'A4纸500张装');assert.equal(raw.fields.quantity,2);
 const manual=extractDemand('买两本行政采购手册');assert.equal(manual.fields.department,undefined);assert.equal(manual.fields.item,'行政采购手册');
});
test('a department-like prefix in an item-first noun is kept, and an explicit recipient wins',()=>{
 const noun=extractDemand('行政采购手册两本');assert.equal(noun.fields.department,undefined);assert.equal(noun.fields.item,'行政采购手册');assert(noun.issues.some(i=>i.field==='department'));
 const recipient=extractDemand('行政采购手册两本给研发');assert.deepEqual(recipient.issues,[]);assert.equal(recipient.fields.department,'研发部');assert.equal(recipient.fields.item,'行政采购手册');
});
test('explicit recipients retain ownership for item-before-quantity grammar',()=>{
 for(const [raw,department,item,unit] of [['给行政采购A4纸两包','行政部','A4纸','包'],['给研发购买显示器一台','研发部','显示器','台']] as const){
  const parsed=extractDemand(raw);assert.deepEqual(parsed.issues,[]);assert.equal(parsed.fields.department,department);assert.equal(parsed.fields.item,item);assert.equal(parsed.fields.unit,unit);
 }
});
