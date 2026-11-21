import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boss } from '../src/boss.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'boss-recovery-test-'));
  let boss = new Boss(root);
  t.after(() => { boss.close(); rmSync(root, { recursive: true, force: true }); });
  boss.init('isolated recovery fixture');
  for (const [id, kind] of [['worker', 'worker'], ['reviewer', 'reviewer'], ['technician', 'technician'], ['manager', 'manager']]) {
    boss.bindRole({ id, kind, title: id, threadId: `fixture-${id}` });
  }
  boss.startStage({ id: 's1', title: 'fixture stage', goal: 'verify fixture file', acceptance: ['file is correct'] });
  writeFileSync(join(root, 'result.txt'), 'v1');
  return {
    root, get boss() { return boss; },
    restart() { boss.close(); boss = new Boss(root); return boss; },
  };
}

function delivery(boss) {
  return boss.deliver({ role: 'worker', summary: 'fixture result', files: ['result.txt'],
    evidence: 'fixture verification', sourceRef: 'fixture:worker-report' });
}

function finishReviewJob(boss, turnId = 'fixture-turn') {
  const task = boss.claim();
  assert.equal(task.role, 'reviewer');
  boss.markSent({ ids: task.ids, turnId });
  boss.complete({ ids: task.ids, text: 'fixture reviewer reply', sourceRef: 'fixture:reviewer-reply' });
}

function report(boss) {
  return boss.report({ completed: 'fixture result', incomplete: 'none', verification: 'fixture verified',
    next: 'next fixture stage', sourceRef: 'fixture:manager-report' });
}

test('claim recovers after upstream committed but local transaction rolled back', t => {
  const f = fixture(t);
  f.boss.enqueue({ id: 'crash-job', role: 'worker', text: 'fixture task' });
  const originalClaim = f.boss.loop.claim.bind(f.boss.loop);
  let upstreamRun;
  f.boss.loop.claim = (...args) => {
    const result = originalClaim(...args);
    upstreamRun = result.run;
    throw new Error('simulated crash after upstream commit');
  };
  assert.throws(() => f.boss.claim(), /simulated crash/);
  assert.equal(f.boss.status().jobs['crash-job'].state, 'queued');
  const recovered = f.restart().claim();
  assert.deepEqual(recovered.ids, ['crash-job']);
  assert.equal(recovered.run, upstreamRun);
  f.boss.markSent({ ids: recovered.ids, turnId: 'fixture-recovered-turn' });
  f.boss.complete({ ids: recovered.ids, text: 'finished once', sourceRef: 'fixture:worker-result' });
  assert.equal(f.restart().claim(), null);
  assert.equal(f.boss.messages().filter(e => e.type === 'message.received').length, 1);
});

test('F1: verified terminal receipt survives interruption and releases the next task', t => {
  const f = fixture(t);
  f.boss.enqueue({ id: 'lost', role: 'worker', text: 'fixture task' });
  const { ids } = f.boss.claim();
  f.boss.uncertain({ ids, reason: '宿主回复丢失' });
  f.boss.enqueue({ id: 'next', role: 'worker', kind: 'discussion', text: 'fixture follow-up' });
  assert.deepEqual(f.boss.claimStatus(), { status: 'blocked', reason: 'in_flight', ids });
  const closure = { ids, outcome: 'failed', confirmation: 'not_sent', reason: '工具拒绝',
    evidence: 'fixture:宿主确认没有轮次' };
  assert.throws(() => f.boss.closeDispatch({ ...closure, confirmation: 'unknown' }), /核实/);
  const finish = f.boss.loop.finish.bind(f.boss.loop);
  f.boss.loop.finish = (...args) => { finish(...args); throw new Error('模拟取消后中断'); };
  assert.throws(() => f.boss.closeDispatch(closure), /模拟取消后中断/);
  const boss = f.restart();
  assert.deepEqual(boss.closeDispatch(closure), { ids, state: 'failed' });
  assert.deepEqual(boss.closeDispatch(closure), { duplicate: true });
  assert.equal(boss.status().jobs.lost.result, null);
  assert.equal(boss.status().jobs.lost.termination.evidence, closure.evidence);
  assert.throws(() => boss.closeDispatch({ ...closure, evidence: 'different' }));
  const next = boss.claimStatus();
  assert.equal(next.status, 'claimed');
  assert.deepEqual(next.ids, ['next']);
  boss.markSent({ ids: next.ids, turnId: 'fixture-real-turn' });
  assert.throws(() => boss.closeDispatch({ ...closure, ids: next.ids }), /轮次/);
  assert.throws(() => boss.closeDispatch({ ...closure, ids: next.ids, confirmation: 'terminated', turnId: 'wrong' }), /不符/);
  boss.closeDispatch({ ...closure, ids: next.ids, outcome: 'cancelled', confirmation: 'terminated', turnId: 'fixture-real-turn' });
  assert.deepEqual(boss.claimStatus(), { status: 'empty' });
  assert.equal(boss.messages().filter(event => event.type === 'message.received').length, 0);
});

test('F2: rejects invalid IDs before persistence and preserves legacy unroutable records', t => {
  const { boss } = fixture(t);
  const task = { role: 'worker', text: 'legacy intent' };
  for (const id of ['task with spaces', 'a'.repeat(101), '\ud800']) {
    assert.throws(() => boss.enqueue({ ...task, id }));
  }
  assert.deepEqual(boss.status().jobs, {});
  boss.store.change((state, log) => {
    const id = 'invalid legacy ID';
    state.jobs[id] = { ...task, id, kind: 'work', stageId: 's1', state: 'queued', loopEvent: null };
    log('message.queued', state.jobs[id]);
  });
  const id = 'valid #._:/@-'.replace(' ', '');
  boss.enqueue({ ...task, id });
  assert.equal(boss.status().jobs['invalid legacy ID'].state, 'failed');
  assert.deepEqual(boss.claim().ids, [id]);
});

test('F3: same bytes with new evidence reject previous or incomplete review receipts', t => {
  const { boss } = fixture(t);
  const first = delivery(boss);
  finishReviewJob(boss);
  const second = delivery(boss);
  assert.equal(first.version, second.version);
  const conclusion = { verdict: 'pass', evidence: 'fixture verified', sourceRef: 'fixture:reviewer-reply' };
  assert.throws(() => boss.review({ ...first, ...conclusion }), /本次交付/);
  assert.throws(() => boss.review({ ...second, ...conclusion }), /已完成/);
  const job = boss.claim();
  assert.deepEqual(job.ids, [second.reviewTaskId]);
  boss.markSent({ ids: job.ids, turnId: 'fixture-second' });
  boss.complete({ ids: job.ids, text: 'second raw reply', sourceRef: 'fixture:second' });
  assert.throws(() => boss.review({ ...second, ...conclusion }), /真实回执/);
  boss.review({ ...second, ...conclusion, sourceRef: 'fixture:second' });
  assert.equal(report(boss).reviewTaskId, second.reviewTaskId);
});

test('F4: committed delivery and exactly one review task recover after routing interruption', t => {
  const f = fixture(t);
  const input = { role: 'worker', summary: 'fixture', files: ['result.txt'], evidence: 'verified',
    sourceRef: 'fixture:worker', submissionId: 'stable-1' };
  const ingest = f.boss.loop.ingest.bind(f.boss.loop);
  f.boss.loop.ingest = (...args) => { ingest(...args); throw new Error('模拟路由提交后中断'); };
  assert.throws(() => f.boss.deliver(input), /模拟路由提交后中断/);
  assert.equal(f.boss.status().stage.delivery.submissionId, input.submissionId);
  assert.equal(f.boss.status().jobs['review-stable-1'].loopEvent, null);
  const boss = f.restart();
  const shot = boss.deliver(input);
  assert.equal(shot.reviewTaskId, 'review-stable-1');
  assert.deepEqual(boss.claim().ids, [shot.reviewTaskId]);
  assert.equal(boss.messages().filter(event => event.type === 'delivery.submitted').length, 1);
});

test('F4: absent reviewer rejects before storing delivery', t => {
  const { boss } = fixture(t);
  boss.store.change(state => { delete state.roles.reviewer; });
  assert.throws(() => delivery(boss), /先绑定独立审查员/);
  assert.equal(boss.status().stage.delivery, null);
  assert.deepEqual(boss.status().jobs, {});
});

for (const legacy of [false, true]) {
  test(`F5: interruption after ${legacy ? 'legacy' : 'current'} upstream cancellation preserves same-role discussion`, t => {
    const f = fixture(t);
    const boss = f.boss;
    boss.enqueue({ id: 'blocked-work', role: 'worker', text: 'fixture work' });
    boss.enqueue({ id: 'allowed-discussion', role: 'worker', kind: 'discussion', text: 'fixture discussion' });
    boss.store.change(state => { state.stage.status = 'blocked'; });
    if (legacy) {
      const native = boss.loop.claim('boss-desktop', 'legacy-claim');
      boss.loop.finish(native.run, native.token, { outcome: 'cancelled', summary: '阶段门禁关闭，保留任务原文，未向聊天派发。' });
      assert.equal(boss.status().jobs['blocked-work'].state, 'queued');
    } else {
      const finish = boss.loop.finish.bind(boss.loop);
      boss.loop.finish = (...args) => { finish(...args); throw new Error('模拟门禁取消后中断'); };
      assert.throws(() => boss.claim(), /模拟门禁取消后中断/);
    }
    const recovered = f.restart();
    const result = recovered.claimStatus();
    const discussion = result.status === 'claimed' ? result : recovered.claimStatus();
    assert.equal(discussion.status, 'claimed');
    assert.deepEqual(discussion.ids, ['allowed-discussion']);
    assert.equal(recovered.status().jobs['blocked-work'].state, 'held');
  });
}

test('F7a: manager starts directly and task plan and actual model stay traceable', t => {
  const { boss } = fixture(t);
  assert.throws(() => boss.enqueue({ role: 'manager', text: '开始调度' }), /直接启动/);
  const modelPlan = { model: 'gpt-6.1-sol', thinking: 'low' };
  const materials = [{ path: 'result.txt', version: 'sha256-fixture' }];
  boss.enqueue({ id: 'planned', role: 'worker', text: 'fixture work', modelPlan, materials });
  boss.enqueue({ id: 'plain', role: 'worker', text: 'fixture second' });
  const claim = boss.claim();
  assert.deepEqual(claim.ids, ['planned']);
  assert.deepEqual(claim.modelPlan, modelPlan);
  assert.match(claim.text, /result.txt（版本 sha256-fixture）/);
  assert.throws(() => boss.markSent({ ids: claim.ids, turnId: 'fixture-turn' }), /实际使用/);
  const sendConfig = { model: 'gpt-6.1-sol', thinking: 'medium', hostId: 'local' };
  boss.markSent({ ids: claim.ids, turnId: 'fixture-turn', sendConfig });
  assert.deepEqual(boss.status().jobs.planned.sendConfig, sendConfig);
  assert.ok(boss.messages().some(event => event.type === 'dispatch.sent' && event.body.sendConfig?.thinking === 'medium'));
  boss.complete({ ids: claim.ids, text: 'fixture reply', sourceRef: 'fixture:reply' });
  assert.deepEqual(boss.claim().ids, ['plain']);
});

test('stale reported files cannot be approved but can be explicitly returned for revision', t => {
  const f = fixture(t);
  const shot = delivery(f.boss);
  finishReviewJob(f.boss);
  f.boss.review({ ...shot, verdict: 'pass', evidence: 'fixture checked', sourceRef: 'fixture:reviewer-reply' });
  const old = report(f.boss);
  writeFileSync(join(f.root, 'result.txt'), 'v2 after report');
  const decision = { reportId: old.id, version: old.version, opinion: 'fixture owner opinion', userMessageRef: 'fixture:owner' };
  assert.throws(() => f.boss.decide({ ...decision, decision: 'approve' }), /变化/);
  f.boss.decide({ ...decision, decision: 'revise' });
  assert.equal(f.boss.status().stage.status, 'working');
  assert.equal(f.boss.status().stage.review, null);
  assert.equal(f.boss.status().stage.report, null);
  assert.ok(f.boss.messages().some(e => e.type === 'report.submitted' && e.body.id === old.id));
  const revised = delivery(f.boss);
  assert.notEqual(revised.version, old.version);
  assert.throws(() => f.boss.decide({ ...decision, decision: 'approve' }), /失效/);
});

test('owner can stop a reported stage even when its submitted file disappeared', t => {
  const f = fixture(t);
  const shot = delivery(f.boss);
  finishReviewJob(f.boss);
  f.boss.review({ ...shot, verdict: 'pass', evidence: 'fixture checked', sourceRef: 'fixture:reviewer-reply' });
  const submitted = report(f.boss);
  unlinkSync(join(f.root, 'result.txt'));
  f.boss.decide({ reportId: submitted.id, version: submitted.version, decision: 'stop',
    opinion: 'fixture stop', userMessageRef: 'fixture:owner-stop' });
  assert.equal(f.boss.status().stage.status, 'stopped');
  assert.equal(f.boss.status().stage.report.id, submitted.id);
});

test('a queued task held by the gate does not prevent later discussion', t => {
  const f = fixture(t);
  for (let round = 1; round <= 2; round++) {
    const shot = delivery(f.boss);
    finishReviewJob(f.boss, `fixture-review-turn-${round}`);
    if (round === 2) f.boss.enqueue({ role: 'worker', id: 'later-work', text: 'queued before blocker' });
    f.boss.review({ ...shot, verdict: 'block', progress: false,
      findings: [{ id: 'b1', requirement: 'file is correct', evidence: 'still wrong', release: 'fix file' }],
      evidence: 'fixture block', sourceRef: 'fixture:reviewer-reply' });
  }
  assert.equal(f.boss.status().stage.status, 'blocked');
  assert.equal(f.boss.claim(), null);
  assert.equal(f.boss.status().jobs['later-work'].state, 'held');
  f.boss.enqueue({ role: 'technician', kind: 'discussion', id: 'explain', text: 'explain the issue' });
  const discussion = f.restart().claim();
  assert.equal(discussion.role, 'technician');
  assert.deepEqual(discussion.ids, ['explain']);
});

test('completion recovery rejects changed full text or source despite an identical upstream summary', t => {
  const f = fixture(t);
  f.boss.enqueue({ id: 'receipt-job', role: 'worker', text: 'fixture task' });
  const task = f.boss.claim();
  f.boss.markSent({ ids: task.ids, turnId: 'fixture-receipt-turn' });
  const prefix = 'x'.repeat(450);
  const original = { ids: task.ids, text: `${prefix} ORIGINAL`, sourceRef: 'fixture:original-source' };
  const finish = f.boss.loop.finish.bind(f.boss.loop);
  f.boss.loop.finish = (...args) => {
    finish(...args);
    throw new Error('simulated crash after upstream completion');
  };
  assert.throws(() => f.boss.complete(original), /simulated crash/);
  f.restart();
  assert.throws(() => f.boss.complete({ ...original, text: `${prefix} REPLACED` }), /冲突/);
  assert.throws(() => f.boss.complete({ ...original, sourceRef: 'fixture:replacement-source' }), /冲突/);
  f.boss.complete(original);
  assert.equal(f.boss.status().jobs['receipt-job'].result, original.text);
  assert.equal(f.boss.status().jobs['receipt-job'].sourceRefResult, original.sourceRef);
  assert.deepEqual(f.boss.complete(original), { duplicate: true });
  assert.equal(f.boss.messages().filter(e => e.type === 'message.received').length, 1);
});

test('merged task batch cannot be partially completed', t => {
  const f = fixture(t);
  f.boss.enqueue({ id: 'batch-one', role: 'worker', text: 'fixture first task' });
  f.boss.enqueue({ id: 'batch-two', role: 'worker', text: 'fixture second task' });
  const task = f.boss.claim();
  assert.deepEqual([...task.ids].sort(), ['batch-one', 'batch-two']);
  f.boss.markSent({ ids: task.ids, turnId: 'fixture-batch-turn' });
  assert.throws(() => f.boss.complete({ ids: [task.ids[0]], text: 'incomplete receipt', sourceRef: 'fixture:partial' }));
  for (const id of task.ids) assert.equal(f.boss.status().jobs[id].state, 'active');
  assert.equal(f.boss.messages().filter(e => e.type === 'message.received').length, 0);
  f.boss.complete({ ids: task.ids, text: 'complete batch receipt', sourceRef: 'fixture:complete' });
  for (const id of task.ids) assert.equal(f.boss.status().jobs[id].state, 'done');
  assert.equal(f.boss.messages().filter(e => e.type === 'message.received').length, 1);
});
