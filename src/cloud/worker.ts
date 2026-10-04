import {launch} from '@cloudflare/playwright';
import type { Browser } from 'playwright';
import type {D1Database,Ai} from '@cloudflare/workers-types';
import {createHandler} from '../runtime/handler.js';
import {createBrowserExecutor,BrowserExecutionError} from '../browser/executor.js';
import {D1Repository} from './repository.js';
import {proposeCloudPlan} from '../planner.js';
import {claimBrowserSlot,consumeBudget} from './budget.js';
import {allowedCloudOrigin} from './origin.js';
interface Env {DB:D1Database; BROWSER:Parameters<typeof launch>[0]; AI?:Ai; SESSION_SECRET:string; PUBLIC_ORIGINS:string; TRUSTED_PREVIEW_PROJECT?:string; ENABLE_FREE_AI?:string; ENABLE_BROWSER_RUN?:string; RELEASE_VERSION?:string;}
export default {async fetch(request:Request,env:Env):Promise<Response>{
  const origin=new URL(request.url).origin;const origins=env.PUBLIC_ORIGINS.split(',').map(x=>x.trim());
  if(!allowedCloudOrigin(request.url,origins,env.TRUSTED_PREVIEW_PROJECT))return Response.json({ok:false,error:{code:'ORIGIN_DENIED',message:'服务地址不受信任。'}},{status:403});
  if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)return Response.json({ok:false,error:{code:'NOT_CONFIGURED',message:'服务配置尚未完成。'}},{status:503});
  const path=new URL(request.url).pathname;
  if((path==='/api/session'||path==='/api/propose'||path.endsWith('/revise'))&&!await consumeBudget(env.DB,path==='/api/session'?'session-requests':'proposal-requests',200))return Response.json({ok:false,error:{code:'FREE_REQUEST_BUDGET_EXHAUSTED',message:'今日体验额度已用完。'}},{status:429,headers:{'Cache-Control':'no-store'}});
  const repo=new D1Repository(env.DB);
  const executor=createBrowserExecutor({browserFactory:async()=>{if(env.ENABLE_BROWSER_RUN!=='true')throw new BrowserExecutionError('BROWSER_PLAN_NOT_CONFIRMED',false);if(!await claimBrowserSlot(env.DB))throw new BrowserExecutionError('FREE_BROWSER_BUDGET_OR_INTERVAL_EXHAUSTED',false);return await launch(env.BROWSER) as unknown as Browser;},timeoutMs:25_000});
  const handle=createHandler({repository:repo,sessionSecret:env.SESSION_SECRET,publicOrigin:origin,executor,proposePlan:async(text)=>{
    const ai=env.ENABLE_FREE_AI==='true'&&env.AI&&await consumeBudget(env.DB,'model-proposal',12)?env.AI:undefined;
    return proposeCloudPlan(text,ai as unknown as Parameters<typeof proposeCloudPlan>[1]);
  },plannerLabel:env.ENABLE_FREE_AI==='true'?'免费额度内模型提案；不可用时有界规则':'有界规则提案；模型未启用'});
  const response=await handle(request);const headers=new Headers(response.headers);headers.set('X-Office-Release',env.RELEASE_VERSION||'unversioned');return new Response(response.body,{status:response.status,headers});
}};
