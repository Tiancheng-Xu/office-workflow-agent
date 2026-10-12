import {z} from 'zod';
import {DomainError,type Repository} from '../runtime/repository.js';
import {canonicalPayload,hash} from '../runtime/validation.js';
import {validateMaterialSource} from './sources.js';
import {extractCandidates,reviewMaterials,procurementDraft} from './review.js';
import type {MaterialCase,MaterialInput,MaterialReport,ReviewDecision} from './types.js';

const revisionSchema=z.number().int().positive();
const decisionSchema=z.object({candidateId:z.string().min(1).max(1600),value:z.string().max(2000),action:z.enum(['confirm','dismiss']),reason:z.string().max(1000)}).strict();
const createSchema=z.object({mode:z.enum(['procurement','trade']),sources:z.array(z.unknown()).min(1).max(3),decisions:z.array(decisionSchema).length(0)}).strict();
const reviewSchema=z.object({revision:revisionSchema,decisions:z.array(decisionSchema).max(1000)}).strict();
const linkSchema=z.object({revision:revisionSchema,runId:z.string().uuid()}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
 const result=schema.safeParse(value);if(!result.success)throw new DomainError('INVALID_MATERIAL_INPUT','材料请求参数无效。',400);return result.data;
}
function invalidDecision():never {throw new DomainError('INVALID_MATERIAL_DECISION','人核选择、值或修改理由无效。',400);}
function validateInput(value:unknown):MaterialInput {
 const input=parse(createSchema,value);
 let sources:MaterialInput['sources'];
 try{sources=input.sources.map(validateMaterialSource);}catch{throw new DomainError('INVALID_MATERIAL_SOURCE','材料来源结构、哈希或引用无效。',400);}
 if(new Set(sources.map(s=>s.id)).size!==sources.length||sources.some(s=>input.mode==='procurement'?s.role!=='procurement':!['contract','order','product'].includes(s.role)))throw new DomainError('INVALID_MATERIAL_SOURCE','来源标识重复或业务角色不匹配。',400);
 return {mode:input.mode,sources,decisions:[]};
}
function analyze(input:MaterialInput){
 const candidates=extractCandidates(input),ids=new Set<string>();
 for(const d of input.decisions){
  const candidate=candidates.find(c=>c.id===d.candidateId);
  if(!candidate||ids.has(d.candidateId))invalidDecision();ids.add(d.candidateId);
  if((d.action==='dismiss'||d.value!==candidate.value||!candidate.value)&&d.reason.trim().length<3)invalidDecision();
 }
 const outcome=reviewMaterials(input);
 if(outcome.findings.some(f=>['decision-reference','decision-action','decision-reason'].includes(f.code)))invalidDecision();
 return outcome;
}
/** Deterministic JSON checksum input; it is not a signature or source-authenticity proof. */
export function canonicalMaterialJson(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalMaterialJson).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonicalMaterialJson(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function createMaterialService(repository:Repository,now:()=>number=Date.now){
 const required=async(tenant:string,id:string)=>{const c=await repository.getMaterialCase(tenant,id);if(!c)throw new DomainError('MATERIAL_NOT_FOUND','材料案例不存在。',404);return c;};
 const expected=(c:MaterialCase,revision:number)=>{if(c.revision!==revision)throw new DomainError('STALE_MATERIAL_REVISION','材料已改变，请刷新后人核。');};
 const save=async(tenant:string,c:MaterialCase,old:number)=>{if(!await repository.saveMaterialCaseCAS(tenant,c,old))throw new DomainError('STALE_MATERIAL_REVISION','材料或关联计划已改变，请刷新后重试。');return c;};
 return {
  list:(tenant:string)=>repository.listMaterialCases(tenant),get:required,
  async create(tenant:string,value:unknown){const input=validateInput(value),at=new Date(now()).toISOString();const c:MaterialCase={id:crypto.randomUUID(),revision:1,input,outcome:analyze(input),createdAt:at,updatedAt:at};await repository.createMaterialCase(tenant,c);return c;},
  async review(tenant:string,id:string,value:unknown){const v=parse(reviewSchema,value),c=await required(tenant,id);expected(c,v.revision);const input={...c.input,decisions:v.decisions as ReviewDecision[]};const {linkedRun:_,...old}=c;return save(tenant,{...old,input,outcome:analyze(input),revision:c.revision+1,updatedAt:new Date(now()).toISOString()},c.revision);},
  async link(tenant:string,id:string,value:unknown){
   const v=parse(linkSchema,value),c=await required(tenant,id);expected(c,v.revision);
   if(c.input.mode!=='procurement')throw new DomainError('MATERIAL_LINK_NOT_ALLOWED','只有采购材料可关联采购草稿。',400);
   const outcome=analyze(c.input);if(outcome.pending>0||outcome.status!=='consistent')throw new DomainError('MATERIAL_REVIEW_REQUIRED','请完整人核采购字段后关联草稿。');
   const run=await repository.getRun(tenant,v.runId);if(!run)throw new DomainError('RUN_NOT_FOUND','运行不存在。',404);
   if(!['draft','approved'].includes(run.status)||run.effectStatus!=='none'||run.result)throw new DomainError('MATERIAL_LINK_NOT_ALLOWED','只能关联尚未生效的采购草稿。');
   let draft;try{draft=procurementDraft(c.input,run.plan.requestId);}catch{throw new DomainError('MATERIAL_REVIEW_REQUIRED','人核字段无法生成采购草稿。',400);}
   const payload=canonicalPayload(draft.plan);
   if(payload!==canonicalPayload(run.plan)||await hash(payload)!==run.planHash)throw new DomainError('MATERIAL_PAYLOAD_CONFLICT','采购草稿字段或哈希与材料人核值不一致。');
   return save(tenant,{...c,outcome,revision:c.revision+1,updatedAt:new Date(now()).toISOString(),linkedRun:{id:run.id,revision:run.revision,planHash:run.planHash,caseRevision:c.revision+1}},c.revision);
  },
  async report(tenant:string,id:string):Promise<MaterialReport>{
   const stored=await required(tenant,id);
   // Copy only the material schema. Never include session, capability or Run fields.
   const c:MaterialCase={id:stored.id,revision:stored.revision,input:{mode:stored.input.mode,sources:stored.input.sources.map(s=>validateMaterialSource(s)),decisions:stored.input.decisions.map(d=>parse(decisionSchema,d))},outcome:analyze(stored.input),createdAt:stored.createdAt,updatedAt:stored.updatedAt,...(stored.linkedRun?{linkedRun:{id:stored.linkedRun.id,revision:stored.linkedRun.revision,planHash:stored.linkedRun.planHash,caseRevision:stored.linkedRun.caseRevision}}:{})};
   let link:MaterialReport['link']={status:'not-linked'};
   if(c.linkedRun){const bound=c.linkedRun;try{const run=await repository.getRun(tenant,bound.id);link=run?{status:c.revision===bound.caseRevision&&run.revision===bound.revision&&run.planHash===bound.planHash?'matched':'stale',runId:run.id,runRevision:run.revision,planHash:run.planHash}:{status:'unavailable',runId:bound.id};}catch{link={status:'unavailable',runId:bound.id};}}
   const body={schema:'office-material-report-v1' as const,syntheticOnly:true as const,generatedAt:new Date(now()).toISOString(),case:c,link,statement:'仅记录合成材料来源、规则候选与人工复核；来源账本不证明原件真实性或OCR/转录准确性。关联状态仅核对当前案例与计划版本/哈希，不代表批准、执行或业务效果。SHA-256是校验和，不是签名。'};
   return {...body,digest:{algorithm:'SHA-256',value:await hash(canonicalMaterialJson(body))}};
  }
 };
}
