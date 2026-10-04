import { DomainError, type Repository, type SessionRecord } from './repository.js';
import { randomToken } from './validation.js';
const COOKIE='office_session';
export class SessionManager {
  private key:Promise<CryptoKey>;
  constructor(private repository:Repository,secret:string,private secure:boolean,private now:()=>number) {
    if(secret.length<32)throw new Error('sessionSecret must contain at least 32 characters');
    this.key=crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  }
  async read(request:Request):Promise<SessionRecord|undefined> {
    const cookie=request.headers.get('cookie')??'';
    const entries=cookie.split(';').map(c=>c.trim()).filter(c=>c.startsWith(COOKIE+'='));
    if(entries.length!==1)return undefined;
    const value=entries[0]!.slice(COOKIE.length+1),parts=value.split('.');
    if(parts.length!==2||!/^[a-f0-9]{64}$/.test(parts[0]!)||!/^[a-f0-9]{64}$/.test(parts[1]!))return undefined;
    const bytes=new Uint8Array(parts[1]!.match(/../g)!.map(v=>parseInt(v,16)));
    if(!await crypto.subtle.verify('HMAC',await this.key,bytes,new TextEncoder().encode(parts[0]!)))return undefined;
    const session=await this.repository.getSession(parts[0]!);
    return session&&session.expiresAt>this.now()?session:undefined;
  }
  async create():Promise<{session:SessionRecord;cookie:string}> {
    const session:SessionRecord={id:randomToken(),tenantId:randomToken(),csrf:randomToken(),expiresAt:this.now()+24*60*60*1000};
    await this.repository.createSession(session);
    const sig=await crypto.subtle.sign('HMAC',await this.key,new TextEncoder().encode(session.id));
    const hex=Array.from(new Uint8Array(sig),b=>b.toString(16).padStart(2,'0')).join('');
    return {session,cookie:`${COOKIE}=${session.id}.${hex}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${this.secure?'; Secure':''}`};
  }
  mutation(request:Request,session:SessionRecord,origin:string):void {
    if(request.headers.get('origin')!==origin)throw new DomainError('ORIGIN_DENIED','请求来源不受信任。',403);
    if(request.headers.get('x-csrf-token')!==session.csrf)throw new DomainError('CSRF_DENIED','请求缺少有效的会话确认。',403);
  }
}
