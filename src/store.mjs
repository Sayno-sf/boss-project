import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 当前项目的控制状态与原始操作记录。每次写入都从 SQLite 重新读取，避免两个客户端覆盖状态。 */
export class BossStore {
  constructor(filename, { readOnly = false } = {}) {
    if (readOnly) {
      if (existsSync(filename)) this.db = new DatabaseSync(filename, { readOnly: true });
      this.db?.exec('PRAGMA busy_timeout=5000');
      return;
    }
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS boss_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS boss_events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  read() {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT body FROM boss_state WHERE id=1').get();
    return row ? JSON.parse(row.body) : null;
  }
  change(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let state = this.read();
      const log = (type, body) => this.db.prepare('INSERT INTO boss_events(at,type,body) VALUES(?,?,?)')
        .run(new Date().toISOString(), type, JSON.stringify(body));
      const result = fn(state, log);
      state = result?.initialState ?? state;
      if (!state) throw new Error('项目尚未初始化');
      this.db.prepare('INSERT INTO boss_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result?.value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(after = 0) {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM boss_events WHERE seq > ? ORDER BY seq').all(after)
      .map(row => ({ ...row, body: JSON.parse(row.body) }));
  }
  close() { this.db?.close(); }
}
