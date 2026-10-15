import { PUBLIC_INPUT_SCHEMAS,PUBLIC_TOOL_NAMES,runPublicQuery,type AgentResult,type PublicSnapshot,type PublicToolName } from './public-queries.js';
export type ReadonlyTool={name:PublicToolName,description:string,inputSchema:object,execute:(input:unknown,context:{signal:AbortSignal})=>Promise<AgentResult>};
export interface ModelContextPort{register(tool:ReadonlyTool,lifetime:AbortSignal):Promise<void>;removeOwned(name:PublicToolName):Promise<void>;}
export type RegistrationReport={state:'registered'|'unsupported'|'failed',registeredNames:PublicToolName[],failureCodes:string[]};
export type RegistrationHandle={ready:Promise<RegistrationReport>,dispose():void};
type NativeContext={registerTool:(tool:ReadonlyTool&{annotations:{readOnlyHint:boolean,untrustedContentHint:boolean,consequentialHint:boolean}},options:{signal:AbortSignal})=>Promise<unknown>};
const nativePorts=new WeakMap<object,ModelContextPort>();
const leases=new WeakMap<ModelContextPort,{active:boolean,owner:symbol,barrier:Promise<void>}>();
const descriptions:Record<PublicToolName,string>={
  of_project_info:'Read one public portfolio project summary. No private data or actions.',
  of_project_evidence:'List reviewed same-origin evidence links for a public project, in bounded pages.',
};
function nativePort():ModelContextPort|undefined{
  try{
    if(typeof document==='undefined') return;
    const context=(document as Document&{modelContext?:NativeContext}).modelContext;
    if(!context||typeof context.registerTool!=='function') return;
    const existing=nativePorts.get(context);if(existing) return existing;
    const port:ModelContextPort={
      async register(tool,signal){await context.registerTool({...tool,annotations:{readOnlyHint:true,untrustedContentHint:true,consequentialHint:false}},{signal});},
      // Native registrations are owned by the signal; manual unregister by name could delete a stranger after abort.
      async removeOwned(){},
    };
    nativePorts.set(context,port);return port;
  }catch{return;}
}
export function mountProjectTools(getSnapshot:()=>PublicSnapshot,injected?:ModelContextPort):RegistrationHandle {
  const port=injected??nativePort();
  if(!port) return {ready:Promise.resolve({state:'unsupported',registeredNames:[],failureCodes:[]}),dispose(){}};
  const previous=leases.get(port);
  if(previous?.active) return {ready:Promise.resolve({state:'failed',registeredNames:[],failureCodes:['OWNERSHIP_CONFLICT']}),dispose(){}};
  const owner=Symbol('portfolio-tools');const controller=new AbortController();
  let closed=false;let release!:()=>void;const disposed=new Promise<void>(r=>{release=r;});
  const lease={active:true,owner,barrier:Promise.resolve()};leases.set(port,lease);
  const ready=(async():Promise<RegistrationReport>=>{
    await previous?.barrier;
    const names:PublicToolName[]=[];const failureCodes:string[]=[];
    for(const name of PUBLIC_TOOL_NAMES){
      if(closed) break;
      try{
        await port.register({name,description:descriptions[name],inputSchema:PUBLIC_INPUT_SCHEMAS[name],execute:async(input,context)=>{
          try{return runPublicQuery(name,input,getSnapshot(),closed?controller.signal:context?.signal);}
          catch{return {ok:false,error:{code:'DATA_UNAVAILABLE'},provenance:{snapshotVersion:'unavailable',scope:'public-summary'}};}
        }},controller.signal);
        if(!closed) names.push(name);
      }catch{if(!closed) failureCodes.push('REGISTRATION_FAILED');}
    }
    if(closed) failureCodes.push('DISPOSED');
    if(failureCodes.length) controller.abort(); // partial registration is not an advertised usable tool set
    return {state:failureCodes.length?'failed':'registered',registeredNames:failureCodes.length?[]:names,failureCodes};
  })();
  lease.barrier=(async()=>{await ready;await disposed;})();
  return {ready,dispose(){
    if(closed) return;closed=true;controller.abort();
    if(leases.get(port)?.owner===owner) lease.active=false;
    release();
  }};
}

// A restored bfcache document keeps the UI module, but its pagehide signal was aborted.
// Re-register only this public interface on pageshow; never rerun the business UI.
export function mountPageProjectTools(
  getSnapshot:()=>PublicSnapshot,
  events:Pick<EventTarget,'addEventListener'|'removeEventListener'>|undefined=typeof window==='undefined'?undefined:window,
  port?:ModelContextPort,
):RegistrationHandle {
  let registration:RegistrationHandle|undefined=mountProjectTools(getSnapshot,port);
  const ready=registration.ready;let disposed=false;
  const hide=()=>{registration?.dispose();registration=undefined;};
  const show=()=>{if(!disposed&&!registration)registration=mountProjectTools(getSnapshot,port);};
  events?.addEventListener('pagehide',hide);
  events?.addEventListener('pageshow',show);
  return {ready,dispose(){
    if(disposed)return;disposed=true;
    events?.removeEventListener('pagehide',hide);
    events?.removeEventListener('pageshow',show);
    hide();
  }};
}
