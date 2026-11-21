import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boss } from '../src/boss.mjs';
import { renderReport } from '../src/render-report.mjs';

// 离线快照用于验证展示语义，不代表真实聊天、独立审查或用户验收。
function fixture() {
  return {
    name: '报告展示演示', approvals: [],
    stage: {
      id: 'phase1', title: '持久角色协作', status: 'awaiting_boss',
      delivery: { version: 'version-1', summary: '可阅读阶段报告', evidence: '员工测试记录', sourceRef: 'codex://worker/report' },
      review: { version: 'version-1', verdict: 'pass', findings: [], evidence: '独立复查记录', sourceRef: 'codex://reviewer/review' },
      report: { id: 'report-1', version: 'version-1', completed: '已实现中文报告。', incomplete: '真实桌面展示尚未验收。',
        verification: '离线检查通过。', next: '批复后决定后续范围。', employeeReport: 'codex://worker/report',
        reviewRecord: 'codex://reviewer/review', reviewVerdict: 'pass' },
    },
  };
}
const finding = { id: 'evidence-1', requirement: '保留真实验证', evidence: '尚缺运行记录', release: '补充运行证据并复审' };
const noPass = output => assert.doesNotMatch(output, /审查结论：通过|审查通过/);
const noWait = output => assert.doesNotMatch(output, /等待 BOSS 批复/);

test('正常报告显示四项正文、阶段版本、原文链接和等待批复状态', () => {
  const state = fixture();
  const output = renderReport(state);
  for (const text of ['持久角色协作', 'phase1', 'version-1', '等待 BOSS 批复',
    '## 完成', '## 未完成', '## 验证', '## 下一步', ...['completed', 'incomplete', 'verification', 'next'].map(key => state.stage.report[key])]) {
    assert.ok(output.includes(text), text);
  }
  assert.match(output, /审查结论：通过/);
  assert.ok(output.includes('[员工报告原文](<codex://worker/report>)'));
  assert.ok(output.includes('[审查原文](<codex://reviewer/review>)'));
});

test('未初始化与无阶段时不虚构报告、通过或等待批复', () => {
  for (const state of [null, undefined, { name: '新项目', stage: null }]) {
    const output = renderReport(state);
    assert.match(output, state ? /尚无阶段/ : /尚未初始化/);
    noPass(output); noWait(output);
  }
});

for (const [status, label] of [['working', '进行中'], ['reviewing', '待审'], ['blocked', '阶段受阻'], ['stopped', '已停止'], ['future_status', '未知状态（future\\_status）']]) {
  test(`无报告时按实际显示 ${status}，不虚构等待状态`, () => {
    const state = fixture();
    Object.assign(state.stage, { status, report: null, delivery: null, review: null });
    const output = renderReport(state);
    assert.ok(output.includes(label));
    assert.match(output, /尚无阶段报告/);
    noPass(output); noWait(output);
  });
}

test('无报告但已有交付时保留成果版本、验证依据与原文', () => {
  const state = fixture();
  Object.assign(state.stage, { status: 'reviewing', report: null, review: null });
  const output = renderReport(state);
  for (const text of ['version-1', '员工测试记录', 'codex://worker/report', '审查结论：待审']) assert.ok(output.includes(text));
  noPass(output); noWait(output);
});

for (const verdict of ['block', 'needs_evidence']) {
  test(`${verdict} 如实保留审查依据及未解决项`, () => {
    const state = fixture();
    Object.assign(state.stage.review, { verdict, findings: [finding] });
    state.stage.report.reviewVerdict = verdict;
    const output = renderReport(state);
    assert.ok(output.includes(verdict === 'block' ? '审查结论：阻断' : '审查结论：待补证据'));
    for (const text of [...Object.values(finding), '独立复查记录']) assert.ok(output.includes(text));
    noPass(output);
  });
}

test('待补证据即使没有具体问题也不能视为通过', () => {
  const state = fixture();
  state.stage.review.verdict = state.stage.report.reviewVerdict = 'needs_evidence';
  const output = renderReport(state);
  assert.match(output, /待补证据/);
  assert.match(output, /未列出具体问题/);
  noPass(output);
});

for (const [name, alter, reason] of [
  ['待审阶段', s => { s.status = 'reviewing'; }, '待审'],
  ['缺少审查记录', s => { s.review = null; }, '待审'],
  ['缺少交付', s => { s.delivery = null; }, '缺少成果或审查版本'],
  ['缺少交付证据', s => { s.delivery.evidence = ''; }, '缺少验证证据'],
  ['缺少审查证据', s => { s.review.evidence = '  '; }, '缺少验证证据'],
  ['缺少报告验证', s => { delete s.report.verification; }, '缺少验证证据'],
  ['缺少审查来源', s => { delete s.review.sourceRef; }, '缺少原文来源'],
  ['缺少员工原文链接', s => { delete s.report.employeeReport; }, '缺少原文来源'],
  ['缺少未解决项记录', s => { delete s.review.findings; }, '缺少未解决项记录'],
  ['仍有未解决项', s => { s.review.findings = [finding]; }, '仍有未解决项'],
  ['缺少版本', s => { s.report.version = ''; }, '缺少成果或审查版本'],
  ['审查版本不符', s => { s.review.version = 'old-version'; }, '版本不符'],
  ['报告版本不符', s => { s.report.version = 'old-version'; }, '版本不符'],
  ['交付版本不符', s => { s.delivery.version = 'new-version'; }, '版本不符'],
  ['报告结论不符', s => { s.report.reviewVerdict = 'block'; }, '报告与审查记录不一致'],
  ['报告来源不符', s => { s.report.reviewRecord = 'codex://old/review'; }, '报告与审查记录不一致'],
]) {
  test(`${name} 不沿用 pass 结论`, () => {
    const state = fixture();
    alter(state.stage);
    const output = renderReport(state);
    assert.ok(output.includes(reason));
    noPass(output);
  });
}

test('未知审查结论不当作通过', () => {
  const state = fixture();
  state.stage.review.verdict = state.stage.report.reviewVerdict = 'future_verdict';
  const output = renderReport(state);
  assert.ok(output.includes('未知结论（future\\_verdict）'));
  noPass(output);
});

test('批复接受限制后保留阻断原文和问题，不再提示等待批复', () => {
  const state = fixture();
  state.stage.status = 'approved';
  state.stage.review.verdict = state.stage.report.reviewVerdict = 'block';
  state.stage.review.findings = [finding];
  state.approvals = [
    { reportId: 'report-1', version: 'old-version', opinion: '旧意见不能展示' },
    { reportId: 'report-1', version: 'version-1', decision: 'approve', opinion: '接受缺少运行证据的限制。',
      acceptedBlockers: ['evidence-1'], userMessageRef: 'codex://boss/decision' },
    { reportId: 'different-report', version: 'version-1', opinion: '其他报告不能展示' },
  ];
  const output = renderReport(state);
  for (const text of ['已获 BOSS 批复', '接受缺少运行证据的限制。', '已接受的限制：evidence-1', '尚缺运行记录', 'codex://boss/decision']) {
    assert.ok(output.includes(text));
  }
  assert.doesNotMatch(output, /旧意见不能展示|其他报告不能展示/);
  assert.match(output, /审查结论：阻断/);
  noPass(output); noWait(output);
});

test('已批复但缺少匹配依据时显示缺口，不借用旧批复', () => {
  const state = fixture();
  state.stage.status = 'approved';
  state.approvals = [{ reportId: 'old-report', version: 'version-1', opinion: '过期意见' }];
  const output = renderReport(state);
  assert.match(output, /未提供与当前报告及版本匹配的批复记录/);
  assert.doesNotMatch(output, /过期意见/);
  noWait(output);
});

test('Markdown 原文链接保留括号并处理路径空格，正文保留段落', () => {
  const state = fixture();
  state.stage.delivery.sourceRef = state.stage.report.employeeReport = 'D:\\报告 文件\\worker(1).md';
  state.stage.report.completed = '第一段。\n\n第二段。';
  const output = renderReport(state);
  assert.ok(output.includes('[员工报告原文](<D:/报告%20文件/worker(1).md>)'));
  assert.ok(output.includes('第一段。\n\n第二段。'));
});

test('对深度冻结的输入可重复调用，且不修改状态', () => {
  const state = fixture();
  const before = structuredClone(state);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(state);
  assert.equal(renderReport(state), renderReport(state));
  assert.deepEqual(state, before);
});

test('使用真实 Boss.status() 返回值验证交付、待审、报告、批复和停止', t => {
  const root = mkdtempSync(join(tmpdir(), 'boss-render-test-'));
  const boss = new Boss(root);
  t.after(() => { boss.close(); rmSync(root, { recursive: true, force: true }); });
  assert.match(renderReport(boss.status()), /尚未初始化/);
  boss.init('离线展示集成');
  assert.match(renderReport(boss.status()), /尚无阶段/);
  for (const id of ['worker', 'reviewer']) boss.bindRole({ id, kind: id, title: id, threadId: `fixture-${id}` });
  boss.startStage({ id: 'phase1', title: '离线展示验证', goal: '验证实际字段', acceptance: ['报告准确显示状态'] });
  noWait(renderReport(boss.status()));
  writeFileSync(join(root, 'result.txt'), 'offline fixture');
  const shot = boss.deliver({ role: 'worker', summary: '离线结果', files: ['result.txt'], evidence: '离线检查', sourceRef: 'fixture:worker' });
  noPass(renderReport(boss.status()));
  const job = boss.claim();
  boss.markSent({ ids: job.ids, turnId: 'fixture-turn' });
  boss.complete({ ids: job.ids, text: '离线审查回复', sourceRef: 'fixture:review' });
  boss.review({ ...shot, verdict: 'pass', evidence: '离线复查依据', sourceRef: 'fixture:review' });
  const report = boss.report({ completed: '离线完成', incomplete: '真实聊天未验证', verification: '离线通过', next: '等待批示', sourceRef: 'fixture:report' });
  const waiting = renderReport(boss.status());
  assert.match(waiting, /等待 BOSS 批复/);
  assert.match(waiting, /审查结论：通过/);
  boss.decide({ reportId: report.id, version: report.version, decision: 'approve', opinion: '离线模拟批复', userMessageRef: 'fixture:approval' });
  const approved = renderReport(boss.status());
  assert.match(approved, /已获 BOSS 批复/);
  assert.match(approved, /离线模拟批复/);
  noWait(approved);
  boss.startStage({ id: 'phase2-fixture', title: '离线停止验证', goal: '验证停止', acceptance: ['不显示等待'] });
  const nextShot = boss.deliver({ role: 'worker', summary: '离线结果', files: ['result.txt'], evidence: '离线检查', sourceRef: 'fixture:worker' });
  const nextJob = boss.claim();
  boss.markSent({ ids: nextJob.ids, turnId: 'fixture-next-turn' });
  boss.complete({ ids: nextJob.ids, text: '离线审查回复', sourceRef: 'fixture:review' });
  boss.review({ ...nextShot, verdict: 'pass', evidence: '离线复查依据', sourceRef: 'fixture:review' });
  const nextReport = boss.report({ completed: '离线完成', incomplete: '无新增项', verification: '离线检查', next: '建议停止', sourceRef: 'fixture:report2' });
  boss.decide({ reportId: nextReport.id, version: nextReport.version, decision: 'stop', opinion: '离线模拟停止', userMessageRef: 'fixture:stop' });
  const stopped = renderReport(boss.status());
  assert.match(stopped, /当前状态：已停止/);
  assert.match(stopped, /决定：停止/);
  noWait(stopped);
});
