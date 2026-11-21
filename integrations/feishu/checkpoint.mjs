import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function nextMail(db) {
  const row=db.prepare("SELECT * FROM inbox WHERE state='ready' AND taken IS NULL ORDER BY rowid LIMIT 1").get();
  return row ? {id:row.id,reportId:row.report_id,kind:row.kind,sourceRef:'feishu:'+row.message_id+'/'+row.id,...JSON.parse(row.body)} : null;
}

// Add the owner's actual message to the manager's normal tool result. Keep
// this optional read independent of the success/failure of any project write.
export function managerMail(boss, thread=process.env.CODEX_THREAD_ID) {
  const file=join(boss.stateDir,'feishu.sqlite');
  if (!thread || !existsSync(file)) return null;
  let db;
  try {
    const roles=Object.values(boss.status()?.roles??{});
    if (!roles.some(role=>role.kind==='manager' && role.threadId===thread)) return null;
    db=new DatabaseSync(file,{readOnly:true});
    return nextMail(db);
  } catch { return null; } // The independent listener retains and retries delivery.
  finally { db?.close(); }
}
