import type { D1Database } from '@cloudflare/workers-types';
import type { Run,Demand } from '../contracts.js';
import {ADAPTER_VERSION,DomainError,type Repository,type SessionRecord,type CapabilityRecord,type Submission} from '../runtime/repository.js';
import {assertApproval,canonicalPayload,event,hash,validatePlan} from '../runtime/validation.js';
type Row=Record<string,unknown>;
export class D1Repository implements Repository {
  constructor(readonly db:D1Database){}
  async createSession(s:SessionRecord){await this.db.batch([this.db.prepare('INSERT INTO sessions(id,tenant_id,csrf,expires_at) VALUES(?,?,?,?)').bind(s.id,s.tenantId,s.csrf,s.expiresAt),this.db.prepare('INSERT INTO targets(tenant_id,revision) VALUES(?,0)').bind(s.tenantId)]);}
  async getSession(id:string){const r=await this.db.prepare('SELECT * FROM sessions WHERE id=?').bind(id).first<Row>();return r?{id:String(r.id),tenantId:String(r.tenant_id),csrf:String(r.csrf),expiresAt:Number(r.expires_at)}:undefined;}
  async createRun(t:string,r:Run){await this.db.prepare('INSERT INTO runs(id,tenant_id,epoch,status,body) VALUES(?,?,?,?,?)').bind(r.id,t,r.epoch,r.status,JSON.stringify(r)).run();}
  async getRun(t:string,id:string){const r=await this.db.prepare('SELECT body FROM runs WHERE tenant_id=? AND id=?').bind(t,id).first<Row>();return r?JSON.parse(String(r.body)) as Run:undefined;}
  async listRuns(t:string){const r=await this.db.prepare('SELECT body FROM runs WHERE tenant_id=? ORDER BY rowid DESC LIMIT 100').bind(t).all<Row>();return r.results.map(x=>JSON.parse(String(x.body)) as Run);}
  async saveRunCAS(t:string,r:Run,e:number){if(r.epoch!==e+1)throw new DomainError('INVALID_EPOCH','状态更新版本无效。',500);return (await this.db.prepare('UPDATE runs SET epoch=?,status=?,body=? WHERE tenant_id=? AND id=? AND epoch=?').bind(r.epoch,r.status,JSON.stringify(r),t,r.id,e).run()).meta.changes===1;}
  async getTargetRevision(t:string){const r=await this.db.prepare('SELECT revision FROM targets WHERE tenant_id=?').bind(t).first<Row>();if(!r)throw new DomainError('TENANT_NOT_FOUND','体验会话已失效。',401);return Number(r.revision);}
  async getDemand(t:string,id:string){const r=await this.db.prepare('SELECT body FROM demands WHERE tenant_id=? AND request_id=?').bind(t,id).first<Row>();return r?JSON.parse(String(r.body)) as Demand:undefined;}
  async issueCapability(c:CapabilityRecord){await this.db.prepare('INSERT INTO capabilities(token_hash,tenant_id,run_id,revision,plan_hash,target_revision,adapter_version,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(c.tokenHash,c.tenantId,c.runId,c.revision,c.planHash,c.targetRevision,c.adapterVersion,c.expiresAt).run();}
  async getCapability(tokenHash:string){const r=await this.db.prepare('SELECT * FROM capabilities WHERE token_hash=?').bind(tokenHash).first<Row>();return r?{tokenHash:String(r.token_hash),tenantId:String(r.tenant_id),runId:String(r.run_id),revision:Number(r.revision),planHash:String(r.plan_hash),targetRevision:Number(r.target_revision),adapterVersion:String(r.adapter_version),expiresAt:Number(r.expires_at)}:undefined;}
  async submitDemand(input:Submission):Promise<Demand>{
    validatePlan(input.plan);const payloadHash=await hash(canonicalPayload(input.plan));const cap=await this.getCapability(input.tokenHash);
    if(!cap||cap.runId!==input.runId||cap.expiresAt<=input.now)throw new DomainError('CAPABILITY_INVALID','执行授权无效。',403);
    const run=await this.getRun(cap.tenantId,cap.runId);if(!run)throw new DomainError('RUN_NOT_FOUND','运行不存在。',404);
    if(input.revision!==run.revision||input.planHash!==run.planHash||input.targetRevision!==run.targetRevision||input.adapterVersion!==run.adapterVersion||cap.revision!==run.revision||cap.planHash!==run.planHash||cap.targetRevision!==run.targetRevision||cap.adapterVersion!==run.adapterVersion)throw new DomainError('STALE_APPROVAL','批准版本已失效。');
    assertApproval(run,input.now,ADAPTER_VERSION);
    if(payloadHash!==run.planHash||canonicalPayload(input.plan)!==canonicalPayload(run.plan))throw new DomainError('PAYLOAD_CONFLICT','表单参数与已批准计划不一致。');
    const prior=await this.getDemand(cap.tenantId,run.plan.requestId);if(prior){if(prior.payloadHash!==run.planHash)throw new DomainError('PAYLOAD_CONFLICT','需求编号被不同参数使用。');return prior;}
    if(run.status!=='executing')throw new DomainError('EXECUTION_NOT_CLAIMED','执行未认领或已取消。');
    const demand:Demand={requestId:run.plan.requestId,department:run.plan.department,item:run.plan.item,quantity:run.plan.quantity,...(run.plan.unit?{unit:run.plan.unit}:{}),reason:run.plan.reason,payloadHash:run.planHash,createdAt:new Date(input.now).toISOString(),executionKey:run.executionKey};
    const applied=event({...run,effectStatus:'applied',result:demand},input.now,'effect-applied','旧后台已登记合成采购需求；等待独立查询核对。');
    // D1 batch is an atomic transaction. Recheck live run/capability/target at INSERT, so cancellation or another run cannot race this read snapshot.
    // changes() couples target increment and effect update only to THIS successful insert; no repeated target increment on deduplication.
    const results=await this.db.batch([
      this.db.prepare(`INSERT INTO demands(tenant_id,request_id,payload_hash,execution_key,body)
        SELECT ?,?,?,?,? FROM runs r JOIN capabilities c ON c.run_id=r.id AND c.tenant_id=r.tenant_id JOIN targets t ON t.tenant_id=r.tenant_id
        WHERE r.id=? AND r.tenant_id=? AND r.epoch=? AND r.status='executing'
        AND c.token_hash=? AND c.expires_at>max(?,(julianday('now')-2440587.5)*86400000) AND c.revision=? AND c.plan_hash=? AND c.target_revision=? AND c.adapter_version=?
        AND t.revision=? AND json_extract(r.body,'$.approvedHash')=? AND json_extract(r.body,'$.approvalExpiresAt')=?
        AND julianday(json_extract(r.body,'$.approvalExpiresAt'))>julianday('now')
        ON CONFLICT(tenant_id,request_id) DO NOTHING`).bind(cap.tenantId,run.plan.requestId,run.planHash,run.executionKey,JSON.stringify(demand),run.id,cap.tenantId,run.epoch,input.tokenHash,input.now,run.revision,run.planHash,run.targetRevision,run.adapterVersion,run.targetRevision,run.planHash,run.approvalExpiresAt!),
      this.db.prepare('UPDATE targets SET revision=revision+1 WHERE tenant_id=? AND revision=? AND changes()=1').bind(cap.tenantId,run.targetRevision),
      this.db.prepare('UPDATE runs SET epoch=?,status=?,body=? WHERE tenant_id=? AND id=? AND epoch=? AND changes()=1').bind(applied.epoch,applied.status,JSON.stringify(applied),cap.tenantId,run.id,run.epoch)
    ]);
    const stored=await this.getDemand(cap.tenantId,run.plan.requestId);if(stored){if(stored.payloadHash!==run.planHash)throw new DomainError('PAYLOAD_CONFLICT','需求编号被不同参数使用。');return stored;}
    if(results[0]?.meta.changes===0)throw new DomainError('TARGET_DRIFT','运行或后台版本已改变；未登记。');throw new DomainError('SUBMISSION_FAILED','登记没有得到确认。',500);
  }
  async recoverExecuting(now:number){const rows=await this.db.prepare("SELECT tenant_id,body FROM runs WHERE status='executing'").all<Row>();let n=0;for(const row of rows.results){const r=JSON.parse(String(row.body)) as Run;const next=event({...r,status:'unknown',effectStatus:r.effectStatus==='applied'?'applied':'unknown'},now,'crash-recovery','服务恢复：仅核对原需求编号，不重新提交。');if(await this.saveRunCAS(String(row.tenant_id),next,r.epoch))n++;}return n;}
  async health(){const r=await this.db.batch([this.db.prepare('SELECT COUNT(*) AS n FROM runs'),this.db.prepare('SELECT COUNT(*) AS n FROM demands'),this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('unknown','executing')")]);return {runs:Number((r[0]!.results[0] as Row).n),demands:Number((r[1]!.results[0] as Row).n),unknown:Number((r[2]!.results[0] as Row).n)};}
}
