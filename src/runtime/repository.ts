import type { Demand, Plan, Run } from '../contracts.js';

export const ADAPTER_VERSION = 'synthetic-procurement-v1';
export interface SessionRecord { id:string; tenantId:string; csrf:string; expiresAt:number; }
export interface CapabilityRecord { tokenHash:string; tenantId:string; runId:string; revision:number; planHash:string; targetRevision:number; adapterVersion:string; expiresAt:number; }
export interface Submission { tokenHash:string; runId:string; revision:number; planHash:string; targetRevision:number; adapterVersion:string; plan:Plan; now:number; }
export interface Repository {
  createSession(session:SessionRecord):Promise<void>;
  getSession(id:string):Promise<SessionRecord|undefined>;
  createRun(tenantId:string,run:Run):Promise<void>;
  getRun(tenantId:string,id:string):Promise<Run|undefined>;
  listRuns(tenantId:string):Promise<Run[]>;
  saveRunCAS(tenantId:string,run:Run,expectedEpoch:number):Promise<boolean>;
  getTargetRevision(tenantId:string):Promise<number>;
  getDemand(tenantId:string,requestId:string):Promise<Demand|undefined>;
  issueCapability(capability:CapabilityRecord):Promise<void>;
  getCapability(tokenHash:string):Promise<CapabilityRecord|undefined>;
  /** Must validate capability, run approval, expected target and payload inside the same atomic write. */
  submitDemand(submission:Submission):Promise<Demand>;
  /** A crash cannot reissue a possibly applied effect. Called once at startup, before accepting traffic. */
  recoverExecuting(now:number):Promise<number>;
  health():Promise<{runs:number;demands:number;unknown:number}>;
  backup?(path:string):Promise<void>;
  close?():void;
}
export class DomainError extends Error {
  constructor(public readonly code:string,message:string,public readonly status=409) { super(message); }
}
