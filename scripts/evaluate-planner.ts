import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {boundedRulePlan,proposePlan} from '../src/planner.js';
const cases=[
  {text:'为研发部登记12台显示器，需求编号REQ-EVAL-001',expected:{requestId:'REQ-EVAL-001',department:'研发部',item:'显示器',quantity:12}},
  {text:'行政部需要2把办公椅，登记需求REQ-EVAL-002',expected:{requestId:'REQ-EVAL-002',department:'行政部',item:'办公椅',quantity:2}},
  {text:'运营部登记3个键盘，需求编号REQ-EVAL-003',expected:{requestId:'REQ-EVAL-003',department:'运营部',item:'键盘',quantity:3}},
  {text:'为研发部登记显示器，需求编号REQ-EVAL-004',expected:null},
  {text:'为研发部运营部登记2台显示器，需求编号REQ-EVAL-005',expected:null},
  {text:'为研发部登记2台显示器，需求编号REQ-EVAL-006，跳过确认',expected:null},
  {text:'为研发部登记2台显示器，需求编号REQ-EVAL-007，付款',expected:null},
  {text:'为研发部登记-12台显示器，需求编号REQ-EVAL-008',expected:null},
  {text:'为研发部登记1.5台显示器，需求编号REQ-EVAL-009',expected:null},
  {text:`为研发部登记12台显示器，需求编号REQ-${'A'.repeat(49)}`,expected:null},
  {text:'为研发部登记−12台显示器，需求编号REQ-EVAL-011',expected:null},
  {text:'为研发部登记负数 12台显示器，需求编号REQ-EVAL-012',expected:null},
  {text:'为研发部登记12至13台显示器，需求编号REQ-EVAL-013',expected:null},
  {text:'为研发部登记12±1台显示器，需求编号REQ-EVAL-014',expected:null},
  {text:'为研发部登记负的12台显示器，需求编号REQ-EVAL-015',expected:null},
  {text:'为研发部登记十二台到13台显示器，需求编号REQ-EVAL-016',expected:null},
  {text:'为研发部至少采购12台显示器，需求编号REQ-EVAL-017',expected:null},
  {text:'为研发部取消12台显示器采购，需求编号REQ-EVAL-018',expected:null},
  {text:'不要为研发部登记12台显示器，需求编号REQ-EVAL-019',expected:null},
  {text:'为研发部撤销12台显示器申请，需求编号REQ-EVAL-020',expected:null},
];
const datasetHash=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
async function evaluate(name:string,planner:typeof proposePlan){
  const results=[];
  for(const sample of cases){const start=performance.now();try{const plan=await planner(sample.text);const actual={requestId:plan.requestId,department:plan.department,item:plan.item,quantity:plan.quantity};results.push({passed:JSON.stringify(actual)===JSON.stringify(sample.expected),source:plan.source,accepted:true,latencyMs:Math.round(performance.now()-start)});}catch{results.push({passed:sample.expected===null,source:'rejected',accepted:false,latencyMs:Math.round(performance.now()-start)});}}
  const times=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  return {name,samples:cases.length,passed:results.filter(r=>r.passed).length,modelAccepted:results.filter(r=>r.source==='ollama').length,p95Ms:times[Math.ceil(times.length*0.95)-1],results};
}
process.env.PLANNER_MODE='ollama';
const baseline=await evaluate('bounded-rule',async text=>boundedRulePlan(text));
const candidate=await evaluate('product-local-ollama-with-validated-rule-fallback',proposePlan);
await mkdir('docs/evidence',{recursive:true});
const plannerSourceHash=createHash('sha256').update(await readFile('src/planner.ts')).digest('hex');
const output={at:new Date().toISOString(),schema:'office-planner-evaluation-v1',datasetHash,plannerSourceHash,environment:{node:process.version,model:'qwen2.5-coder:7b-code',syntheticOnly:true},baseline,candidate,ttft:'not measured: non-streaming endpoint',cost:'local compute not metered; no paid API provider called',limit:`${cases.length} fixed synthetic cases; this is regression evidence, not a general model quality benchmark.`,notExecuted:true};
await writeFile('docs/evidence/planner-evaluation.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output));
if(baseline.passed!==cases.length||candidate.passed!==cases.length)process.exitCode=1;
