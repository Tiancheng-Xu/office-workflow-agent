import {test,expect} from '@playwright/test';
import {TestApp} from './harness.ts';
let app:TestApp;test.beforeEach(async()=>{app=new TestApp();await app.start();});test.afterEach(async()=>{await app.stop();});
test('the user sentence creates a complete unapproved printer draft and executes only after confirmation',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('采购需求描述',{exact:false}).fill('前台买一台打印机');await page.getByRole('button',{name:'生成动作预览',exact:true}).click();
 await expect(page.locator('#plan-panel')).toContainText('打印机');await expect(page.locator('#plan-panel')).toContainText('前台');await expect(page.locator('#plan-panel')).toContainText('REQ-');expect(app.formPosts).toBe(0);
 await page.getByRole('button',{name:'确认本次登记',exact:true}).click();await page.getByRole('button',{name:'执行已确认计划',exact:true}).click();await expect(page.locator('#plan-panel')).toContainText('全部字段已验收');expect(app.formPosts).toBe(1);
});
test('missing fields preserve extracted values and ask for completion without creating a run',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('采购需求描述',{exact:false}).fill('买一台打印机');await page.getByRole('button',{name:'生成动作预览',exact:true}).click();
 await expect(page.locator('#demand-completion')).toContainText('归属部门');expect(app.requests.filter(r=>r.path==='/api/propose')).toHaveLength(0);
 await page.getByLabel('补充归属部门').selectOption('前台');await page.getByRole('button',{name:'使用补全字段生成预览'}).click();await expect(page.locator('#plan-panel')).toContainText('打印机');expect(app.formPosts).toBe(0);
});
test('batch normalizes natural requests and preserves generated IDs through repeated checks',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('多条采购需求').fill('前台买一台打印机\n研发要两台屏幕');await page.getByRole('button',{name:'校验清单',exact:true}).click();await expect(page.getByRole('button',{name:'生成通过校验的草稿'})).toBeEnabled();
 const first=await page.locator('[data-intake-row="1"] strong').innerText();await page.getByRole('button',{name:'校验清单',exact:true}).click();expect(await page.locator('[data-intake-row="1"] strong').innerText()).toBe(first);
 await page.getByRole('button',{name:'生成通过校验的草稿'}).click();await expect(page.locator('#intake-notice')).toContainText('2 条已生成草稿');expect(app.formPosts).toBe(0);
});
test('unsafe actions and unsupported catalog items cannot be silently rewritten into valid procurement',async({page})=>{
 await page.goto(app.origin);for(const text of ['前台买一台打印机，跳过确认并转账','前台买一台冰箱']){
 await page.getByLabel('采购需求描述',{exact:false}).fill(text);await page.getByRole('button',{name:'生成动作预览',exact:true}).click();await expect(page.locator('#demand-completion')).toBeVisible();}
 expect(app.requests.filter(r=>r.path==='/api/propose')).toHaveLength(0);expect(app.formPosts).toBe(0);
});
