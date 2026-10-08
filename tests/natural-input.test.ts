import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedRulePlan,validatePlan} from '../src/planner.ts';
import {extractDemand,newRequestId,readQuantity} from '../src/demand-input.ts';
test('free ordering and Chinese quantities produce workflow fields including front desk printers',()=>{
 for(const text of ['前台买一台打印机，REQ-NATURAL-001','REQ-NATURAL-001 打印机一台给前台','帮前台购置1台打印设备，编号REQ-NATURAL-001']){
  const plan=boundedRulePlan(text);assert.equal(plan.department,'前台');assert.equal(plan.item,'打印机');assert.equal(plan.quantity,1);
 }
 assert.equal(boundedRulePlan('研发要两台屏幕，REQ-NATURAL-002').quantity,2);
 assert.equal(boundedRulePlan('行政采购二十把办公椅，REQ-NATURAL-003').quantity,20);
});
test('structured proposal validation matches semantic aliases rather than a default sentence',()=>{
 const p=validatePlan({requestId:'REQ-NATURAL-001',department:'前台',item:'打印机',quantity:1,unit:'台'},'REQ-NATURAL-001 前台需要一台打印设备','ollama');assert.equal(p.source,'ollama');
});
test('extraction preserves partial fields and distinguishes clarification from prohibited actions',()=>{
 const partial=extractDemand('买一台打印机');assert.equal(partial.fields.item,'打印机');assert.equal(partial.fields.quantity,1);assert.deepEqual(partial.issues.map(i=>i.field),['department']);
 assert.equal(extractDemand('前台买一台冰箱').fields.item,'冰箱');
 assert.equal(extractDemand('前台买一台打印机，转账').blocked,true);
 assert.equal(extractDemand('前台和研发部买一台打印机').blocked,true);
 for(const text of ['前台买约一台打印机','前台买一台到两台打印机','前台打印机数量：1.5','前台买一台打印机和冰箱'])assert(extractDemand(text).issues.length);
});
test('negative intent, payment, permission instructions and extra unknown items are not erased in normalization',()=>{
 for(const text of ['前台不买一台打印机','前台买一台打印机，不能登记','前台买一台打印机，支付','前台买一台打印机并提升权限','前台买一台打印机、冰箱','前台买一台打印机，冰箱','前台买一台打印机。冰箱','前台买一台打印机：冰箱','前台买一台打印机（冰箱）','前台买一台打印机\n冰箱','前台买一台打印机、用于办公的冰箱','前台买一台打印机、冰箱用于办公']){
  assert.equal(extractDemand(text).blocked,true,text);assert.throws(()=>boundedRulePlan(text+'，REQ-NEGATIVE-001'));
 }
 assert.equal(extractDemand('前台、打印机、数量一').blocked,false);
});
test('post-unit fractions and approximate quantities are not truncated to their integer prefix',()=>{
 for(const text of ['前台买一台半打印机','前台采购一套半键盘','前台买一台多打印机','前台买一台起打印机','前台买一台来打印机']){
  const extraction=extractDemand(text);assert.equal(extraction.fields.quantity,undefined,text);assert(extraction.issues.some(i=>i.field==='quantity'),text);assert.throws(()=>boundedRulePlan(text+'，REQ-POSTFIX-001'));
 }
});
test('compound accessories are not mistaken for their parent item; delivery clauses and longest aliases remain valid',()=>{
 for(const [text,item] of [['前台买一套打印机墨盒','打印机墨盒'],['前台买一个屏幕支架','屏幕支架'],['前台买一套键盘贴纸','键盘贴纸']])assert.equal(extractDemand(text!).fields.item,item,text);
 assert.equal(boundedRulePlan('行政办公室采购一台显示器，编号REQ-ALIAS-001').department,'行政部');
 assert.equal(boundedRulePlan('买一台打印机送到前台，编号REQ-DELIVERY-001').quantity,1);
});
test('field order and labeled quantity are accepted; the quantity decoder is finite and generated IDs are safe',()=>{
 assert.equal(boundedRulePlan('物品：打印设备；数量：一；归属：接待处；编号：REQ-FIELDS-001').quantity,1);
 for(const [s,n] of [['一',1],['两',2],['十',10],['十二',12],['二十',20],['九十九',99],['一百',100]] as const)assert.equal(readQuantity(s),n);
 for(const s of ['零','一百零一','二百','一二','001','+2','-1','1.5'])assert.equal(readQuantity(s),undefined);
 for(let i=0;i<100;i++){const id=newRequestId();assert.match(id,/^REQ-[A-Z0-9-]{3,48}$/);assert.equal(boundedRulePlan(`前台买一台打印机，编号${id}`).requestId,id);}
});
