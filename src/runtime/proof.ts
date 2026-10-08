import {itemSchema,unitSchema,type Unit} from '../procurement-fields.js';
import {departments} from '../catalog.js';
import type { Demand, Plan, Run, RunStatus } from '../contracts.js';
import { canonicalPayload, hash } from './validation.js';

export interface ProofObservation {
  checkedAt:string;
  queryStatus:'found'|'not-found'|'unavailable';
  demand?:Demand;
}
export type AllowedNextAction='approve'|'execute'|'query-only'|'none';
interface PublicPayload {
  requestId:string|null;department:string|null;item:string|null;quantity:number|null;unit?:Unit|null;reason:string|null;
}
interface PublicPlan extends PublicPayload {source:string|null;}
interface PublicDemand extends PublicPayload {payloadHash:string|null;executionKey:string|null;createdAt:string|null;}
interface PublicBrowserEvidence {
  startedAt:string|null;completedAt:string|null;elapsedMs:number|null;origin:string|null;
  adapterVersion:string|null;planHash:string|null;
  domMatched:boolean|null;payloadMatched:boolean|null;postObserved:boolean|null;registeredMarker:boolean|null;
  stopCode:string|null;
}
interface FieldChecks {
  requestId:boolean|null;department:boolean|null;item:boolean|null;quantity:boolean|null;unit?:boolean|null;reason:boolean|null;
  payloadHash:boolean|null;canonicalHash:boolean|null;executionKey:boolean|null;planHash:boolean|null;
}
export interface ExecutionProof {
  schema:'office-agent-execution-proof-v1'|'office-agent-execution-proof-v2';syntheticOnly:true;generatedAt:string;
  run:{id:string|null;revision:number|null;targetRevision:number|null;adapterVersion:string|null;
    status:RunStatus;effectStatus:Run['effectStatus'];plan:PublicPlan;planHash:string|null;executionKey:string|null};
  approval:{status:'matched'|'missing'|'mismatch'|'expired';approvedHash:string|null;expiresAt:string|null;hashMatches:boolean;validAtObservation:boolean};
  browser:{status:'observed'|'not-observed'|'invalid';sameAttempt:boolean;evidence:PublicBrowserEvidence|null;
    statement:'no-browser-action-recorded-for-this-run'|'browser-observations-only-not-business-effect'};
  database:{effectStatus:Run['effectStatus'];hasPersistedResult:boolean;persistedResultMatchesPlan:boolean|null;result:PublicDemand|null};
  api:{checkedAt:string;queryStatus:ProofObservation['queryStatus'];status:'verified'|'mismatch'|'not-found'|'unknown';
    checks:FieldChecks;demand:PublicDemand|null;issues:string[]};
  allowedNextAction:AllowedNextAction;
  digest:{algorithm:'SHA-256';value:string};
}

const stopCodes=new Set(['DOM_DRIFT','FORM_PAYLOAD_DRIFT','BROWSER_TIMEOUT','BROWSER_INTERRUPTED','NETWORK_DENIED',
  'REDIRECT_DENIED','POPUP_DENIED','DOWNLOAD_DENIED','LEGACY_UNAVAILABLE','SUBMISSION_REJECTED','RESULT_DRIFT']);
const runStatuses=new Set<RunStatus>(['draft','approved','executing','unknown','verified','blocked','cancelled']);
const digestPattern=/^[a-f0-9]{64}$/;
function publicString(value:unknown,max:number):string|null {
  return typeof value==='string'&&value.length<=max?value:null;
}
function code(value:unknown):string|null {
  return typeof value==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(value)?value:null;
}
function digestValue(value:unknown):string|null {
  return typeof value==='string'&&digestPattern.test(value)?value:null;
}
function positiveInteger(value:unknown):number|null {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;
}
function nonnegativeInteger(value:unknown):number|null {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function timestamp(value:unknown):string|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function publicPayload(value:Plan|Demand):PublicPayload {
  return {requestId:code(value.requestId),department:publicString(value.department,20),item:publicString(value.item,64),
    quantity:positiveInteger(value.quantity),...(value.unit!==undefined?{unit:unitSchema.safeParse(value.unit).success?value.unit:null}:{}),reason:publicString(value.reason,200)};
}
function publicDemand(value:Demand):PublicDemand {
  return {...publicPayload(value),payloadHash:digestValue(value.payloadHash),executionKey:digestValue(value.executionKey),createdAt:timestamp(value.createdAt)};
}
function validPayload(value:PublicPayload):boolean {
  return value.requestId!==null&&/^REQ-[A-Z0-9][A-Z0-9-]{2,63}$/.test(value.requestId)
    &&departments.some(x=>x===value.department)&&itemSchema.safeParse(value.item).success&&(value.unit===undefined||unitSchema.safeParse(value.unit).success)
    &&value.quantity!==null&&value.quantity<=100&&value.reason!==null&&value.reason.trim().length>0;
}
async function payloadDigest(value:PublicPayload):Promise<string|null> {
  if(!validPayload(value))return null;
  // The existing canonicalizer intentionally ignores planner source and all extra fields.
  return hash(canonicalPayload(value as Plan));
}
function origin(value:unknown):string|null {
  if(typeof value!=='string')return null;
  try {
    const parsed=new URL(value);
    return ['http:','https:'].includes(parsed.protocol)&&parsed.origin!=='null'?parsed.origin:null;
  } catch {return null;}
}
function browserWitness(run:Run):ExecutionProof['browser'] {
  const raw=run.browserEvidence;
  if(!raw)return {status:'not-observed',sameAttempt:false,evidence:null,statement:'no-browser-action-recorded-for-this-run'};
  const bool=(value:unknown)=>typeof value==='boolean'?value:null;
  const evidence:PublicBrowserEvidence={startedAt:timestamp(raw.startedAt),completedAt:timestamp(raw.completedAt),
    elapsedMs:typeof raw.elapsedMs==='number'&&Number.isFinite(raw.elapsedMs)&&raw.elapsedMs>=0?raw.elapsedMs:null,
    origin:origin(raw.origin),adapterVersion:code(raw.adapterVersion),planHash:digestValue(raw.planHash),
    domMatched:bool(raw.domMatched),payloadMatched:bool(raw.payloadMatched),postObserved:bool(raw.postObserved),
    registeredMarker:bool(raw.registeredMarker),stopCode:raw.stopCode===undefined?null:stopCodes.has(raw.stopCode)?raw.stopCode:'UNKNOWN_STOP'};
  const sameAttempt=evidence.origin!==null&&evidence.startedAt!==null&&evidence.elapsedMs!==null
    &&evidence.adapterVersion!==null&&evidence.adapterVersion===run.adapterVersion
    &&evidence.planHash!==null&&evidence.planHash===run.planHash
    &&[evidence.domMatched,evidence.payloadMatched,evidence.postObserved,evidence.registeredMarker].every(value=>value!==null)
    &&(raw.completedAt===undefined||evidence.completedAt!==null);
  return {status:sameAttempt?'observed':'invalid',sameAttempt,evidence,statement:'browser-observations-only-not-business-effect'};
}
function emptyChecks():FieldChecks {
  return {requestId:null,department:null,item:null,quantity:null,reason:null,payloadHash:null,canonicalHash:null,executionKey:null,planHash:null};
}
function fieldChecks(plan:PublicPayload,planHash:string|null,executionKey:string|null,computedPlanHash:string|null,demand:PublicDemand,computedDemandHash:string|null):FieldChecks {
  return {...(plan.unit!==undefined||demand.unit!==undefined?{unit:plan.unit!==null&&demand.unit!==null&&(plan.unit??'件')===(demand.unit??'件')}:{ }),requestId:demand.requestId!==null&&demand.requestId===plan.requestId,
    department:demand.department!==null&&demand.department===plan.department,
    item:demand.item!==null&&demand.item===plan.item,quantity:demand.quantity!==null&&demand.quantity===plan.quantity,
    reason:demand.reason!==null&&demand.reason===plan.reason,
    payloadHash:planHash!==null&&demand.payloadHash===planHash,
    canonicalHash:computedDemandHash!==null&&computedDemandHash===demand.payloadHash&&computedDemandHash===planHash,
    executionKey:executionKey!==null&&demand.executionKey===executionKey,
    planHash:computedPlanHash!==null&&computedPlanHash===planHash};
}
function allMatch(checks:FieldChecks):boolean {return Object.values(checks).every(value=>value===true);}
function allowedAction(run:ExecutionProof['run'],approval:ExecutionProof['approval'],browser:ExecutionProof['browser'],api:ExecutionProof['api']):AllowedNextAction {
  // A report can never authorize repeating a possibly applied write, even after NOT_FOUND.
  if(run.effectStatus!=='none'||['executing','unknown','verified'].includes(run.status)
    ||browser.evidence?.postObserved===true||browser.evidence?.registeredMarker===true
    ||api.queryStatus==='unavailable'||api.status==='verified'||api.status==='mismatch'||api.status==='unknown')return 'query-only';
  if(run.status==='cancelled')return 'none';
  if(run.status==='approved'&&approval.validAtObservation)return 'execute';
  if(['draft','approved','blocked'].includes(run.status))return 'approve';
  return 'none';
}

/** Pure observation report. Browser receipts are observations; only the fresh API demand is checked here. */
export async function createExecutionProof(run:Run,observation:ProofObservation):Promise<ExecutionProof> {
  const generatedAt=timestamp(observation.checkedAt);
  if(generatedAt===null)throw new TypeError('checkedAt must be an ISO date-time');
  const plan={...publicPayload(run.plan),source:['bounded-rule','ollama','workers-ai'].includes(run.plan.source)?run.plan.source:null};
  const planHash=digestValue(run.planHash),executionKey=digestValue(run.executionKey);
  const persisted=run.result?publicDemand(run.result):null;
  const fresh=observation.queryStatus==='found'&&observation.demand?publicDemand(observation.demand):null;
  const [computedPlanHash,computedPersistedHash,computedFreshHash]=await Promise.all([
    payloadDigest(plan),persisted?payloadDigest(persisted):null,fresh?payloadDigest(fresh):null]);
  const publicRun:ExecutionProof['run']={id:code(run.id),revision:positiveInteger(run.revision),targetRevision:nonnegativeInteger(run.targetRevision),
    adapterVersion:code(run.adapterVersion),status:runStatuses.has(run.status)?run.status:'unknown',
    effectStatus:['none','unknown','applied'].includes(run.effectStatus)?run.effectStatus:'unknown',plan,planHash,executionKey};
  const approvedHash=digestValue(run.approvedHash),expiresAt=timestamp(run.approvalExpiresAt);
  const hashMatches=approvedHash!==null&&approvedHash===planHash&&computedPlanHash===planHash;
  const approval:ExecutionProof['approval']={status:approvedHash===null||expiresAt===null?'missing':!hashMatches?'mismatch':Date.parse(expiresAt)<=Date.parse(generatedAt)?'expired':'matched',
    approvedHash,expiresAt,hashMatches,validAtObservation:hashMatches&&expiresAt!==null&&Date.parse(expiresAt)>Date.parse(generatedAt)};
  const browser=browserWitness(run);
  const api:ExecutionProof['api']={checkedAt:generatedAt,queryStatus:observation.queryStatus,
    status:observation.queryStatus==='not-found'?'not-found':'unknown',checks:{...emptyChecks(),...(plan.unit!==undefined?{unit:null}:{})},demand:fresh,issues:[]};
  if(observation.queryStatus==='unavailable')api.issues=['QUERY_UNAVAILABLE'];
  if(observation.queryStatus==='found') {
    if(fresh===null)api.issues=['FRESH_DEMAND_MISSING'];
    else {
      api.checks=fieldChecks(plan,planHash,executionKey,computedPlanHash,fresh,computedFreshHash);
      api.status=allMatch(api.checks)?'verified':'mismatch';
      if(api.status==='mismatch')api.issues=['DEMAND_MISMATCH'];
    }
  }
  // Keep durable effect evidence independent from current query availability or consistency.
  const database:ExecutionProof['database']={effectStatus:publicRun.effectStatus,hasPersistedResult:persisted!==null,
    persistedResultMatchesPlan:persisted?allMatch(fieldChecks(plan,planHash,executionKey,computedPlanHash,persisted,computedPersistedHash)):null,result:persisted};
  const body={schema:run.plan.unit!==undefined?'office-agent-execution-proof-v2' as const:'office-agent-execution-proof-v1' as const,syntheticOnly:true as const,generatedAt,
    run:publicRun,approval,browser,database,api,allowedNextAction:allowedAction(publicRun,approval,browser,api)};
  return {...body,digest:{algorithm:'SHA-256',value:await hash(canonicalJSON(body))}};
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function canonicalJSON(value:unknown,ancestors=new Set<object>()):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=='object'||value===null||ancestors.has(value))throw new TypeError('Only finite JSON values are supported');
  ancestors.add(value);
  try {
    if(Array.isArray(value))return '['+value.map(item=>canonicalJSON(item,ancestors)).join(',')+']';
    if(!isRecord(value))throw new TypeError('Only JSON objects are supported');
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJSON(value[key],ancestors)).join(',')+'}';
  } finally {ancestors.delete(value);}
}

/** Checksum verification detects edits against the supplied digest; it is not a signature or authenticity check. */
export async function verifyExecutionProof(proof:unknown):Promise<boolean> {
  if(!isRecord(proof)||!['office-agent-execution-proof-v1','office-agent-execution-proof-v2'].includes(String(proof.schema))||proof.syntheticOnly!==true||!isRecord(proof.digest)
    ||proof.digest.algorithm!=='SHA-256'||digestValue(proof.digest.value)===null
    ||Object.keys(proof.digest).sort().join(',')!=='algorithm,value')return false;
  const expectedKeys=['allowedNextAction','api','approval','browser','database','digest','generatedAt','run','schema','syntheticOnly'];
  if(Object.keys(proof).sort().join(',')!==expectedKeys.join(','))return false;
  const {digest,...body}=proof;
  try {return await hash(canonicalJSON(body))===digest.value;}catch {return false;}
}
