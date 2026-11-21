import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '../src/mcp.mjs');

// A real stdio server and temporary local databases; no model or chat is created.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'boss-mcp-test-'));
  const child = spawn(process.execPath, [server], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let sequence = 0;
  let stderr = '';
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`MCP exited (${code}/${signal}): ${stderr}`)); }
    pending.clear();
    resolveClosed({ code, signal });
  }));
  child.on('error', error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); }
    catch (error) {
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
      pending.clear();
      return;
    }
    const request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2_000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); rmSync(root, { recursive: true, force: true }); }
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP response timed out: ${method}; ${stderr}`)); }, 10_000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { root, child, request, call: (name, args = {}) => request('tools/call', { name, arguments: { root, ...args } }) };
}

test('MCP process initializes and exposes typed tools without an owner approval tool', async t => {
  const { child, request } = await fixture(t);
  const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boss-offline-test', version: '1' } });
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  assert.equal(initialized.result.serverInfo.name, 'boss');
  assert.ok(initialized.result.capabilities.tools);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list', {});
  const names = list.result.tools.map(tool => tool.name);
  for (const name of ['boss_status', 'boss_messages', 'boss_init', 'boss_assign', 'boss_discuss', 'boss_review', 'boss_report']) assert.ok(names.includes(name));
  assert.ok(!names.includes('boss_decide'), 'MCP must not let a role impersonate BOSS approval');
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.required.includes('root'));
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual((await request('ping')).result, {});
});

test('MCP rejects missing, unknown and incorrectly typed arguments before invoking actions', async t => {
  const { request, call, root } = await fixture(t);
  for (const [name, args] of [
    ['boss_init', { root }],
    ['boss_init', { root, name: ' ' }],
    ['boss_init', { root, name: 'offline', unexpected: true }],
    ['boss_messages', { root, after: -1 }],
    ['boss_messages', { root, after: '1' }],
    ['boss_status', {}],
    ['boss_decide', { root, decision: 'approve' }],
  ]) {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.error?.code, -32602, `${name} must reject ${JSON.stringify(args)}`);
  }
  assert.equal((await call('boss_status')).result.content[0].text, 'null', 'Invalid calls must not initialize a project');
});

test('MCP init and status persist a local project across separate requests', async t => {
  const { call, root } = await fixture(t);
  const created = await call('boss_init', { name: '无模型 MCP 验收' });
  assert.ok(!created.result.isError);
  const project = JSON.parse(created.result.content[0].text);
  assert.equal(project.name, '无模型 MCP 验收');
  assert.equal(project.root, root);
  assert.deepEqual(project.roles, {});
  assert.equal(project.stage, null);
  const status = JSON.parse((await call('boss_status')).result.content[0].text);
  assert.equal(status.id, project.id);
  const messages = JSON.parse((await call('boss_messages')).result.content[0].text);
  assert.ok(messages.some(event => event.type === 'project.created'));
});

test('CLI and MCP read-only queries leave a pristine directory untouched', async t => {
  const { root, call } = await fixture(t);
  for (const command of ['status', 'messages', 'report-view']) {
    const result = spawnSync(process.execPath, [resolve(dirname(server), 'cli.mjs'), command, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).ok);
  }
  assert.equal((await call('boss_status')).result.content[0].text, 'null');
  assert.equal((await call('boss_messages')).result.content[0].text, '[]');
  assert.match((await call('boss_report_view')).result.content[0].text, /尚未初始化/);
  assert.equal(existsSync(join(root, '.boss')), false);
});

test('public CLI/MCP interoperate through delivery, strict review, and dispatch closure', async t => {
  const { root, call } = await fixture(t);
  const cli = (command, input) => {
    const file = join(root, 'input.json');
    if (input) writeFileSync(file, JSON.stringify(input));
    const run = spawnSync(process.execPath, [resolve(dirname(server), 'cli.mjs'), command, '--root', root,
      ...(input ? ['--input', file] : [])], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout).result;
  };
  const mcp = async (name, args) => {
    const response = await call(name, args);
    assert.ok(!response.error && !response.result.isError, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  cli('init', { name: '隔离公开接口' });
  for (const id of ['worker', 'reviewer']) cli('bind', { id, kind: id, title: id, threadId: `fixture-${id}` });
  cli('stage', { id:'s1', title:'检查公开接口', goal:'核验接口', acceptance:['记录真实形状'] });
  assert.equal((await mcp('boss_claim')).status, 'empty');
  await mcp('boss_assign', { id:'old', role:'worker', text:'任务' });
  const claim = cli('claim');
  assert.equal(claim.status, 'claimed');
  assert.equal((await mcp('boss_claim')).status, 'blocked');
  await mcp('boss_close_dispatch', { ids:claim.ids, outcome:'failed', confirmation:'not_sent', reason:'模拟失败', evidence:'fixture:host' });
  writeFileSync(join(root, 'artifact.txt'), 'fixture');
  const shot = cli('deliver', { role:'worker', files:['artifact.txt'], summary:'交付', evidence:'验证依据', sourceRef:'fixture:worker' });
  const review = await mcp('boss_claim');
  assert.deepEqual(review.ids, [shot.reviewTaskId]);
  cli('uncertain', { ids:review.ids, reason:'模拟宿主工具返回超时' });
  assert.ok((await call('boss_sent', { ids:review.ids, turnId:'fixture-turn' })).result.isError);
  cli('sent', { ids:review.ids, turnId:'fixture-turn', evidence:'fixture:核实找到原轮次' });
  await mcp('boss_complete', { ids:review.ids, text:'独立审查原文', sourceRef:'fixture:review' });
  const verdict = { version:shot.version, verdict:'pass', evidence:'审查依据', sourceRef:'fixture:review' };
  assert.equal((await call('boss_review', verdict)).error.code, -32602);
  await mcp('boss_review', { ...verdict, submissionId:shot.submissionId, reviewTaskId:shot.reviewTaskId });
  cli('report', { completed:'完成', incomplete:'无', verification:'隔离验证', next:'待批示', sourceRef:'fixture:report' });
  assert.match(cli('report-view'), /等待 BOSS 批复/);
  assert.match((await call('boss_report_view')).result.content[0].text, /等待 BOSS 批复/);
});
