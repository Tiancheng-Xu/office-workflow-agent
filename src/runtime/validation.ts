import {departments,items} from '../catalog.js';
import { z } from 'zod';
import type { Plan, Run } from '../contracts.js';
import { DomainError } from './repository.js';

export const planSchema=z.object({
  requestId:z.string().regex(/^REQ-[A-Z0-9][A-Z0-9-]{2,63}$/),
  department:z.enum(departments),item:z.enum(items),
  quantity:z.number().int().min(1).max(100),reason:z.string().trim().min(1).max(200),
  source:z.enum(['bounded-rule','ollama','workers-ai'])
}).strict();
export function validatePlan(value:unknown):Plan {
  const result=planSchema.safeParse(value);
  if(!result.success)throw new DomainError('INVALID_PLAN','计划字段不完整或超出合成采购范围。',400);
  return result.data;
}
export function canonicalPayload(plan:Plan):string {
  return JSON.stringify({requestId:plan.requestId,department:plan.department,item:plan.item,quantity:plan.quantity,reason:plan.reason});
}
export async function hash(value:string):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export function randomToken():string { return crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''); }
export function event(run:Run,now:number,type:string,message:string):Run {
  return {...run,epoch:run.epoch+1,events:[...run.events,{at:new Date(now).toISOString(),type,message}].slice(-100)};
}
export function assertApproval(run:Run,now:number,adapterVersion:string):void {
  if(run.approvedHash!==run.planHash||!run.approvalExpiresAt||Date.parse(run.approvalExpiresAt)<=now)
    throw new DomainError('APPROVAL_EXPIRED','批准失效，请重新确认计划。');
  if(run.adapterVersion!==adapterVersion)throw new DomainError('ADAPTER_DRIFT','后台适配版本已改变，请重新提案。');
}
export function escapeHtml(value:unknown):string {
  return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
