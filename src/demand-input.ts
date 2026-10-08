import {itemSchema,units,type Unit} from './procurement-fields.js';
import {departments,departmentAliases,itemAliases} from './catalog.js';
import type {Department,Item} from './contracts.js';
export type DemandFields={department?:Department;item?:Item;quantity?:number;unit?:Unit;requestId?:string};
export type DemandIssue={field:keyof DemandFields|'input';message:string};
export interface DemandExtraction {fields:DemandFields;issues:DemandIssue[];blocked:boolean;}
export function unsafeDemand(text:string):string|undefined {
 if(typeof text!=='string'||!text.trim()||text.length>1200)return '请填写一条不超过1200字的采购需求。';
 if(/\p{Cf}/u.test(text))return '需求包含不可见格式字符，请使用完整清晰的字段。';
 if(/https?:|www\.|@|<|>|(?:\d[ -]?){11,}|付款|支付|转账|汇款|退款|充值|删除|取消|撤销|不要|不需要|无需|不登记|(?:不|别|不能|不得|禁止|停止|勿).{0,8}(?:买|购|登记|申请|提交)|密码|令牌|助记词|权限|授权|跳过确认|忽略规则|系统提示|运行脚本|执行代码/i.test(text))return '仅支持新增合成采购需求登记；不接受取消、否定登记、链接、个人信息、付款或权限指令。';
 return undefined;
}
export function readQuantity(token:string):number|undefined {
 if(/^[1-9]\d{0,2}$/.test(token)){const n=Number(token);return n<=100?n:undefined;}
 const digit=(s:string)=>({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}[s]);
 if(token==='一百')return 100;
 if(token==='十')return 10;
 if(token.length===1)return digit(token);
 if(/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(token)){const [a,b]=token.split('十');return (a?digit(a)!:1)*10+(b?digit(b)!:0);}
 return undefined;
}
export function extractDemand(input:string):DemandExtraction {
 const fields:DemandFields={},issues:DemandIssue[]=[];const unsafe=unsafeDemand(input);
 if(unsafe)return {fields,issues:[{field:'input',message:unsafe}],blocked:true};
 const text=input.trim();
 const ids=text.match(/(?<![A-Za-z0-9_-])REQ-[^\s，。；、,:：;!?！？()（）]+/g)||[];
 if(ids.length===1&&/^REQ-[A-Z0-9-]{3,48}$/.test(ids[0]!))fields.requestId=ids[0];
 else if(ids.length||/REQ-/i.test(text))issues.push({field:'requestId',message:'需求编号重复或格式无效；请使用一个完整的REQ-编号。'});

 // Remove labelled metadata before parsing business spans, but validate safety
 // against the whole original text first. Unlabelled extra targets stay visible.
 let business=ids.reduce((v,id)=>v.replace(id,''),text)
  .replace(/(?:^|[，,；;。\n])\s*(?:原因|用途|备注)\s*(?:[:：]|是)[^，,；;。\n]*/gu,'');
 const declaredItems=Array.from(business.matchAll(/(?:^|[，,；;。\n])\s*(?:物品|品类)\s*[:：=]\s*([^，,；;。\n]+)/gu));
 business=business.replace(/(?:^|[，,；;。\n])\s*(?:物品|品类)\s*[:：=]\s*([^，,；;。\n]+)/gu,'');
 const departmentNames=Object.entries(departmentAliases).flatMap(([department,aliases])=>aliases.map(alias=>({department:department as Department,alias}))).sort((a,b)=>b.alias.length-a.alias.length);
 const foundDepartments=new Set<Department>();
 for(const {department,alias} of departmentNames){
  let from=0;
  while(true){const at=business.indexOf(alias,from);if(at<0)break;const tail=business.slice(at+alias.length);
   const before=business.slice(0,at);
   const atDepartmentBoundary=!before.trim()||/(?:^|[\s，,；;。\n、:：=!?！？()（）]|为|给|帮|送到|送至|送给)\s*$/u.test(before);
   const numericTail=new RegExp(`^[\\p{N}一二三四五六七八九十百两]+\\s*(?:${units.join('|')})`,'u').test(tail);
   const verbBeforeQuantity=/^(?:采购|购置|添置|订购|登记|申请|购买)\s*([^，,；;。\n]+)/u.exec(tail);
   const ambiguousItemFirst=verbBeforeQuantity!==null&&!new RegExp(`^[\\p{N}零〇一二三四五六七八九十百千万两亿]+\\s*(?:${units.join('|')})`,'u').test(verbBeforeQuantity[1]!);
   if(atDepartmentBoundary&&(!ambiguousItemFirst||/(?:为|给|帮|送到|送至|送给)\s*$/u.test(before))&&(!tail||numericTail||/^(?:[\s，,；;。\n、:：=!?！？()（）]|买|购|采购|登记|申请|需要|要|添置|订购|补充|的|数量|物品|品类)/u.test(tail))){
    foundDepartments.add(department);business=business.slice(0,at)+business.slice(at+alias.length);from=at;
   }else from=at+alias.length;
  }
 }
 if(foundDepartments.size===1)fields.department=[...foundDepartments][0];
 else issues.push({field:'department',message:foundDepartments.size>1?'识别到多个部门，请拆分或确认归属。':'请补充归属部门。'});
 business=business.replace(/需求编号|编号|归属|部门/g,'');
 const number='[\\p{N}零〇一二三四五六七八九十百千万两亿]+';
 const measured=new RegExp(`(?<![A-Za-z\\p{N}.])(${number})\\s*(${units.join('|')})`,'gu');
 const labeled=new RegExp(`数量\\s*[:：=]?\\s*(${number})(?:\\s*(${units.join('|')}))?`,'gu');
 const quantities=Array.from(business.matchAll(labeled));
 let stripped=business.replace(labeled,'');
 const measures=Array.from(stripped.matchAll(measured)).filter(match=>!/^\s*(?:装|套)/u.test(stripped.slice(match.index!+match[0].length))); 
 quantities.push(...measures);
 const qualifier=/负|minus|negative|至少|至多|最多|最少|不超过|不少于|不低于|不多于|超过|小于|大于|多于|少于|不足|不满|大约|大概|约|近|左右|上下|以上|以下|或者|范围|区间/iu;
 const rangePrefix=new RegExp(`${number}\\s*(?:到|至|[.,．﹒٫٬+−＋﹣﹢➕➖±~～/⁄∕\\p{Pd}])\\s*$`,'u');
 const ambiguous=qualifier.test(business)||quantities.some(match=>{
  const source=measures.includes(match)?stripped:business;
  const before=source.slice(0,match.index),after=source.slice(match.index!+match[0].length);
  return rangePrefix.test(before)||/[A-Za-z\p{N}.半+−＋﹣﹢➕➖－-][\p{M}\s]*$/u.test(before)
   ||/^\s*(?:半|多|余|来|起|到|至|[.,．﹒٫٬+−＋﹣﹢➕➖±~～/⁄∕-]\s*\p{N})/u.test(after);
 });
 const quantity=quantities.length===1&&!ambiguous?readQuantity(quantities[0]![1]!):undefined;
 const declaredUnits=new Set(quantities.map(match=>match[2]).filter(Boolean));
 if(declaredUnits.size===1){const unit=[...declaredUnits][0] as Unit;if(unit!=='件')fields.unit=unit;}
 if(quantity!==undefined)fields.quantity=quantity;
 else issues.push({field:'quantity',message:'请明确一个1–100的整数数量和单位（如一打、两包、2块）；范围、约数、分数或多个计量需要澄清。'});
 stripped=stripped.replace(measured,(whole,_number,_unit,offset:number)=>measures.some(match=>match.index===offset)?'':whole);
 // Strip sentence grammar at clause boundaries, never substrings inside nouns.
 const candidates=[...declaredItems.map(match=>match[1]!.trim()),...stripped.split(/[，,；;。\n、:：=!?！？()（）]/u).map(part=>part.trim()
  .replace(/^(?:(?:为|给|帮|请|想|希望|麻烦|安排|尽快|的)\s*)+/u,'')
  .replace(/^(?:(?:采购|购买|购置|添置|订购|登记|申请|需要|想要|急需|急用|买|要|物品|品类)\s*)+/u,'')
  .replace(/(?:送到|送至|送给|放在|给)\s*$/u,'').trim()).filter(Boolean)];
 if(quantity===undefined&&ambiguous){for(let i=0;i<candidates.length;i++)candidates[i]=candidates[i]!.replace(/^(?:负数?|负的|大约|大概|约|近|至少|至多|最多|最少|左右|上下|以上|以下)\s*/u,'');}
 if(candidates.length===1){
  const candidate=candidates[0]!.replace(/[a-z]+/g,value=>value.toUpperCase());
  const alias=Object.entries(itemAliases).find(([,aliases])=>aliases.some(value=>value===candidate));
  const item=alias?.[0]??candidate;
  if(itemSchema.safeParse(item).success)fields.item=item;
  else issues.push({field:'item',message:'请确认一个明确的物品名称和规格，数量与单位请单独填写。'});
 }else issues.push({field:'item',message:candidates.length>1?'识别到多个内容片段，请拆分成一条一个物品。':'请补充物品名称，可保留规格或型号。'});
 if(foundDepartments.size>1||candidates.length>1||/再买|另外|顺便|以及|还有|并且|[和及与或]/u.test(business))issues.push({field:'input',message:'存在并列或备选内容，请拆分需求；本条需要一个部门、物品和明确计量。'});

 return {fields,issues,blocked:issues.some(issue=>issue.field==='input')};
}
export function demandText(fields:Required<Omit<DemandFields,'unit'>>&Pick<DemandFields,'unit'>):string {
 return `部门：${fields.department}；物品：${fields.item}；数量：${fields.quantity}${fields.unit??'件'}；需求编号：${fields.requestId}`;
}
export function newRequestId():string{return 'REQ-'+crypto.randomUUID().replaceAll('-','').toUpperCase().match(/.{8}/g)!.map(part=>'N'+part).join('-');}
export function demandKey(fields:DemandFields):string{return JSON.stringify([fields.department??null,fields.item??null,fields.quantity??null,fields.unit??'件']);}
