import {departments,items} from '../catalog.js';
import {extractDemand,demandText,newRequestId,demandKey,type DemandFields} from '../demand-input.js';
import {escapeText as esc} from './html.js';
export function mountDemandCompletion(container:HTMLElement,onComplete:(text:string)=>void){
 let raw='',generated='',pending:ReturnType<typeof extractDemand>|undefined;
 const generatedIds=new Map<string,string>();
 function prepare(input:string):string|undefined {
  if(input!==raw){raw=input;generated='';}pending=extractDemand(input);
  if(!pending.blocked&&!pending.fields.requestId&&!pending.issues.some(i=>i.field==='requestId')){const key=demandKey(pending.fields);generated=generatedIds.get(key)||newRequestId();generatedIds.set(key,generated);pending.fields.requestId=generated;}
  const f=pending.fields;
  if(!pending.issues.length&&f.department&&f.item&&f.quantity!==undefined&&f.requestId){
   container.innerHTML=`<p class="demand-summary">已整理：${esc(f.department)} · ${esc(f.item)} · ${f.quantity} 件 · <span class="mono">${esc(f.requestId)}</span>${generated?'（系统生成编号）':''}。仅生成未批准草稿，登记仍需逐条确认。</p>`;
   return demandText({department:f.department,item:f.item,quantity:f.quantity,requestId:f.requestId});
  }
  container.innerHTML=`<div class="demand-clarification"><strong>补全这条需求</strong><p>保留原话：${esc(input)}</p><ul>${pending.issues.map(i=>`<li>${esc(i.message)}</li>`).join('')}</ul>${pending.blocked?'':`<div class="completion-fields">${!f.department?`<label>补充归属部门<select id="complete-department" required><option value="">请选择</option>${departments.map(v=>`<option>${v}</option>`).join('')}</select></label>`:`<p>已识别部门：${esc(f.department)}</p>`}${!f.item?`<label>确认登记品类<select id="complete-item" required><option value="">请选择受支持品类</option>${items.map(v=>`<option>${v}</option>`).join('')}</select></label>`:`<p>已识别品类：${esc(f.item)}</p>`}${f.quantity===undefined?'<label>确认明确数量<input id="complete-quantity" type="number" min="1" max="100" step="1" required></label>':`<p>已识别数量：${f.quantity} 件</p>`}${!f.requestId?'<label>补充完整需求编号<input id="complete-request" type="text" pattern="REQ-[A-Z0-9\\-]{3,48}" required maxlength="52"></label>':`<p>需求编号：<span class="mono">${esc(f.requestId)}</span>${generated?'（系统生成）':''}</p>`}</div><p>你补充或选择的字段将作为本次入参；不支持的原物品不会被自动替换。</p><button type="button" id="complete-demand" class="button secondary">使用补全字段生成预览</button>`}</div>`;
  container.querySelector<HTMLInputElement|HTMLSelectElement>('input,select')?.focus();return undefined;
 }
 container.addEventListener('click',e=>{
  if(!(e.target instanceof Element)||!e.target.closest('#complete-demand')||!pending||pending.blocked)return;
  const controls=Array.from(container.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'));if(controls.some(c=>!c.reportValidity()))return;
  const select=(id:string)=>(container.querySelector<HTMLInputElement|HTMLSelectElement>('#'+id)?.value);
  const f={...pending.fields,department:pending.fields.department||select('complete-department'),item:pending.fields.item||select('complete-item'),quantity:pending.fields.quantity??Number(select('complete-quantity')),requestId:pending.fields.requestId||select('complete-request')};
  if(!departments.some(v=>v===f.department)||!items.some(v=>v===f.item)||!Number.isInteger(f.quantity)||f.quantity!<1||f.quantity!>100||!/^REQ-[A-Z0-9-]{3,48}$/.test(f.requestId||''))return;
  const normalized=demandText(f as Required<DemandFields>);if(extractDemand(normalized).issues.length)return;generatedIds.set(demandKey(f as DemandFields),f.requestId!);onComplete(normalized);
 });
 return {prepare,clearView(){pending=undefined;container.innerHTML='';},reset(){raw='';generated='';pending=undefined;generatedIds.clear();container.innerHTML='';}};
}
