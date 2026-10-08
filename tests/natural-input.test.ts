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
 const p=validatePlan({requestId:'REQ-NATURAL-001',department:'前台',item:'打印机',quantity:1},'REQ-NATURAL-001 前台需要一台打印设备','ollama');assert.equal(p.source,'ollama');
});
test('extraction preserves partial fields and distinguishes clarification from prohibited actions',()=>{
 const partial=extractDemand('买一台打印机');assert.equal(partial.fields.item,'打印机');assert.equal(partial.fields.quantity,1);assert.deepEqual(partial.issues.map(i=>i.field),['department']);
 assert.equal(extractDemand('前台买一台冰箱').fields.item,undefined);
 assert.equal(extractDemand('前台买一台打印机，转账').blocked,true);
 assert.equal(extractDemand('前台和研发部买一台打印机').blocked,true);
 for(const text of ['前台买约一台打印机','前台买一台到两台打印机','前台打印机数量：1.5','前台买一台打印机和冰箱'])assert(extractDemand(text).issues.length);
});
test('field order and labeled quantity are accepted; the quantity decoder is finite and generated IDs are safe',()=>{
 assert.equal(boundedRulePlan('物品：打印设备；数量：一；归属：接待处；编号：REQ-FIELDS-001').quantity,1);
 for(const [s,n] of [['一',1],['两',2],['十',10],['十二',12],['二十',20],['九十九',99],['一百',100]] as const)assert.equal(readQuantity(s),n);
 for(const s of ['零','一百零一','二百','一二','001','+2','-1','1.5'])assert.equal(readQuantity(s),undefined);
 for(let i=0;i<100;i++){const id=newRequestId();assert.match(id,/^REQ-[A-Z0-9-]{3,48}$/);assert.equal(boundedRulePlan(`前台买一台打印机，编号${id}`).requestId,id);}
});
