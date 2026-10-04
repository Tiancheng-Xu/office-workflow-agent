import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { implementationSnapshot, implementationHashMethod, publicEvidenceText, qaHarnessSnapshot, qaBudgets } from './qa-metadata.ts';
export default class QAReporter implements Reporter {
  private startedAt = new Date().toISOString();
  private initialSnapshot = implementationSnapshot();
  private initialQA = qaHarnessSnapshot();
  private tests: unknown[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    this.tests.push({ title: test.titlePath().slice(1).join(' > '), status: result.status, durationMs: result.duration, retry: result.retry,
      errors: result.errors.map(error => ({ message: error.message && publicEvidenceText(error.message).replace(/\u001b\[[0-9;]*m/g, '').replace(/([?&](?:cap|token)=)[^&\s]+/gi, '$1[redacted]').replace(/(office_session=)[^;\s]+/gi, '$1[redacted]').slice(0, 3000), location: error.location && { ...error.location, file: publicEvidenceText(error.location.file) } })) });
  }
  onEnd(result: FullResult) {
    mkdirSync('docs/qa', { recursive: true });
    const finalSnapshot = implementationSnapshot();
    const finalQA = qaHarnessSnapshot();
    let revision = 'unavailable';
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    const results = this.tests as { status: string }[];
    const contractBytes = readFileSync('specs/office-agent/contract.json');
    const contract = JSON.parse(contractBytes.toString('utf8')) as { version: number; contractHash: string };
    writeFileSync('docs/qa/browser-results.json', JSON.stringify({ schema: 'office-independent-qa-v1', reviewer: 'independent Codex Sol ultra QA; not implementation author', syntheticOnly: true,
      startedAt: this.startedAt, completedAt: new Date().toISOString(), status: result.status,
      node: process.version, nodeExecutable: process.execPath, command: publicEvidenceText(process.argv.join(' ')), revision,
      diffHash: this.initialSnapshot.hash, hashMethod: implementationHashMethod, sourceManifest: this.initialSnapshot.files,
      contractVersion: contract.version, declaredContractHash: contract.contractHash,
      contractFileByteHash: createHash('sha256').update(contractBytes).digest('hex'),
      finalDiffHash: finalSnapshot.hash, implementationStableDuringRun: this.initialSnapshot.hash === finalSnapshot.hash,
      sourceGate: this.initialSnapshot.hash !== finalSnapshot.hash ? 'FAIL_SOURCE_CHANGED_DURING_RUN' : this.initialQA.hash !== finalQA.hash ? 'FAIL_QA_CHANGED_DURING_RUN' : result.status !== 'passed' ? 'FAIL_TESTS' : 'PASS_LOCAL_SOURCE',
      qaHarnessHash: this.initialQA.hash, finalQAHarnessHash: finalQA.hash, qaHarnessManifest: this.initialQA.files,
      qaHarnessStableDuringRun: this.initialQA.hash === finalQA.hash, qaBudgets,
      denominator: results.length, passed: results.filter(test => test.status === 'passed').length, failed: results.filter(test => test.status === 'failed' || test.status === 'timedOut').length,
      tests: this.tests, limitations: ['Local synthetic HTTP/SQLite/Chromium only; production business readback is a separate gate.', 'Node 22 not verified in this run.'] }, null, 2) + '\n');
  }
}
