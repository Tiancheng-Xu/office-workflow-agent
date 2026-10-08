import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Run } from '../../src/contracts.ts';
import { verifyExecutionProof, type ExecutionProof } from '../../src/runtime/proof.ts';
import { TestApp, type Client } from './harness.ts';

export type ReportView = ExecutionProof;
// Independent digest calculation: no implementation canonicalizer or hashing helper is imported.
export function independentlyCanonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentlyCanonicalJSON).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${independentlyCanonicalJSON(item)}`).join(',')}}`;
}
export function independentProofDigest(proof: ExecutionProof): string {
  const { digest: _, ...body } = proof;
  return createHash('sha256').update(independentlyCanonicalJSON(body), 'utf8').digest('hex');
}
export function assertNoPrivateReportFields(value: unknown, path = 'report') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    expect(/^(?:csrf|cookie|cookies|token|cap|capability|authorization|password|secret|sessionId|tenantId|browserStorage|rawForm|rawUrl)$/i.test(key), `${path}.${key}`).toBe(false);
    if (typeof item === 'string') expect(item, `${path}.${key}`).not.toMatch(/[?&](?:cap|token)=|office_session=/i);
    assertNoPrivateReportFields(item, `${path}.${key}`);
  }
}
export async function readAndAssertProof(app: TestApp, client: Client, run: Run) {
  const response = await app.api<ReportView>(client, `/api/runs/${run.id}/report`);
  expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
  if (!response.body.ok) throw new Error('proof report rejected');
  const report = response.body.data;
  expect(report.syntheticOnly).toBe(true);
  expect(report.schema).toBe(run.plan.unit?'office-agent-execution-proof-v2':'office-agent-execution-proof-v1');
  expect(Object.keys(report).sort()).toEqual(['allowedNextAction', 'api', 'approval', 'browser', 'database', 'digest', 'generatedAt', 'run', 'schema', 'syntheticOnly']);
  expect(report.run.id).toBe(run.id);
  expect(report.run.revision).toBe(run.revision);
  expect(report.run.targetRevision).toBe(run.targetRevision);
  expect(report.run.planHash).toBe(run.planHash);
  expect(report.run.executionKey).toBe(run.executionKey);
  expect(report.digest.algorithm).toBe('SHA-256');
  expect(report.digest.value).toMatch(/^[a-f0-9]{64}$/);
  expect(independentProofDigest(report)).toBe(report.digest.value);
  expect(await verifyExecutionProof(report)).toBe(true);
  assertNoPrivateReportFields(report);
  return report;
}
export function assertVerifiedProof(proof: ExecutionProof, quantity: number) {
  expect(proof.api.queryStatus).toBe('found'); expect(proof.api.status).toBe('verified');
  expect(Object.keys(proof.api.checks).sort()).toEqual(['canonicalHash', 'department', 'executionKey', 'item', 'payloadHash', 'planHash', 'quantity', 'reason', 'requestId',...(proof.schema==='office-agent-execution-proof-v2'?['unit']:[])]);
  expect(Object.values(proof.api.checks).every(value => value === true)).toBe(true);
  expect(proof.api.demand?.quantity).toBe(quantity);
  expect(proof.database.effectStatus).toBe('applied');
  expect(proof.database.hasPersistedResult).toBe(true);
  expect(proof.database.persistedResultMatchesPlan).toBe(true);
  expect(proof.database.result?.quantity).toBe(quantity);
}
