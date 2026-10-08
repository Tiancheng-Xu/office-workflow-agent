import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync, copyFileSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import type { Demand, Run } from '../contracts.js';
import { ADAPTER_VERSION, DomainError, type CapabilityRecord, type Repository, type SessionRecord, type Submission } from './repository.js';
import { assertApproval, canonicalPayload, event, hash, validatePlan } from './validation.js';

type Row=Record<string,unknown>;
export class SqliteRepository implements Repository {
  readonly db:DatabaseSync;
  constructor(readonly path=':memory:') {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const migrations=new URL('../../migrations/',import.meta.url);
    for(const file of readdirSync(migrations).filter(name=>/^\d+_.+\.sql$/.test(name)).sort())
      this.transaction(()=>this.db.exec(readFileSync(new URL(file,migrations),'utf8')));
  }
  async createSession(s:SessionRecord):Promise<void> {
    this.transaction(()=>{
      this.db.prepare('INSERT INTO sessions(id,tenant_id,csrf,expires_at) VALUES(?,?,?,?)').run(s.id,s.tenantId,s.csrf,s.expiresAt);
      this.db.prepare('INSERT OR IGNORE INTO targets(tenant_id,revision) VALUES(?,0)').run(s.tenantId);
    });
  }
  async getSession(id:string):Promise<SessionRecord|undefined> {
    const row=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row|undefined;
    return row?{id:String(row.id),tenantId:String(row.tenant_id),csrf:String(row.csrf),expiresAt:Number(row.expires_at)}:undefined;
  }
  async createRun(tenantId:string,run:Run):Promise<void> {
    this.db.prepare('INSERT INTO runs(id,tenant_id,epoch,status,body) VALUES(?,?,?,?,?)').run(run.id,tenantId,run.epoch,run.status,JSON.stringify(run));
  }
  async getRun(tenantId:string,id:string):Promise<Run|undefined> {
    const row=this.db.prepare('SELECT body FROM runs WHERE tenant_id=? AND id=?').get(tenantId,id) as Row|undefined;
    return row?JSON.parse(String(row.body)) as Run:undefined;
  }
  async listRuns(tenantId:string):Promise<Run[]> {
    return this.db.prepare('SELECT body FROM runs WHERE tenant_id=? ORDER BY rowid DESC LIMIT 100').all(tenantId).map(r=>JSON.parse(String(r.body)) as Run);
  }
  async saveRunCAS(tenantId:string,run:Run,expectedEpoch:number):Promise<boolean> {
    if(run.epoch!==expectedEpoch+1)throw new DomainError('INVALID_EPOCH','状态更新版本无效。',500);
    const result=this.db.prepare('UPDATE runs SET epoch=?,status=?,body=? WHERE tenant_id=? AND id=? AND epoch=?').run(run.epoch,run.status,JSON.stringify(run),tenantId,run.id,expectedEpoch);
    return Number(result.changes)===1;
  }
  async getTargetRevision(tenantId:string):Promise<number> {
    const row=this.db.prepare('SELECT revision FROM targets WHERE tenant_id=?').get(tenantId) as Row|undefined;
    if(!row)throw new DomainError('TENANT_NOT_FOUND','体验会话失效。',401);
    return Number(row.revision);
  }
  async getDemand(tenantId:string,requestId:string):Promise<Demand|undefined> {
    const row=this.db.prepare('SELECT body FROM demands WHERE tenant_id=? AND request_id=?').get(tenantId,requestId) as Row|undefined;
    return row?JSON.parse(String(row.body)) as Demand:undefined;
  }
  async issueCapability(c:CapabilityRecord):Promise<void> {
    this.db.prepare('INSERT INTO capabilities(token_hash,tenant_id,run_id,revision,plan_hash,target_revision,adapter_version,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(c.tokenHash,c.tenantId,c.runId,c.revision,c.planHash,c.targetRevision,c.adapterVersion,c.expiresAt);
  }
  async getCapability(tokenHash:string):Promise<CapabilityRecord|undefined> {
    const r=this.db.prepare('SELECT * FROM capabilities WHERE token_hash=?').get(tokenHash) as Row|undefined;
    return r?{tokenHash:String(r.token_hash),tenantId:String(r.tenant_id),runId:String(r.run_id),revision:Number(r.revision),planHash:String(r.plan_hash),targetRevision:Number(r.target_revision),adapterVersion:String(r.adapter_version),expiresAt:Number(r.expires_at)}:undefined;
  }
  async submitDemand(input:Submission):Promise<Demand> {
    validatePlan(input.plan);
    const payloadHash=await hash(canonicalPayload(input.plan));
    return this.transaction(()=>{
      // Recheck expiry at the effect boundary, after any asynchronous payload digest work.
      const boundaryNow=Math.max(input.now,Date.now());
      const rawCap=this.db.prepare('SELECT * FROM capabilities WHERE token_hash=?').get(input.tokenHash) as Row|undefined;
      if(!rawCap||rawCap.run_id!==input.runId||Number(rawCap.expires_at)<=boundaryNow)throw new DomainError('CAPABILITY_INVALID','浏览器执行授权无效。',403);
      const tenantId=String(rawCap.tenant_id);
      const rawRun=this.db.prepare('SELECT body FROM runs WHERE tenant_id=? AND id=?').get(tenantId,input.runId) as Row|undefined;
      if(!rawRun)throw new DomainError('RUN_NOT_FOUND','运行不存在。',404);
      const run=JSON.parse(String(rawRun.body)) as Run;
      if(input.revision!==run.revision||input.planHash!==run.planHash||input.targetRevision!==run.targetRevision||input.adapterVersion!==run.adapterVersion||Number(rawCap.revision)!==run.revision||rawCap.plan_hash!==run.planHash||Number(rawCap.target_revision)!==run.targetRevision||rawCap.adapter_version!==run.adapterVersion)
        throw new DomainError('STALE_APPROVAL','页面与已批准计划的版本不一致。');
      assertApproval(run,boundaryNow,ADAPTER_VERSION);
      if(payloadHash!==run.planHash||canonicalPayload(input.plan)!==canonicalPayload(run.plan))throw new DomainError('PAYLOAD_CONFLICT','表单参数与已批准计划不一致。');
      const rawExisting=this.db.prepare('SELECT body FROM demands WHERE tenant_id=? AND request_id=?').get(tenantId,run.plan.requestId) as Row|undefined;
      if(rawExisting) {
        const existing=JSON.parse(String(rawExisting.body)) as Demand;
        if(existing.payloadHash!==run.planHash)throw new DomainError('PAYLOAD_CONFLICT','需求编号已被不同参数使用。');
        // No write is repeated, even if the user cancelled after the first effect.
        return existing;
      }
      if(run.status!=='executing')throw new DomainError('EXECUTION_NOT_CLAIMED','执行未认领或已取消。');
      const rawTarget=this.db.prepare('SELECT revision FROM targets WHERE tenant_id=?').get(tenantId) as Row|undefined;
      if(!rawTarget||Number(rawTarget.revision)!==run.targetRevision)throw new DomainError('TARGET_DRIFT','后台数据版本已改变，请重新提案。');
      const demand:Demand={requestId:run.plan.requestId,department:run.plan.department,item:run.plan.item,quantity:run.plan.quantity,...(run.plan.unit?{unit:run.plan.unit}:{}),reason:run.plan.reason,payloadHash:run.planHash,createdAt:new Date(boundaryNow).toISOString(),executionKey:run.executionKey};
      this.db.prepare('INSERT INTO demands(tenant_id,request_id,payload_hash,execution_key,body) VALUES(?,?,?,?,?)').run(tenantId,run.plan.requestId,run.planHash,run.executionKey,JSON.stringify(demand));
      this.db.prepare('UPDATE targets SET revision=revision+1 WHERE tenant_id=? AND revision=?').run(tenantId,run.targetRevision);
      const applied=event({...run,effectStatus:'applied',result:demand},boundaryNow,'effect-applied','旧后台已登记合成采购需求；等待独立查询核对。');
      this.db.prepare('UPDATE runs SET epoch=?,status=?,body=? WHERE tenant_id=? AND id=? AND epoch=?').run(applied.epoch,applied.status,JSON.stringify(applied),tenantId,run.id,run.epoch);
      return demand;
    });
  }
  async recoverExecuting(now:number):Promise<number> {
    return this.transaction(()=>{
      const rows=this.db.prepare("SELECT tenant_id,body FROM runs WHERE status='executing'").all();
      for(const row of rows) {
        const run=JSON.parse(String(row.body)) as Run;
        const recovered=event({...run,status:'unknown',effectStatus:run.effectStatus==='applied'?'applied':'unknown'},now,'crash-recovery','服务恢复：仅核对原需求编号，禁止重新提交。');
        this.db.prepare('UPDATE runs SET epoch=?,status=?,body=? WHERE tenant_id=? AND id=? AND epoch=?').run(recovered.epoch,recovered.status,JSON.stringify(recovered),String(row.tenant_id),run.id,run.epoch);
      }
      return rows.length;
    });
  }
  async health():Promise<{runs:number;demands:number;unknown:number}> {
    const count=(sql:string)=>Number(this.db.prepare(sql).get()!.count);
    return {runs:count('SELECT COUNT(*) AS count FROM runs'),demands:count('SELECT COUNT(*) AS count FROM demands'),unknown:count("SELECT COUNT(*) AS count FROM runs WHERE status IN ('unknown','executing')")};
  }
  async backup(path:string):Promise<void> { mkdirSync(dirname(path),{recursive:true}); await sqliteBackup(this.db,path); }
  static restore(backupPath:string,targetPath:string):SqliteRepository {
    // The restore target must not already be open. A SQLite backup copy preserves schema and transactions.
    const source=new DatabaseSync(backupPath,{readOnly:true});
    try {
      const integrity=source.prepare('PRAGMA integrity_check').get();
      if(integrity?.integrity_check!=='ok')throw new DomainError('BACKUP_INVALID','备份校验失败。',500);
    } finally { source.close(); }
    mkdirSync(dirname(targetPath),{recursive:true});
    // Exclusive copy refuses to overwrite any existing database and preserves future tables too.
    copyFileSync(backupPath,targetPath,constants.COPYFILE_EXCL);
    return new SqliteRepository(targetPath);
  }
  close():void { this.db.close(); }
  private transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value=fn();this.db.exec('COMMIT');return value; }
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
}
