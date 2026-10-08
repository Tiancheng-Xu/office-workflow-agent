import {departments,items} from '../catalog.js';
import { z } from 'zod';
import { verifyExecutionProof } from '../runtime/proof.js';
import type { Run } from '../contracts.js';
import type { QueueFilter } from './operations.js';

const stamp = z.string().datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).nullable();
const payload = {
  requestId: z.string().regex(/^REQ-[A-Z0-9-]{3,48}$/).nullable(),
  department: z.enum(departments).nullable(), item: z.enum(items).nullable(),
  quantity: z.number().int().min(1).max(100).nullable(), reason: z.literal('合成采购需求登记').nullable(),
};
const demand = z.object({...payload, payloadHash:digest.nullable(),executionKey:digest.nullable(),createdAt:stamp.nullable()}).nullable();
const evidence = z.object({
  startedAt:stamp.nullable(),completedAt:stamp.nullable(),elapsedMs:z.number().nonnegative().nullable(),
  origin:z.string().url().refine(value => { const url=new URL(value);return value===url.origin; }).nullable(),
  adapterVersion:code,planHash:digest.nullable(),domMatched:z.boolean().nullable(),payloadMatched:z.boolean().nullable(),
  postObserved:z.boolean().nullable(),registeredMarker:z.boolean().nullable(),stopCode:code,
}).nullable();
const checked = z.boolean().nullable();
const fieldChecks = z.object({requestId:checked,department:checked,item:checked,quantity:checked,reason:checked,payloadHash:checked,canonicalHash:checked,executionKey:checked,planHash:checked});
// Explicit objects strip all unexpected keys, including inside nested report layers.
const reportSchema = z.object({
  schema:z.literal('office-agent-execution-proof-v1'),syntheticOnly:z.literal(true),generatedAt:stamp,
  run:z.object({id:z.string().uuid(),revision:z.number().int().positive(),targetRevision:z.number().int().nonnegative().nullable(),
    adapterVersion:code,status:z.enum(['draft','approved','executing','unknown','verified','blocked','cancelled']),
    effectStatus:z.enum(['none','unknown','applied']),plan:z.object({...payload,source:z.enum(['bounded-rule','ollama','workers-ai']).nullable()}),
    planHash:digest,executionKey:digest.nullable()}),
  approval:z.object({status:z.enum(['matched','missing','mismatch','expired']),approvedHash:digest.nullable(),expiresAt:stamp.nullable(),hashMatches:z.boolean(),validAtObservation:z.boolean()}),
  browser:z.object({status:z.enum(['observed','not-observed','invalid']),sameAttempt:z.boolean(),evidence,
    statement:z.enum(['no-browser-action-recorded-for-this-run','browser-observations-only-not-business-effect'])}),
  database:z.object({effectStatus:z.enum(['none','unknown','applied']),hasPersistedResult:z.boolean(),persistedResultMatchesPlan:z.boolean().nullable(),result:demand}),
  api:z.object({checkedAt:stamp,queryStatus:z.enum(['found','not-found','unavailable']),status:z.enum(['verified','mismatch','not-found','unknown']),checks:fieldChecks,demand,issues:z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)).max(30)}),
  allowedNextAction:z.enum(['approve','execute','query-only','none']),digest:z.object({algorithm:z.literal('SHA-256'),value:digest}),
});
type PublicReport = z.infer<typeof reportSchema>;
type Entry = {runId:string;requestId:string;readStatus:'read';report:PublicReport}|{runId:string;requestId:string;readStatus:'failed';code:'REPORT_UNAVAILABLE_OR_INVALID'};

export async function collectHandoff(runs: Run[], filter: QueueFilter, read: (id:string) => Promise<unknown>, alive: () => boolean) {
  if (!runs.length || runs.length > 10) throw new Error('请将筛选结果缩小到 1–10 条再导出。');
  const startedAt = new Date().toISOString();
  const entries: Entry[] = [];
  for (const run of runs) {
    if (!alive()) throw new Error('工作区已切换，旧核对包不会下载。');
    try {
      const report = reportSchema.parse(await read(run.id));
      if (!await verifyExecutionProof(report)) throw new Error('报告校验值不匹配。');
      if (report.run.id!==run.id||report.run.revision!==run.revision||report.run.planHash!==run.planHash||report.run.plan.requestId!==run.plan.requestId) throw new Error('报告版本已改变。');
      entries.push({runId:run.id,requestId:run.plan.requestId,readStatus:'read',report});
    } catch { entries.push({runId:run.id,requestId:run.plan.requestId,readStatus:'failed',code:'REPORT_UNAVAILABLE_OR_INVALID'}); }
    if (!alive()) throw new Error('工作区已切换，旧核对包不会下载。');
  }
  const readEntries = entries.filter((entry):entry is Extract<Entry,{readStatus:'read'}> => entry.readStatus==='read');
  return {schema:'office-agent-handoff-v1',syntheticOnly:true,scope:'current-session-filtered-runs',startedAt,generatedAt:new Date().toISOString(),
    selection:{...filter,count:runs.length},complete:readEntries.length===runs.length,
    summary:{selected:runs.length,reportsRead:readEntries.length,readFailures:runs.length-readEntries.length,
      apiVerified:readEntries.filter(entry=>entry.report.api.status==='verified'&&entry.report.api.queryStatus==='found'&&Object.values(entry.report.api.checks).length===9&&Object.values(entry.report.api.checks).every(value=>value===true)).length},
    statement:'Each report is a separate fresh API observation. Read completeness is not execution success. The digest is not a signature.',entries};
}
