import { axisNames, labelVerdict } from '../../src/coordination.mjs';

export const decisions = Object.freeze({approve: '批准', revise: '退回修改', stop: '停止'});
const plain = content => ({tag: 'plain_text', content});
const paragraph = content => ({tag: 'div', text: plain(content)});
const excerpt = value => value.length > 1200 ? value.slice(0, 1199) + '…' : value;

export function reportData(state) {
  const {stage} = state;
  return {project:state.name, stage:stage.title, ...stage.report,
    findings: stage.review.findings.map(f => f.id + '：' + f.requirement),
    missingEvidence: stage.review.verdict !== 'pass' && !stage.review.findings.length};
}

export function briefCard(project,stage,message) {
  return {schema:'2.0',header:{title:plain(project+' · 进度简报')},
    body:{elements:[paragraph(stage),paragraph(message)]}};
}

export function reportCard(report, status, editable) {
  const elements = [];
  if (report.format===2) {
    for (const value of [report.completed,report.verification,report.incomplete,report.next]) elements.push(paragraph(excerpt(value)));
  } else for (const [label, value] of [['完成',report.completed],['未完成',report.incomplete],
    ['验证',report.verification],['下一步',report.next]]) {
    elements.push(paragraph(label + '：' + excerpt(value)));
  }
  elements.push(paragraph('审查：' + ({pass:'通过',block:'有阻断',needs_evidence:'待补证据'}[report.reviewVerdict] ?? report.reviewVerdict)
    + '\n员工记录：' + excerpt(report.employeeReport) + '\n审查记录：' + excerpt(report.reviewRecord)));
  for (const [axis,pass] of Object.entries(report.passes??{})) elements.push(paragraph(axisNames[axis]+'：'+labelVerdict[pass.verdict]+'。'+excerpt(pass.evidence)));
  if (report.reviewOriginal) elements.push(paragraph('审查员原话\n'+excerpt(report.reviewOriginal)));
  if (report.checks?.length) elements.push(paragraph('反馈复测\n'+excerpt(report.checks.map(check=>
    check.feedbackId+'（'+check.version+'）'+({pass:'通过',fail:'未通过',unverified:'未验证'}[check.outcome])+'：'+check.evidence).join('\n'))));
  if (report.findings.length || report.missingEvidence) {
    elements.push(paragraph('未解决项：' + (report.findings.join('\n') || 'evidence-missing：证据不足')));
  }
  elements.push(paragraph(status));
  if (editable) {
    const fields = [
      {tag:'select_static',name:'decision',required:true,placeholder:plain('选择批复决定'),
        options:Object.entries(decisions).map(([value,label])=>({text:plain(label),value}))},
      {tag:'input',name:'opinion',required:true,placeholder:plain('写下批示意见')},
    ];
    if (report.findings.length || report.missingEvidence) fields.push({
      tag:'input',name:'blockers',placeholder:plain('如批准并接受限制，逐项填写 ID，用逗号分隔')});
    fields.push({tag:'button',name:'submit_decision',type:'primary',text:plain('提交批复'),
      form_action_type:'submit',behaviors:[{type:'callback',value:{reportId:report.id, version:report.version}}]});
    elements.push(paragraph('有疑问可以直接引用回复这张卡片。'), {tag:'form',name:'approval',elements:fields});
  }
  return {schema:'2.0',config:{update_multi:true},header:{title:plain(excerpt(report.project + ' · ' + report.stage + (report.format===2?' · 阶段奏折':'')))},
    body:{elements}};
}
