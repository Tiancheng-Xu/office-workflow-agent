import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Run } from '../../src/contracts.ts';
import { TestApp } from './harness.ts';

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { await app.stop(); });

test('the current-session queue filters real drafts by department and request without changing totals or archived journeys', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-QUEUE-001\n为行政部登记6把办公椅，需求编号REQ-QUEUE-002');
  await page.getByRole('button', {name:'校验清单'}).click();
  await page.getByRole('button', {name:'生成通过校验的草稿'}).click();
  await expect(page.locator('#intake-notice')).toContainText('2 条已生成草稿');
  await page.getByLabel('处理阶段').selectOption('review');
  await page.getByLabel('筛选部门').selectOption('行政部');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('REQ-QUEUE-002');
  await expect(page.locator('#history-total')).toContainText('2 会话');
  await expect(page.locator('#retained-history details')).toHaveCount(10);
  await page.getByLabel('搜索当前会话记录').fill('REQ-QUEUE-001');
  await expect(page.locator('#history-list')).toContainText('没有匹配的当前会话记录');
  expect(app.formPosts).toBe(0);
});

test('expired approvals return to review while a real DOM stop can be found by its error code', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('采购需求描述', {exact:false}).fill('为研发部登记12台显示器，需求编号REQ-QUEUE-STOP');
  await page.getByRole('button', {name:'生成动作预览',exact:true}).click();
  await page.getByRole('button', {name:'确认本次登记',exact:true}).click();
  await page.getByLabel('处理阶段').selectOption('execute');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(1);
  await page.clock.install({time:Date.now()+301000});
  await page.getByLabel('处理阶段').selectOption('review');
  await expect(page.locator('#history-list')).toContainText('确认已过期');
  await page.getByLabel('处理阶段').selectOption('execute');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(0);
  await page.clock.setSystemTime(Date.now());
  app.fault='dom-label';
  await page.getByRole('button', {name:'执行已确认计划',exact:true}).click();
  await expect(page.locator('#plan-panel')).toContainText('旧后台表单与预期结构不一致');
  await page.getByLabel('处理阶段').selectOption('stopped');
  await page.getByLabel('搜索当前会话记录').fill('DOM_DRIFT');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('检查停止原因');
  expect(app.formPosts).toBe(0);
  expect(app.browserLaunches).toBe(1);
});

test('tampered report content is recorded as a failed read and cannot claim successful API verification', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('采购需求描述',{exact:false}).fill('为研发部登记12台显示器，需求编号REQ-HASH-001');
  await page.getByRole('button',{name:'生成动作预览',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认本次登记',exact:true})).toBeVisible();
  await page.route('**/api/runs/*/report', async route => {
    const response = await route.fetch(); const payload = await response.json();
    payload.data.api.status='verified';payload.data.api.queryStatus='found';
    payload.data.csrf='synthetic-secret-that-must-not-appear';
    await route.fulfill({response,json:payload});
  });
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出筛选结果核对包'}).click();
  const pack=JSON.parse(await readFile((await (await downloaded).path())!,'utf8'));
  expect(pack.complete).toBe(false);
  expect(pack.summary).toEqual({selected:1,reportsRead:0,readFailures:1,apiVerified:0});
  expect(pack.entries[0].code).toBe('REPORT_UNAVAILABLE_OR_INVALID');
  expect(JSON.stringify(pack)).not.toContain('synthetic-secret');
  expect(app.browserLaunches).toBe(0);
});

test('handoff export uses fresh GET reports, preserves partial failure and never presents draft status as verified', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-PACK-001\n为行政部登记6把办公椅，需求编号REQ-PACK-002');
  await page.getByRole('button', {name:'校验清单'}).click();
  await page.getByRole('button', {name:'生成通过校验的草稿'}).click();
  await expect(page.locator('#intake-notice')).toContainText('2 条已生成草稿');
  const runs: Run[] = (await (await page.request.get(app.origin + '/api/runs')).json()).data;
  await page.route(`**/api/runs/${runs.find(run => run.plan.requestId === 'REQ-PACK-002')!.id}/report`, route => route.fulfill({status:503,contentType:'application/json',body:'{"ok":false,"error":{"code":"QUERY_UNAVAILABLE","message":"synthetic unavailable"}}'}));
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name:'导出筛选结果核对包'}).click();
  const download = await downloaded;
  const pack = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(pack.schema).toBe('office-agent-handoff-v1');
  expect(pack.complete).toBe(false);
  expect(pack.summary).toEqual({selected:2,reportsRead:1,readFailures:1,apiVerified:0});
  const success = pack.entries.find((entry: {readStatus: string}) => entry.readStatus === 'read');
  expect(success.report.run.plan.requestId).toBe('REQ-PACK-001');
  expect(success.report.api.status).toBe('not-found');
  expect(Number.isFinite(Date.parse(success.report.api.checkedAt))).toBe(true);
  expect(JSON.stringify(pack)).not.toMatch(/csrf|cookie|capability|tenantId|authorization|password|secret/i);
  expect(app.requests.filter(request => /\/(approve|execute|cancel)$/.test(request.path))).toEqual([]);
  expect(app.formPosts).toBe(0);
  await expect(page.locator('#handoff-notice')).toContainText('不完整');
});
