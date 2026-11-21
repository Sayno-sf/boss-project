import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexExecutable } from '../../src/codex-bridge.mjs';

const run = promisify(execFile);

// Only the registered manager receives this fixed notification. The authenticated
// text and approval stay in the project inbox and never become command arguments.
export async function queueManager(thread, root) {
  const message = '飞书经理收件：请按本项目 AGENTS.md 的飞书收件说明，在原经理聊天执行 wait 0，逐条答复或确认接手，直到收件箱为空。已有批复以项目记录为准。空队列无需行动。';
  const exe = process.env.BOSS_CODEX_BIN || process.env.CODEX_APP_RUNTIME_CLI_PATH || codexExecutable();
  await run(exe, ['queue', '--thread', thread, '--message', message, '--resume'], {
    cwd: root, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
  });
  // A zero exit includes "queued, could not resume". Only a manager ack is a receipt.
}

export async function wakePending(channel, send = queueManager, now = Date.now()) {
  const db = channel.db;
  const watch=db.prepare('SELECT expires FROM manager_watch WHERE id=1').get();
  if (watch?.expires>now) return;
  const due = db.prepare(`SELECT i.id, coalesce(w.attempts,0) AS attempts
    FROM inbox i LEFT JOIN wakes w ON w.id=i.id
    WHERE i.state='ready' AND i.taken IS NULL AND w.queued IS NULL
      AND (w.retry_after IS NULL OR w.retry_after<=?) ORDER BY i.rowid`).all(now);
  if (!due.length) return;
  // The listener is exclusive per project. Persist the retry delay before the
  // external call so a restart cannot immediately issue a duplicate notification.
  const claim = db.prepare(`INSERT INTO wakes(id,attempts,retry_after) VALUES(?,1,?)
    ON CONFLICT(id) DO UPDATE SET attempts=attempts+1,retry_after=excluded.retry_after`);
  for (const item of due) claim.run(item.id, now + Math.min(300_000, 15_000 * 2 ** Math.min(item.attempts,5)));
  await send(channel.manager, channel.boss.root);
  const finish = db.prepare('UPDATE wakes SET queued=? WHERE id=?');
  for (const item of due) finish.run(now,item.id);
}
