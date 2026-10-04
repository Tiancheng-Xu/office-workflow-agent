import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ApiReply, Run, SessionView } from '../src/contracts.ts';
import { implementationHash, publicEvidenceText } from '../tests/e2e/qa-metadata.ts';

type Message = { type: string; origin?: string; node?: string; phase?: string; demands?: number; formPosts?: number; formGets?: number; browserLaunches?: number; demandCount?: number };
function nextMessage(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${type}`)); }, 15_000);
    const listener = (message: Message) => { if (message.type === type) { cleanup(); resolve(message); } };
    const died = () => { cleanup(); reject(new Error(`child exited before ${type}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off('message', listener); child.off('exit', died); };
    child.on('message', listener); child.once('exit', died);
  });
}
async function start(database: string, mode: string) {
  const child = fork(resolve('tests/e2e/crash-server.ts'), [database, mode], { execPath: process.execPath, execArgv: ['--import', 'tsx'], silent: true, env: { ...process.env, PLANNER_MODE: 'rules' } });
  child.stdout?.resume(); child.stderr?.resume();
  const ready = await nextMessage(child, 'ready');
  return { child, origin: ready.origin!, node: ready.node! };
}
async function request<T>(origin: string, cookie: string, csrf: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const reply = await response.json() as ApiReply<T>;
  assert.equal(reply.ok, true, `HTTP ${response.status}`);
  return (reply as { ok: true; data: T }).data;
}
async function shutdown(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill(signal); await exited;
}
export async function runCrashQA() {
  const startedAt = new Date().toISOString(), diffHash = implementationHash(), results: unknown[] = [];
  for (const phase of ['gate-before-effect', 'gate-after-effect']) {
    const directory = await mkdtemp(join(tmpdir(), 'office-crash-qa-'));
    const database = join(directory, 'office.sqlite');
    const first = await start(database, phase);
    let restored: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const sessionResponse = await fetch(first.origin + '/api/session');
      const sessionReply = await sessionResponse.json() as ApiReply<SessionView>;
      assert.equal(sessionReply.ok, true);
      const csrf = (sessionReply as { ok: true; data: SessionView }).data.csrf;
      const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
      const run = await request<Run>(first.origin, cookie, csrf, '/api/propose', { text: `为研发部登记12台显示器，需求编号REQ-CRASH-${phase === 'gate-before-effect' ? 'BEFORE' : 'AFTER'}。` });
      await request(first.origin, cookie, csrf, `/api/runs/${run.id}/approve`, { revision: run.revision, planHash: run.planHash, targetRevision: run.targetRevision });
      const gate = nextMessage(first.child, 'gate');
      const pendingExecute = request<Run>(first.origin, cookie, csrf, `/api/runs/${run.id}/execute`, {}).then(() => 'returned', () => 'connection-lost');
      const atGate = await gate;
      assert.equal(atGate.formPosts, 1);
      assert.equal(atGate.demands, phase === 'gate-before-effect' ? 0 : 1);
      await shutdown(first.child, 'SIGKILL');
      const pendingOutcome = await pendingExecute;
      assert.equal(first.child.signalCode, 'SIGKILL');
      restored = await start(database, 'none');
      const runs = await request<Run[]>(restored.origin, cookie, csrf, '/api/runs');
      const recovered = runs.find(current => current.id === run.id)!;
      assert.equal(recovered.status, 'unknown');
      assert.equal(recovered.effectStatus, phase === 'gate-before-effect' ? 'unknown' : 'applied');
      assert.ok(recovered.events.some(event => event.type === 'crash-recovery'));
      const replay = await request<Run>(restored.origin, cookie, csrf, `/api/runs/${run.id}/execute`, {});
      assert.equal(replay.status, phase === 'gate-before-effect' ? 'unknown' : 'verified');
      const stats = nextMessage(restored.child, 'stats'); restored.child.send('inspect');
      const observed = await stats;
      assert.equal(observed.browserLaunches, 0); assert.equal(observed.formPosts, 0); assert.equal(observed.formGets, 0);
      assert.equal(observed.demandCount, phase === 'gate-before-effect' ? 0 : 1);
      results.push({ phase, processSignal: first.child.signalCode, pendingOutcome, persistedFormPostsBeforeKill: atGate.formPosts, demandsBeforeKill: atGate.demands,
        recoveredStatus: recovered.status, recoveredEffectStatus: recovered.effectStatus, replayStatus: replay.status, noReissuedBrowser: true, observed, node: first.node });
    } finally { await shutdown(first.child, 'SIGTERM'); if (restored) await shutdown(restored.child, 'SIGTERM'); }
  }
  const report = { schema: 'office-independent-crash-qa-v1', syntheticOnly: true, startedAt, completedAt: new Date().toISOString(), node: process.version, nodeExecutable: process.execPath, command: publicEvidenceText(process.argv.join(' ')), invokedBy: process.env.TEST_WORKER_INDEX === undefined ? 'standalone script' : 'Playwright operations.spec.ts',
    diffHash, finalDiffHash: implementationHash(), denominator: results.length, passed: results.length, faultMethod: 'SIGKILL of real child HTTP service during real Chromium POST, before/after actual SQLite transaction', results };
  await mkdir('docs/qa', { recursive: true }); await writeFile('docs/qa/crash-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ crashCases: results.length, passed: results.length, node: process.version }));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/qa-crash.ts')) await runCrashQA();
