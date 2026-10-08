import { test, expect } from '@playwright/test';
import { TestApp } from './harness.ts';

let app: TestApp;
test.beforeEach(async () => { app = new TestApp(); await app.start(); });
test.afterEach(async () => { await app.stop(); });

test('batch preparation shows every field and rejects ambiguous and repeated rows without creating runs', async ({ page }) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-BATCH-001\n为行政部登记6把办公椅，需求编号REQ-BATCH-002\n为运营部登记约3个键盘，需求编号REQ-BATCH-003\n为研发部登记8台显示器，需求编号REQ-BATCH-001');
  await page.getByRole('button', { name: '校验清单' }).click();
  const rows = page.locator('[data-intake-row]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('清单内编号重复');
  await expect(rows.nth(3)).toContainText('清单内编号重复');
  await expect(rows.nth(1)).toContainText('行政部 · 办公椅 · 6 把');
  await expect(rows.nth(2)).toContainText('数量');
  expect((await (await page.request.get(app.origin + '/api/runs')).json()).data).toEqual([]);
  expect(app.formPosts).toBe(0);
  expect(app.browserLaunches).toBe(0);
});

test('fresh workspace duplicate checks prevent drafting a request created after preparation', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-CONCURRENT-001');
  await page.getByRole('button',{name:'校验清单'}).click();
  const session=(await (await page.request.get(app.origin+'/api/session')).json()).data;
  const external=await page.request.post(app.origin+'/api/propose',{headers:{Origin:app.origin,'X-CSRF-Token':session.csrf},data:{text:'为研发部登记15台显示器，需求编号REQ-CONCURRENT-001'}});
  expect(external.status()).toBe(201);
  await page.getByRole('button',{name:'生成通过校验的草稿'}).click();
  await expect(page.locator('[data-intake-row]')).toContainText('当前工作区已有这个编号');
  await expect(page.getByRole('button',{name:'生成通过校验的草稿'})).toBeDisabled();
  expect((await (await page.request.get(app.origin+'/api/runs')).json()).data).toHaveLength(1);
  expect(app.requests.filter(request=>request.path==='/api/propose')).toHaveLength(1);
  expect(app.formPosts).toBe(0);
});

test('a lost draft response pauses later rows and query recovery never repeats the proposal', async ({ page }) => {
  let proposals = 0;
  await page.route('**/api/propose', async route => {
    proposals++;
    if (proposals === 2) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-LOST-001\n为行政部登记6把办公椅，需求编号REQ-LOST-002\n为运营部登记3个键盘，需求编号REQ-LOST-003');
  await page.getByRole('button', { name: '校验清单' }).click();
  await page.getByRole('button', { name: '生成通过校验的草稿' }).click();
  await expect(page.locator('[data-intake-row="2"]')).toContainText('提案结果待确认');
  await expect(page.locator('#intake-notice')).toContainText('已暂停后续行');
  expect(proposals).toBe(2);
  expect((await (await page.request.get(app.origin+'/api/runs')).json()).data).toHaveLength(2);
  await page.getByRole('button', { name: '查询已有草稿' }).click();
  await expect(page.locator('[data-intake-row="2"]')).toContainText('查询找到字段一致的原记录');
  expect(proposals).toBe(2);
  await page.getByRole('button', { name: '生成通过校验的草稿' }).click();
  await expect(page.locator('#intake-notice')).toContainText('3 条已生成草稿');
  expect(proposals).toBe(3);
  expect(app.formPosts).toBe(0);
});

test('prepared drafts can each refresh their target after a prior registration and finish through the original approval chain', async ({ page }) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-TARGET-001\n为行政部登记6把办公椅，需求编号REQ-TARGET-002');
  await page.getByRole('button', { name: '校验清单' }).click();
  await page.getByRole('button', { name: '生成通过校验的草稿' }).click();
  await expect(page.locator('#intake-notice')).toContainText('2 条已生成草稿');
  await page.locator('[data-intake-row="1"]').getByRole('button', { name: /查看原记录/ }).click();
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  await page.locator('[data-intake-row="2"]').getByRole('button', { name: /查看原记录/ }).click();
  await page.getByRole('button', { name: '刷新目标并重新预览', exact: true }).click();
  await expect(page.locator('#plan-panel #revision-label')).toHaveText('v2');
  await page.getByRole('button', { name: '确认本次登记', exact: true }).click();
  await page.getByRole('button', { name: '执行已确认计划', exact: true }).click();
  await expect(page.locator('#plan-panel')).toContainText('已通过 API 核对登记结果');
  const runs = (await (await page.request.get(app.origin + '/api/runs')).json()).data;
  expect(runs.map((run: {status: string}) => run.status)).toEqual(['verified', 'verified']);
  expect(app.formPosts).toBe(2);
  expect(app.browserLaunches).toBe(2);
  await page.getByLabel('处理阶段').selectOption('complete');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(2);
});

test('an invalid row containing a repeated request ID blocks the valid row too', async ({page}) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-REPEAT-001\n为研发部登记约8台显示器，需求编号REQ-REPEAT-001');
  await page.getByRole('button', {name:'校验清单'}).click();
  await expect(page.locator('[data-intake-row="1"]')).toContainText('清单内编号重复');
  await expect(page.getByRole('button', {name:'生成通过校验的草稿'})).toBeDisabled();
  expect((await (await page.request.get(app.origin+'/api/runs')).json()).data).toEqual([]);
});

test('a changed browser session clears intake and ignores a late proposal response', async ({page}) => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const arrived = new Promise<void>(resolve => {reached = resolve;});
  await page.route('**/api/propose', async route => {const response = await route.fetch();reached();await gate;await route.fulfill({response});});
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-OLD-001\n为行政部登记6把办公椅，需求编号REQ-OLD-002');
  await page.getByRole('button', {name:'校验清单'}).click();
  await page.getByRole('button', {name:'生成通过校验的草稿'}).click();
  await arrived;
  await page.context().clearCookies();
  const session = await page.request.get(app.origin+'/api/session');
  expect(session.status()).toBe(200);
  await page.getByRole('button', {name:'刷新记录', exact:true}).click();
  await expect(page.getByRole('button', {name:'重新连接',exact:true})).toBeVisible();
  await page.getByRole('button', {name:'重新连接',exact:true}).click();
  await expect(page.getByLabel('多条采购需求')).toHaveValue('');
  release();
  await expect(page.locator('#intake-rows [data-intake-row]')).toHaveCount(0);
  await expect(page.locator('#history-list [data-select]')).toHaveCount(0);
  expect((await (await page.request.get(app.origin+'/api/runs')).json()).data).toEqual([]);
  expect(app.requests.filter(request=>request.path==='/api/propose')).toHaveLength(1);
});

test('field templates append a bounded row and eleven rows are rejected in full on mobile', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(app.origin);
  await page.getByText('用字段模板追加一条', {exact:true}).click();
  const form = page.locator('#intake-template');
  await form.getByLabel('部门').selectOption('运营部');
  await form.getByLabel('品类').fill('键盘');
  await form.getByLabel('数量').fill('3');
  await form.getByLabel('需求编号').fill('REQ-TEMPLATE-001');
  await form.getByRole('button', {name:'追加到清单'}).click();
  await expect(page.getByLabel('多条采购需求')).toHaveValue('为运营部登记3件键盘，需求编号REQ-TEMPLATE-001');
  await page.getByRole('button', {name:'校验清单'}).click();
  await expect(page.locator('[data-intake-row]')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('多条采购需求').fill(Array.from({length:11},(_,i)=>`为研发部登记12台显示器，需求编号REQ-LIMIT-${String(i).padStart(3,'0')}`).join('\n'));
  await page.getByRole('button', {name:'校验清单'}).click();
  await expect(page.locator('#intake-notice')).toContainText('1–10 条');
  await expect(page.locator('[data-intake-row]')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'生成通过校验的草稿'})).toBeDisabled();
  expect(app.formPosts).toBe(0);
});

test('a batch persists separate unapproved drafts and resumes after reload without launching browsers', async ({ page }) => {
  await page.goto(app.origin);
  await page.getByLabel('多条采购需求').fill('为研发部登记12台显示器，需求编号REQ-DRAFT-001\n为行政部登记6把办公椅，需求编号REQ-DRAFT-002');
  await page.getByRole('button', { name: '校验清单' }).click();
  await page.getByRole('button', { name: '生成通过校验的草稿' }).click();
  await expect(page.locator('#intake-notice')).toContainText('2 条已生成草稿');
  const runs = (await (await page.request.get(app.origin + '/api/runs')).json()).data;
  expect(runs).toHaveLength(2);
  expect(runs.map((run: {status: string}) => run.status)).toEqual(['draft', 'draft']);
  expect(app.requests.filter(request => /\/(approve|execute)$/.test(request.path))).toEqual([]);
  expect(app.formPosts).toBe(0);
  expect(app.browserLaunches).toBe(0);
  await page.reload();
  await expect(page.getByLabel('多条采购需求')).toHaveValue('');
  await expect(page.locator('#history-list [data-select]')).toHaveCount(2);
});
