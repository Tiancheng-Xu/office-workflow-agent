import type { D1Database } from '@cloudflare/workers-types';
export async function consumeBudget(db:D1Database,name:string,limit:number,now=Date.now()):Promise<boolean> {
  const day=new Date(now).toISOString().slice(0,10);
  return !!await db.prepare('INSERT INTO resource_budgets(day,name,used) VALUES(?,?,1) ON CONFLICT(day,name) DO UPDATE SET used=used+1 WHERE used<? RETURNING used').bind(day,name,limit).first();
}
export async function claimBrowserSlot(db:D1Database,now=Date.now()):Promise<boolean> {
  // Serialize launches across isolates, including preview if the same DB is
  // mistakenly bound. Avoid consuming a Cloudflare launch faster than 20 s.
  const slot=await db.prepare('INSERT INTO resource_windows(name,next_allowed_at) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE next_allowed_at<=? RETURNING next_allowed_at').bind('browser-launch',now+30_000,now).first();
  if(!slot)return false;
  return consumeBudget(db,'browser-launch',6,now);
}
