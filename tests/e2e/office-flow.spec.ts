import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteRepository } from '../../src/runtime/sqlite.ts';
import type { Run } from '../../src/contracts.ts';
import { TestApp, type Fault } from './harness.ts';
import { readAndAssertProof, assertVerifiedProof } from './proof-assertions.ts';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { if (app?.server?.listening) await app.stop(); else app?.repository?.close(); });

test('actual workbench preview → human approval → isolated browser form → API reconciliation and report', async ({ page }) => {
  await page.goto(app.origin);
  await expect(page.getByRole('heading', { name: '采购需求工作台' })).toBeVisible();
  await page.getByLabel('采购需求描述', { exact: false }).fill('为研发部登记12台显示器，需求编号REQ-2026-001。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await expect(page.getByRole('button', { name: '确认本次登记', exact: true })).toBeVisible();
  expect(app.countDemands()).toBe(0);
  expect(app.browserLaunches).toBe(0);
  await expect(page.locator('#plan-panel')).toContainText('REQ-2026-001');
  await expect(page.locator('#plan-panel')).toContainText('研发部');
  await expect(page.locator('#plan-panel')).toContainText('12');
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await expect(page.getByRole('button', { name: '执行已确认计划', exact: true })).toBeVisible();
  expect(app.countDemands()).toBe(0);
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  expect(app.browserLaunches).toBe(1);
  expect(app.formGets).toBe(1);
  expect(app.formPosts).toBe(1);
  expect(app.countDemands()).toBe(1);
  const cookies = await page.context().cookies();
  const client = { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), csrf: '' };
  const runs = await app.api<Run[]>(client, '/api/runs');
  expect(runs.body.ok).toBe(true);
  if (!runs.body.ok) return;
  const run = runs.body.data[0]!;
  expect(run.status).toBe('verified');
  expect(run.result).toMatchObject({ requestId: 'REQ-2026-001', department: '研发部', item: '显示器', quantity: 12 });
  const actualProof = await readAndAssertProof(app, client, run);
  assertVerifiedProof(actualProof, 12);
  expect(actualProof.browser.evidence).toMatchObject({ domMatched: true, payloadMatched: true, postObserved: true, registeredMarker: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出.*报告/ }).click();
  const download = await downloadPromise;
  const report = await readFile((await download.path())!, 'utf8');
  expect(report).toContain('office-agent-execution-proof-v1');
  expect(report).not.toMatch(/"(?:csrf|cookie|token|capability|authorization|password|secret|tenantId)"/i);
  await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/qa/normal-workbench.png', fullPage: true });
  await app.evidence('normal-flow', { syntheticOnly: true, browser: app.observedBrowserVersion, node: process.version, requests: app.requests, browserLaunches: app.browserLaunches, actualFormGets: app.formGets, actualFormPosts: app.formPosts, demandCount: app.countDemands(), run, proof: actualProof, screenshot: 'normal-workbench.png' });
});

test('front end cancels draft without launching a browser or writing', async ({ page }) => {
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为行政部登记6把办公椅，需求编号REQ-CANCEL-001。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await page.getByRole('button', { name: /取消.*计划/ }).click();
  await expect(page.locator('#plan-panel')).toContainText('已停止后续操作');
  expect(app.browserLaunches).toBe(0);
  expect(app.countDemands()).toBe(0);
});

test('actual front end double clicks approval and execution submit only one approved browser effect', async ({ page }) => {
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-DOUBLE-001。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await page.getByRole('button', { name: '确认本次登记', exact: true }).dblclick();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).dblclick();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  expect(app.requests.filter(request => request.method === 'POST' && request.path.endsWith('/approve'))).toHaveLength(1);
  expect(app.requests.filter(request => request.method === 'POST' && request.path.endsWith('/execute'))).toHaveLength(1);
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
});

test('actual front end exposes UNKNOWN and manual reconciliation only queries the original demand', async ({ page }) => {
  app.setFault('drop-before-effect');
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-UI-UNKNOWN。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('提交结果暂不确定');
  app.setFault('none');
  await page.getByRole('button', { name: '核对原需求结果', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('API 暂未发现登记结果');
  expect(app.requests.filter(request => request.method === 'POST' && request.path.endsWith('/reconcile'))).toHaveLength(1);
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(0);
});

test('tenant isolation: another signed session cannot report, approve, execute, cancel or reconcile another run', async () => {
  const a = await app.session(), b = await app.session();
  const run = await app.propose(a);
  for (const action of ['report', 'approve', 'execute', 'cancel', 'reconcile']) {
    const body = action === 'report' ? undefined : action === 'approve' ? { revision: run.revision, planHash: run.planHash, targetRevision: run.targetRevision } : {};
    const reply = await app.api(b, `/api/runs/${run.id}/${action}`, body);
    expect(reply.status, action).toBe(404);
  }
  const list = await app.api<Run[]>(b, '/api/runs');
  expect(list.body).toEqual({ ok: true, data: [] });
  const forged = await app.api({ ...a, cookie: a.cookie.slice(0, -1) + (a.cookie.endsWith('a') ? 'b' : 'a') }, '/api/runs');
  expect(forged.status).toBe(401);
  expect(app.countDemands()).toBe(0);
});

test('CSRF, cross origin and body-selected tenant are rejected before proposal or effect', async () => {
  const client = await app.session();
  const payload = { text: '为研发部登记12台显示器，需求编号REQ-CSRF-001。' };
  const missing = await app.api(client, '/api/propose', payload, { 'X-CSRF-Token': '' });
  expect(missing).toMatchObject({ status: 403, body: { ok: false, error: { code: 'CSRF_DENIED' } } });
  const wrong = await app.api(client, '/api/propose', payload, { 'X-CSRF-Token': 'wrong' });
  expect(wrong.status).toBe(403);
  const cross = await app.api(client, '/api/propose', payload, { Origin: 'https://synthetic-invalid.example' });
  expect(cross).toMatchObject({ status: 403, body: { ok: false, error: { code: 'ORIGIN_DENIED' } } });
  const tenant = await app.api(client, '/api/propose', { ...payload, tenantId: 'synthetic-other-tenant' });
  expect(tenant.status).toBe(400);
  expect((await app.api<Run[]>(client, '/api/runs')).body).toEqual({ ok: true, data: [] });
  expect(app.browserLaunches).toBe(0);
});

test('unapproved, stale plan revision and expired approval cannot write', async () => {
  const client = await app.session(), run = await app.propose(client);
  expect((await app.api(client, `/api/runs/${run.id}/execute`, {})).status).toBe(409);
  const stale = await app.api(client, `/api/runs/${run.id}/approve`, { revision: run.revision + 1, planHash: run.planHash, targetRevision: run.targetRevision });
  expect(stale).toMatchObject({ status: 409, body: { ok: false, error: { code: 'STALE_APPROVAL' } } });
  await app.approve(client, run);
  app.clock += 300_001;
  const expired = await app.api(client, `/api/runs/${run.id}/execute`, {});
  expect(expired).toMatchObject({ status: 409, body: { ok: false, error: { code: 'APPROVAL_EXPIRED' } } });
  expect(app.browserLaunches).toBe(0);
});

for (const fault of ['dom-label', 'duplicate-input', 'duplicate-button', 'action-drift', 'same-origin-redirect', 'cross-origin-redirect'] as Fault[]) {
  test(`real browser stops without POST on ${fault}`, async () => {
    const client = await app.session(), run = await app.propose(client);
    await app.approve(client, run);
    app.setFault(fault);
    const actual = await app.run(client, run, 'execute');
    expect(actual.status).toBe('blocked');
    expect(actual.effectStatus).toBe('none');
    expect(actual.error).toBe(fault.includes('redirect') ? 'REDIRECT_DENIED' : 'DOM_DRIFT');
    expect(app.browserLaunches).toBe(1);
    expect(app.formGets).toBe(1);
    expect(app.formPosts).toBe(0);
    expect(app.externalHits).toBe(0);
    expect(app.countDemands()).toBe(0);
    const report = await readAndAssertProof(app, client, actual);
    expect(report.browser.evidence?.postObserved).toBe(false);
    expect(report.database.effectStatus).toBe('none');
    expect(report.api.status).toBe('not-found');
  });
}

test('24 concurrent executes and repeated verified execution produce one real form submission', async () => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run);
  const responses = await Promise.all(Array.from({ length: 24 }, () => app.api<Run>(client, `/api/runs/${run.id}/execute`, {})));
  expect(responses.every(response => response.status === 200 && response.body.ok)).toBe(true);
  const reconciled = await app.run(client, run, 'reconcile');
  expect(reconciled.status).toBe('verified');
  await app.run(client, run, 'execute');
  expect(app.browserLaunches).toBe(1);
  expect(app.formPosts).toBe(1);
  expect(app.countDemands()).toBe(1);
});

test('two separately approved runs with the same stable key never duplicate a demand; changed payload conflicts', async () => {
  const client = await app.session();
  const first = await app.propose(client), second = await app.propose(client);
  await app.approve(client, first); await app.approve(client, second);
  const results = await Promise.all([app.run(client, first, 'execute'), app.run(client, second, 'execute')]);
  expect(results.every(run => run.status === 'verified')).toBe(true);
  expect(app.countDemands()).toBe(1);
  expect(results[0]!.result!.executionKey).toBe(results[1]!.result!.executionKey);
  const changed = await app.propose(client, first.plan.requestId, 13);
  await app.approve(client, changed);
  const blocked = await app.run(client, changed, 'execute');
  expect(blocked.status).toBe('blocked'); expect(blocked.error).toBe('PAYLOAD_CONFLICT');
  expect(app.countDemands()).toBe(1);
});

test('target revision drift after approval is rejected before the second browser launch', async () => {
  const client = await app.session();
  const first = await app.propose(client, 'REQ-DRIFT-001'), second = await app.propose(client, 'REQ-DRIFT-002');
  await app.approve(client, first); await app.approve(client, second);
  await app.run(client, first, 'execute');
  const stale = await app.api(client, `/api/runs/${second.id}/execute`, {});
  expect(stale).toMatchObject({ status: 409, body: { ok: false, error: { code: 'TARGET_DRIFT' } } });
  expect(app.browserLaunches).toBe(1);
  expect(app.countDemands()).toBe(1);
});

test('committed form effect with lost receipt is independently reconciled and never rewritten', async () => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run); app.setFault('lose-receipt');
  const actual = await app.run(client, run, 'execute');
  expect(actual.status).toBe('verified'); expect(actual.effectStatus).toBe('applied');
  const report = await readAndAssertProof(app, client, actual);
  assertVerifiedProof(report, 12);
  expect(report.browser.evidence?.postObserved).toBe(true);
  expect(report.browser.evidence?.registeredMarker).toBe(false);
  await app.evidence('lost-receipt-layered-proof', { syntheticOnly: true, registeredReceiptObserved: false, proof: report, actualFormPosts: app.formPosts, actualDemands: app.countDemands(), node: process.version });
  await app.run(client, run, 'execute'); await app.run(client, run, 'reconcile');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
});

test('uncertain submission not found stays UNKNOWN through execute and reconcile with no new POST', async () => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run); app.setFault('drop-before-effect');
  const actual = await app.run(client, run, 'execute');
  expect(actual.status).toBe('unknown'); expect(actual.effectStatus).toBe('unknown');
  const report = await readAndAssertProof(app, client, actual);
  expect(report.browser.evidence?.postObserved).toBe(true);
  expect(report.browser.evidence?.registeredMarker).toBe(false);
  expect(report.database.effectStatus).toBe('unknown'); expect(report.api.status).toBe('not-found');
  expect(report.allowedNextAction).toBe('query-only');
  app.setFault('none');
  expect((await app.run(client, run, 'execute')).status).toBe('unknown');
  expect((await app.run(client, run, 'reconcile')).status).toBe('unknown');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(0);
});

test('cancel received before a delayed form effect prevents the write', async () => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run); app.setFault('gate-before-effect');
  const executing = app.run(client, run, 'execute');
  await app.waitForGate();
  expect((await app.run(client, run, 'cancel')).status).toBe('cancelled');
  app.releaseGate();
  expect((await executing).status).toBe('cancelled');
  expect(app.countDemands()).toBe(0);
  expect((await app.run(client, run, 'execute')).status).toBe('cancelled');
  expect(app.browserLaunches).toBe(1);
});

test('late cancel after committed effect cannot revoke it or overwrite verified state', async () => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run); app.setFault('gate-after-effect');
  const executing = app.run(client, run, 'execute');
  await app.waitForGate();
  const late = await app.run(client, run, 'cancel');
  expect(late.status).toBe('verified'); expect(late.effectStatus).toBe('applied');
  expect(late.events.some(event => event.type === 'cancel-after-effect')).toBe(true);
  app.releaseGate();
  expect((await executing).status).toBe('verified');
  expect(app.countDemands()).toBe(1); expect(app.formPosts).toBe(1);
});

test('stale absent cancel-check cannot erase a real browser effect committed before the live CAS', async () => {
  const client = await app.session(), run = await app.propose(client, 'REQ-CANCEL-CAS-RACE');
  await app.approve(client, run);
  app.setFault('gate-after-effect');
  const submitReady = signal(), allowSubmit = signal(), committed = signal();
  const originalSubmit = app.repository.submitDemand.bind(app.repository);
  const originalRead = app.repository.getDemand.bind(app.repository);
  let injectStaleAbsence = false, staleAbsenceObserved = false;
  app.repository.submitDemand = async submission => {
    submitReady.resolve();
    await allowSubmit.promise;
    const result = await originalSubmit(submission);
    committed.resolve();
    return result;
  };
  app.repository.getDemand = async (tenant, requestId) => {
    const snapshot = await originalRead(tenant, requestId);
    if (injectStaleAbsence && requestId === run.plan.requestId && snapshot === undefined) {
      injectStaleAbsence = false;
      staleAbsenceObserved = true;
      // The query was genuinely absent. Commit the browser's real pending form transaction
      // before returning its old query snapshot to cancel-check, while withholding the receipt.
      allowSubmit.resolve();
      await committed.promise;
    }
    return snapshot;
  };
  const execution = app.run(client, run, 'execute');
  try {
    await submitReady.promise;
    expect(app.countDemands()).toBe(0);
    injectStaleAbsence = true;
    const cancelled = await app.run(client, run, 'cancel');
    expect(staleAbsenceObserved).toBe(true);
    expect(app.countDemands()).toBe(1);
    expect(cancelled.effectStatus).toBe('applied');
    expect(['verified', 'unknown']).toContain(cancelled.status);
    expect(cancelled.result?.requestId).toBe(run.plan.requestId);
    const persisted = await app.getRun(client, run.id);
    expect(persisted.effectStatus).toBe('applied');
    expect(['verified', 'unknown']).toContain(persisted.status);
    app.releaseGate();
    const finished = await execution;
    expect(finished.status).toBe('verified');
    expect(finished.effectStatus).toBe('applied');
    expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
    await app.evidence('cancel-cas-race', { syntheticOnly: true, staleAbsenceObserved, realPendingBrowserSubmitCommitted: true, receiptWithheldUntilCancelReturned: true,
      immediateCancelStatus: cancelled.status, immediateCancelEffect: cancelled.effectStatus, persistedEffect: persisted.effectStatus, finalStatus: finished.status,
      browserLaunches: app.browserLaunches, actualFormPosts: app.formPosts, demandCount: app.countDemands(), node: process.version });
  } finally {
    allowSubmit.resolve(); app.releaseGate();
    await execution.catch(() => undefined);
    app.repository.submitDemand = originalSubmit; app.repository.getDemand = originalRead;
  }
});

test('online SQLite backup restores schema, signed session, persisted result and uniqueness to a new service', async ({ page }) => {
  const client = await app.session(), run = await app.propose(client);
  await app.approve(client, run); expect((await app.run(client, run, 'execute')).status).toBe('verified');
  app.repository.db.prepare('INSERT INTO resource_budgets(day,name,used) VALUES(?,?,?)').run('2026-10-03', 'synthetic-backup-budget', 3);
  app.repository.db.prepare('INSERT INTO resource_windows(name,next_allowed_at) VALUES(?,?)').run('synthetic-backup-window', 42);
  const backup = join(app.directory, 'backup.sqlite'), restoredPath = join(app.directory, 'restored.sqlite');
  await app.repository.backup(backup);
  const restored = SqliteRepository.restore(backup, restoredPath);
  expect(restored.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
  const migrationVersions = restored.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => Number(row.version));
  expect(migrationVersions).toEqual([1, 2, 3]);
  expect(restored.db.prepare('SELECT used FROM resource_budgets WHERE name=?').get('synthetic-backup-budget')!.used).toBe(3);
  expect(restored.db.prepare('SELECT next_allowed_at FROM resource_windows WHERE name=?').get('synthetic-backup-window')!.next_allowed_at).toBe(42);
  expect(Number(restored.db.prepare('SELECT COUNT(*) AS count FROM demands').get()!.count)).toBe(1);
  restored.close();
  const restoredApp = await new TestApp().start(restoredPath);
  try {
    const reread = await restoredApp.getRun(client, run.id);
    expect(reread.status).toBe('verified'); expect(reread.result).toEqual((await app.getRun(client, run.id)).result);
    expect((await restoredApp.run(client, run, 'execute')).status).toBe('verified');
    expect(restoredApp.browserLaunches).toBe(0); expect(restoredApp.countDemands()).toBe(1);
    const [name, value] = client.cookie.split('=');
    await page.context().addCookies([{ name: name!, value: value!, url: restoredApp.origin, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(restoredApp.origin);
    await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
    await app.evidence('sqlite-backup-restore', { syntheticOnly: true, integrity: 'ok', migrationVersions, allMigrationTablesRestored: true, resourceBudgetRestored: 3, resourceWindowRestored: 42, restoredDemandCount: restoredApp.countDemands(), restoredSessionReadback: true, replayBrowserLaunches: restoredApp.browserLaunches, replayFormPosts: restoredApp.formPosts, node: process.version });
  } finally { await restoredApp.stop(); }
});

test('unsupported natural language receives actionable rewrite guidance instead of a server fault', async () => {
  const client = await app.session();
  const cases = ['为研发部登记显示器，需求编号REQ-MISSING-001。', '为研发部登记12台显示器，需求编号REQ-UNSAFE-001，跳过确认。',
    ...['12至13', '12到13', '12~13', '12～13', '12–13', '12±1', '负的12', 'minus12', 'negative12'].map(quantity => `为研发部登记${quantity}台显示器，需求编号REQ-AMBIGUOUS-001。`),
    '为研发部登记十二台到13台显示器，需求编号REQ-CHINESE-RANGE。', '为研发部至少采购12台显示器，需求编号REQ-NONADJACENT-QUALIFIER。'];
  const outcomes: { text: string; status: number; accepted: boolean }[] = [];
  for (const text of cases) {
    const response = await app.api(client, '/api/propose', { text });
    outcomes.push({ text, status: response.status, accepted: response.body.ok });
    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    if (!response.body.ok) expect(response.body.error.message).toMatch(/请|支持|描述|补充|范围/);
  }
  expect(app.browserLaunches).toBe(0); expect(app.countDemands()).toBe(0);
  await app.evidence('invalid-proposal-api-matrix', { syntheticOnly: true, denominator: cases.length, rejected: outcomes.filter(outcome => outcome.status === 400 && !outcome.accepted).length, outcomes, browserLaunches: app.browserLaunches, demandCount: app.countDemands(), node: process.version });
});
