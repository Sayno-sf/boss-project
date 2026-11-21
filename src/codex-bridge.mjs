import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message ?? 'Codex RPC failed'}`);
    this.name = 'CodexRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export function codexExecutable() {
  if (process.env.BOSS_CODEX_BIN) return process.env.BOSS_CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  // Native executable avoids .cmd quoting and never invokes Windows PowerShell.
  const result = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
  return result.stdout?.trim().split(/\r?\n/).find(Boolean) ?? 'codex.exe';
}

/** Persistent conversation transport. Closing the transport never archives/deletes a thread.
 * proxy shares an existing daemon; stdio is an explicit fallback, never automatic.
 * This coordinates one client, not a security boundary against another desktop client.
 */
export class CodexBridge {
  constructor({ command, args, transport = 'proxy', timeoutMs = 30_000, cwd, env,
    clientInfo = { name: 'boss-plugin', title: 'BOSS', version: '0.1.0' },
    requestHandler, maxLineBytes = 16 * 1024 * 1024 } = {}) {
    if (!['proxy', 'stdio'].includes(transport)) throw new Error('transport must be proxy or stdio');
    this.command = command ?? codexExecutable();
    this.args = args ?? ['app-server', ...(transport === 'proxy' ? ['proxy'] : ['--stdio'])];
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    this.env = env;
    this.clientInfo = clientInfo;
    this.requestHandler = requestHandler;
    this.maxLineBytes = maxLineBytes;
    this.notifications = new EventEmitter();
    this.pending = new Map();
    this.ownedThreads = new Set();
    this.active = new Map();
    this.sending = new Set();
    this.uncertain = new Set();
    this.completed = new Map();
    this.waiters = new Set();
    this.nextId = 1;
    this.closed = false;
    this.ready = false;
    this.stderr = '';
  }

  subscribe(fn) {
    this.notifications.on('notification', fn);
    return () => this.notifications.off('notification', fn);
  }

  async connect() {
    if (this.ready) return this;
    if (this.connecting) return this.connecting;
    if (this.closed) throw new Error('Bridge is closed; create a new connection explicitly');
    this.connecting = this.#connect();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async #connect() {
    const env = { ...process.env, ...this.env };
    // A new app-server is not a child of the current model turn. Preserve CODEX_HOME/config.
    for (const key of ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID']) delete env[key];
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: this.cwd, env,
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
          this.#fail(new Error('Codex JSONL message exceeds size limit'));
          return;
        }
        if (line.trim()) this.#receive(line);
      }
      if (Buffer.byteLength(buffer, 'utf8') > this.maxLineBytes) {
        this.#fail(new Error('Codex JSONL message exceeds size limit'));
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.child.stdin.on('error', error => this.#fail(error));
    this.child.on('error', error => this.#fail(error));
    this.child.on('close', (code, signal) => {
      this.#fail(new Error(`Codex transport exited (${code ?? signal})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
    });
    try {
      this.server = await this.request('initialize', { clientInfo: this.clientInfo, capabilities: {} });
      this.#write({ method: 'initialized' });
      this.ready = true;
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || !this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error('Codex transport is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out; the remote operation may still have happened`), { code: 'RPC_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex transport is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.#fail(new Error('Codex emitted invalid JSONL')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail(new Error('Codex emitted an invalid RPC message'));
      return;
    }
    if (message.method && message.id !== undefined) {
      // Never approve server-initiated permissions implicitly.
      Promise.resolve().then(() => {
        if (!this.requestHandler) throw Object.assign(new Error(`No handler for ${message.method}`), { code: -32601 });
        return this.requestHandler(message);
      }).then(result => {
        if (!this.closed) this.#write({ id: message.id, result });
      }, error => {
        if (!this.closed) this.#write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return; // Late response to a timed-out request: never retry the operation automatically.
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    const { method, params = {} } = message;
    if (typeof method !== 'string') {
      this.#fail(new Error('Codex notification is missing a method'));
      return;
    }
    if (method === 'turn/started' && params.threadId && params.turn?.id) {
      this.active.set(params.threadId, params.turn.id);
    } else if (method === 'turn/completed' && params.threadId && params.turn?.id) {
      const key = `${params.threadId}:${params.turn.id}`;
      this.completed.set(key, params.turn);
      if (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value);
      if (this.active.get(params.threadId) === params.turn.id) this.active.delete(params.threadId);
    }
    this.notifications.emit('notification', message);
    this.notifications.emit(method, params);
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.notifications.emit('closed', error);
    this.child?.stdin.end();
    if (this.child?.exitCode === null) this.child.kill();
  }

  /** Explicitly register a saved BOSS thread after restoring the plugin's role mapping.
   * Do not pass unrelated user threads. sendTurn still refuses threads reported active.
   */
  adoptThread(threadId) {
    if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('threadId is required');
    this.ownedThreads.add(threadId);
  }

  async createThread({ cwd = this.cwd, title, instructions, ...options } = {}) {
    const result = await this.request('thread/start', {
      ...options, ...(cwd && { cwd }), ephemeral: false,
      ...(instructions && { developerInstructions: instructions }),
    });
    const thread = result.thread;
    if (!thread?.id) throw new Error('thread/start did not return a thread ID');
    this.adoptThread(thread.id);
    if (title) {
      try { await this.request('thread/name/set', { threadId: thread.id, name: title }); }
      catch (error) { error.createdThreadId = thread.id; throw error; }
    }
    return thread;
  }

  async readThread(threadId, { includeTurns = false } = {}) {
    const result = await this.request('thread/read', { threadId, includeTurns });
    return result.thread;
  }

  async sendTurn(threadId, text, options = {}) {
    if (!this.ownedThreads.has(threadId)) throw new Error('Thread must be explicitly adopted before execution');
    if (this.uncertain.has(threadId)) throw new Error('Previous execution outcome is uncertain; inspect the thread before reconnecting');
    if (this.sending.has(threadId) || this.active.has(threadId)) throw new Error('Thread already has an active turn');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message text is required');
    this.sending.add(threadId);
    try {
      const existing = await this.readThread(threadId);
      if (existing.status?.type === 'active') throw new Error('Thread is active in another client');
      const resumed = await this.request('thread/resume', { threadId });
      if (resumed.thread?.status?.type === 'active') throw new Error('Thread became active in another client');
      let result;
      try {
        result = await this.request('turn/start', {
          ...options, threadId, input: [{ type: 'text', text }],
        });
      } catch (error) {
        // Transport loss/timeout cannot prove that an execution was never accepted.
        if (!(error instanceof CodexRpcError)) this.uncertain.add(threadId);
        throw error;
      }
      if (!result.turn?.id) throw new Error('turn/start did not return a turn ID');
      if (!this.completed.has(`${threadId}:${result.turn.id}`)) this.active.set(threadId, result.turn.id);
      return result.turn;
    } finally {
      this.sending.delete(threadId);
    }
  }

  waitTurn(threadId, turnId, { timeoutMs = 300_000 } = {}) {
    const key = `${threadId}:${turnId}`;
    if (this.completed.has(key)) return Promise.resolve(this.completed.get(key));
    if (this.closed) return Promise.reject(new Error('Codex transport is closed'));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.notifications.off('turn/completed', onCompleted);
        this.waiters.delete(waiter);
      };
      const waiter = { reject: error => { cleanup(); reject(error); } };
      const onCompleted = params => {
        if (params.threadId === threadId && params.turn?.id === turnId) {
          cleanup(); resolve(params.turn);
        }
      };
      timer = setTimeout(() => waiter.reject(new Error('Waiting for turn timed out; the turn has not been cancelled')), timeoutMs);
      this.waiters.add(waiter);
      this.notifications.on('turn/completed', onCompleted);
    });
  }

  async interrupt(threadId, turnId = this.active.get(threadId)) {
    if (!this.ownedThreads.has(threadId)) throw new Error('Thread must be explicitly adopted before interrupting');
    if (!turnId) throw new Error('An explicit active turn ID is required');
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async close() {
    if (!this.closed) this.#fail(new Error('Codex bridge closed'));
  }
}
