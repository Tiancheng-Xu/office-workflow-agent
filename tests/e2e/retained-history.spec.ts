import { test, expect } from '@playwright/test';
import { TestApp } from './harness.ts';

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { await app.stop(); });

test('a new production-style session can read ten local journeys without importing executable runs', async ({ page }) => {
  await page.goto(app.origin);
  const archive = page.getByRole('region', { name: '本地全流程历史' });
  await expect(archive.locator('details')).toHaveCount(10);
  await expect(archive).toContainText('本地测试历史');
  await expect(archive).toContainText('10 个不同结束节点');
  await expect(page.locator('#history-total')).toContainText('10 历史');
  await archive.locator('details').last().locator('summary').click();
  await expect(archive.locator('details').last()).toContainText('A真实受控Chromium登记');
  await expect(archive.getByRole('button', { name: /确认|执行|核对原/ })).toHaveCount(0);
  const live = await page.request.get(app.origin + '/api/runs');
  expect((await live.json()).data).toEqual([]);
  expect(app.browserLaunches).toBe(0);
  expect(app.formPosts).toBe(0);
});

test('mobile history preserves applied effect with unknown API observation and ten distinct endings', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(app.origin);
  const archive = page.getByRole('region', { name: '本地全流程历史' });
  await expect(archive.locator('details')).toHaveCount(10);
  expect(new Set(await archive.locator('.archive-stage').allTextContents()).size).toBe(10);
  const failure = archive.locator('[data-record="case-09"]');
  await failure.locator('summary').click();
  await expect(failure).toContainText('verified / applied');
  await expect(failure).toContainText('历史 API 核对：unknown');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a corrupted published report fails closed without making any mutation', async ({ page }) => {
  await page.route('**/evidence/flows/case-10.json', route => route.fulfill({status:200,contentType:'application/json',body:'{"recordId":"case-10","actualEndStage":"FAKE_SUCCESS"}'}));
  await page.goto(app.origin);
  const record = page.locator('[data-record="case-10"]');
  await record.locator('summary').click();
  await expect(record.getByRole('alert')).toContainText('历史报告读取或校验失败');
  await expect(record).not.toContainText('FAKE_SUCCESS');
  expect((await (await page.request.get(app.origin+'/api/runs')).json()).data).toEqual([]);
  expect(app.formPosts).toBe(0);
});
