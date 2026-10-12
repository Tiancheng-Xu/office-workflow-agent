import {extractDemand,readQuantity,demandText,type DemandFields} from '../demand-input.js';
import {boundedRulePlan} from '../planner.js';
import {departmentAliases,itemAliases,departments} from '../catalog.js';
import {itemSchema,unitSchema,units} from '../procurement-fields.js';
import type {MaterialInput,MaterialField,FieldCandidate,MaterialOutcome,MaterialFinding,ProcurementDraft} from './types.js';

const procurementRequired:MaterialField[]=['department','item','quantity','unit','requestId'];
const tradeRequired:MaterialField[]=['item','quantity','unit','currency','total'];
const labels:Record<MaterialField,string[]>={department:['归属部门','部门','归属','department'],requestId:['需求编号','编号','request id','requestId'],item:['产品名称','商品名称','物品','品类','名称','产品','item','product name','product'],quantity:['数量','quantity','qty'],unit:['计量单位','单位','unit'],currency:['币种','货币','currency'],unitPrice:['单价','unit price','unitPrice'],total:['总金额','总额','金额','total amount','total'],deliveryDate:['交货日期','交付日期','交期','delivery date','deliveryDate']};
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const allLabels=Object.values(labels).flat().sort((a,b)=>b.length-a.length);
const labelPattern=allLabels.map(escaped).join('|');
const labelField=new Map(Object.entries(labels).flatMap(([field,names])=>names.map(name=>[name.toLowerCase(),field as MaterialField] as const)));
const required=(input:MaterialInput,role:string)=>input.mode==='procurement'?procurementRequired:role==='product'?['item'] as MaterialField[]:tradeRequired;
const key=(sourceId:string,field:MaterialField,spanId:string,index:number)=>`${encodeURIComponent(sourceId)}:${field}:${encodeURIComponent(spanId)}:${index}`;
function normalize(field:MaterialField,value:string,mode:MaterialInput['mode']):string {
 const v=value.trim();
 if(field==='department')return Object.entries(departmentAliases).find(([,names])=>(names as readonly string[]).includes(v))?.[0]??v;
 if(field==='item'&&mode==='procurement'){const upper=v.replace(/[a-z]+/g,s=>s.toUpperCase());return Object.entries(itemAliases).find(([,names])=>(names as readonly string[]).includes(v))?.[0]??upper;}
 if(field==='currency'){if(/^(?:人民币|RMB)$/i.test(v))return 'CNY';return /^[A-Za-z]{3}$/.test(v)?v.toUpperCase():v;}
 if(field==='quantity'&&mode==='procurement')return readQuantity(v)?.toString()??v;
 if(['quantity','unitPrice','total'].includes(field)&&/^\d+(?:\.\d+)?$/.test(v)){const [whole,fraction]=v.split('.');return `${whole!.replace(/^0+(?=\d)/,'')}${fraction?.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):''}`;}
 return v;
}

/** Rule candidates preserve the cited span; empty evidence identifies a human completion. */
export function extractCandidates(input:MaterialInput):FieldCandidate[]{
 const result:FieldCandidate[]=[];
 for(const source of input.sources){
  const found=new Set<MaterialField>();
  const add=(field:MaterialField,raw:string,spanId:string,index:number)=>{found.add(field);result.push({id:key(source.id,field,spanId,index),sourceId:source.id,field,raw,value:normalize(field,raw,input.mode),evidenceIds:[spanId]});};
  for(const span of source.spans){
   // Both ASCII and Chinese numeric commas stay visible; ambiguous values cannot become prefixes.
   const re=new RegExp(`(?:^|[，,;；\\n])\\s*(${labelPattern})\\s*[:：=]\\s*((?:[^;；\\n，]|(?<=[0-9])，(?=[0-9]))*?)(?=(?:[,，]\\s*(?:${labelPattern})\\s*[:：=])|[;；\\n]|(?<![0-9])，|，(?![0-9])|$)`,'gi');
   const matches=[...span.text.matchAll(re)];
   for(const match of matches){const field=labelField.get(match[1]!.toLowerCase())!;const raw=match[2]!.trim();
    if(input.mode==='procurement'&&!procurementRequired.includes(field))continue;
    const measured=input.mode==='procurement'&&field==='quantity'?new RegExp(`^([0-9一二三四五六七八九十百两]+)\\s*(${units.join('|')})$`).exec(raw):null;
    if(measured){add(field,measured[1]!,span.id,match.index!);add('unit',measured[2]!,span.id,match.index!);}else add(field,raw,span.id,match.index!);
   }
   const labelledFields=new Set(matches.map(m=>labelField.get(m[1]!.toLowerCase())!));
   if(input.mode!=='procurement'||[...labelledFields].some(f=>f!=='department'&&f!=='requestId'))continue;
   const demand=extractDemand(span.text);if(demand.blocked)continue;
   for(const [field,value] of Object.entries(demand.fields) as [MaterialField,string|number][]){
    if(labelledFields.has(field))continue;
    let raw=String(value);
    if(field==='department')raw=(departmentAliases[value as keyof typeof departmentAliases] as readonly string[]).filter(s=>span.text.includes(s)).sort((a,b)=>b.length-a.length)[0]??raw;
    if(field==='item')raw=(itemAliases[value as keyof typeof itemAliases] as readonly string[]|undefined)?.find(s=>span.text.includes(s))??span.text.match(new RegExp(escaped(raw),'iu'))?.[0]??raw;
    if(field==='quantity'){const m=[...span.text.matchAll(new RegExp(`(?<![A-Za-z\\p{N}.])([0-9一二三四五六七八九十百两]+)\\s*(${units.join('|')})`,'gu'))].find(m=>readQuantity(m[1]!)===value&&!/^\s*(?:装|套)/.test(span.text.slice(m.index!+m[0].length)));raw=m?.[1]??raw;}
    add(field,raw,span.id,0);
   }
   // The legacy parser omits 件 because it is the old default. Material review requires its evidence.
   if(demand.fields.quantity!==undefined&&!demand.fields.unit){const m=[...span.text.matchAll(/(?<![A-Za-z\p{N}.])([0-9一二三四五六七八九十百两]+)\s*件/gu)].find(m=>readQuantity(m[1]!)===demand.fields.quantity);if(m)add('unit','件',span.id,m.index!);}
  }
  for(const field of required(input,source.role))if(!found.has(field))result.push({id:`${encodeURIComponent(source.id)}:${field}:missing`,sourceId:source.id,field,raw:'',value:'',evidenceIds:[]});
 }
 return result;
}

type Decimal={integer:bigint;scale:number};
function decimal(value:string):Decimal|undefined {if(!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)||value.length>80)return;const [whole,fraction='']=value.split('.');return {integer:BigInt(whole!+fraction),scale:fraction.length};}
function equalDecimal(a:Decimal,b:Decimal):boolean{return a.integer*10n**BigInt(b.scale)===b.integer*10n**BigInt(a.scale);}
function valid(field:MaterialField,value:string,mode:MaterialInput['mode']):boolean{
 if(!value||value.length>120||/[\p{Cc}\p{Cf}]/u.test(value))return false;
 if(field==='department')return (departments as readonly string[]).includes(value);
 if(field==='requestId')return /^REQ-[A-Z0-9-]{3,48}$/.test(value);
 if(field==='item')return mode==='procurement'?itemSchema.safeParse(value).success:value.length<=64&&!/[<>]/.test(value);
 if(field==='unit')return mode==='procurement'?unitSchema.safeParse(value).success:/^[\p{L}][\p{L}\p{N} ./-]{0,31}$/u.test(value);
 if(field==='currency')return ['USD','EUR','CNY','GBP','JPY'].includes(value);
 if(field==='quantity'){if(mode==='procurement')return /^[1-9]\d{0,2}$/.test(value)&&Number(value)<=100;const d=decimal(value);return !!d&&d.integer>0n;}
 if(field==='unitPrice'||field==='total')return !!decimal(value);
 if(field==='deliveryDate'){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [year,month,day]=value.split('-').map(Number) as [number,number,number];if(year<1||month<1||month>12||day<1)return false;const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];return day<=days[month-1]!;}
 return false;
}

/** Consistent means confirmed material values agree; it grants no business approval. */
export function reviewMaterials(input:MaterialInput):MaterialOutcome {
 const candidates=extractCandidates(input),findings:MaterialFinding[]=[];
 const finding=(code:string,message:string,sourceIds:string[],field?:MaterialField,evidenceIds:string[]=[])=>findings.push({code,message,sourceIds,severity:'error',...(field?{field}:{}),evidenceIds});
 const ids=new Set<string>();let sourceInvalid=false;
 for(const s of input.sources){if(ids.has(s.id)||(input.mode==='procurement'?s.role!=='procurement':!['contract','order','product'].includes(s.role)))sourceInvalid=true;ids.add(s.id);const spanIds=new Set<string>();for(const span of s.spans){if(spanIds.has(span.id))sourceInvalid=true;spanIds.add(span.id);}}
 if(!input.sources.length||sourceInvalid||(input.mode==='trade'&&(!input.sources.some(s=>s.role==='contract')||!input.sources.some(s=>s.role==='order'))))finding('source-role','采购需至少一份采购资料；贸易需合同和订单，且来源与引用编号必须唯一。',input.sources.map(s=>s.id));
 const index=new Map(candidates.map(c=>[c.id,c])),seen=new Set<string>(),accepted=new Map<string,string>();let confirmed=0;
 for(const decision of input.decisions){const c=index.get(decision.candidateId);
  if(!c||seen.has(decision.candidateId)){finding('decision-reference','决策必须引用存在且唯一的候选。',c?[c.sourceId]:[]);continue;}seen.add(c.id);
  if(!['confirm','dismiss'].includes(decision.action)){finding('decision-action','请明确确认或忽略候选。',[c.sourceId],c.field,c.evidenceIds);continue;}
  const value=typeof decision.value==='string'?decision.value:'';
  if((decision.action==='dismiss'||!c.evidenceIds.length||value!==c.value)&&(typeof decision.reason!=='string'||Array.from(decision.reason.trim()).length<3)){finding('decision-reason','修改、无原文补充或忽略候选需至少3字理由。',[c.sourceId],c.field,c.evidenceIds);continue;}
  if(decision.action==='dismiss')continue;
  const normalized=normalize(c.field,value,input.mode);
  if(!valid(c.field,normalized,input.mode)){finding('invalid-field','字段格式或范围无效，请人工澄清。',[c.sourceId],c.field,c.evidenceIds);continue;}
  accepted.set(c.id,normalized);confirmed++;
 }
 const final=new Map<string,Map<MaterialField,string>>();
 for(const source of input.sources){const fields=new Map<MaterialField,string>();final.set(source.id,fields);
  const sourceCandidates=candidates.filter(c=>c.sourceId===source.id);
  for(const field of new Set(sourceCandidates.map(c=>c.field))){const matching=sourceCandidates.filter(c=>c.field===field&&accepted.has(c.id));const values=new Set(matching.map(c=>accepted.get(c.id)!));
   if(values.size>1)finding('field-conflict','同一资料该字段存在不同确认值，请选择并说明忽略理由。',[source.id],field,matching.flatMap(c=>c.evidenceIds));else if(values.size===1)fields.set(field,[...values][0]!);
  }
  for(const field of required(input,source.role))if(!fields.has(field)&&!findings.some(f=>f.code==='field-conflict'&&f.field===field&&f.sourceIds.includes(source.id)))finding('missing-field','必需字段缺少唯一有效确认值。',[source.id],field,sourceCandidates.filter(c=>c.field===field).flatMap(c=>c.evidenceIds));
  if(input.mode==='trade'&&fields.has('unitPrice')&&fields.has('quantity')&&fields.has('total')){const qty=decimal(fields.get('quantity')!)!,price=decimal(fields.get('unitPrice')!)!,total=decimal(fields.get('total')!)!;if(!equalDecimal({integer:qty.integer*price.integer,scale:qty.scale+price.scale},total))finding('amount-mismatch','数量 × 单价与总额不一致；未换算单位或币种。',[source.id],'total',sourceCandidates.filter(c=>['quantity','unitPrice','total'].includes(c.field)&&accepted.has(c.id)).flatMap(c=>c.evidenceIds));}
 }
 for(const field of (input.mode==='procurement'?procurementRequired:['item','quantity','unit','currency','unitPrice','total','deliveryDate']) as MaterialField[]){const compared=input.sources.filter(s=>s.role!=='product'||field==='item').filter(s=>final.get(s.id)?.has(field));const values=compared.map(s=>final.get(s.id)!.get(field)!);if(new Set(values).size>1)finding('cross-source-mismatch','资料确认值不一致，需人工核对；未换算单位或币种。',compared.map(s=>s.id),field,candidates.filter(c=>c.field===field&&compared.some(s=>s.id===c.sourceId)&&accepted.has(c.id)).flatMap(c=>c.evidenceIds));}
 const pending=candidates.filter(c=>!seen.has(c.id)).length;
 const needsReview=pending>0||findings.some(f=>['source-role','decision-reference','decision-action','decision-reason','invalid-field','missing-field'].includes(f.code));
 return {status:needsReview?'needs-review':findings.length?'reviewed-with-issues':'consistent',candidates,findings,confirmed,pending};
}

export function procurementDraft(input:MaterialInput,requestId?:string):ProcurementDraft {
 const outcome=reviewMaterials(input);if(input.mode!=='procurement'||outcome.status!=='consistent')throw new Error('采购资料尚未完成有效人核。');
 const fields:Record<string,string>={};
 for(const candidate of outcome.candidates){const decision=input.decisions.find(d=>d.candidateId===candidate.id);if(decision?.action!=='confirm')continue;const value=normalize(candidate.field,decision.value,input.mode);if(fields[candidate.field]!==undefined&&fields[candidate.field]!==value)throw new Error('采购资料包含字段歧义。');fields[candidate.field]=value;}
 if(requestId!==undefined&&requestId!==fields.requestId)throw new Error('需求编号必须与已确认候选一致。');
 const text=demandText({department:fields.department,item:fields.item,quantity:Number(fields.quantity),unit:fields.unit,requestId:fields.requestId} as Required<DemandFields>);
 return {text,plan:boundedRulePlan(text)};
}
