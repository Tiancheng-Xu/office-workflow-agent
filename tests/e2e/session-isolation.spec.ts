import { test, expect, type Route } from '@playwright/test';
import type { ApiReply, Run } from '../../src/contracts.ts';
import { TestApp } from './harness.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { if (app?.server?.listening) await app.stop(); else app?.repository?.close(); });

for (const lateKind of ['approval', 'proposal', 'list'] as const) {
  test(`actual session rotation clears the previous tenant and ignores late ${lateKind} results`, async ({ page }) => {
    const oldRequestId = `REQ-SESSION-${lateKind.toUpperCase()}-OLD`;
    const lateRequestId = `REQ-SESSION-${lateKind.toUpperCase()}-LATE`;
    const newRequestId = `REQ-SESSION-${lateKind.toUpperCase()}-NEW`;
    const arrived = deferred<{ status: number; payload: ApiReply<Run | Run[]> }>();
    const release = deferred<void>();
    let armed = false;
    const matchesLate = (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      return lateKind === 'approval' ? path.endsWith('/approve') && route.request().method() === 'POST'
        : lateKind === 'proposal' ? path === '/api/propose' && route.request().method() === 'POST'
        : path === '/api/runs' && route.request().method() === 'GET';
    };
    await page.route('**/api/**', async route => {
      if (!armed || !matchesLate(route)) { await route.continue(); return; }
      armed = false;
      // Receive an actual old-session HTTP response, then delay its delivery to the page.
      // All plan, approval and tenant decisions still run through the real service.
      const response = await route.fetch();
      arrived.resolve({ status: response.status(), payload: await response.json() as ApiReply<Run | Run[]> });
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await page.goto(app.origin);
      await page.locator('#request-text').fill(`为研发部登记12台显示器，需求编号${oldRequestId}。`);
      await page.getByRole('button', { name: '生成动作预览' }).click();
      await expect(page.locator('#plan-panel')).toContainText(oldRequestId);
      await expect(page.locator('#history-list')).toContainText(oldRequestId);
      const oldRunId = (await page.locator('#plan-technical').getAttribute('data-run'))!;
      await page.locator('#plan-technical summary').click();
      expect(await page.locator('#plan-technical').evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
      const oldCookie = (await page.context().cookies()).find(cookie => cookie.name === 'office_session')!.value;

      armed = true;
      if (lateKind === 'approval') await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
      else if (lateKind === 'proposal') {
        await page.locator('#request-text').fill(`为研发部登记12台显示器，需求编号${lateRequestId}。`);
        await page.getByRole('button', { name: '生成动作预览' }).click();
      } else await page.getByRole('button', { name: '刷新记录', exact: true }).click();
      const held = await arrived.promise;
      expect(held.status).toBe(200 + (lateKind === 'proposal' ? 1 : 0));
      expect(held.payload.ok).toBe(true);
      if (!held.payload.ok) throw new Error('real old-session request rejected');
      if (lateKind === 'list') expect((held.payload.data as Run[]).some(run => run.id === oldRunId)).toBe(true);
      else expect((held.payload.data as Run).plan.requestId).toBe(lateKind === 'proposal' ? lateRequestId : oldRequestId);

      // Rotate the actual isolated browser cookie while its old response is in flight.
      await page.context().clearCookies();
      if (lateKind === 'list') await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
      else await page.getByRole('button', { name: '刷新记录', exact: true }).click();
      await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '重新连接', exact: true }).click();
      await expect(page.locator('#connection-state')).toContainText('工作区已连接');
      await expect(page.locator('#history-list')).toContainText('还没有执行记录');
      await expect(page.locator('#plan-panel')).toContainText('把一句需求变成可确认的动作');
      await expect(page.locator('#plan-technical')).toHaveCount(0);
      await expect(page.locator('[data-select]')).toHaveCount(0);
      expect((await page.context().cookies()).find(cookie => cookie.name === 'office_session')!.value !== oldCookie).toBe(true);

      const lateDelivered = page.waitForResponse(response => {
        const path = new URL(response.url()).pathname;
        return lateKind === 'approval' ? path.endsWith('/approve') : lateKind === 'proposal' ? path === '/api/propose' : path === '/api/runs';
      });
      release.resolve();
      await (await lateDelivered).finished();
      await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      await expect(page.locator('#history-list')).toContainText('还没有执行记录');
      await expect(page.locator('#history-list')).not.toContainText(oldRequestId);
      await expect(page.locator('#history-list')).not.toContainText(lateRequestId);
      await expect(page.locator('#plan-panel')).not.toContainText(oldRequestId);
      await expect(page.locator('#plan-panel')).not.toContainText(lateRequestId);
      await expect(page.locator('#plan-technical')).toHaveCount(0);
      await expect(page.locator('[data-select]')).toHaveCount(0);

      // The reconnected tenant must stay usable and its first plan must start with closed technical details.
      await page.locator('#request-text').fill(`为研发部登记12台显示器，需求编号${newRequestId}。`);
      await page.getByRole('button', { name: '生成动作预览' }).click();
      await expect(page.locator('#plan-panel')).toContainText(newRequestId);
      await expect(page.locator('#history-list')).toContainText(newRequestId);
      await expect(page.locator('[data-select]')).toHaveCount(1);
      const newRunId = (await page.locator('#plan-technical').getAttribute('data-run'))!;
      expect(newRunId !== oldRunId).toBe(true);
      expect(await page.locator('#plan-technical').evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
      const actualListResponse = await page.request.get(app.origin + '/api/runs');
      const actualList = await actualListResponse.json() as ApiReply<Run[]>;
      expect(actualList.ok).toBe(true);
      if (actualList.ok) expect(actualList.data.map(run => run.plan.requestId)).toEqual([newRequestId]);
      expect(app.countDemands()).toBe(0);
      expect(app.browserLaunches).toBe(0);
      await app.evidence(`session-rotation-${lateKind}`, {
        syntheticOnly: true, lateKind, oldResponseStatus: held.status, signedSessionRotated: true,
        oldCachedPlanExisted: true, oldTechnicalDetailsOpened: true, oldSelectedRunCleared: true,
        lateOldTenantResultIgnored: true, newTenantVisiblePlans: 1, newTechnicalDetailsClosed: true,
        realNewTenantApiReadback: actualList.ok && actualList.data.map(run => run.plan.requestId).join(',') === newRequestId,
        browserLaunches: app.browserLaunches, demandCount: app.countDemands(), node: process.version,
      });
    } finally { release.resolve(); await page.unroute('**/api/**'); }
  });
}

test('an external tab session replacement invalidates the old UI context before reconnecting to the new tenant', async ({ page, context }) => {
  const oldRequestId = 'REQ-EXTERNAL-TAB-OLD';
  await page.goto(app.origin);
  await page.locator('#request-text').fill(`为研发部登记12台显示器，需求编号${oldRequestId}。`);
  await page.getByRole('button', { name: '生成动作预览' }).click();
  await expect(page.locator('#plan-panel')).toContainText(oldRequestId);
  await expect(page.locator('#history-list')).toContainText(oldRequestId);
  await page.locator('#plan-technical summary').click();
  expect(await page.locator('#plan-technical').evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
  const oldCookie = (await context.cookies()).find(cookie => cookie.name === 'office_session')!.value;

  // This request context shares the isolated browser's cookie jar, just like an external tab.
  // It establishes a real new signed session without calling the old page's reconnect function.
  await context.clearCookies();
  const replacementResponse = await context.request.get(app.origin + '/api/session');
  expect(replacementResponse.status()).toBe(200);
  const replacement = await replacementResponse.json() as { ok: true; data: { csrf: string } };
  expect(replacement.ok).toBe(true);
  expect((await context.cookies()).find(cookie => cookie.name === 'office_session')!.value !== oldCookie).toBe(true);
  const replacementListResponse = await context.request.get(app.origin + '/api/runs', { headers: { 'X-OfficeFlow-Context': replacement.data.csrf } });
  expect(replacementListResponse.status()).toBe(200);
  expect(await replacementListResponse.json()).toEqual({ ok: true, data: [] });
  // The stale page still contains A's cached plan until its actual refresh detects the mismatch.
  await expect(page.locator('#history-list')).toContainText(oldRequestId);
  const rejectedRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs');
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  const mismatchResponse = await rejectedRefresh;
  expect(mismatchResponse.status()).toBe(403);
  expect(await mismatchResponse.json()).toMatchObject({ ok: false, error: { code: 'SESSION_CHANGED' } });

  // Clear cached tenant data immediately, before the user clicks reconnect.
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(page.locator('#history-list')).not.toContainText(oldRequestId);
  await expect(page.locator('#plan-panel')).not.toContainText(oldRequestId);
  await expect(page.locator('[data-select]')).toHaveCount(0);
  await expect(page.locator('#plan-technical')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成动作预览' })).toBeDisabled();
  const establishedCookie = (await context.cookies()).find(cookie => cookie.name === 'office_session')!.value;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.locator('#connection-state')).toContainText('工作区已连接');
  await expect(page.locator('#history-list')).toContainText('还没有执行记录');
  await expect(page.locator('#plan-panel')).toContainText('把一句需求变成可确认的动作');
  await expect(page.locator('#plan-technical')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成动作预览' })).toBeEnabled();
  expect((await context.cookies()).find(cookie => cookie.name === 'office_session')!.value === establishedCookie).toBe(true);
  const currentList = await context.request.get(app.origin + '/api/runs', { headers: { 'X-OfficeFlow-Context': replacement.data.csrf } });
  expect(await currentList.json()).toEqual({ ok: true, data: [] });
  expect(app.browserLaunches).toBe(0); expect(app.countDemands()).toBe(0);
  await app.evidence('external-tab-session-rotation', { syntheticOnly: true, oldTenantCachedBeforeRotation: true, externalRequestEstablishedNewSignedSession: true,
    actualRefreshStatus: mismatchResponse.status(), actualErrorCode: 'SESSION_CHANGED', oldTenantCacheClearedBeforeReconnect: true, newTenantEmptyAfterReconnect: true,
    preservedEstablishedReplacementSession: true, browserLaunches: app.browserLaunches, demandCount: app.countDemands(), node: process.version });
});
