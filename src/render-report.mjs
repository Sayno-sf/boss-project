import { axisNames, labelVerdict } from './coordination.mjs';

const present = value => typeof value === 'string' && value.trim().length > 0;
const body = (value, fallback = '未提供') => present(value) ? value.trim() : fallback;
const inline = value => body(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
const link = (label, value) => present(value)
  ? `[${label}](<${value.trim().replaceAll('\\', '/').replace(/[<>\s]/g, encodeURIComponent)}>)`
  : `${label}：未提供`;

const statuses = {
  working: '进行中', reviewing: '待审', awaiting_boss: '等待 BOSS 批复',
  blocked: '阶段受阻', approved: '已获 BOSS 批复', stopped: '已停止',
};

function renderReview(stage) {
  const { delivery, review, report } = stage;
  if (!review) return ['审查结论：待审（尚无独立审查记录）。'];

  // 只解释状态中的证据绑定；不读取磁盘，不替代独立审查或重新计算成果版本。
  const gaps = [];
  if (stage.status === 'reviewing') gaps.push('当前阶段待审');
  if (!present(delivery?.version) || !present(review.version) || (report && !present(report.version))) {
    gaps.push('缺少成果或审查版本');
  } else if (delivery.version !== review.version || (report && report.version !== delivery.version)) {
    gaps.push('版本不符，需重新审查');
  }
  if (!present(delivery?.evidence) || !present(review.evidence) || (report && !present(report.verification))) {
    gaps.push('缺少验证证据');
  }
  if (!present(delivery?.sourceRef) || !present(review.sourceRef)
      || (report && (!present(report.employeeReport) || !present(report.reviewRecord)))) {
    gaps.push('缺少原文来源');
  }
  if (report && (report.reviewVerdict !== review.verdict
      || (present(report.employeeReport) && report.employeeReport !== delivery?.sourceRef)
      || (present(report.reviewRecord) && report.reviewRecord !== review.sourceRef))) {
    gaps.push('报告与审查记录不一致');
  }
  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (!Array.isArray(review.findings)) gaps.push('缺少未解决项记录');
  if (review.verdict === 'pass' && findings.length) gaps.push('仍有未解决项');

  let conclusion;
  if (review.verdict === 'block') conclusion = '阻断';
  else if (review.verdict === 'needs_evidence') conclusion = '待补证据';
  else if (review.verdict === 'pass') conclusion = gaps.length ? '待核验' : '通过（所提供状态中的版本与证据记录一致）';
  else conclusion = `未知结论（${inline(review.verdict)}）`;
  const lines = [`审查结论：${conclusion}。`];
  if (gaps.length) lines.push(`核验限制：${gaps.join('；')}。`);
  if (review.verdict === 'pass' && gaps.length) lines.push('记录中的结论为 pass，当前不能据此确认通过。');
  lines.push(`审查依据：${body(review.evidence)}`);
  for (const [axis,pass] of Object.entries(review.passes??{})) lines.push(axisNames[axis]+'：'+labelVerdict[pass.verdict]+'。'+body(pass.evidence));
  if (findings.length) {
    lines.push('### 未解决项');
    for (const finding of findings) {
      lines.push(`- ${inline(finding?.id)}：要求：${inline(finding?.requirement)}；证据：${inline(finding?.evidence)}；解除条件：${inline(finding?.release)}。`);
    }
  } else {
    lines.push('未解决项：记录中未列出具体问题。');
  }
  return lines;
}

/** 将 Boss.status() 的快照渲染为中文 Markdown；不修改输入，也不访问文件。 */
export function renderReport(state) {
  if (!state) return '# BOSS 阶段报告\n\n项目尚未初始化。\n';
  const lines = [`# ${inline(state.name)} · 阶段报告`];
  const stage = state.stage;
  if (!stage) return [...lines, '当前状态：尚无阶段。', '尚无阶段报告。', ''].join('\n\n');

  const { delivery, review, report } = stage;
  lines.push(`阶段：${inline(stage.title)}（${inline(stage.id)}）`,
    `当前状态：${statuses[stage.status] ?? `未知状态（${inline(stage.status)}）`}。`);
  if (report?.format===2) {
    lines.push(body(report.completed),body(report.verification),body(report.incomplete),body(report.next));
    lines.push('## 交付记录');
  }
  if (report || delivery) lines.push(`成果版本：${inline(report ? report.version : delivery.version)}`);
  if (report && delivery?.version !== report.version) lines.push(`当前交付版本：${inline(delivery?.version)}`);
  if (review && review.version !== (report?.version ?? delivery?.version)) lines.push(`审查版本：${inline(review.version)}`);

  if (report && report.format!==2) {
    for (const [title, key] of [['完成', 'completed'], ['未完成', 'incomplete'], ['验证', 'verification'], ['下一步', 'next']]) {
      lines.push(`## ${title}`, body(report[key]));
    }
  } else if (!report) {
    lines.push('尚无阶段报告。');
    if (delivery) lines.push(`员工交付说明：${body(delivery.summary)}`, `员工验证依据：${body(delivery.evidence)}`);
  }
  lines.push('## 审查', ...renderReview(stage));
  if (report?.reviewOriginal) lines.push('### 审查员原话',report.reviewOriginal);
  if (report?.checks?.length) {
    lines.push('### 反馈复测记录');
    for (const check of report.checks) lines.push(`- ${inline(check.feedbackId)}（${inline(check.version)}）：${{pass:'通过',fail:'未通过',unverified:'未验证'}[check.outcome]}。 ${body(check.evidence)}`);
  }
  if (report || delivery || review) {
    lines.push('## 原文', link('员工报告原文', report?.employeeReport ?? delivery?.sourceRef),
      link('审查原文', report?.reviewRecord ?? review?.sourceRef));
  }

  // 批复绑定当前报告与版本；接受限制仍保留上面的原审查结论和未解决项。
  const approval = report && Array.isArray(state.approvals)
    ? state.approvals.findLast(item => item.reportId === report.id && item.version === report.version)
    : null;
  if (approval) {
    const decision = { approve: '批准', revise: '退回修改', stop: '停止' }[approval.decision] ?? inline(approval.decision);
    lines.push('## BOSS 批复', `决定：${decision}。`, `意见：${body(approval.opinion)}`);
    if (approval.acceptedBlockers?.length) {
      lines.push(`已接受的限制：${approval.acceptedBlockers.map(inline).join('、')}（仍保留未解决记录）。`);
    }
    lines.push(link('批复原文', approval.userMessageRef));
  } else if (stage.status === 'approved' || stage.status === 'stopped') {
    lines.push('批复依据：未提供与当前报告及版本匹配的批复记录。');
  }
  return `${lines.join('\n\n')}\n`;
}
