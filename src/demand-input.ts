import {departments,items,departmentAliases,itemAliases} from './catalog.js';
import type {Department,Item} from './contracts.js';
export type DemandFields={department?:Department;item?:Item;quantity?:number;requestId?:string};
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
 function mention(alias:string,kind:'department'|'item'){
  for(let at=text.indexOf(alias);at>=0;at=text.indexOf(alias,at+alias.length)){
   const tail=text.slice(at+alias.length);
   if(!tail||/^[\s，。；、,:：;!?！？()（）]/u.test(tail))return true;
   if(kind==='department'&&/^(?:买|购|采购|登记|申请|需要|要|添置|订购|补充|的|数量|物品|品类|部门|[\p{N}一二三四五六七八九十百两])/u.test(tail))return true;
   if(kind==='item'&&/^(?:[\p{N}一二三四五六七八九十百两]+\s*(?:台|把|个|件|套)|数量|给|送到|送至|送给|用于|用来|作为|放在|需要|要)/u.test(tail))return true;
  }
  return false;
 }
 const rawDepartments=departments.filter(key=>departmentAliases[key].some(value=>text.includes(value)));
 const ds=departments.filter(key=>departmentAliases[key].some(value=>mention(value,'department')));
 const rawItems=items.filter(key=>itemAliases[key].some(value=>text.includes(value)));
 const its=items.filter(key=>itemAliases[key].some(value=>mention(value,'item')));
 if(ds.length===1&&rawDepartments.length===1)fields.department=ds[0];else issues.push({field:'department',message:rawDepartments.length>1?'识别到多个部门，请确认本条需求的归属部门。':'请补充归属部门。'});
 if(its.length===1&&rawItems.length===1)fields.item=its[0];else issues.push({field:'item',message:rawItems.length>1?'识别到多个品类，请拆分为一条一个品类。':`未识别到可登记的物品。当前支持${items.join('、')}，耗材或配件不能当作整机，请确认品类。`});
 const quantityText=ids.reduce((v,id)=>v.replace(id,''),text);
 const tokens=quantityText.match(/[\p{N}零〇一二三四五六七八九十百千万两亿]+/gu)||[];
 const measured=/[\p{N}零〇一二三四五六七八九十百千万两亿]+\s*(?:台|把|个|件|套)/u.test(quantityText)||/数量\s*[:：=]?\s*[\p{N}零〇一二三四五六七八九十百千万两亿]+/u.test(quantityText);
 const arithmetic=/\p{N}\s*[.,．﹒٫٬]\s*\p{N}/u.test(quantityText);
 const qualifiers=/负|minus|negative|至少|至多|最多|最少|不超过|不少于|不低于|不多于|超过|小于|大于|多于|少于|不足|不满|大约|大概|约|近|左右|上下|以上|以下|或者|范围|区间|[\p{Pd}+−＋﹣﹢➕➖±~～/⁄∕]|\d\s*[eE]|(?:台|把|个|件|套)\s*(?:半|多|余|来|起)/iu.test(quantityText);
 const quantity=tokens.length===1&&!qualifiers&&!arithmetic&&measured?readQuantity(tokens[0]!):undefined;
 if(quantity!==undefined)fields.quantity=quantity;else issues.push({field:'quantity',message:'请明确一个1–100的整数数量（如一台、两把或数量：12）；范围、约数、算式或多个数量需要澄清。'});
 const alternatives=/再买|另外|顺便|以及|还有|并且|[和及与或]/u.test(quantityText);
 // Consume the full sentence, not only comma-separated fragments. Explicit
 // purpose labels are metadata; unlabelled unknown targets must not disappear.
 let remainder=quantityText.replace(/(?:^|[，,；;。\n])\s*(?:原因|用途|备注)\s*(?:[:：]|是)[^，,；;。\n]*/gu,'');
 const aliases=[...Object.values(departmentAliases),...Object.values(itemAliases)].flat().sort((a,b)=>b.length-a.length);
 for(const value of aliases)remainder=remainder.replaceAll(value,'');
 remainder=remainder.replace(/[\p{N}零〇一二三四五六七八九十百千万两亿]+\s*(?:台|把|个|件|套)?/gu,'')
  .replace(/需求编号|需求|编号|部门|归属|物品|品类|数量|采购|购买|添置|购置|订购|登记|申请|需要|想要|希望|急需|急用|尽快|安排|麻烦|谢谢|送到|送至|送给|放在|买|要|想|帮|请|为|给|的|[:：=、，,；;。.!！？?()（）\s]/gu,'');
 if(quantity===undefined)remainder=remainder.replace(/半|多|余|来|起|约|左右|至少|最多|最少/g,'');
 if(alternatives||remainder.trim())issues.push({field:'input',message:'出现备选、并列或无法归属的内容；请确认一条需求只有一个部门、品类和数量，多个目标请分别填写。'});

 return {fields,issues,blocked:issues.some(issue=>issue.field==='input')};
}
export function demandText(fields:Required<DemandFields>):string {
 return `为${fields.department}登记${fields.quantity}件${fields.item}，需求编号${fields.requestId}`;
}
export function newRequestId():string{return 'REQ-'+crypto.randomUUID().replaceAll('-','').toUpperCase().match(/.{8}/g)!.map(part=>'N'+part).join('-');}
export function demandKey(fields:DemandFields):string{return JSON.stringify([fields.department??null,fields.item??null,fields.quantity??null]);}
