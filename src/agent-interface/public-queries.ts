import { z } from 'zod';
export type PublicToolName='of_project_info'|'of_project_evidence';
export type PublicSnapshot={version:string,projects:readonly {id:string,title:string,summary:string,skills:readonly string[],evidenceLinks:readonly {title:string,href:string}[],unavailableFields:readonly string[]}[]};
type Provenance={snapshotVersion:string,scope:'public-summary'};
export type AgentResult={ok:true,data:unknown,provenance:Provenance,nextCursor?:string}|{ok:false,error:{code:'INVALID_INPUT'|'NOT_FOUND'|'STALE_CURSOR'|'ABORTED'|'RESULT_TOO_LARGE'|'DATA_UNAVAILABLE'},provenance:Provenance};
export const PUBLIC_TOOL_NAMES:PublicToolName[]=['of_project_info','of_project_evidence'];
const projectId=z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const info=z.object({projectId}).strict();
const evidence=z.object({projectId,limit:z.number().int().min(1).max(5).default(3),cursor:z.string().max(128).optional()}).strict();
const jsonId={type:'string',minLength:1,maxLength:80,pattern:'^[a-z0-9]+(?:-[a-z0-9]+)*$'};
export const PUBLIC_INPUT_SCHEMAS:Record<PublicToolName,object>={
  of_project_info:{type:'object',additionalProperties:false,properties:{projectId:jsonId},required:['projectId']},
  of_project_evidence:{type:'object',additionalProperties:false,properties:{projectId:jsonId,limit:{type:'integer',minimum:1,maximum:5,default:3},cursor:{type:'string',maxLength:128}},required:['projectId']},
};
export function getProjectSnapshot():PublicSnapshot{return {version:'office-public-v1',projects:[{
  id:'office-workflow-agent',title:'OfficeFlow 办公流程 Agent',summary:'将业务需求转为可信字段，经人工版本批准执行后独立核对结果；本接口仅提供公开说明与证明入口。',
  skills:['Structured Input','Human Approval','Idempotency','Recovery'],evidenceLinks:[{title:'公开工作证明',href:'https://office-workflow-agent.baby2b.online/evidence/'}],unavailableFields:[],
}]};}
export function runPublicQuery(name:PublicToolName,input:unknown,snapshot:PublicSnapshot,signal?:AbortSignal):AgentResult{
  const provenance:Provenance={snapshotVersion:snapshot.version,scope:'public-summary'};
  const error=(code:Extract<AgentResult,{ok:false}>['error']['code']):AgentResult=>({ok:false,error:{code},provenance});
  if(signal?.aborted)return error('ABORTED');
  const parsed=(name==='of_project_info'?info:name==='of_project_evidence'?evidence:null)?.safeParse(input);
  if(!parsed?.success)return error('INVALID_INPUT');
  const project=snapshot.projects.find(p=>p.id===parsed.data.projectId);if(!project)return error('NOT_FOUND');
  if('cursor' in parsed.data&&parsed.data.cursor!==undefined)return error('STALE_CURSOR');
  const evidenceLinks=project.evidenceLinks
    .filter(link=>link.href==='https://office-workflow-agent.baby2b.online/evidence/')
    .map(link=>({title:link.title,href:link.href}));
  const publicProject={id:project.id,title:project.title,summary:project.summary,skills:[...project.skills],evidenceLinks,unavailableFields:[...project.unavailableFields]};
  const data=name==='of_project_info'?publicProject:evidenceLinks.slice(0,'limit' in parsed.data&&typeof parsed.data.limit==='number'?parsed.data.limit:3);
  const result:AgentResult={ok:true,data,provenance};return new TextEncoder().encode(JSON.stringify(result)).length<=6144?result:error('RESULT_TOO_LARGE');
}
