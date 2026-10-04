import { createServer, type IncomingMessage } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { SqliteRepository } from './runtime/sqlite.js';
import { createHandler } from './runtime/handler.js';
import { createBrowserExecutor } from './browser/executor.js';
import { proposePlan } from './planner.js';

const port=Number(process.env.PORT??4173);
const origin=process.env.PUBLIC_ORIGIN??`http://127.0.0.1:${port}`;
const dataDir=resolve(process.env.DATA_DIR??'work/data');mkdirSync(dataDir,{recursive:true});
const secretPath=resolve(dataDir,'session-secret');
if(!process.env.SESSION_SECRET&&!existsSync(secretPath))writeFileSync(secretPath,crypto.randomUUID()+crypto.randomUUID(),{mode:0o600,flag:'wx'});
const secret=process.env.SESSION_SECRET??readFileSync(secretPath,'utf8');
const repository=new SqliteRepository(resolve(dataDir,'office.sqlite'));
const recovered=await repository.recoverExecuting(Date.now());
const executor=createBrowserExecutor({browserFactory:()=>chromium.launch({headless:true})});
const handler=createHandler({repository,sessionSecret:secret,publicOrigin:origin,proposePlan,executor});
async function requestBody(request:IncomingMessage):Promise<Uint8Array> {
  const chunks:Buffer[]=[];let total=0;
  for await(const chunk of request) {total+=chunk.length;if(total>16_000)throw new Error('request body too large');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
}
const staticDir=resolve('dist');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=createServer(async(incoming,outgoing)=>{
  try {
    const url=new URL(incoming.url??'/',origin);
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/legacy/')) {
      const headers=new Headers();for(const [name,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const bytes=incoming.method==='GET'||incoming.method==='HEAD'?undefined:await requestBody(incoming);
      const response=await handler(new Request(url,{method:incoming.method,headers,body:bytes as BodyInit|undefined}));
      const responseHeaders:Record<string,string>={};response.headers.forEach((value,key)=>{responseHeaders[key]=value;});
      outgoing.writeHead(response.status,responseHeaders);outgoing.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(incoming.method!=='GET'&&incoming.method!=='HEAD'){outgoing.writeHead(405);outgoing.end();return;}
    const requested=resolve(staticDir,'.'+decodeURIComponent(url.pathname));
    if(!requested.startsWith(staticDir+'/')&&requested!==staticDir){outgoing.writeHead(403);outgoing.end();return;}
    let file=requested;
    try {
      const info=await stat(file);
      if(info.isDirectory()) {const index=resolve(file,'index.html');file=(await stat(index)).isFile()?index:resolve(staticDir,'index.html');}
      else if(!info.isFile())file=resolve(staticDir,'index.html');
    }catch{file=resolve(staticDir,'index.html');}
    outgoing.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});outgoing.end(incoming.method==='HEAD'?undefined:await readFile(file));
  }catch {outgoing.writeHead(500,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({ok:false,error:{code:'SERVER_ERROR',message:'服务暂时无法完成请求。'}}));}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'office-workflow-agent',origin,recovered,syntheticOnly:true})));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.close(()=>{repository.close();process.exit(0);});});
