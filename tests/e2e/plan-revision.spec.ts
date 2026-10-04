import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Run } from '../../src/contracts.ts';
import { verifyExecutionProof, type ExecutionProof } from '../../src/runtime/proof.ts';
import { TestApp, type Client } from './harness.ts';
import { readAndAssertProof, assertVerifiedProof, independentProofDigest, assertNoPrivateReportFields, type ReportView } from './proof-assertions.ts';

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { if (app?.server?.listening) await app.stop(); else app?.repository?.close(); });
const changedText = (run: Run, quantity: number) => `为研发部登记${quantity}台显示器，需求编号${run.plan.requestId}。`;
const reviseBody = (run: Run, quantity: number) => ({ revision: run.revision, planHash: run.planHash, text: changedText(run, quantity) });

async function pageClient(page: import('@playwright/test').Page): Promise<Client> {
  const response = await page.request.get(app.origin + '/api/session');
  const session = await response.json() as { ok: true; data: { csrf: string } };
  const cookie = (await page.context().cookies()).filter(cookie => cookie.name === 'office_session').map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  return { csrf: session.data.csrf, cookie };
}

test('actual UI revises approved 12 to 15, displays a real diff, revokes old approval and registers 15 with verified proof', async ({ page }) => {
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-REVISION-UI。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await expect(page.getByRole('button', { name: '执行已确认计划', exact: true })).toBeVisible();
  const client = await pageClient(page);
  const original = (await app.api<Run[]>(client, '/api/runs')).body;
  if (!original.ok) throw new Error('missing original run');
  const v1 = original.data[0]!;
  expect(v1.revision).toBe(1); expect(v1.plan.quantity).toBe(12); expect(v1.status).toBe('approved');
  await page.getByRole('button', { name: '修改计划', exact: true }).click();
  await page.getByLabel('修订后的完整需求描述', { exact: true }).fill(changedText(v1, 15));
  const revisedResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/runs/${v1.id}/revise`);
  await page.getByRole('button', { name: '生成修订预览', exact: true }).click();
  const actualRevisedResponse = await revisedResponsePromise;
  expect(actualRevisedResponse.status()).toBe(200);
  await expect(page.locator('#revision-label')).toHaveText('v2');
  await expect(page.locator('#plan-diff [data-diff-field="quantity"]')).toContainText('12');
  await expect(page.locator('#plan-diff [data-diff-field="quantity"]')).toContainText('15');
  await expect(page.locator('#revision-notice')).toContainText('旧批准已清除');
  await expect(page.getByRole('button', { name: '执行已确认计划', exact: true })).toHaveCount(0);
  const v2 = await app.getRun(client, v1.id);
  expect(v2).toMatchObject({ id: v1.id, revision: 2, status: 'draft', effectStatus: 'none', executionKey: v1.executionKey, previousRevision: 1 });
  expect(v2.plan.quantity).toBe(15); expect(v2.previousPlan?.quantity).toBe(12);
  expect(v2.plan.requestId).toBe(v1.plan.requestId);
  expect(v2.planHash !== v1.planHash).toBe(true);
  expect(v2.approvedHash).toBeUndefined(); expect(v2.approvalExpiresAt).toBeUndefined(); expect(v2.browserEvidence).toBeUndefined();
  const oldApproval = await app.api(client, `/api/runs/${v1.id}/approve`, { revision: v1.revision, planHash: v1.planHash, targetRevision: v1.targetRevision });
  expect(oldApproval.status).toBe(409);
  expect((await app.api(client, `/api/runs/${v2.id}/execute`, {})).status).toBe(409);
  expect(app.browserLaunches).toBe(0); expect(app.countDemands()).toBe(0);
  const beforeApproval = await readAndAssertProof(app, client, v2);
  expect(beforeApproval.approval.status).toBe('missing'); expect(beforeApproval.browser.status).toBe('not-observed');
  expect(beforeApproval.database.effectStatus).toBe('none'); expect(beforeApproval.api.status).toBe('not-found');

  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
  const verified = await app.getRun(client, v2.id);
  expect(verified.result?.quantity).toBe(15); expect(verified.revision).toBe(2);
  const actualReport = await readAndAssertProof(app, client, verified);
  assertVerifiedProof(actualReport, 15);
  expect(actualReport.browser.sameAttempt).toBe(true);
  expect(actualReport.browser.evidence).toMatchObject({ domMatched: true, payloadMatched: true, postObserved: true, registeredMarker: true });
  expect(actualReport.browser.evidence?.origin).toBe(app.origin);
  await expect(page.locator('#execution-proof [data-proof-layer="database"]')).toHaveAttribute('data-proof-state', 'verified');
  await expect(page.locator('#execution-proof [data-proof-layer="api"]')).toHaveAttribute('data-proof-state', 'verified');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出报告', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf8')) as ReportView;
  expect(exported.digest.value).toBe(independentProofDigest(exported));
  assertNoPrivateReportFields(exported);
  const tampered = structuredClone(actualReport);
  tampered.api.demand!.quantity = 99;
  expect(independentProofDigest(tampered) === tampered.digest.value).toBe(false);
  expect(await verifyExecutionProof(tampered)).toBe(false);
  await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/qa/revision-proof-workbench.png', fullPage: true });
  await app.evidence('revision-ui-proof', { syntheticOnly: true, approvedOriginalQuantity: 12, revisedQuantity: 15, previousRevision: 1, revision: verified.revision,
    oldApprovalRejected: oldApproval.status, beforeReapprovalBrowserLaunches: 0, realBrowserLaunches: app.browserLaunches, actualFormPosts: app.formPosts, demandCount: app.countDemands(),
    actualResultQuantity: verified.result!.quantity, independentlyVerifiedDigest: actualReport.digest, alteredReportRejected: true, proof: actualReport, node: process.version });
});

test('two concurrent revision requests from one version yield exactly one new revision and stale input cannot overwrite it', async () => {
  const client = await app.session(), original = await app.propose(client, 'REQ-REVISION-CAS');
  await app.approve(client, original);
  const replies = await Promise.all([15, 20].map(quantity => app.api<Run>(client, `/api/runs/${original.id}/revise`, reviseBody(original, quantity))));
  expect(replies.filter(reply => reply.status === 200 && reply.body.ok)).toHaveLength(1);
  expect(replies.filter(reply => reply.status === 409 && !reply.body.ok)).toHaveLength(1);
  const winner = await app.getRun(client, original.id);
  expect(winner.revision).toBe(2); expect([15, 20]).toContain(winner.plan.quantity);
  expect(winner.previousPlan?.quantity).toBe(12); expect(winner.previousRevision).toBe(1);
  expect(winner.approvedHash).toBeUndefined(); expect(winner.status).toBe('draft');
  const stale = await app.api(client, `/api/runs/${original.id}/revise`, reviseBody(original, 30));
  expect(stale.status).toBe(409);
  expect((await app.getRun(client, original.id)).plan.quantity).toBe(winner.plan.quantity);
  const changedIdentity = await app.api(client, `/api/runs/${winner.id}/revise`, { revision: winner.revision, planHash: winner.planHash, text: '为研发部登记15台显示器，需求编号REQ-OTHER-IDENTITY。' });
  expect(changedIdentity.status).toBeGreaterThanOrEqual(400);
  expect(changedIdentity.status).toBeLessThan(500);
  expect((await app.getRun(client, original.id)).plan.requestId).toBe(original.plan.requestId);
  expect(app.browserLaunches).toBe(0); expect(app.countDemands()).toBe(0);
});

test('an actual stale UI editor cannot overwrite a newer API revision', async ({ page }) => {
  await page.goto(app.origin);
  await page.locator('#request-text').fill('为研发部登记12台显示器，需求编号REQ-STALE-EDITOR。');
  await page.getByRole('button', { name: '生成动作预览' }).click();
  const client = await pageClient(page), response = await app.api<Run[]>(client, '/api/runs');
  if (!response.body.ok) throw new Error('missing run');
  const original = response.body.data[0]!;
  await page.getByRole('button', { name: '修改计划', exact: true }).click();
  const externallyRevised = await app.api<Run>(client, `/api/runs/${original.id}/revise`, reviseBody(original, 20));
  expect(externallyRevised.status).toBe(200);
  await page.getByLabel('修订后的完整需求描述', { exact: true }).fill(changedText(original, 15));
  const staleResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/runs/${original.id}/revise`);
  await page.getByRole('button', { name: '生成修订预览', exact: true }).click();
  expect((await staleResponsePromise).status()).toBe(409);
  const live = await app.getRun(client, original.id);
  expect(live.revision).toBe(2); expect(live.plan.quantity).toBe(20);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('#revision-label')).toHaveText('v2');
  await expect(page.locator('#plan-panel .quantity-value')).toHaveText('20');
  expect(app.browserLaunches).toBe(0); expect(app.countDemands()).toBe(0);
});

test('executing and verified plans cannot be revised while the real browser owns the claim', async () => {
  const client = await app.session(), original = await app.propose(client, 'REQ-REVISION-ACTIVE');
  await app.approve(client, original); app.setFault('gate-before-effect');
  const execution = app.run(client, original, 'execute');
  try {
    await app.waitForGate();
    const forbidden = await app.api(client, `/api/runs/${original.id}/revise`, reviseBody(original, 15));
    expect(forbidden.status).toBe(409);
    expect((await app.getRun(client, original.id)).revision).toBe(1);
    app.releaseGate();
    const verified = await execution;
    expect(verified.status).toBe('verified'); expect(verified.result?.quantity).toBe(12);
    expect((await app.api(client, `/api/runs/${verified.id}/revise`, reviseBody(verified, 15))).status).toBe(409);
    expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(1);
  } finally { app.releaseGate(); await execution.catch(() => undefined); }
});

test('UNKNOWN recovery report is query-only and cannot authorize a revision or a new browser POST', async ({ page }) => {
  const client = await app.session(), original = await app.propose(client, 'REQ-REVISION-UNKNOWN');
  await app.approve(client, original); app.setFault('drop-before-effect');
  const uncertain = await app.run(client, original, 'execute');
  expect(uncertain.status).toBe('unknown');
  expect((await app.api(client, `/api/runs/${uncertain.id}/revise`, reviseBody(uncertain, 15))).status).toBe(409);
  const actualReport = await readAndAssertProof(app, client, uncertain);
  expect(actualReport.browser.evidence?.postObserved).toBe(true);
  expect(actualReport.browser.evidence?.registeredMarker).toBe(false);
  expect(actualReport.database.effectStatus).toBe('unknown');
  expect(actualReport.api.queryStatus).toBe('not-found'); expect(actualReport.api.status).toBe('not-found');
  expect(actualReport.allowedNextAction).toBe('query-only');
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name: name!, value: value!, url: app.origin, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(app.origin);
  await expect(page.locator('#recovery-panel')).toContainText('核对');
  await expect(page.getByRole('button', { name: '修改计划', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '执行已确认计划', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '核对原需求结果', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('API 暂未发现登记结果');
  app.setFault('none');
  const afterReplay = await app.run(client, uncertain, 'execute');
  const afterReport = await readAndAssertProof(app, client, afterReplay);
  expect(afterReport.allowedNextAction).toBe('query-only');
  expect(app.browserLaunches).toBe(1); expect(app.formPosts).toBe(1); expect(app.countDemands()).toBe(0);
  await app.evidence('unknown-proof-query-only', { syntheticOnly: true, actualReport: actualReport, afterReadOnlyReplay: afterReport,
    revisionRejected: true, browserLaunches: app.browserLaunches, actualFormPosts: app.formPosts, demandCount: app.countDemands(), node: process.version });
});
