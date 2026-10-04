import type { Browser, BrowserContext, Page, Route } from 'playwright';
import type { BrowserEvidence, Run } from '../contracts.js';

export type BrowserFactory=()=>Promise<Browser>;
export interface BrowserExecution {origin:string;run:Run;capability:string;}
export interface BrowserExecutor {execute(input:BrowserExecution):Promise<void|BrowserEvidence>;}
export class BrowserExecutionError extends Error {
  constructor(public readonly code:string,public readonly effectPossible:boolean,public readonly evidence?:BrowserEvidence) {super(code);}
}
export function createBrowserExecutor({browserFactory,timeoutMs=25_000}:{browserFactory:BrowserFactory;timeoutMs?:number}):BrowserExecutor {
  return {async execute(input) {
    let browser:Browser|undefined,context:BrowserContext|undefined,submitted=false;
    const started=Date.now(),budgetMs=Math.min(30_000,Math.max(250,timeoutMs)),deadlineAt=started+budgetMs;
    let timedOut=false;
    let guardError:string|undefined;
    const setGuard=(code:string)=>{guardError??=code;};
    const expectedOrigin=new URL(input.origin).origin;
    const evidence:BrowserEvidence={startedAt:new Date(started).toISOString(),elapsedMs:0,origin:expectedOrigin,adapterVersion:input.run.adapterVersion,planHash:input.run.planHash,domMatched:false,payloadMatched:false,postObserved:false,registeredMarker:false};
    const completedEvidence=(stopCode?:string):BrowserEvidence=>({...evidence,completedAt:new Date().toISOString(),elapsedMs:Date.now()-started,...(stopCode?{stopCode}:{})});
    const validUrl=(raw:string,method:string)=>{
      const url=new URL(raw);
      if(url.origin!==expectedOrigin)return false;
      if(method==='POST')return url.pathname==='/legacy/submit'&&url.search==='';
      if(method!=='GET'||!['/legacy/form','/legacy/result'].includes(url.pathname))return false;
      return url.searchParams.size===2&&url.searchParams.get('run')===input.run.id&&url.searchParams.get('cap')===input.capability;
    };
    const check=()=>{if(timedOut||Date.now()>=deadlineAt)throw new BrowserExecutionError('BROWSER_TIMEOUT',submitted);if(guardError)throw new BrowserExecutionError(guardError,submitted);};
    const work=(async()=>{
    try {
      browser=await browserFactory();
      check();
      context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
      check();
      context.setDefaultTimeout(budgetMs);
      context.setDefaultNavigationTimeout(budgetMs);
      let mainPage:Page|undefined;
      context.on('page',page=>{
        if(!mainPage)mainPage=page;
        else {setGuard('POPUP_DENIED');void page.close();}
      });
      await context.route('**/*',async(route:Route)=>{
        const req=route.request();
        if(timedOut||Date.now()>=deadlineAt){setGuard('BROWSER_TIMEOUT');await route.abort('timedout').catch(()=>{});return;}
        let allowed=false;
        try {allowed=validUrl(req.url(),req.method())&&!req.redirectedFrom()&&req.isNavigationRequest()&&req.frame()===mainPage?.mainFrame();}catch{allowed=false;}
        if(!allowed) {setGuard(req.redirectedFrom()?'REDIRECT_DENIED':'NETWORK_DENIED');await route.abort('blockedbyclient');return;}
        if(req.method()==='POST') {
          evidence.postObserved=true;
          const body=new URLSearchParams(req.postData()??'');
          const expected={run:input.run.id,cap:input.capability,revision:String(input.run.revision),planHash:input.run.planHash,targetRevision:String(input.run.targetRevision),adapterVersion:input.run.adapterVersion,requestId:input.run.plan.requestId,department:input.run.plan.department,item:input.run.plan.item,quantity:String(input.run.plan.quantity),reason:input.run.plan.reason};
          if(body.size!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>body.getAll(key).length!==1||body.get(key)!==value)) {
            setGuard('FORM_PAYLOAD_DRIFT');await route.abort('blockedbyclient');return;
          }
          // Persisted claim and server approval are required before this point.
          evidence.payloadMatched=true;
          submitted=true;
        }
        // Inspect the response before Chromium can follow a redirect, including same-origin redirects.
        // The request still comes from the browser's fixed form action and approved filled fields.
        try {
          const response=await route.fetch({maxRedirects:0,timeout:Math.max(1,deadlineAt-Date.now())});
          if(response.status()>=300&&response.status()<400) {setGuard('REDIRECT_DENIED');await route.abort('blockedbyclient');return;}
          await route.fulfill({response});
        } catch {setGuard('BROWSER_INTERRUPTED');await route.abort('failed').catch(()=>{});}
      });
      const page=await context.newPage();mainPage=page;
      page.on('response',response=>{if(response.status()>=300&&response.status()<400)setGuard('REDIRECT_DENIED');});
      page.on('download',download=>{setGuard('DOWNLOAD_DENIED');void download.cancel();});
      const formUrl=new URL('/legacy/form',input.origin);formUrl.searchParams.set('run',input.run.id);formUrl.searchParams.set('cap',input.capability);
      const response=await page.goto(formUrl.href,{waitUntil:'domcontentloaded'});
      check();
      if(!response?.ok())throw new BrowserExecutionError('LEGACY_UNAVAILABLE',false);
      const form=page.locator('form[data-adapter]');
      if(await form.count()!==1||await page.locator('form').count()!==1)throw new BrowserExecutionError('DOM_DRIFT',false);
      const expectedAttrs={'data-adapter':input.run.adapterVersion,'data-run':input.run.id,'data-target-revision':String(input.run.targetRevision),'method':'post','action':'/legacy/submit'};
      for(const [attribute,value] of Object.entries(expectedAttrs)){check();if(await form.getAttribute(attribute)!==value)throw new BrowserExecutionError('DOM_DRIFT',false);}
      const hidden={run:input.run.id,cap:input.capability,revision:String(input.run.revision),planHash:input.run.planHash,targetRevision:String(input.run.targetRevision),adapterVersion:input.run.adapterVersion};
      for(const [name,value] of Object.entries(hidden)) {
        const field=form.locator(`input[name="${name}"][type="hidden"]`);
        if(await field.count()!==1||await field.inputValue()!==value)throw new BrowserExecutionError('DOM_DRIFT',false);
      }
      const visible=[['需求编号','requestId',input.run.plan.requestId],['部门','department',input.run.plan.department],['物品','item',input.run.plan.item],['数量','quantity',String(input.run.plan.quantity)],['用途','reason',input.run.plan.reason]] as const;
      if(await form.locator('input,select,textarea').count()!==11)throw new BrowserExecutionError('DOM_DRIFT',false);
      for(const [label,name,value] of visible) {
        check();
        const field=page.getByLabel(label,{exact:true});
        if(await field.count()!==1||await field.getAttribute('name')!==name)throw new BrowserExecutionError('DOM_DRIFT',false);
        if(name==='department'||name==='item') {
          const options=await field.locator('option').allTextContents();
          const expected=name==='department'?['研发部','运营部','行政部']:['显示器','键盘','办公椅'];
          if(JSON.stringify(options)!==JSON.stringify(expected))throw new BrowserExecutionError('DOM_DRIFT',false);
          await field.selectOption(value);
        } else {
          const tag=await field.evaluate(element=>element.tagName.toLowerCase());
          if(tag!==(name==='reason'?'textarea':'input'))throw new BrowserExecutionError('DOM_DRIFT',false);
          if(name==='quantity'&&(await field.getAttribute('type')!=='number'||await field.getAttribute('min')!=='1'||await field.getAttribute('max')!=='100'))throw new BrowserExecutionError('DOM_DRIFT',false);
          await field.fill(value);
        }
        if(await field.inputValue()!==value)throw new BrowserExecutionError('DOM_DRIFT',false);
      }
      const submit=page.getByRole('button',{name:'登记合成需求',exact:true});
      if(await submit.count()!==1||await submit.getAttribute('type')!=='submit')throw new BrowserExecutionError('DOM_DRIFT',false);
      evidence.domMatched=true;
      check();
      const navigation=page.waitForResponse(r=>new URL(r.url()).pathname==='/legacy/submit');
      const [result]=await Promise.all([navigation,submit.click()]);
      await page.waitForLoadState('domcontentloaded');
      check();
      if(!result.ok())throw new BrowserExecutionError('SUBMISSION_REJECTED',submitted);
      if(await page.locator('[data-result="registered"]').count()!==1)throw new BrowserExecutionError('RESULT_DRIFT',submitted);
      evidence.registeredMarker=true;
    } catch(error) {
      if(error instanceof BrowserExecutionError)throw error;
      throw new BrowserExecutionError(guardError??'BROWSER_INTERRUPTED',submitted);
    } finally {await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
    })();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      timedOut=true;
      void context?.close().catch(()=>{});void browser?.close().catch(()=>{});
      reject(new BrowserExecutionError('BROWSER_TIMEOUT',submitted));
    },budgetMs);});
    try {await Promise.race([work,deadline]);return completedEvidence();}
    catch(error) {
      const stopped=error instanceof BrowserExecutionError?error:new BrowserExecutionError('BROWSER_INTERRUPTED',submitted);
      throw new BrowserExecutionError(stopped.code,stopped.effectPossible,completedEvidence(stopped.code));
    }finally {clearTimeout(timer);}
  }};
}
