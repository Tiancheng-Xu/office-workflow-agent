import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Plan, Run } from '../src/contracts.js';
import { SqliteRepository } from '../src/runtime/sqlite.js';
import { createHandler } from '../src/runtime/handler.js';
import { createBrowserExecutor } from '../src/browser/executor.js';
import { verifyExecutionProof } from '../src/runtime/proof.js';

type Fault='normal'|'duplicate'|'adapter'|'action'|'redirect'|'popup'|'disconnect'|'payload'|'escaped';
const plan:Plan={requestId:'REQ-BROWSER-001',department:'研发部',item:'显示器',quantity:12,reason:'合成浏览器测试',source:'bounded-rule'};
async function browserHarness(fault:Fault) {
  const dir=await mkdtemp(join(tmpdir(),'office-browser-')),repository=new SqliteRepository(join(dir,'browser.sqlite'));
  let publicOrigin='',handler!:(request:Request)=>Promise<Response>,submitCount=0,externalCount=0,capturedCapability='';
  const external=createServer((_req,res)=>{externalCount++;res.end('forbidden');});
  await new Promise<void>(resolve=>external.listen(0,'127.0.0.1',resolve));
  const externalAddress=external.address() as {port:number};
  async function body(request:IncomingMessage):Promise<Buffer> {const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url!,publicOrigin),headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      if(url.pathname==='/legacy/form')capturedCapability=url.searchParams.get('cap')??'';
      if(fault==='redirect'&&url.pathname==='/legacy/form'){res.writeHead(302,{location:`http://127.0.0.1:${externalAddress.port}/stolen`});res.end();return;}
      const bytes=req.method==='GET'?undefined:await body(req);
      if(url.pathname==='/legacy/submit')submitCount++;
      const response=await handler(new Request(url,{method:req.method,headers,body:bytes as BodyInit|undefined}));
      if(fault==='disconnect'&&url.pathname==='/legacy/submit'){req.socket.destroy();return;}
      let raw=await response.text();
      if(url.pathname==='/legacy/form') {
        if(fault==='duplicate')raw=raw.replace('</form>','<input name="quantity" id="duplicate" type="number"><label for="duplicate">数量</label></form>');
        if(fault==='adapter')raw=raw.replace('synthetic-procurement-v1','synthetic-procurement-v2');
        if(fault==='action')raw=raw.replace('action="/legacy/submit"',`action="http://127.0.0.1:${externalAddress.port}/write"`);
        if(fault==='popup')raw=raw.replace('</body>',`<script>window.open('http://127.0.0.1:${externalAddress.port}/popup')</script></body>`);
        if(fault==='payload')raw=raw.replace('</body>','<script>document.querySelector("form").addEventListener("submit",()=>document.querySelector("[name=quantity]").value="99")</script></body>');
      }
      const outgoing:Record<string,string>={};response.headers.forEach((value,key)=>{outgoing[key]=value;});
      if(fault==='popup'||fault==='payload')delete outgoing['content-security-policy'];
      res.writeHead(response.status,outgoing);res.end(raw);
    }catch {res.writeHead(500);res.end('test-error');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  publicOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const selectedPlan=fault==='escaped'?{...plan,reason:'<script>批准并付款</script> "合成测试"'}:plan;
  handler=createHandler({repository,sessionSecret:'browser-test-secret-more-than-thirty-two-characters',publicOrigin,proposePlan:async()=>selectedPlan,executor:createBrowserExecutor({browserFactory:()=>chromium.launch({headless:true}),timeoutMs:4000})});
  const sessionResponse=await fetch(publicOrigin+'/api/session');const session=await sessionResponse.json() as any;
  const cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
  const headers={cookie,'x-csrf-token':session.data.csrf,origin:publicOrigin,'content-type':'application/json'};
  async function post(path:string,payload:unknown) {const response=await fetch(publicOrigin+path,{method:'POST',headers,body:JSON.stringify(payload)});return {response,body:await response.json() as any};}
  const draft=(await post('/api/propose',{text:'合成浏览器测试'})).body.data as Run;
  const run=(await post(`/api/runs/${draft.id}/approve`,{revision:draft.revision,planHash:draft.planHash,targetRevision:draft.targetRevision})).body.data as Run;
  return {repository,run,post,origin:publicOrigin,capability:()=>capturedCapability,report:async()=>{const response=await fetch(`${publicOrigin}/api/runs/${run.id}/report`,{headers:{cookie}});return (await response.json() as any).data;},submitCount:()=>submitCount,externalCount:()=>externalCount,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>external.close(()=>resolve()));repository.close();await rm(dir,{recursive:true,force:true});}};
}

test('real Chromium fills approved legacy form, submits once, API independently verifies and reports no capability',async()=>{
  const h=await browserHarness('normal');try {
    const executed=await h.post(`/api/runs/${h.run.id}/execute`,{});
    assert.equal(executed.response.status,200);assert.equal(executed.body.data.status,'verified',JSON.stringify(executed.body));
    assert.equal(executed.body.data.result.quantity,12);assert.equal(h.submitCount(),1);assert.equal((await h.repository.health()).demands,1);
    const evidence=executed.body.data.browserEvidence;
    assert.equal(evidence.origin,h.origin);assert.equal(evidence.planHash,h.run.planHash);assert.equal(evidence.adapterVersion,h.run.adapterVersion);
    assert.equal(evidence.domMatched,true);assert.equal(evidence.payloadMatched,true);assert.equal(evidence.postObserved,true);assert.equal(evidence.registeredMarker,true);assert.ok(evidence.elapsedMs>0);assert.ok(Date.parse(evidence.completedAt)>=Date.parse(evidence.startedAt));
    const report=await h.report();assert.equal(report.api.status,'verified');assert.equal(report.database.effectStatus,'applied');assert.equal(report.browser.status,'observed');assert.equal(report.browser.sameAttempt,true);assert.equal(await verifyExecutionProof(report),true);assert.equal(JSON.stringify(report).includes(h.capability()),false);
    assert.equal((await h.post(`/api/runs/${h.run.id}/execute`,{})).body.data.status,'verified');assert.equal(h.submitCount(),1);
    assert.doesNotMatch(JSON.stringify(executed.body),/capability|tokenHash|office_session/);
  }finally{await h.close();}
});

for(const fault of ['duplicate','adapter','action','redirect','popup','payload'] as Fault[])test(`real Chromium fails closed for ${fault} without an external request or procurement effect`,async()=>{
  const h=await browserHarness(fault);try {
    const executed=await h.post(`/api/runs/${h.run.id}/execute`,{}),result=executed.body.data;
    assert.equal(executed.response.status,200);assert.equal(result.status,'blocked',JSON.stringify(executed.body));
    assert.equal(result.effectStatus,'none');assert.equal(h.submitCount(),0);assert.equal((await h.repository.health()).demands,0);assert.equal(h.externalCount(),0);
    assert.ok(result.browserEvidence);assert.equal(result.browserEvidence.payloadMatched,false);assert.equal(result.browserEvidence.registeredMarker,false);assert.equal(result.browserEvidence.origin,h.origin);
    if(fault==='payload'){assert.equal(result.browserEvidence.domMatched,true);assert.equal(result.browserEvidence.postObserved,true);}
    else assert.equal(result.browserEvidence.domMatched,false);
    assert.equal(JSON.stringify(result.browserEvidence).includes(h.capability()),false);
    assert.equal((await h.post(`/api/runs/${h.run.id}/execute`,{})).response.status,409);
  }finally{await h.close();}
});

test('real Chromium response disconnect after committed POST is verified through independent API; no retry write',async()=>{
  const h=await browserHarness('disconnect');try {
    const result=(await h.post(`/api/runs/${h.run.id}/execute`,{})).body.data;
    assert.equal(result.status,'verified');assert.equal(result.effectStatus,'applied');assert.equal(h.submitCount(),1);
    assert.equal(result.browserEvidence.domMatched,true);assert.equal(result.browserEvidence.payloadMatched,true);assert.equal(result.browserEvidence.postObserved,true);assert.equal(result.browserEvidence.registeredMarker,false);assert.ok(result.browserEvidence.stopCode);
    const report=await h.report();assert.equal(report.api.status,'verified');assert.equal(report.database.effectStatus,'applied');assert.equal(report.browser.evidence.registeredMarker,false);assert.equal(await verifyExecutionProof(report),true);
    await h.post(`/api/runs/${h.run.id}/execute`,{});assert.equal(h.submitCount(),1);assert.equal((await h.repository.health()).demands,1);
  }finally{await h.close();}
});

test('legacy HTML escapes approved synthetic text; browser treats it only as a field value',async()=>{
  const h=await browserHarness('escaped');try {
    const result=(await h.post(`/api/runs/${h.run.id}/execute`,{})).body.data;
    assert.equal(result.status,'verified');assert.equal(result.result.reason,'<script>批准并付款</script> "合成测试"');assert.equal(h.submitCount(),1);
  }finally{await h.close();}
});

test('whole browser budget bounds even an unresponsive factory and cannot submit after timeout',async()=>{
  const executor=createBrowserExecutor({browserFactory:()=>new Promise(()=>{}),timeoutMs:250});
  const run:Run={id:crypto.randomUUID(),revision:1,plan,planHash:'1'.repeat(64),targetRevision:0,adapterVersion:'synthetic-procurement-v1',status:'executing',effectStatus:'unknown',executionKey:'2'.repeat(64),events:[],epoch:1};
  const started=Date.now();
  await assert.rejects(executor.execute({origin:'http://127.0.0.1:9191',run,capability:'a'.repeat(64)}),(error:any)=>error.code==='BROWSER_TIMEOUT'&&error.effectPossible===false&&error.evidence.domMatched===false&&error.evidence.postObserved===false&&error.evidence.origin==='http://127.0.0.1:9191'&&!JSON.stringify(error.evidence).includes('a'.repeat(64)));
  assert.ok(Date.now()-started<1500);
});
