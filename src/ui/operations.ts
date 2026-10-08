import type { Run } from '../contracts.js';
import type { ExecutionProof } from '../runtime/proof.js';
export type QueueStage = 'review' | 'execute' | 'reconcile' | 'stopped' | 'complete';
export const queueLabels: Record<QueueStage, string> = {review:'待审核', execute:'待执行', reconcile:'需核对', stopped:'已停止', complete:'已完成'};
export interface QueueObservation { proof?: ExecutionProof; reportUnavailable?: boolean; }
export interface QueueFilter { search: string; department: string; stage: string; }
export function queueStage(run: Run, observation: QueueObservation = {}, now = Date.now()): QueueStage {
  const {proof, reportUnavailable} = observation;
  if (reportUnavailable) return 'reconcile';
  if (run.status === 'verified') return !proof || (proof.api.status !== 'verified' || proof.api.queryStatus !== 'found' || !Object.values(proof.api.checks).every(value => value === true)) ? 'reconcile' : 'complete';
  if (proof?.allowedNextAction === 'query-only' || run.status === 'executing' || run.status === 'unknown' || run.effectStatus !== 'none') return 'reconcile';
  if (run.status === 'cancelled' || run.status === 'blocked') return 'stopped';
  if (run.status === 'approved' && run.approvedHash === run.planHash && run.approvalExpiresAt && Date.parse(run.approvalExpiresAt) > now) return 'execute';
  return 'review';
}
export function queueAdvice(run: Run, observation: QueueObservation = {}): string {
  const stage = queueStage(run, observation);
  if (stage === 'reconcile') return '仅核对原需求结果，保留已发生效果';
  if (stage === 'complete') return '读取新鲜报告后交接；状态不代替本次验收';
  if (stage === 'execute') return '打开计划，逐条执行已确认内容';
  if (stage === 'stopped') return run.status === 'cancelled' ? '保留取消记录；新需求另行准备' : '检查停止原因，再修订或刷新目标重新确认';
  return run.status === 'approved' ? '确认已过期或不匹配；刷新目标后重新确认' : '打开完整字段，刷新目标并人工确认';
}
export function matchesQueue(run: Run, filter: QueueFilter, observation: QueueObservation = {}): boolean {
  const haystack = [run.plan.requestId,run.plan.department,run.plan.item,run.error ?? '',run.status].join(' ').toLocaleLowerCase();
  return (!filter.search.trim() || haystack.includes(filter.search.trim().toLocaleLowerCase())) && (!filter.department || run.plan.department === filter.department) && (!filter.stage || queueStage(run, observation) === filter.stage);
}
