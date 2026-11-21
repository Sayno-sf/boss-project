import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decide } from '../vendor/agent-autoloop/kernel/decide.ts';
import { initialize, snapshot as upstreamSnapshot } from '../vendor/agent-autoloop/kernel/evolve.ts';
import { eventOutcome } from '../vendor/agent-autoloop/kernel/query.ts';
import { commitLatest, openView } from '../vendor/agent-autoloop/kernel/store.ts';
import { parseRules } from '../vendor/agent-autoloop/protocol/rules.ts';

const FORMAT = 'boss-autoloop-d3a44cac-v1';
const EMPTY_RULES = { timezone: 'Asia/Shanghai', askFirst: [], sources: {}, agents: {}, channels: {}, rules: [] };

/**
 * 上游内核的本地事务边界：只路由事件、认领任务和保存执行事实。
 * 不启动进程、不调用模型；卡片回答也不代表 BOSS 的阶段审批。
 * 调用方仍负责身份认证、线程互斥、阶段门禁和执行权限。
 */
export class Autoloop {
  #db;
  #environment;
  #closed = false;

  constructor(filename) {
    if (typeof filename !== 'string' || !filename.trim()) throw new TypeError('filename must be a non-empty string');
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      initialize(this.#db);
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        // 与上游 facts 分开保存凭据，不把 HMAC 密钥写进事件或 snapshot。
        this.#db.exec('CREATE TABLE IF NOT EXISTS boss_autoloop_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
        this.#db.prepare('INSERT OR IGNORE INTO boss_autoloop_meta(key,value) VALUES (?,?)')
          .run('secret', randomBytes(32).toString('hex'));
        const secret = this.#db.prepare('SELECT value FROM boss_autoloop_meta WHERE key=?').get('secret').value;
        this.#environment = { secret, publicUrl: '' };
        const view = openView(this.#db, FORMAT);
        if (!view.get('config', 'rules')) this.configure(EMPTY_RULES);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error('Autoloop is closed');
  }

  /**
   * 低层内核命令入口；参数顺序遵循上游 HANDLERS。
   * 例如 started:[run,token,{session}]，heartbeat:[worker,[run]]。
   * 仅供可信的本地编排层调用，不应直接映射为匿名 HTTP API。
   */
  apply(type, args = [], now = Date.now()) {
    this.#assertOpen();
    if (typeof type !== 'string' || !Array.isArray(args)) throw new TypeError('apply requires a type and argument array');
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new TypeError('now must be epoch milliseconds');
    let value;
    commitLatest(this.#db, FORMAT, (view) => {
      const result = decide(view, { type, args }, now, this.#environment);
      value = result.value;
      return result.facts;
    });
    return value;
  }

  /** 校验原始规则并设置默认值；不会修改调用方传入的对象。 */
  configure(rules) {
    this.#assertOpen();
    const now = Date.now();
    const parsed = parseRules(typeof rules === 'string' ? rules : JSON.stringify(rules), now, 'Asia/Shanghai');
    this.apply('rules', [parsed], now);
    return parsed;
  }

  ingest(source, event) {
    return this.apply('ingest', [source, event]);
  }

  /** 返回 Job 或 null；相同 claim 重试会重新签发 token，应使用最新返回值。 */
  claim(worker, claim) {
    if (typeof worker !== 'string' || !worker || typeof claim !== 'string' || !claim) {
      throw new TypeError('worker and claim must be non-empty strings');
    }
    return this.apply('claimNext', [worker, claim]);
  }

  finish(run, token, result) {
    return this.apply('finish', [run, token, result]);
  }

  /** 此回答只恢复上游卡片对应的任务，不授予任何项目或阶段权限。 */
  answer(card, response) {
    return this.apply('answer', [card, response]);
  }

  #read(query) {
    this.#assertOpen();
    let result;
    // 在一个短事务里读 seq 和投影，避免另一个连接写入导致混合版本。
    commitLatest(this.#db, FORMAT, (view) => {
      result = query(view);
      return [];
    });
    return result;
  }

  /** 使用上游查询返回该来源事件的路由及执行结果；不是生成式解释。 */
  why(source, eventId) {
    return this.#read((view) => eventOutcome(view, source, eventId));
  }

  /** 保留上游 {seq,tables,next} 形状，不含 wrapper 的 HMAC 密钥。 */
  snapshot() {
    return this.#read(upstreamSnapshot);
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}

export default Autoloop;
