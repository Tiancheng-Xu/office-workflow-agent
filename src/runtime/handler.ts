import { z } from 'zod';
import type { BrowserEvidence, Demand, Plan, Run, SessionView } from '../contracts.js';
import type { BrowserExecutor } from '../browser/executor.js';
import { BrowserExecutionError } from '../browser/executor.js';
import { ADAPTER_VERSION, DomainError, type CapabilityRecord, type Repository, type SessionRecord } from './repository.js';
import { assertApproval, canonicalPayload, escapeHtml, event, hash, randomToken, validatePlan } from './validation.js';
import { SessionManager } from './session.js';
import { createExecutionProof } from './proof.js';

export interface HandlerOptions {
  repository:Repository;sessionSecret:string;publicOrigin:string;proposePlan:(text:string)=>Promise<Plan>;
  executor:BrowserExecutor;now?:()=>number;adapterVersion?:string;plannerLabel?:string;
}
const approvalSchema=z.object({revision:z.number().int().positive(),planHash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().nonnegative()}).strict();
const proposalSchema=z.object({text:z.string().trim().min(1).max(2000)}).strict();
const reviseSchema=z.object({revision:z.number().int().positive(),planHash:z.string().regex(/^[a-f0-9]{64}$/),text:z.string().trim().min(1).max(2000)}).strict();
const emptySchema=z.object({}).strict();
const securityHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
function json(data:unknown,status=200,headers:Record<string,string>={}):Response {
  return new Response(JSON.stringify(data),{status,headers:{...securityHeaders,'Content-Type':'application/json; charset=utf-8',...headers}});
}
function html(content:string,status=200):Response {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成采购后台</title><body>${content}</body></html>`,{status,headers:{...securityHeaders,'Referrer-Policy':'strict-origin','Content-Type':'text/html; charset=utf-8'}});
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new DomainError('INVALID_INPUT','请求参数无效。',400);
  return parsed.data;
}
async function body(request:Request):Promise<unknown> {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new DomainError('INVALID_CONTENT_TYPE','请使用 JSON 请求。',415);
  if(Number(request.headers.get('content-length')??0)>12_000)throw new DomainError('BODY_TOO_LARGE','请求过长。',413);
  const raw=await limitedText(request);
  try{return JSON.parse(raw);}catch{throw new DomainError('INVALID_JSON','JSON 格式无效。',400);}
}
async function limitedText(request:Request):Promise<string> {
  const reader=request.body?.getReader();if(!reader)return '';
  const decoder=new TextDecoder();let total=0,result='';
  while(true) {
    const chunk=await reader.read();if(chunk.done)break;
    total+=chunk.value.byteLength;
    if(total>12_000){await reader.cancel();throw new DomainError('BODY_TOO_LARGE','请求过长。',413);}
    result+=decoder.decode(chunk.value,{stream:true});
  }
  return result+decoder.decode();
}
export function createHandler(options:HandlerOptions):(request:Request)=>Promise<Response> {
  const {repository,executor}=options,now=options.now??Date.now;
  const adapterVersion=options.adapterVersion??ADAPTER_VERSION;
  const origin=new URL(options.publicOrigin).origin;
  const sessions=new SessionManager(repository,options.sessionSecret,origin.startsWith('https:'),now);
  async function requiredRun(tenantId:string,id:string):Promise<Run> {
    const run=await repository.getRun(tenantId,id);
    if(!run)throw new DomainError('RUN_NOT_FOUND','运行不存在。',404);
    return run;
  }
  function executionLeaseExpired(run:Run):boolean {
    const claim=run.events.filter(item=>item.type==='execution-claimed').at(-1);
    return !claim||!Number.isFinite(Date.parse(claim.at))||Date.parse(claim.at)+35_000<=now();
  }
  async function update(tenantId:string,id:string,change:(run:Run)=>Run|Promise<Run>):Promise<Run> {
    for(let retry=0;retry<5;retry++) {
      const current=await requiredRun(tenantId,id),next=await change(current);
      if(next===current)return current;
      if(await repository.saveRunCAS(tenantId,next,current.epoch))return next;
    }
    throw new DomainError('CONCURRENT_CHANGE','状态正在改变，请刷新后重试。');
  }
  async function reconcile(tenantId:string,id:string,type='reconciled'):Promise<Run> {
    return update(tenantId,id,async current=>{
      const demand=await repository.getDemand(tenantId,current.plan.requestId);
      if(current.status==='verified')return current;
      if(demand) {
        if(demand.payloadHash!==current.planHash||demand.executionKey!==current.executionKey)return event({...current,status:'blocked',error:'PAYLOAD_CONFLICT'},now(),'payload-conflict','需求编号已有不同参数或执行编号；未执行新写入。');
        return event({...current,status:'verified',effectStatus:'applied',result:demand,error:undefined},now(),type,'API 独立查询确认登记结果；重复执行不会重复登记。');
      }
      // Live observation must not change an active execution's epoch: its form POST uses that claim.
      if(current.status==='executing'&&!executionLeaseExpired(current))return current;
      if(current.status==='draft'||current.status==='approved'||current.status==='blocked'||current.status==='cancelled')
        return event(current,now(),type,'API 未发现登记结果；本次核对没有发起写入。');
      return event({...current,status:'unknown',effectStatus:current.effectStatus==='applied'?'applied':'unknown'},now(),type,'API 暂未发现登记结果；保留不确定状态，不自动重新提交。');
    });
  }
  async function capability(request:Request):Promise<{cap:CapabilityRecord;run:Run;token:string}> {
    const url=new URL(request.url),runId=url.searchParams.get('run'),token=url.searchParams.get('cap');
    if(!runId||!token||url.searchParams.size!==2||!/^[a-f0-9]{64}$/.test(token))throw new DomainError('CAPABILITY_INVALID','执行授权无效。',403);
    const cap=await repository.getCapability(await hash(token));
    if(!cap||cap.runId!==runId||cap.expiresAt<=now())throw new DomainError('CAPABILITY_INVALID','执行授权已失效。',403);
    const run=await requiredRun(cap.tenantId,cap.runId);
    if(run.revision!==cap.revision||run.planHash!==cap.planHash||run.targetRevision!==cap.targetRevision||run.adapterVersion!==cap.adapterVersion)throw new DomainError('STALE_APPROVAL','执行授权与计划版本不一致。');
    assertApproval(run,now(),adapterVersion);
    return {cap,run,token};
  }
  async function legacy(request:Request,path:string):Promise<Response> {
    if(path==='/legacy/form'&&request.method==='GET') {
      const {run,token}=await capability(request);
      if(run.status!=='executing')throw new DomainError('EXECUTION_NOT_CLAIMED','运行未认领或已结束。');
      const hidden:Record<string,string|number>={run:run.id,cap:token,revision:run.revision,planHash:run.planHash,targetRevision:run.targetRevision,adapterVersion:run.adapterVersion};
      const fields=Object.entries(hidden).map(([key,value])=>`<input type="hidden" name="${key}" value="${escapeHtml(value)}">`).join('');
      return html(`<h1>独立体验租户 · 合成采购需求</h1><p>此页只登记模拟办公需求，无付款操作。</p><form method="post" action="/legacy/submit" data-adapter="${escapeHtml(run.adapterVersion)}" data-run="${escapeHtml(run.id)}" data-target-revision="${run.targetRevision}">${fields}<label for="requestId">需求编号</label><input id="requestId" name="requestId" type="text" required maxlength="68"><label for="department">部门</label><select id="department" name="department">${['研发部','运营部','行政部'].map(v=>`<option value="${v}">${v}</option>`).join('')}</select><label for="item">物品</label><select id="item" name="item">${['显示器','键盘','办公椅'].map(v=>`<option value="${v}">${v}</option>`).join('')}</select><label for="quantity">数量</label><input id="quantity" name="quantity" type="number" min="1" max="100" required><label for="reason">用途</label><textarea id="reason" name="reason" maxlength="200" required></textarea><button type="submit">登记合成需求</button></form>`);
    }
    if(path==='/legacy/submit'&&request.method==='POST') {
      if(request.headers.get('origin')!==origin)throw new DomainError('ORIGIN_DENIED','表单来源不受信任。',403);
      if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new DomainError('INVALID_CONTENT_TYPE','表单格式无效。',415);
      const raw=await limitedText(request);
      const form=new URLSearchParams(raw);
      const names=['run','cap','revision','planHash','targetRevision','adapterVersion','requestId','department','item','quantity','reason'];
      if(form.size!==names.length||names.some(name=>form.getAll(name).length!==1))throw new DomainError('INVALID_INPUT','表单字段发生变化。',400);
      const token=form.get('cap')!;
      if(!/^[a-f0-9]{64}$/.test(token))throw new DomainError('CAPABILITY_INVALID','执行授权无效。',403);
      const cap=await repository.getCapability(await hash(token));
      if(!cap)throw new DomainError('CAPABILITY_INVALID','执行授权无效。',403);
      const run=await requiredRun(cap.tenantId,form.get('run')!);
      const plan=validatePlan({requestId:form.get('requestId'),department:form.get('department'),item:form.get('item'),quantity:Number(form.get('quantity')),reason:form.get('reason'),source:run.plan.source});
      const demand=await repository.submitDemand({tokenHash:cap.tokenHash,runId:form.get('run')!,revision:Number(form.get('revision')),planHash:form.get('planHash')!,targetRevision:Number(form.get('targetRevision')),adapterVersion:form.get('adapterVersion')!,plan,now:now()});
      return html(`<h1 data-result="registered">需求已登记</h1><p>${escapeHtml(demand.requestId)} · ${escapeHtml(demand.department)} · ${escapeHtml(demand.item)} · ${demand.quantity}</p>`);
    }
    if(path==='/legacy/result'&&request.method==='GET') {
      const {cap,run}=await capability(request);
      const demand=await repository.getDemand(cap.tenantId,run.plan.requestId);
      return html(demand?`<p data-result="registered">${escapeHtml(demand.requestId)}</p>`:'<p data-result="not-found">未查询到登记结果</p>');
    }
    throw new DomainError('NOT_FOUND','页面不存在。',404);
  }
  return async request=> {
    try {
      const url=new URL(request.url),path=url.pathname;
      if(url.origin!==origin)throw new DomainError('ORIGIN_DENIED','服务地址不受信任。',403);
      if(path.startsWith('/legacy/'))return await legacy(request,path);
      if(path==='/api/health'&&request.method==='GET')return json({ok:true,data:{status:'ok',adapterVersion,...await repository.health()}});
      let session=await sessions.read(request);
      if(path==='/api/session'&&request.method==='GET') {
        let cookie:string|undefined;
        if(!session) {const created=await sessions.create();session=created.session;cookie=created.cookie;}
        const view:SessionView={csrf:session.csrf,tenantLabel:'独立合成体验租户',adapterVersion,planner:options.plannerLabel??'有界提案；来源以计划标记为准'};
        return json({ok:true,data:view},200,cookie?{'Set-Cookie':cookie}:{});
      }
      if(!session)throw new DomainError('SESSION_REQUIRED','请先建立体验会话。',401);
      const workspaceContext=request.headers.get('x-officeflow-context');
      if(workspaceContext!==null&&workspaceContext!==session.csrf)
        throw new DomainError('SESSION_CHANGED','工作区会话已切换，请重新连接。',403);
      if(request.method!=='GET')sessions.mutation(request,session,origin);
      if(path==='/api/runs'&&request.method==='GET') {
        const runs=await repository.listRuns(session.tenantId);
        const observed=await Promise.all(runs.map(run=>run.status==='executing'&&executionLeaseExpired(run)?reconcile(session!.tenantId,run.id,'lease-expired'):Promise.resolve(run)));
        return json({ok:true,data:observed});
      }
      if(path==='/api/propose'&&request.method==='POST') {
        const {text}=parse(proposalSchema,await body(request));
        let proposed:Plan;
        try {proposed=await options.proposePlan(text);}
        catch {throw new DomainError('PLAN_UNSUPPORTED','请改写为单一合成采购需求，并明确部门、物品、1–100的数量及REQ-开头的需求编号；不接受付款、链接或权限指令。',400);}
        const plan=validatePlan(proposed);
        const planHash=await hash(canonicalPayload(plan)),targetRevision=await repository.getTargetRevision(session.tenantId);
        const run:Run={id:crypto.randomUUID(),revision:1,plan,planHash,targetRevision,adapterVersion,status:'draft',effectStatus:'none',executionKey:await hash(`${session.tenantId}:${plan.requestId}`),events:[{at:new Date(now()).toISOString(),type:'proposed',message:`已提出合成采购计划；来源：${plan.source}。等待人工确认。`}],epoch:0};
        await repository.createRun(session.tenantId,run);
        return json({ok:true,data:run},201);
      }
      const match=path.match(/^\/api\/runs\/([a-f0-9-]{36})\/(approve|revise|execute|reconcile|cancel|report)$/);
      if(!match)throw new DomainError('NOT_FOUND','接口不存在。',404);
      const [,id,action]=match;
      await requiredRun(session.tenantId,id!);
      if(action==='report'&&request.method==='GET') {
        let run=await requiredRun(session.tenantId,id!);
        if(run.status==='executing'&&executionLeaseExpired(run)) {
          try {run=await reconcile(session.tenantId,id!,'lease-expired');}
          catch { /* report still records an unavailable fresh read without inventing an effect */ }
        }
        let demand:Demand|undefined,queryStatus:'found'|'not-found'|'unavailable';
        try {demand=await repository.getDemand(session.tenantId,run.plan.requestId);queryStatus=demand?'found':'not-found';}
        catch {queryStatus='unavailable';}
        return json({ok:true,data:await createExecutionProof(run,{checkedAt:new Date(now()).toISOString(),queryStatus,demand})});
      }
      if(request.method!=='POST')throw new DomainError('METHOD_NOT_ALLOWED','请求方法不受支持。',405);
      if(action==='revise') {
        const input=parse(reviseSchema,await body(request));
        const current=await requiredRun(session.tenantId,id!);
        if(!['draft','approved','blocked'].includes(current.status)||current.effectStatus!=='none'||current.result)
          throw new DomainError('REVISION_NOT_ALLOWED','只有尚未产生效果的草稿、已批准或已停止计划可修订；不确定效果只能核对。');
        if(input.revision!==current.revision||input.planHash!==current.planHash)
          throw new DomainError('STALE_REVISION','计划已改变，请刷新后修订。');
        let proposed:Plan;
        try {proposed=await options.proposePlan(input.text);}
        catch {throw new DomainError('PLAN_UNSUPPORTED','请明确同一需求编号的部门、物品和1–100的数量；修订仅提出计划，不会登记。',400);}
        const plan=validatePlan(proposed);
        if(plan.requestId!==current.plan.requestId)throw new DomainError('REQUEST_ID_CHANGED','修订必须保留原需求编号；新编号请单独提案。');
        const targetRevision=await repository.getTargetRevision(session.tenantId);
        const revised=event({...current,revision:current.revision+1,previousPlan:current.plan,previousRevision:current.revision,plan,planHash:await hash(canonicalPayload(plan)),targetRevision,adapterVersion,status:'draft',effectStatus:'none',approvedHash:undefined,approvalExpiresAt:undefined,browserEvidence:undefined,result:undefined,error:undefined},now(),'plan-revised','计划已修订并清除旧批准；请审阅差异后重新确认，未发起后台登记。');
        if(!await repository.saveRunCAS(session.tenantId,revised,current.epoch))throw new DomainError('CONCURRENT_CHANGE','状态已改变，修订未保存，请刷新后重试。');
        return json({ok:true,data:revised});
      }
      if(action==='approve') {
        const input=parse(approvalSchema,await body(request));
        const current=await requiredRun(session.tenantId,id!);
        if(['executing','unknown','verified','cancelled'].includes(current.status)||current.effectStatus!=='none'||current.result)throw new DomainError('APPROVAL_NOT_ALLOWED','此状态不能重新批准。');
        if(input.revision!==current.revision||input.planHash!==current.planHash||input.targetRevision!==current.targetRevision||current.adapterVersion!==adapterVersion)throw new DomainError('STALE_APPROVAL','批准内容与当前计划版本不一致。');
        if(await repository.getTargetRevision(session.tenantId)!==current.targetRevision)throw new DomainError('TARGET_DRIFT','后台版本已改变，请重新提案。');
        const approved=event({...current,status:'approved',effectStatus:'none',approvedHash:current.planHash,approvalExpiresAt:new Date(now()+5*60*1000).toISOString(),error:undefined},now(),'approved','用户已确认完整计划；批准有效期五分钟。');
        if(!await repository.saveRunCAS(session.tenantId,approved,current.epoch))throw new DomainError('CONCURRENT_CHANGE','状态已改变，请刷新后确认。');
        return json({ok:true,data:approved});
      }
      parse(emptySchema,await body(request));
      if(action==='reconcile')return json({ok:true,data:await reconcile(session.tenantId,id!)});
      if(action==='cancel') {
        await reconcile(session.tenantId,id!,'cancel-check');
        const cancelled=await update(session.tenantId,id!,async current=>{
          if(current.status==='verified')return event(current,now(),'cancel-after-effect','登记效果已存在，取消不会撤销已登记需求。');
          if(current.effectStatus==='applied'||current.result) {
            // cancel-check can have returned a stale absence while a valid form committed.
            // Inspect the live CAS snapshot and freshly query the original key before claiming verified.
            let demand:Demand|undefined;
            try {demand=await repository.getDemand(session!.tenantId,current.plan.requestId);}catch { /* keep durable applied evidence when the query is unavailable */ }
            if(demand&&demand.payloadHash===current.planHash&&demand.executionKey===current.executionKey)
              return event({...current,status:'verified',effectStatus:'applied',result:demand,error:undefined},now(),'cancel-after-effect','取消时独立查询确认登记已存在；取消不会撤销该效果。');
            return event({...current,status:'unknown',effectStatus:'applied',error:'EFFECT_QUERY_UNCONFIRMED'},now(),'cancel-after-effect-unconfirmed','持久记录表明已登记；当前查询未确认，保留已写入效果并仅核对原需求编号。');
          }
          if(current.status==='cancelled')return current;
          return event({...current,status:'cancelled',effectStatus:current.effectStatus==='unknown'?'unknown':'none',approvedHash:undefined,approvalExpiresAt:undefined},now(),'cancelled','已停止新的提交；仍可核对原需求编号，取消不会撤销已发生效果。');
        });
        return json({ok:true,data:cancelled});
      }
      if(action==='execute') {
        let run=await requiredRun(session.tenantId,id!);
        if(run.status==='executing')return json({ok:true,data:executionLeaseExpired(run)?await reconcile(session.tenantId,id!,'lease-expired'):run});
        if(run.status==='verified'||run.status==='unknown'||run.status==='cancelled')return json({ok:true,data:await reconcile(session.tenantId,id!)});
        if(run.status!=='approved')throw new DomainError('APPROVAL_REQUIRED','必须先人工确认计划。');
        assertApproval(run,now(),adapterVersion);
        const existing=await repository.getDemand(session.tenantId,run.plan.requestId);
        if(existing)return json({ok:true,data:await reconcile(session.tenantId,id!,'deduplicated')});
        if(await repository.getTargetRevision(session.tenantId)!==run.targetRevision)throw new DomainError('TARGET_DRIFT','后台版本已改变，请重新提案。');
        const claimed=event({...run,status:'executing',effectStatus:'unknown'},now(),'execution-claimed','提交前执行认领已持久化；后续故障只核对原需求编号。');
        if(!await repository.saveRunCAS(session.tenantId,claimed,run.epoch))return json({ok:true,data:await reconcile(session.tenantId,id!)});
        run=claimed;
        const token=randomToken();
        try {
          await repository.issueCapability({tokenHash:await hash(token),tenantId:session.tenantId,runId:run.id,revision:run.revision,planHash:run.planHash,targetRevision:run.targetRevision,adapterVersion:run.adapterVersion,expiresAt:Math.min(Date.parse(run.approvalExpiresAt!),now()+30_000)});
        } catch {
          const failed=await update(session.tenantId,id!,current=>current.status==='verified'||current.status==='cancelled'?current:event({...current,status:'unknown',effectStatus:current.effectStatus==='applied'?'applied':'unknown',error:'CAPABILITY_PERSIST_FAILED'},now(),'capability-failed','执行授权持久化中断；保留原执行编号，仅可核对。'));
          return json({ok:true,data:failed});
        }
        let browserError:BrowserExecutionError|undefined,browserEvidence:BrowserEvidence|undefined;
        try {browserEvidence=await executor.execute({origin,run,capability:token})||undefined;}
        catch(error) {browserError=error instanceof BrowserExecutionError?error:new BrowserExecutionError('BROWSER_INTERRUPTED',true);browserEvidence=browserError.evidence;}
        if(browserEvidence) {
          // Store a whitelist of actual observations; no capability, query URL or raw form can persist.
          const evidenceSchema=z.object({startedAt:z.string().datetime(),completedAt:z.string().datetime().optional(),elapsedMs:z.number().finite().min(0).max(120_000),origin:z.literal(origin),adapterVersion:z.literal(run.adapterVersion),planHash:z.literal(run.planHash),domMatched:z.boolean(),payloadMatched:z.boolean(),postObserved:z.boolean(),registeredMarker:z.boolean(),stopCode:z.enum(['DOM_DRIFT','FORM_PAYLOAD_DRIFT','BROWSER_TIMEOUT','BROWSER_INTERRUPTED','NETWORK_DENIED','REDIRECT_DENIED','POPUP_DENIED','DOWNLOAD_DENIED','LEGACY_UNAVAILABLE','SUBMISSION_REJECTED','RESULT_DRIFT','BROWSER_PLAN_NOT_CONFIRMED','FREE_BROWSER_BUDGET_OR_INTERVAL_EXHAUSTED']).optional()}).strip();
          const parsed=evidenceSchema.safeParse(browserEvidence);
          if(parsed.success)await update(session.tenantId,id!,current=>current.revision!==run.revision||current.planHash!==run.planHash?current:event({...current,browserEvidence:parsed.data},now(),'browser-observed','已记录受控浏览器的字段、POST及回执观测；业务效果仍由独立查询确认。'));
        }
        const checked=await reconcile(session.tenantId,id!,'execution-query');
        if(checked.status==='verified')return json({ok:true,data:checked});
        if(browserError) {
          const failure=await update(session.tenantId,id!,current=>{
            if(current.status==='verified'||current.status==='cancelled')return current;
            const applied=current.effectStatus==='applied'||Boolean(current.result);
            return event({...current,status:applied||browserError!.effectPossible?'unknown':'blocked',effectStatus:applied?'applied':browserError!.effectPossible?'unknown':'none',error:browserError!.code},now(),'browser-stopped',applied||browserError!.effectPossible?'浏览器中断，保留持久效果记录；仅可核对，禁止自动重写。':'浏览器安全检查停止了提交；请重新提案并人工确认。');
          });
          return json({ok:true,data:failure});
        }
        const unresolved=await update(session.tenantId,id!,current=>current.status==='verified'||current.status==='cancelled'?current:event({...current,status:'unknown',effectStatus:current.effectStatus==='applied'?'applied':'unknown'},now(),'effect-unresolved','浏览器已结束但 API 未确认结果；仅可核对原需求编号。'));
        return json({ok:true,data:unresolved});
      }
      throw new DomainError('NOT_FOUND','接口不存在。',404);
    } catch(error) {
      const domain=error instanceof DomainError?error:undefined;
      return json({ok:false,error:{code:domain?.code??'INTERNAL_ERROR',message:domain?.message??'服务暂时无法完成请求；请核对已有运行。'}},domain?.status??500);
    }
  };
}
