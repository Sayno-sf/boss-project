import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Boss } from '../src/boss.mjs';

// 全部用户消息、模型回复、线程与轮次 ID 均为明确的离线模拟。
// 这些测试只验证控制面状态与证据绑定，不证明真实 Codex 聊天已运行。
const ROLES = [
  { id: 'technician', kind: 'technician', title: '模拟老技术员', threadId: 'simulated-thread-technician' },
  { id: 'manager', kind: 'manager', title: '模拟经理', threadId: 'simulated-thread-manager' },
  { id: 'reviewer', kind: 'reviewer', title: '模拟审查员', threadId: 'simulated-thread-reviewer' },
  { id: 'worker-a', kind: 'worker', title: '模拟员工甲', threadId: 'simulated-thread-worker-a' },
];
const STAGE = { id: 'stage-1', title: '模拟可验证阶段', goal: '交付一个可检查的文本成果', acceptance: ['artifact.txt 包含约定内容'] };
const BLOCKER = { id: 'block-1', requirement: '成果必须可核验', evidence: '模拟证据表明缺少必要验证', release: '补充可复现验证并复审' };

function fixture(t, { setup = true } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'boss-control-test-'));
  const root = path.join(directory, 'project');
  mkdirSync(root);
  writeFileSync(path.join(root, 'artifact.txt'), '模拟约定成果 v1\n');
  const instances = new Set();
  const open = () => { const boss = new Boss(root); instances.add(boss); return boss; };
  const close = (boss) => { boss.close(); instances.delete(boss); };
  t.after(() => {
    for (const boss of instances) boss.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const boss = open();
  boss.init('模拟项目');
  if (setup) {
    for (const role of ROLES) boss.bindRole(role);
    boss.startStage(STAGE);
  }
  return { boss, root, directory, open, close };
}

function completeDispatch(boss, { expectedRole, text = '模拟模型原始回复：检查已完成。' } = {}) {
  const dispatch = boss.claim();
  assert.ok(dispatch, '应有可派发的模拟任务');
  if (expectedRole) assert.equal(dispatch.role, expectedRole);
  const turnId = `simulated-turn-${dispatch.run}`;
  const sourceRef = `simulated://model/${dispatch.threadId}/${turnId}`;
  boss.markSent({ ids: dispatch.ids, turnId });
  boss.complete({ ids: dispatch.ids, text, sourceRef });
  return { ...dispatch, turnId, sourceRef, text };
}

function submitDelivery(boss, options = {}) {
  return boss.deliver({ role: 'worker-a', summary: '模拟员工交付成果', files: ['artifact.txt'],
    evidence: '模拟验证：已读取并检查文本', sourceRef: 'simulated://employee/report', ...options });
}

function reviewedDelivery(boss, { verdict = 'pass', findings = [], progress = true } = {}) {
  const delivery = submitDelivery(boss);
  const dispatch = completeDispatch(boss, { expectedRole: 'reviewer' });
  const review = boss.review({ ...delivery, verdict, findings, progress,
    evidence: '模拟独立审查：读取具体成果和对应验证记录', sourceRef: dispatch.sourceRef });
  return { delivery, review, dispatch };
}

function report(boss) {
  return boss.report({ completed: '模拟成果已经交付', incomplete: '本轮无其他交付项',
    verification: '模拟检查结果见独立审查记录', next: '批复后进入下一阶段', sourceRef: 'simulated://manager/report' });
}

function approve(boss, phaseReport, options = {}) {
  return boss.decide({ reportId: phaseReport.id, version: phaseReport.version, decision: 'approve',
    opinion: '模拟用户意见：验收范围满足要求，批准进入下一阶段。', userMessageRef: 'simulated://user/approval', ...options });
}

test('role bindings survive reopening; roles cannot silently switch or share conversations', (t) => {
  const f = fixture(t, { setup: false });
  for (const role of ROLES) f.boss.bindRole(role);
  const before = f.boss.status().roles;
  f.close(f.boss);
  const reopened = f.open();
  assert.deepEqual(reopened.status().roles, before);
  assert.equal(reopened.bindRole(ROLES[0]).threadId, ROLES[0].threadId);
  assert.throws(() => reopened.bindRole({ ...ROLES[0], threadId: 'replacement-thread' }));
  assert.throws(() => reopened.bindRole({ id: 'worker-b', kind: 'worker', title: '模拟员工乙', threadId: ROLES[0].threadId }));
  assert.throws(() => reopened.bindRole({ id: 'manager-b', kind: 'manager', title: '第二经理', threadId: 'simulated-manager-b' }));
  assert.deepEqual(reopened.status().roles, before);
});

test('enqueue, claim, sent and complete retain original messages and are retry-safe', (t) => {
  const { boss } = fixture(t);
  const task = { id: 'simulated-work-1', role: 'worker-a', text: '模拟经理指令：检查 artifact.txt。', source: 'manager', sourceRef: 'simulated://manager/task-1' };
  boss.enqueue(task);
  boss.enqueue(task);
  assert.equal(Object.keys(boss.status().jobs).length, 1);
  assert.throws(() => boss.enqueue({ ...task, text: '相同 ID 的其他指令' }));
  const dispatch = boss.claim();
  assert.equal(dispatch.threadId, ROLES[3].threadId);
  assert.deepEqual(dispatch.ids, [task.id]);
  assert.equal(boss.claim(), null, '不能在一个活动派发未结束时再次派发');
  boss.markSent({ ids: dispatch.ids, turnId: 'simulated-turn-work-1' });
  const reply = { ids: dispatch.ids, text: '模拟员工原始回复：内容符合约定。', sourceRef: 'simulated://worker/reply-1' };
  boss.complete(reply);
  assert.equal(boss.complete(reply).duplicate, true);
  assert.throws(() => boss.complete({ ...reply, text: '改写的回复' }));
  const job = boss.status().jobs[task.id];
  assert.equal(job.state, 'done');
  assert.equal(job.text, task.text);
  assert.equal(job.result, reply.text);
  const received = boss.messages().filter((item) => item.type === 'message.received');
  assert.equal(received.length, 1);
  assert.equal(received[0].body.text, reply.text);
  assert.equal(received[0].body.sourceRef, reply.sourceRef);
});

test('delivery triggers independent review; report freezes work until an opinion-bound approval', (t) => {
  const { boss } = fixture(t);
  boss.enqueue({ role: 'worker-a', text: '模拟执行任务。', source: 'manager' });
  completeDispatch(boss, { expectedRole: 'worker-a' });
  const delivery = submitDelivery(boss);
  const reviewJobs = Object.values(boss.status().jobs).filter((job) => job.kind === 'review');
  assert.equal(reviewJobs.length, 1);
  assert.equal(reviewJobs[0].role, 'reviewer');
  assert.equal(reviewJobs[0].source, 'worker-a');
  assert.ok(reviewJobs[0].text.includes(delivery.version));
  const reviewer = completeDispatch(boss, { expectedRole: 'reviewer' });
  boss.review({ ...delivery, verdict: 'pass', evidence: '模拟独立原始验证', sourceRef: reviewer.sourceRef });
  const phaseReport = report(boss);
  assert.equal(boss.status().stage.status, 'awaiting_boss');
  assert.equal(phaseReport.version, delivery.version);
  assert.equal(phaseReport.reviewRecord, reviewer.sourceRef);
  assert.throws(() => boss.enqueue({ role: 'worker-a', text: '继续实现下一步' }));
  assert.throws(() => boss.startStage({ ...STAGE, id: 'stage-2' }));
  boss.enqueue({ role: 'technician', kind: 'discussion', text: '模拟 BOSS 提问：解释本轮验证与取舍。', source: 'boss', sourceRef: 'simulated://user/question' });
  completeDispatch(boss, { expectedRole: 'technician' });
  assert.equal(boss.status().stage.status, 'awaiting_boss', '讨论不构成阶段批复');
  assert.throws(() => approve(boss, phaseReport, { opinion: ' ' }));
  assert.throws(() => approve(boss, phaseReport, { userMessageRef: '' }));
  const decision = approve(boss, phaseReport);
  assert.equal(decision.reportId, phaseReport.id);
  assert.equal(decision.version, delivery.version);
  assert.equal(boss.status().stage.status, 'approved');
  boss.startStage({ ...STAGE, id: 'stage-2', title: '模拟第二阶段' });
  assert.equal(boss.status().stage.id, 'stage-2');
  assert.equal(boss.status().stages[0].status, 'approved');
});

test('stale versions and changes to delivered bytes invalidate review, reporting and approval', (t) => {
  const { boss, root } = fixture(t);
  const first = submitDelivery(boss);
  const firstDispatch = completeDispatch(boss, { expectedRole: 'reviewer' });
  assert.throws(() => boss.review({ ...first, version: 'stale-version', verdict: 'pass', evidence: '模拟证据', sourceRef: firstDispatch.sourceRef }));
  writeFileSync(path.join(root, 'artifact.txt'), '模拟改动 v2\n');
  assert.throws(() => boss.review({ ...first, verdict: 'pass', evidence: '模拟证据', sourceRef: firstDispatch.sourceRef }));
  const current = reviewedDelivery(boss);
  assert.notEqual(current.delivery.version, first.version);
  writeFileSync(path.join(root, 'artifact.txt'), '审查后修改 v3\n');
  assert.throws(() => report(boss));
  reviewedDelivery(boss);
  const phaseReport = report(boss);
  assert.throws(() => approve(boss, phaseReport, { version: first.version }));
  assert.throws(() => approve(boss, phaseReport, { reportId: 'old-report' }));
  writeFileSync(path.join(root, 'artifact.txt'), '报告后修改 v4\n');
  assert.throws(() => approve(boss, phaseReport));
  assert.equal(boss.status().stage.status, 'awaiting_boss');
  assert.equal(boss.status().approvals.length, 0);
});

test('a blocked review requires explicit acceptance of each named blocker', (t) => {
  const { boss } = fixture(t);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER] });
  const phaseReport = report(boss);
  assert.equal(phaseReport.reviewVerdict, 'block');
  assert.throws(() => approve(boss, phaseReport));
  assert.throws(() => approve(boss, phaseReport, { acceptedBlockers: ['unrelated-blocker'] }));
  assert.throws(() => approve(boss, phaseReport, { acceptedBlockers: BLOCKER.id }), '字符串不是逐项接受的 ID 数组');
  const approved = approve(boss, phaseReport, { acceptedBlockers: [BLOCKER.id], opinion: '模拟用户明确接受 block-1 的限制，并批准交付。' });
  assert.deepEqual(approved.acceptedBlockers, [BLOCKER.id]);
  assert.equal(boss.status().stage.status, 'approved');
});

test('missing evidence requires explicit acceptance rather than an empty finding list bypass', (t) => {
  const { boss } = fixture(t);
  reviewedDelivery(boss, { verdict: 'needs_evidence' });
  const phaseReport = report(boss);
  assert.throws(() => approve(boss, phaseReport));
  approve(boss, phaseReport, { acceptedBlockers: ['evidence-missing'], opinion: '模拟用户明确接受尚缺验证的交付限制。' });
  assert.equal(boss.status().stage.status, 'approved');
});

test('two review rounds without progress block implementation and preserve escalation evidence', (t) => {
  const { boss } = fixture(t);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.stalled, 1);
  assert.equal(boss.status().stage.status, 'working');
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.stalled, 2);
  assert.equal(boss.status().stage.status, 'blocked');
  assert.throws(() => boss.enqueue({ role: 'worker-a', text: '第三次自动尝试实现' }));
  const phaseReport = report(boss);
  assert.equal(phaseReport.reviewVerdict, 'block');
  assert.equal(boss.messages().filter((entry) => entry.type === 'review.recorded').length, 2);
  boss.enqueue({ role: 'technician', kind: 'discussion', text: '解释停滞原因与可选路径。', source: 'boss' });
  completeDispatch(boss, { expectedRole: 'technician' });
  assert.equal(boss.status().stage.status, 'awaiting_boss');
});

test('a persistent blocker still stops work when other findings change across rounds', (t) => {
  const { boss } = fixture(t);
  const a = { ...BLOCKER, id: 'A' };
  const b = { ...BLOCKER, id: 'B' };
  const c = { ...BLOCKER, id: 'C' };
  reviewedDelivery(boss, { verdict: 'block', findings: [a, b], progress: false });
  assert.equal(boss.status().stage.stalled, 1);
  reviewedDelivery(boss, { verdict: 'block', findings: [a, c], progress: false });
  assert.equal(boss.status().stage.stalled, 2, 'A 连续两轮未推进，新增 C 不应重置 A');
  assert.equal(boss.status().stage.status, 'blocked');
  assert.throws(() => boss.enqueue({ role: 'worker-a', text: '继续第三轮自动修复' }));
});

test('unrelated blockers and a blocker absent from the preceding round do not accumulate', (t) => {
  const { boss } = fixture(t);
  const a = { ...BLOCKER, id: 'A' };
  const b = { ...BLOCKER, id: 'B' };
  for (const finding of [a, b, a]) {
    reviewedDelivery(boss, { verdict: 'block', findings: [finding], progress: false });
    assert.equal(boss.status().stage.stalled, 1);
    assert.equal(boss.status().stage.status, 'working');
  }
});

test('progress, passing review and explicit revision reset blocker streaks', (t) => {
  const { boss } = fixture(t);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: true });
  assert.equal(boss.status().stage.stalled, 0);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.stalled, 1);
  reviewedDelivery(boss, { verdict: 'pass', progress: false });
  assert.equal(boss.status().stage.stalled, 0);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.stalled, 1);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.status, 'blocked');
  const phaseReport = report(boss);
  boss.decide({ reportId: phaseReport.id, version: phaseReport.version, decision: 'revise',
    opinion: '模拟用户明确退回，并授权一次重新开始的修复。', userMessageRef: 'simulated://user/restart-revision' });
  assert.equal(boss.status().stage.stalled, 0);
  reviewedDelivery(boss, { verdict: 'block', findings: [BLOCKER], progress: false });
  assert.equal(boss.status().stage.stalled, 1);
  assert.equal(boss.status().stage.status, 'working');
});

test('missing evidence has a stable streak distinct from a similarly named finding', (t) => {
  const { boss } = fixture(t);
  reviewedDelivery(boss, { verdict: 'block', findings: [{ ...BLOCKER, id: 'evidence-missing' }], progress: false });
  reviewedDelivery(boss, { verdict: 'needs_evidence', progress: false });
  assert.equal(boss.status().stage.stalled, 1, '没有明细的待补证据不能继承一个同名实际问题');
  assert.equal(boss.status().stage.status, 'working');
  reviewedDelivery(boss, { verdict: 'needs_evidence', progress: false });
  assert.equal(boss.status().stage.stalled, 2);
  assert.equal(boss.status().stage.status, 'blocked');
});

test('an uncertain send is not resent after restart; only observed completion releases it', (t) => {
  const f = fixture(t);
  f.boss.enqueue({ id: 'uncertain-work', role: 'worker-a', text: '模拟可能已经送达的工作。' });
  const dispatch = f.boss.claim();
  f.boss.uncertain({ ids: dispatch.ids, reason: '模拟发送已开始，但连接中断，尚未确认结果' });
  assert.equal(f.boss.claim(), null);
  f.close(f.boss);
  const reopened = f.open();
  assert.equal(reopened.status().jobs['uncertain-work'].state, 'uncertain');
  reopened.enqueue({ id: 'uncertain-work', role: 'worker-a', text: '模拟可能已经送达的工作。' });
  assert.equal(reopened.claim(), null);
  assert.throws(() => reopened.markSent({ ids: dispatch.ids, turnId: 'blind-retry-turn' }));
  reopened.complete({ ids: dispatch.ids, text: '模拟补查原聊天后发现的完成回复。', sourceRef: 'simulated://recovered/original-message' });
  assert.equal(reopened.status().jobs['uncertain-work'].state, 'done');
  assert.equal(reopened.messages().filter((item) => item.type === 'dispatch.claimed').length, 1);
});

test('delivery rejects escaping paths, absolute paths and directories without changing stage', (t) => {
  const { boss, root, directory } = fixture(t);
  writeFileSync(path.join(directory, 'outside.txt'), '不能作为项目成果读取');
  mkdirSync(path.join(root, 'folder'));
  const before = boss.status();
  for (const files of [['../outside.txt'], [path.join(directory, 'outside.txt')], ['folder']]) {
    assert.throws(() => submitDelivery(boss, { files }));
    assert.deepEqual(boss.status(), before);
  }
});

test('long original messages remain intact while upstream execution records stay within limits', (t) => {
  const { boss } = fixture(t);
  const taskText = '模拟完整任务说明。'.repeat(70);
  const replyText = '模拟员工完整结果与原始验证记录。'.repeat(70);
  boss.enqueue({ id: 'long-message', role: 'worker-a', text: taskText, source: 'manager', sourceRef: 'simulated://manager/long-task' });
  completeDispatch(boss, { expectedRole: 'worker-a', text: replyText });
  const job = boss.status().jobs['long-message'];
  assert.equal(job.text, taskText);
  assert.equal(job.result, replyText);
  assert.equal(boss.messages().find((item) => item.type === 'message.received').body.text, replyText);
});

test('changed report artifacts block approval but allow an explicit return for revision', (t) => {
  const { boss, root } = fixture(t);
  reviewedDelivery(boss);
  const phaseReport = report(boss);
  writeFileSync(path.join(root, 'artifact.txt'), '模拟报告后出现的改动，需要返工重新验证。');
  assert.throws(() => approve(boss, phaseReport));
  boss.decide({ reportId: phaseReport.id, version: phaseReport.version, decision: 'revise',
    opinion: '模拟用户意见：不批准已变化的成果，退回重做交付和审查。', userMessageRef: 'simulated://user/request-revision' });
  assert.equal(boss.status().stage.status, 'working');
  assert.equal(boss.status().stage.review, null);
  assert.equal(boss.status().stage.report, null);
  const replacement = reviewedDelivery(boss);
  assert.notEqual(replacement.delivery.version, phaseReport.version);
  assert.equal(boss.status().stage.review.verdict, 'pass');
});
