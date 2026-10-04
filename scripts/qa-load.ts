import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import type { ApiReply, Run, SessionView } from '../src/contracts.ts';
import { implementationHash, publicEvidenceText } from '../tests/e2e/qa-metadata.ts';

interface Sample { index: number; durationMs: number; status: number; ok: boolean; errorCode?: string; verified?: boolean; }
const percentile = (samples: Sample[], fraction: number) => [...samples].sort((a, b) => a.durationMs - b.durationMs)[Math.max(0, Math.ceil(samples.length * fraction) - 1)]!.durationMs;
export async function runLoadQA() {
  const startedAt = new Date().toISOString(), diffHash = implementationHash();
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('port unavailable');
  const port = address.port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, directory = await mkdtemp(join(tmpdir(), 'office-load-qa-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, DATA_DIR: directory, PLANNER_MODE: 'rules', SESSION_SECRET: 'synthetic-load-secret-only-this-temporary-service-2026' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 500); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('actual src/server.ts startup timeout')), 10_000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('office-workflow-agent')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('actual server exited during startup')); });
    });
    async function session() {
      const response = await fetch(origin + '/api/session'); const reply = await response.json() as ApiReply<SessionView>;
      assert.equal(reply.ok, true);
      return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: (reply as { ok: true; data: SessionView }).data.csrf };
    }
    const client = await session();
    async function api<T>(client: { cookie: string; csrf: string }, path: string, body?: unknown) {
      const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: client.cookie, ...(body === undefined ? {} : { Origin: origin, 'X-CSRF-Token': client.csrf, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) });
      return { status: response.status, reply: await response.json() as ApiReply<T> };
    }
    async function measure(label: string, denominator: number, concurrency: number, operation: (index: number) => Promise<{ status: number; reply: ApiReply<unknown>; verified?: boolean }>) {
      const samples: Sample[] = []; let next = 0; const begin = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < denominator) {
          const index = next++, started = performance.now();
          try {
            const outcome = await operation(index);
            samples.push({ index, durationMs: +(performance.now() - started).toFixed(3), status: outcome.status, ok: outcome.reply.ok, ...(outcome.reply.ok ? {} : { errorCode: outcome.reply.error.code }), ...(outcome.verified === undefined ? {} : { verified: outcome.verified }) });
          } catch { samples.push({ index, durationMs: +(performance.now() - started).toFixed(3), status: 0, ok: false, errorCode: 'TRANSPORT_ERROR' }); }
        }
      }));
      const durationMs = performance.now() - begin;
      return { label, denominator, concurrency, successes: samples.filter(sample => sample.ok).length, errors: samples.filter(sample => !sample.ok).length, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), maxMs: percentile(samples, 1), elapsedMs: +durationMs.toFixed(3), observedRequestsPerSecond: +(denominator * 1000 / durationMs).toFixed(2), samples: samples.sort((a, b) => a.index - b.index) };
    }
    for (let index = 0; index < 10; index++) await api(client, '/api/health');
    const proposals = await measure('actual POST /api/propose over loopback HTTP', 40, 4, index => api(client, '/api/propose', { text: `为研发部登记12台显示器，需求编号REQ-LOAD-${String(index).padStart(3, '0')}。` }));
    const reads = await measure('actual GET /api/runs over loopback HTTP (40 stored plans)', 120, 8, () => api(client, '/api/runs'));
    const executions = await measure('actual execute API + fresh Chromium form + SQLite + reconciliation', 5, 1, async index => {
      const client = await session();
      const proposed = await api<Run>(client, '/api/propose', { text: `为研发部登记12台显示器，需求编号REQ-BUSINESS-${String(index).padStart(3, '0')}。` });
      assert.equal(proposed.reply.ok, true); const run = (proposed.reply as { ok: true; data: Run }).data;
      await api(client, `/api/runs/${run.id}/approve`, { revision: run.revision, planHash: run.planHash, targetRevision: run.targetRevision });
      const execute = await api<Run>(client, `/api/runs/${run.id}/execute`, {});
      return { ...execute, verified: execute.reply.ok && execute.reply.data.status === 'verified' };
    });
    const health = await api<{ demands: number; runs: number }>(client, '/api/health');
    assert.equal(health.reply.ok, true);
    const report = { schema: 'office-independent-load-qa-v1', syntheticOnly: true, startedAt, completedAt: new Date().toISOString(), node: process.version, nodeExecutable: process.execPath, command: publicEvidenceText(process.argv.join(' ')), invokedBy: process.env.TEST_WORKER_INDEX === undefined ? 'standalone script' : 'Playwright operations.spec.ts', actualServerCommand: `${process.execPath} --import tsx src/server.ts`, plannerMode: 'rules',
      diffHash, finalDiffHash: implementationHash(), warmupExcluded: 10, measuredRequestDenominator: 165, groups: [proposals, reads, executions], finalHealth: health.reply,
      limitations: ['Local bounded sample only, not production SLO attainment or exactly-once proof.', '5 business samples include propose/approve/setup latency; do not compare with read API latency.', 'Node 22 is not verified.'], warnings: stderr.includes('ExperimentalWarning') ? ['node:sqlite experimental warning emitted'] : [] };
    await mkdir('docs/qa', { recursive: true }); await writeFile('docs/qa/load-results.json', JSON.stringify(report, null, 2) + '\n');
    assert.equal(proposals.errors, 0); assert.equal(reads.errors, 0); assert.equal(executions.errors, 0);
    assert.equal(executions.samples.filter(sample => sample.verified).length, 5);
    assert.equal((health.reply as { ok: true; data: { demands: number } }).data.demands, 5);
    console.log(JSON.stringify({ measuredRequestDenominator: 165, businessVerified: 5, groups: [proposals, reads, executions].map(({ label, denominator, concurrency, errors, p95Ms }) => ({ label, denominator, concurrency, errors, p95Ms })) }));
    return report;
  } finally {
    if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/qa-load.ts')) await runLoadQA();
