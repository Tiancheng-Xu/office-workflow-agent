import type {Unit} from "./procurement-fields.js";
import {departments} from "./catalog.js";
export type Department = typeof departments[number];
export type Item = string;
export interface Plan { requestId:string; department:Department; item:Item; quantity:number; unit?:Unit; reason:string; source:"bounded-rule"|"ollama"|"workers-ai"; }
export type RunStatus = "draft"|"approved"|"executing"|"unknown"|"verified"|"blocked"|"cancelled";
export interface RunEvent { at:string; type:string; message:string; }
export interface Demand { requestId:string; department:Department; item:Item; quantity:number; unit?:Unit; reason:string; payloadHash:string; createdAt:string; executionKey:string; }
export interface BrowserEvidence {startedAt:string;completedAt?:string;elapsedMs:number;origin:string;adapterVersion:string;planHash:string;domMatched:boolean;payloadMatched:boolean;postObserved:boolean;registeredMarker:boolean;stopCode?:string;}
export interface Run { id:string; revision:number; plan:Plan; planHash:string; targetRevision:number; adapterVersion:string; status:RunStatus; effectStatus:"none"|"unknown"|"applied"; approvedHash?:string; approvalExpiresAt?:string; executionKey:string; events:RunEvent[]; result?:Demand; error?:string; epoch:number; previousPlan?:Plan;previousRevision?:number;browserEvidence?:BrowserEvidence; }
export interface SessionView { csrf:string; tenantLabel:string; adapterVersion:string; planner:string; }
export type ApiReply<T> = {ok:true;data:T}|{ok:false;error:{code:string;message:string}};
/* API: GET /api/session -> SessionView; GET /api/runs -> Run[]; POST /api/propose {text} -> Run;
POST /api/runs/:id/approve {revision,planHash,targetRevision} -> Run;
POST /api/runs/:id/revise {revision,planHash,text} -> Run; same requestId, safe inactive state, clears prior approval.
POST /api/runs/:id/execute|reconcile|cancel {} -> Run; GET /api/runs/:id/report -> sanitized JSON.
Mutations use X-CSRF-Token. Session cookie defines tenant; request bodies never select tenant.
Legacy: GET /legacy/form?run=...&cap=...; POST /legacy/submit; GET /legacy/result?run=...&cap=...
Legacy DOM required fixed data-adapter/data-run/data-target-revision, labels, unique named fields.
No amount/refund fields; only synthetic procurement request records. */
