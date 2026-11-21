import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { field, uniqueNames } from './team.mjs';

const active = new Set(['dispatching', 'active', 'uncertain']);
const reserved = job => active.has(job.state) || (job.state === 'queued' && job.loopEvent != null);
const verdicts = ['pass', 'needs_evidence', 'block'];
export const axisNames = { requirements: '需求符合性', quality: '实现质量' };
export const labelVerdict = { pass: '通过', block: '阻断', needs_evidence: '待补证据' };

export function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(label + '须为正整数');
  return value;
}
export function stagePolicy({maxParallel = 1, workLimit, twoPassReview = true, firstProof, uncertainty} = {}) {
  positive(maxParallel, '并行数');
  if (typeof twoPassReview !== 'boolean') throw Error('双项审查设置无效');
  return {maxParallel, twoPassReview, ...(uncertainty!==undefined && {uncertainty:field(uncertainty,'待核实的问题')}), ...(workLimit !== undefined && {workLimit:positive(workLimit,'派工上限')}),
    ...(firstProof !== undefined && {firstProof:field(firstProof,'第一项验证')})};
}
export function workUsed(state) {
  return Object.values(state.jobs).filter(j => j.stageId === state.stage.id && j.kind === 'work').length;
}
export function normalizeScope(scope, root) {
  if (scope === undefined) return undefined;
  if (!scope || !Array.isArray(scope.read) || !Array.isArray(scope.write)) throw Error('并行范围须列出 read 和 write');
  const paths = list => uniqueNames(list,'范围路径').map(path => {
    path = path.replaceAll('\\','/');
    if (path.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\u0000-\u001f]|[. ]$/.test(p)))
      throw Error('范围须为项目内的具体相对路径');
    let current=root;
    for (const part of path.split('/')) {
      current=join(current,part);
      const item=lstatSync(current,{throwIfNoEntry:false});
      if (!item) break;
      if (item.isSymbolicLink() || (item.isFile() && item.nlink>1)) throw Error('链接路径请采用独占派工');
    }
    return path.normalize('NFC').toLowerCase();
  }).sort();
  return {read:paths(scope.read),write:paths(scope.write)};
}
const overlaps = (a,b) => a === b || a.startsWith(b+'/') || b.startsWith(a+'/');
function conflicts(left,right) {
  if (left.threadId === right.threadId || !left.scope || !right.scope) return true;
  const intersects = (writes,others) => writes.some(a => others.some(b => overlaps(a,b)));
  return intersects(left.scope.write,[...right.scope.read,...right.scope.write]) ||
    intersects(right.scope.write,left.scope.read);
}
export function canRoute(state,job) {
  const cap = state.stage?.policy?.maxParallel ?? 1;
  if (cap === 1) return true; // 单槽沿用上游按角色合批的行为。
  const busy = Object.values(state.jobs).filter(reserved);
  return busy.length < cap && !busy.some(other => conflicts(job,other));
}
export function hasSlot(state) {
  const busy = Object.values(state.jobs).filter(j => active.has(j.state));
  return new Set(busy.map(j => j.loopRun?.run ?? j.id)).size < (state.stage?.policy?.maxParallel ?? 1);
}
export function applicable(state,role) {
  const rows = state.agreements ?? [];
  const replaced = new Set(rows.map(row => row.supersedes));
  return rows.filter(row => !replaced.has(row.id) && (!role || !row.roles.length || row.roles.includes(role)));
}
export function kickoff(state,job) {
  const agreements = applicable(state,job.role);
  job.decisionIds = agreements.map(a => a.id);
  const lines = agreements.map(a => '已定（'+a.id+'）：'+a.text+'。出处：'+a.sourceRef);
  if (state.stage.policy?.uncertainty) lines.unshift('待核实：'+state.stage.policy.uncertainty);
  if (state.stage.policy?.firstProof) lines.unshift('本阶段先验证：'+state.stage.policy.firstProof);
  if (job.scope) lines.push('本任务读取：'+(job.scope.read.join('、')||'无')+'。写入：'+(job.scope.write.join('、')||'无')+'。范围变化先交经理重新排期。');
  return lines.length ? '\n\n'+lines.join('\n') : '';
}
export function reviewConclusion(passes) {
  if (!passes?.requirements || !passes.quality) throw Error('当前交付尚缺需求或质量审查');
  return verdicts[Math.max(...Object.values(passes).map(p => verdicts.indexOf(p.verdict)))];
}
export function safeTrace(job) {
  if (!job) throw Error('未找到任务');
  return {id:job.id,stageId:job.stageId,role:job.role,threadId:job.threadId,kind:job.kind,state:job.state,
    queuedAt:job.queuedAt??null,routedAt:job.routedAt??null,sentAt:job.sentAt??null,completedAt:job.completedAt??null,
    task:job.text,event:job.loopEvent,run:job.loopRun?.run ?? null,turn:job.turnId,
    fromJob:job.fromJob ?? null,followup:job.followup ?? null,followupNeeded:job.followupNeeded ?? [],
    decisions:job.decisionIds ?? [],scope:job.scope ?? null,plan:job.modelPlan ?? null,sent:job.sendConfig ?? null,
    evidence:job.workEvidence ?? null,sourceRef:job.sourceRefResult ?? null,checks:job.checks ?? [],passes:job.passes ?? null};
}
export function board(state) {
  if (!state) throw Error('项目尚未初始化');
  const stage=state.stage;
  const jobs=Object.values(state.jobs).filter(j => j.stageId === stage?.id);
  return {project:state.name,stage:stage && {id:stage.id,title:stage.title,status:stage.status,firstProof:stage.policy?.firstProof,
    used:workUsed(state),limit:stage.policy?.workLimit ?? null,maxParallel:stage.policy?.maxParallel ?? 1},
    roles:Object.values(state.roles).map(r=>({id:r.id,title:r.title,threadId:r.threadId,transport:r.transport,
      responsibility:r.profile?.responsibility,lastDelivery:jobs.filter(j=>j.role===r.id && j.state==='done').sort((a,b)=>
        (b.completedAt??'').localeCompare(a.completedAt??''))[0]?.id??null, tasks:jobs.filter(j=>j.role===r.id && (reserved(j)||j.state==='queued')).map(j=>({id:j.id,state:j.state}))})),
    decisions:applicable(state),pending:jobs.flatMap(j=>(j.followupNeeded??[]).map(item=>({jobId:j.id,...item}))),
    latestBrief:state.briefs?.findLast(b=>b.stageId===stage?.id)?.message ?? null};
}
export function nextId(type,jobId,feedbackId) {
  return type+'-'+createHash('sha256').update(JSON.stringify([jobId,feedbackId])).digest('hex').slice(0,24);
}
