import {test,expect,type Page} from '@playwright/test';
import {TestApp} from './harness.js';
let app:TestApp;
test.beforeEach(async()=>{app=new TestApp();await app.start();});
test.afterEach(async()=>{await app.stop();});
async function open(page:Page){await page.goto(app.origin+'/materials.html');await expect(page.getByRole('heading',{name:'资料核对工作台',exact:true})).toBeVisible();await expect(page.locator('#material-connection')).toContainText('已连接');}
async function review(page:Page){await page.getByRole('button',{name:'确认已填写字段',exact:true}).click();await page.getByRole('button',{name:'保存人工核对',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('人工核对已保存');}
test('VTT purchase material creates only an unapproved draft with durable source link',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await expect(page.locator('#material-sources')).toContainText('00:00:01.000');
 await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await expect(page.locator('#material-fields')).toContainText('A4纸500张装');await review(page);
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('未批准草稿');
 const health=await app.repository.health();expect(health.runs).toBe(1);expect(health.demands).toBe(0);expect(app.browserLaunches).toBe(0);expect(app.formPosts).toBe(0);
 expect(app.requests.some(r=>/\/(approve|execute)$/.test(r.path))).toBe(false);
 await page.reload();await expect(page.locator('#material-cases')).toContainText('采购');await page.locator('[data-open-case]').first().click();await expect(page.locator('#material-result')).toContainText('已关联');
});
test('trade documents preserve discrepancies and export a checksum report without procurement writes',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入外贸核对样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await expect(page.locator('#material-result')).toContainText('差异');
 for(const value of ['数量 · 不同资料的值不一致','币种 · 不同资料的值不一致','总额 · 不同资料的值不一致','交付日期 · 不同资料的值不一致','合成合同：10','合成订单：12','USD','EUR','2026-11-15','2026-11-20'])await expect(page.locator('#material-result')).toContainText(value);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出核对包',exact:true}).click();expect((await download).suggestedFilename()).toMatch(/material-.*\.json/);
 expect((await app.repository.health()).runs).toBe(0);expect(app.browserLaunches).toBe(0);expect(app.formPosts).toBe(0);
});
test('OCR fixture is labeled as imported evidence and does not claim recognition accuracy',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入OCR消费样例',exact:true}).click();await expect(page.locator('#material-sources')).toContainText('夹具');await expect(page.locator('#material-sources')).toContainText('第 1 页');
 await expect(page.locator('#material-sources')).toContainText('原件未比对');await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await expect(page.locator('#material-fields')).toContainText('A4纸500张装');expect(app.formPosts).toBe(0);
});
test('material workspace remains readable at 390px and source text cannot inject markup',async({page})=>{
 await page.setViewportSize({width:390,height:844});await open(page);await page.getByLabel('文本或VTT内容',{exact:true}).fill('部门：行政部\n物品：<img src=x onerror=alert(1)>\n数量：2\n单位：包');await page.getByRole('button',{name:'添加文本来源',exact:true}).click();
 await expect(page.locator('#material-sources')).toContainText('<img');expect(await page.locator('#material-sources img').count()).toBe(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('a lost material save response is recovered by reading the original case',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();
 await page.route('**/api/material-cases',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();
 await expect(page.locator('#material-notice')).toContainText('不要重复保存');
 await expect(page.getByRole('button',{name:'保存资料并整理字段',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'刷新记录核对',exact:true}).click();
 await expect(page.locator('#material-fields')).toContainText('A4纸500张装');
 expect(app.requests.filter(r=>r.method==='POST'&&r.path==='/api/material-cases')).toHaveLength(1);
 expect((await app.repository.health()).runs).toBe(0);
});
test('a lost proposal response recovers and links one original unapproved draft',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.route('**/api/propose',async route=>{await route.fetch();await route.abort('failed');});
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();
 await expect(page.locator('#material-notice')).toContainText('不要重复保存');
 await expect(page.getByRole('button',{name:'创建采购草稿',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'刷新记录核对',exact:true}).click();
 await expect(page.locator('#material-notice')).toContainText('已查到原编号');
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();
 await expect(page.locator('#material-result')).toContainText('已关联');
 expect(app.requests.filter(r=>r.method==='POST'&&r.path==='/api/propose')).toHaveLength(1);
 expect((await app.repository.health()).runs).toBe(1);expect(app.formPosts).toBe(0);
});
test('an unresolved proposal remains query-only after refresh',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.route('**/api/propose',route=>route.abort('failed'));
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('不要重复保存');
 await page.getByRole('button',{name:'刷新记录核对',exact:true}).click();
 await expect(page.locator('#material-notice')).toContainText('不会重新提案');await expect(page.getByRole('button',{name:'创建采购草稿',exact:true})).toBeDisabled();
 expect((await app.repository.health()).runs).toBe(0);expect(app.formPosts).toBe(0);
});
test('editing a confirmed field requires saving review before draft or report',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.getByLabel('数量核对值',{exact:true}).fill('3');
 await expect(page.locator('#material-result')).toContainText('字段修改尚未保存');
 await expect(page.getByRole('button',{name:'创建采购草稿',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'导出核对包',exact:true})).toBeDisabled();
 await page.getByLabel('数量核对理由',{exact:true}).fill('会议后增补一包');await page.getByRole('button',{name:'保存人工核对',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('人工核对已保存');
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-result')).toContainText('已关联');
 expect(app.repository.db.prepare('SELECT body FROM runs').get()!.body).toContain('"quantity":3');
});
test('identical contract and order text keep independent sources and compare successfully',async({page})=>{
 await open(page);await page.getByRole('button',{name:'外贸单据',exact:true}).click();
 const content='物品：样品标签\n数量：10\n单位：盒\n币种：USD\n单价：25\n总额：250';
 for(const role of ['contract','order']){await page.locator('#material-role').selectOption(role);await page.getByLabel('文本或VTT内容',{exact:true}).fill(content);await page.getByRole('button',{name:'添加文本来源',exact:true}).click();await expect(page.locator('#material-sources .source-card')).toHaveCount(role==='contract'?1:2);}
 await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);await expect(page.locator('#material-result')).toContainText('当前资料一致');expect((await app.repository.health()).runs).toBe(0);
});
test('two tabs serialize draft creation and read the original case association',async({page,context})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 const second=await context.newPage();await open(second);await second.locator('[data-open-case]').first().click();await expect(second.getByRole('button',{name:'创建采购草稿',exact:true})).toBeEnabled();
 await Promise.all([page.getByRole('button',{name:'创建采购草稿',exact:true}).click(),second.getByRole('button',{name:'创建采购草稿',exact:true}).click()]);
 await expect(page.locator('#material-result')).toContainText('已关联');await expect(second.locator('#material-result')).toContainText('已关联');
 expect(app.requests.filter(r=>r.method==='POST'&&r.path==='/api/propose')).toHaveLength(1);expect((await app.repository.health()).runs).toBe(1);expect(app.formPosts).toBe(0);
});
test('browsers without cross-tab locks cannot create a material draft',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));await open(page);await expect(page.locator('.scope')).toContainText('不支持跨标签页草稿锁');
 await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await expect(page.getByRole('button',{name:'创建采购草稿',exact:true})).toBeDisabled();expect((await app.repository.health()).runs).toBe(0);
});
test('a definitive proposal rejection permits an explicit later retry',async({page})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.route('**/api/propose',route=>route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'QUOTA_EXCEEDED',message:'额度耗尽'}})}));
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('额度耗尽');expect((await app.repository.health()).runs).toBe(0);
 await page.unroute('**/api/propose');await page.getByRole('button',{name:'刷新记录核对',exact:true}).click();await expect(page.getByRole('button',{name:'创建采购草稿',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-result')).toContainText('已关联');expect((await app.repository.health()).runs).toBe(1);expect(app.formPosts).toBe(0);
});
test('an unresolved proposal blocks another tab and survives page reload',async({page,context})=>{
 await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.route('**/api/propose',route=>route.abort('failed'));await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('不要重复保存');
 const second=await context.newPage();await open(second);await second.locator('[data-open-case]').first().click();await second.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(second.locator('#material-notice')).toContainText('不会重新提案');
 await second.reload();await expect(second.locator('#material-cases')).toContainText('采购');await second.locator('[data-open-case]').first().click();await second.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(second.locator('#material-notice')).toContainText('不会重新提案');
 expect(app.requests.filter(r=>r.method==='POST'&&r.path==='/api/propose')).toHaveLength(0);expect((await app.repository.health()).runs).toBe(0);
});
test('blocked marker storage cannot submit a material proposal',async({page})=>{
 await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error('storage blocked');};});await open(page);await page.getByRole('button',{name:'载入采购字幕样例',exact:true}).click();await page.getByRole('button',{name:'保存资料并整理字段',exact:true}).click();await review(page);
 await page.getByRole('button',{name:'创建采购草稿',exact:true}).click();await expect(page.locator('#material-notice')).toContainText('未发送草稿提案');expect((await app.repository.health()).runs).toBe(0);
});
