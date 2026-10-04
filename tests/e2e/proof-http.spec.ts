import { test, expect } from '@playwright/test';
import type { Demand, Run } from '../../src/contracts.ts';
import { TestApp } from './harness.ts';
import { readAndAssertProof, assertVerifiedProof } from './proof-assertions.ts';

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { if (app?.server?.listening) await app.stop(); else app?.repository?.close(); });

test('fresh HTTP proof detects actual SQLite field drift and query failure without erasing an applied effect or making the API layer green', async ({ page }) => {
  const client = await app.session(), draft = await app.propose(client, 'REQ-PROOF-FRESH');
  await app.approve(client, draft);
  const verified = await app.run(client, draft, 'execute');
  expect(verified.status).toBe('verified');
  const originalProof = await readAndAssertProof(app, client, verified);
  assertVerifiedProof(originalProof, 12);
  const row = app.repository.db.prepare('SELECT body FROM demands WHERE request_id=?').get(draft.plan.requestId)!;
  const originalBody = String(row.body);
  const changedDemand = JSON.parse(originalBody) as Demand;
  changedDemand.quantity = 13;
  app.repository.db.prepare('UPDATE demands SET body=? WHERE request_id=?').run(JSON.stringify(changedDemand), draft.plan.requestId);
  const mismatch = await readAndAssertProof(app, client, verified);
  expect(mismatch.api.queryStatus).toBe('found'); expect(mismatch.api.status).toBe('mismatch');
  expect(mismatch.api.checks.quantity).toBe(false); expect(mismatch.api.checks.canonicalHash).toBe(false);
  expect(mismatch.api.demand?.quantity).toBe(13);
  expect(mismatch.database.effectStatus).toBe('applied'); expect(mismatch.database.result?.quantity).toBe(12);
  expect(mismatch.database.persistedResultMatchesPlan).toBe(true); expect(mismatch.allowedNextAction).toBe('query-only');
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name: name!, value: value!, url: app.origin, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(app.origin);
  await expect(page.locator('[data-proof-layer="api"]')).toHaveAttribute('data-proof-state', 'warning');
  await expect(page.locator('[data-proof-layer="api"]')).toContainText('字段核对不一致');
  await expect(page.locator('[data-proof-layer="database"]')).toHaveAttribute('data-proof-state', 'verified');
  const originalRead = app.repository.getDemand.bind(app.repository);
  app.repository.getDemand = async () => { throw new Error('synthetic storage read fault'); };
  try {
    const unavailable = await readAndAssertProof(app, client, verified);
    expect(unavailable.api.queryStatus).toBe('unavailable'); expect(unavailable.api.status).toBe('unknown');
    expect(unavailable.api.demand).toBeNull(); expect(unavailable.api.issues).toEqual(['QUERY_UNAVAILABLE']);
    expect(unavailable.database.effectStatus).toBe('applied'); expect(unavailable.database.result?.quantity).toBe(12);
    expect(unavailable.allowedNextAction).toBe('query-only');
    await page.getByRole('button', { name: '刷新核对报告', exact: true }).click();
    await expect(page.locator('[data-proof-layer="api"]')).toHaveAttribute('data-proof-state', 'warning');
    await expect(page.locator('[data-proof-layer="api"]')).toContainText('当前查询待确认');
    await expect(page.locator('[data-proof-layer="database"]')).toHaveAttribute('data-proof-state', 'verified');
    const durable = await app.getRun(client, draft.id);
    expect(durable.effectStatus).toBe('applied'); expect(durable.result?.quantity).toBe(12);
    await app.evidence('fresh-report-faults', { syntheticOnly: true, actualSQLiteChangedQuantity: 13, mismatch, unavailable,
      durableEffectAfterFreshQueryFailure: durable.effectStatus, actualFormPosts: app.formPosts, browserLaunches: app.browserLaunches, node: process.version });
  } finally { app.repository.getDemand = originalRead; app.repository.db.prepare('UPDATE demands SET body=? WHERE request_id=?').run(originalBody, draft.plan.requestId); }
  await page.getByRole('button', { name: '刷新核对报告', exact: true }).click();
  await expect(page.locator('[data-proof-layer="api"]')).toHaveAttribute('data-proof-state', 'verified');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
});

test('a real UI new run reuses an existing result through query-only recovery and cannot claim a browser action for that run', async ({ page }) => {
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-PROOF-DEDUP。');
  await page.getByRole('button', { name: '生成动作预览', exact: true }).click();
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  expect(app.formPosts).toBe(1);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-PROOF-DEDUP。');
  await page.getByRole('button', { name: '生成动作预览', exact: true }).click();
  await expect(page.locator('#execution-proof')).toContainText('本次运行没有浏览器动作证据');
  await expect(page.locator('#recovery-panel')).toContainText('只查询，不重发');
  await expect(page.getByRole('button', { name: '确认本次登记', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '执行已确认计划', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '核对原需求结果', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  await expect(page.locator('[data-proof-layer="browser"]')).toHaveAttribute('data-proof-state', 'pending');
  await expect(page.locator('[data-proof-layer="api"]')).toHaveAttribute('data-proof-state', 'verified');
  const response = await page.request.get(app.origin + '/api/session');
  const session = await response.json() as { ok: true; data: { csrf: string } };
  const client = { csrf: session.data.csrf, cookie: (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  const runs = (await app.api<Run[]>(client, '/api/runs')).body;
  if (!runs.ok) throw new Error('missing deduplicated run');
  expect(runs.data).toHaveLength(2);
  const deduplicated = runs.data.find(run => run.browserEvidence === undefined && run.status === 'verified')!;
  expect(deduplicated).toBeDefined(); expect(deduplicated.status).toBe('verified');
  expect(deduplicated.events.some(event => event.type === 'reconciled')).toBe(true);
  const proof = await readAndAssertProof(app, client, deduplicated);
  assertVerifiedProof(proof, 12);
  expect(proof.browser.status).toBe('not-observed'); expect(proof.browser.evidence).toBeNull(); expect(proof.browser.sameAttempt).toBe(false);
  expect(proof.browser.statement).toBe('no-browser-action-recorded-for-this-run');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
  await app.evidence('deduplicated-proof', { syntheticOnly: true, runCount: runs.data.length, actualFormPosts: app.formPosts,
    browserLaunches: app.browserLaunches, demandCount: app.countDemands(), proof, node: process.version });
});
