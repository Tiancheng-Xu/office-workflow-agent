import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProjectSnapshot,runPublicQuery,PUBLIC_INPUT_SCHEMAS } from '../src/agent-interface/public-queries.js';
import type { ModelContextPort,ReadonlyTool } from '../src/agent-interface/webmcp-registry.js';

test('public_only returns bounded static project identity and same-origin proof',()=>{
  const s=getProjectSnapshot();const original=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('Unexpected network');};
  try{
    assert.deepEqual(runPublicQuery('of_project_info',{projectId:'office-workflow-agent'},s),{ok:true,data:s.projects[0],provenance:{snapshotVersion:'office-public-v1',scope:'public-summary'}});
    const result=runPublicQuery('of_project_evidence',{projectId:'office-workflow-agent'},s);
    assert.equal(result.ok,true);if(result.ok) assert.deepEqual(result.data,[{title:'公开工作证明',href:'https://office-workflow-agent.baby2b.online/evidence/'}]);
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=6144);
    assert.ok(!JSON.stringify(s).includes('/Users/'));
  }finally{globalThis.fetch=original;}
});
test('unsupported_and_remount cleans only owned public tools',async()=>{
  const {mountProjectTools}=await import('../src/agent-interface/webmcp-registry.js');
  const absent=mountProjectTools(getProjectSnapshot);assert.equal((await absent.ready).state,'unsupported');absent.dispose();
  const tools=new Map<string,ReadonlyTool>();
  const port:ModelContextPort={async register(tool,signal){if(tools.has(tool.name))throw Error('Conflict');tools.set(tool.name,tool);signal.addEventListener('abort',()=>{if(tools.get(tool.name)===tool)tools.delete(tool.name);},{once:true});},async removeOwned(){}};
  const h=mountProjectTools(getProjectSnapshot,port);assert.equal((await h.ready).state,'registered');assert.deepEqual([...tools.keys()],['of_project_info','of_project_evidence']);h.dispose();assert.equal(tools.size,0);
  const stranger={name:'of_project_info',description:'stranger',inputSchema:{},execute:async()=>({ok:true,data:'foreign',provenance:{snapshotVersion:'x',scope:'public-summary'}})} as ReadonlyTool;
  tools.set(stranger.name,stranger);const rejected=mountProjectTools(getProjectSnapshot,port);assert.equal((await rejected.ready).state,'failed');rejected.dispose();assert.equal(tools.get(stranger.name),stranger);assert.equal(tools.size,1);
});
test('invalid_input_and_cancel refuses privilege fields and stable errors',()=>{
  const s=getProjectSnapshot();
  for(const input of [{projectId:'office-workflow-agent',role:'admin'},{projectId:'office-workflow-agent',tenant:'other'},{projectId:'office-workflow-agent',limit:6},{projectId:'office-workflow-agent',url:'https://evil.example'},{}]){
    const result=runPublicQuery('of_project_evidence',input,s);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'INVALID_INPUT');
  }
  assert.equal(runPublicQuery('of_project_info',{projectId:'missing'},s).ok,false);
  const c=new AbortController();c.abort();const result=runPublicQuery('of_project_info',{projectId:'office-workflow-agent'},s,c.signal);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'ABORTED');
  assert.deepEqual((PUBLIC_INPUT_SCHEMAS.of_project_evidence as {required:string[]}).required,['projectId']);
});

test('public projection excludes extra fields and unreviewed evidence even in a polluted snapshot',()=>{
  const source=getProjectSnapshot();
  const contaminated={...source,projects:[{...source.projects[0],session:{token:'private-session-token'},workspace:'/private/records',evidenceLinks:[
    {title:'公开工作证明',href:'https://office-workflow-agent.baby2b.online/evidence/',internal:'private-proof-token'},
    {title:'control',href:'https://office-workflow-agent.baby2b.online/control/'},
    {title:'outside',href:'https://evil.example/evidence/'},
  ]}]};
  for(const name of ['of_project_info','of_project_evidence'] as const){
    const result=runPublicQuery(name,{projectId:'office-workflow-agent'},contaminated);
    assert.equal(result.ok,true);
    assert.ok(!JSON.stringify(result).includes('private-'));
    assert.ok(!JSON.stringify(result).includes('/private/'));
    assert.ok(!JSON.stringify(result).includes('/control/'));
    assert.ok(!JSON.stringify(result).includes('evil.example'));
  }
});

test('pagehide releases tools and pageshow restores usable queries without remounting business UI',async()=>{
  const api=await import('../src/agent-interface/webmcp-registry.js');
  assert.equal(typeof api.mountPageProjectTools,'function');
  const events=new EventTarget();const tools=new Map<string,ReadonlyTool>();
  const port:ModelContextPort={async register(tool,signal){
    if(tools.has(tool.name))throw Error('Duplicate');tools.set(tool.name,tool);
    signal.addEventListener('abort',()=>{if(tools.get(tool.name)===tool)tools.delete(tool.name);},{once:true});
  },async removeOwned(){}};
  const page=api.mountPageProjectTools(getProjectSnapshot,events,port);
  assert.equal((await page.ready).state,'registered');
  events.dispatchEvent(new Event('pagehide'));assert.equal(tools.size,0);
  events.dispatchEvent(new Event('pageshow'));
  await new Promise(resolve=>setImmediate(resolve));
  const info=tools.get('of_project_info');assert.ok(info);
  const result=await info.execute({projectId:'office-workflow-agent'},{signal:new AbortController().signal});
  assert.equal(result.ok,true);if(result.ok)assert.equal((result.data as {id:string}).id,'office-workflow-agent');
  events.dispatchEvent(new Event('pageshow'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tools.size,2);
  page.dispose();assert.equal(tools.size,0);
  events.dispatchEvent(new Event('pageshow'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tools.size,0);
});
