import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge, CodexRpcError } from '../src/codex-bridge.mjs';

// The fake is only a protocol fixture; it is never counted as real Codex acceptance.
const fixture = String.raw`
const readline = require('node:readline');
let active = false;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  const ok = result => send({id:m.id,result});
  if(m.method === 'initialize') return ok({userAgent:'fixture'});
  if(m.method === 'initialized') return;
  if(m.method === 'thread/start') return ok({thread:{id:'t1',ephemeral:false,status:{type:'idle'}}});
  if(m.method === 'thread/name/set') return ok({});
  if(m.method === 'thread/read' || m.method === 'thread/resume') return ok({thread:{id:m.params.threadId,status:{type: active?'active':'idle'}}});
  if(m.method === 'turn/start') {
    if(m.params.input[0].text === 'timeout') return;
    active = true;
    const turn={id:'u1',status:'inProgress'};
    send({method:'turn/started',params:{threadId:'t1',turn}});
    if(m.params.input[0].text === 'hold') return ok({turn});
    const message=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'t1',delta:'中文内容'}})+'\n');
    const cut=message.indexOf(Buffer.from('中文'))+1;
    process.stdout.write(message.subarray(0,cut));
    setTimeout(()=>{
      process.stdout.write(message.subarray(cut));
      active=false;
      send({method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed',items:[]}}});
      ok({turn});
    }, 5);
    return;
  }
  if(m.method === 'turn/interrupt') {
    active=false;
    send({method:'turn/completed',params:{threadId:'t1',turn:{id:m.params.turnId,status:'interrupted'}}});
    return ok({});
  }
  if(m.method === 'setActive') {active=true;return ok({});}
  if(m.method === 'fail') return send({id:m.id,error:{code:-32602,message:'bad input',data:{field:'x'}}});
  if(m.method === 'die') return process.exit(7);
  if(m.method === 'hang') return;
  if(m.method === 'askPermission') {
    send({id:'permission-1',method:'item/commandExecution/requestApproval',params:{}});
    return ok({});
  }
  if(m.id === 'permission-1') return send({method:'fixture/permissionResult',params:m});
  ok({echo:m.params});
});
`;

async function make(t, options = {}) {
  const bridge = new CodexBridge({ command: process.execPath, args: ['-e', fixture], timeoutMs: 2000, ...options });
  t.after(() => bridge.close());
  await bridge.connect();
  return bridge;
}

test('persistent thread helpers preserve identity and completion before response', async t => {
  const bridge = await make(t);
  const deltas = [];
  const unsubscribe = bridge.subscribe(event => { if(event.method === 'item/agentMessage/delta') deltas.push(event.params.delta); });
  const thread = await bridge.createThread({ cwd: process.cwd(), title: 'BOSS 员工', instructions: '角色规则' });
  assert.equal(thread.id, 't1');
  assert.equal(thread.ephemeral, false);
  const turn = await bridge.sendTurn(thread.id, 'hello');
  assert.equal((await bridge.waitTurn(thread.id, turn.id)).status, 'completed');
  assert.deepEqual(deltas, ['中文内容']);
  assert.equal(bridge.active.has(thread.id), false);
  unsubscribe();
});

test('unowned and active threads are not executed', async t => {
  const bridge = await make(t);
  await assert.rejects(bridge.sendTurn('someone-else', 'hello'), /explicitly adopted/);
  bridge.adoptThread('t1');
  await bridge.request('setActive');
  await assert.rejects(bridge.sendTurn('t1', 'hello'), /another client/);
});

test('concurrent send to same thread is rejected, explicit interrupt ends the active turn', async t => {
  const bridge = await make(t);
  bridge.adoptThread('t1');
  const first = bridge.sendTurn('t1', 'hold');
  await assert.rejects(bridge.sendTurn('t1', 'hello'), /active turn/);
  const turn = await first;
  const completion = bridge.waitTurn('t1', turn.id);
  await bridge.interrupt('t1');
  assert.equal((await completion).status, 'interrupted');
});

test('RPC failures and timeouts reject without automatic retries', async t => {
  const bridge = await make(t);
  await assert.rejects(bridge.request('fail'), error => error instanceof CodexRpcError && error.code === -32602);
  await assert.rejects(bridge.request('hang', {}, { timeoutMs: 25 }), /timed out/);
  assert.equal(bridge.pending.size, 0);
  assert.deepEqual(await bridge.request('echo', { n: 2 }), { echo: { n: 2 } });
});

test('uncertain turn/start blocks another execution', async t => {
  const bridge = await make(t);
  bridge.adoptThread('t1');
  bridge.timeoutMs = 30;
  await assert.rejects(bridge.sendTurn('t1', 'timeout'), /timed out/);
  await assert.rejects(bridge.sendTurn('t1', 'hello'), /uncertain/);
});

test('process exit rejects pending request and turn waiter', async t => {
  const bridge = await make(t);
  const wait = assert.rejects(bridge.waitTurn('t1', 'u1'), /exited/);
  const request = assert.rejects(bridge.request('die'), /exited/);
  await Promise.all([wait, request]);
  assert.equal(bridge.pending.size, 0);
  assert.equal(bridge.waiters.size, 0);
});

test('permission requests are not implicitly approved', async t => {
  const bridge = await make(t);
  const result = new Promise(resolve => bridge.notifications.once('fixture/permissionResult', resolve));
  await bridge.request('askPermission');
  assert.equal((await result).error.code, -32601);
});

test('closing is idempotent and rejects pending work', async t => {
  const bridge = await make(t);
  const pending = assert.rejects(bridge.request('hang'), /closed/);
  await bridge.close();
  await bridge.close();
  await pending;
  await assert.rejects(bridge.connect(), /closed/);
});
