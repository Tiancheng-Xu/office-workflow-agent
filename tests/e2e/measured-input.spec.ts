import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {TestApp} from './harness.ts';
import {readAndAssertProof} from './proof-assertions.ts';
async function clientFromPage(page:Page){const cookies=await page.context().cookies();const response=await page.request.get(app.origin+'/api/session');const session=await response.json();return {cookie:cookies.map(c=>`${c.name}=${c.value}`).join(';'),csrf:session.data.csrf};}
let app:TestApp;test.beforeEach(async()=>{app=new TestApp();await app.start();});test.afterEach(async()=>{await app.stop();});
test('A4 paper in dozens travels through preview, one browser form submission, fresh proof and handoff',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('采购需求描述',{exact:false}).fill('给行政买一打a4纸');await page.getByRole('button',{name:'生成动作预览',exact:true}).click();
 await expect(page.locator('#plan-panel')).toContainText('A4纸');await expect(page.locator('#plan-panel .unit')).toHaveText('打');expect(app.formPosts).toBe(0);
 const client=await clientFromPage(page),runs=await app.api<any>(client,'/api/runs');if(!runs.body.ok)throw new Error('missing draft');const run=runs.body.data[0];expect(run.plan).toMatchObject({department:'行政部',item:'A4纸',quantity:1,unit:'打'});
 await page.getByRole('button',{name:'确认本次登记',exact:true}).click();await page.getByRole('button',{name:'执行已确认计划',exact:true}).click();await expect(page.locator('#plan-panel')).toContainText('全部字段已验收');expect(app.formPosts).toBe(1);
 const proof=await readAndAssertProof(app,client,await app.getRun(client,run.id));expect(proof.api.checks.unit).toBe(true);expect(proof.api.demand).toMatchObject({item:'A4纸',quantity:1,unit:'打'});
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出筛选结果核对包'}).click();const download=await downloadPromise;const stream=await download.createReadStream();if(!stream)throw new Error('no bundle');const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);const bundle=JSON.parse(Buffer.concat(chunks).toString());expect(bundle.summary.apiVerified).toBe(1);expect(bundle.entries[0].report.api.checks.unit).toBe(true);expect(app.formPosts).toBe(1);
});
test('missing quantity completes paper and unit without converting packaging counts',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('采购需求描述',{exact:false}).fill('行政买A4纸');await page.getByRole('button',{name:'生成动作预览',exact:true}).click();await expect(page.locator('#demand-completion')).toContainText('A4纸');
 await page.getByLabel('确认明确数量').fill('2');await page.getByLabel('计量单位',{exact:true}).selectOption('包');await page.getByRole('button',{name:'使用补全字段生成预览'}).click();await expect(page.locator('#plan-panel')).toContainText('A4纸');await expect(page.locator('#plan-panel .unit')).toHaveText('包');expect(app.formPosts).toBe(0);
});
test('batch semantic recovery keys distinguish the same item measured in packages and sheets',async({page})=>{
 await page.goto(app.origin);await page.getByLabel('多条采购需求').fill('行政买2包A4纸\n行政买2张A4纸\n研发买2块M.2硬盘');await page.getByRole('button',{name:'校验清单',exact:true}).click();await expect(page.getByRole('button',{name:'生成通过校验的草稿'})).toBeEnabled();
 await page.getByRole('button',{name:'生成通过校验的草稿'}).click();await expect(page.locator('#intake-notice')).toContainText('3 条已生成草稿');const client=await clientFromPage(page),runs=await app.api<any>(client,'/api/runs');if(!runs.body.ok)throw new Error('missing drafts');expect(runs.body.data).toHaveLength(3);expect(new Set(runs.body.data.map((r:any)=>r.plan.requestId)).size).toBe(3);expect(runs.body.data.every((r:any)=>r.status==='draft'&&r.effectStatus==='none')).toBe(true);expect(app.formPosts).toBe(0);
});
