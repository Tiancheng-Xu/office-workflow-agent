import type {Plan} from '../contracts.js';

export type MaterialMode='procurement'|'trade';
export type SourceRole='procurement'|'contract'|'order'|'product';
export type SourceKind='text'|'vtt'|'ocr';
export interface SourceOptions {label:string;role:SourceRole;id?:string;}
export interface SourceSpan {id:string;text:string;page?:number;bbox?:[number,number,number,number];startMs?:number;endMs?:number;}
export interface MaterialSource {
 id:string;label:string;role:SourceRole;kind:SourceKind;contentHash:string;
 originalHash?:string;originalVerified:boolean;engine?:string;fixture:boolean;spans:SourceSpan[];
}
export type MaterialField='department'|'requestId'|'item'|'quantity'|'unit'|'currency'|'unitPrice'|'total'|'deliveryDate';
export interface FieldCandidate {id:string;sourceId:string;field:MaterialField;raw:string;value:string;evidenceIds:string[];}
export interface ReviewDecision {candidateId:string;value:string;action:'confirm'|'dismiss';reason:string;}
export interface MaterialInput {mode:MaterialMode;sources:MaterialSource[];decisions:ReviewDecision[];}
export interface MaterialFinding {code:string;field?:MaterialField;sourceIds:string[];severity:'error'|'warning'|'info';message:string;evidenceIds:string[];}
export interface MaterialOutcome {status:'needs-review'|'reviewed-with-issues'|'consistent';candidates:FieldCandidate[];findings:MaterialFinding[];confirmed:number;pending:number;}
export interface MaterialCase {
 id:string;revision:number;input:MaterialInput;outcome:MaterialOutcome;createdAt:string;updatedAt:string;
 linkedRun?:{id:string;revision:number;planHash:string;caseRevision:number};
}
export interface ProcurementDraft {text:string;plan:Plan;}
export interface MaterialReport {
 schema:'office-material-report-v1';syntheticOnly:true;generatedAt:string;case:MaterialCase;
 link:{status:'not-linked'|'matched'|'stale'|'unavailable';runId?:string;runRevision?:number;planHash?:string;};
 statement:string;digest:{algorithm:'SHA-256';value:string;};
}
