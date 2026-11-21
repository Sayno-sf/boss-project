import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { BossStore } from './store.mjs';
import { Autoloop } from './autoloop.mjs';
import { snapshot } from './snapshot.mjs';
import { parseEvent } from '../vendor/agent-autoloop/protocol/validate.ts';
import { deliveryEvidence, field, jobNotes, pinSkill, readPin, selectPins, stableRecord, uniqueNames } from './team.mjs';
import { applicable, axisNames, board, canRoute, hasSlot, kickoff, nextId, normalizeScope, positive, reviewConclusion, safeTrace, stagePolicy, workUsed } from './coordination.mjs';
import { renderReport } from './render-report.mjs';

const KINDS = new Set(['technician', 'manager', 'reviewer', 'worker']);
const clip = (value, count) => [...value].slice(0, count).join('');
const nonempty = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}不能为空`); return value.trim(); };
const needed = state => { if (!state) throw new Error('项目尚未初始化'); return state; };
const stageOf = state => { needed(state); if (!state.stage) throw new Error('没有当前阶段'); return state.stage; };
const roleOf = (state, id) => { if (!Object.hasOwn(needed(state).roles, id)) throw new Error(`角色不存在：${id}`); return state.roles[id]; };
const inFlight = new Set(['dispatching', 'active', 'uncertain']);
const terminal = new Set(['done', 'held', 'failed', 'cancelled']);
const allowed = (stage, job, role) => job.stageId === stage.id &&
  (job.kind === 'discussion' || (!(role?.kind === 'manager' && job.kind === 'work') &&
    !['awaiting_boss', 'blocked', 'approved', 'stopped'].includes(stage.status)));
const routeEvent = job => parseEvent({
  id: job.routingId ?? job.id, type: `role.${job.role}`, subject: job.routingId ?? job.id,
  summary: clip(job.text, 180), detail: `完整原文见 BOSS message.queued 事件 ${job.id}`,
});
const routeProblem = job => { try { routeEvent(job); return null; } catch (error) { return error.message; } };
const routingSource = job => job.single || job.modelPlan || job.submissionId || job.routingId || job.handoff || job.skills?.length || job.regressions?.length ? 'boss-single' : 'boss';
const modelFields = (value, name, host = false) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['model', 'thinking', ...(host ? ['hostId'] : [])].includes(key))) {
    throw new Error(`${name}格式无效`);
  }
  const model = nonempty(value.model, `${name}模型`);
  if (value.thinking !== undefined && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(value.thinking))
    throw new Error(`${name}推理强度无效`);
  return { model, ...(value.thinking !== undefined && { thinking: value.thinking }),
    ...(value.hostId !== undefined && { hostId: nonempty(value.hostId, '宿主 ID') }) };
};
const materialsOf = materials => {
  if (materials === undefined) return undefined;
  if (!Array.isArray(materials)) throw new Error('任务材料必须为数组');
  return materials.map(item => {
    const path = nonempty(item?.path, '材料路径').replaceAll('\\', '/');
    if (/^(\/|[a-z]:)/i.test(path) || path.split('/').some(part => part === '..'))
      throw new Error('材料路径必须位于项目内');
    return { path, version: nonempty(item.version, '材料版本') };
  });
};
function queueJob(state, log, stage, target, fields) {
  if (Object.hasOwn(state.jobs,fields.id)) throw Error('任务 ID 已占用：'+fields.id);
  if (fields.kind==='work' && stage.policy?.workLimit && workUsed(state)>=stage.policy.workLimit) throw Error('已达到本阶段派工上限');
  const job = { ...fields, ...(stage.policy?.maxParallel>1 && {single:true}), role: target.id, threadId: target.threadId, stageId: stage.id,
    queuedAt:new Date().toISOString(), state: 'queued', loopEvent: null, loopRun: null, turnId: null, result: null };
  routeEvent(job);
  Object.defineProperty(state.jobs, job.id, { value: job, enumerable: true, writable: true, configurable: true });
  log('message.queued', job);
  return job;
}
const batch = (state, ids) => {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('需要完整且不重复的任务 ID 集合');
  const jobs = ids.map(id => state.jobs[id]);
  if (jobs.some(j => !j?.loopRun) || new Set(jobs.map(j => j.loopRun.run)).size !== 1) throw new Error('任务不属于同一派工批次');
  const all = Object.values(state.jobs).filter(j => j.loopRun?.run === jobs[0].loopRun.run);
  if (all.length !== ids.length || all.some(j => !ids.includes(j.id))) throw new Error('回执必须覆盖完整派工批次');
  return jobs;
};

/** BOSS 的控制面。真实模型执行由 Codex 原生聊天工具接续；这里不冒充用户批复。 */
export class Boss {
  constructor(root, { stateDir = join(root, '.boss'), readOnly = false } = {}) {
    this.root = resolve(root); this.stateDir = resolve(stateDir);
    if (readOnly) {
      this.store = new BossStore(join(this.stateDir, 'boss.db'), { readOnly: true });
      return;
    }
    mkdirSync(this.stateDir, { recursive: true });
    this.store = new BossStore(join(this.stateDir, 'boss.db'));
    this.loop = new Autoloop(join(this.stateDir, 'autoloop.db'));
  }
  init(name) {
    return this.store.change((state, log) => {
      if (state) { if (state.root !== this.root) throw new Error('状态目录属于其他项目'); return { value: state }; }
      const initialState = { schema: 1, id: randomUUID(), name: nonempty(name, '项目名称'), root: this.root,
        roles: {}, stage: null, stages: [], jobs: {}, approvals: [] };
      log('project.created', { name, root: this.root }); return { initialState, value: initialState };
    });
  }
  status() { return this.store.read(); }
  messages(after = 0) { return this.store.events(after); }
  reportView() { return renderReport(this.status()); }
  bindRole({ id, kind, title, threadId }) {
    if (!/^[a-z][a-z0-9-]{0,58}$/.test(id) || Object.hasOwn(Object.prototype, id) || !KINDS.has(kind)) throw new Error('角色标识或类型无效');
    nonempty(threadId, '聊天 ID'); nonempty(title, '角色名称');
    const value = this.store.change((state, log) => {
      needed(state);
      if (state.roles[id]) {
        if (state.roles[id].threadId !== threadId || state.roles[id].kind !== kind) throw new Error('已有角色不能静默换聊天或身份');
        return { value: state.roles[id] };
      }
      if (Object.values(state.roles).some(role => role.threadId === threadId)) throw new Error('一个聊天不能兼任不同角色');
      if (kind !== 'worker' && Object.values(state.roles).some(role => role.kind === kind)) throw new Error('固定角色已存在');
      state.roles[id] = { id, kind, title, threadId, transport: 'codex-desktop-relay' };
      log('role.bound', state.roles[id]); return { value: state.roles[id] };
    });
    this.configure(); return value;
  }
  profile({role,specialty,responsibility,skills=[]}) {
    const pins=skills.map(skill=>pinSkill(this,skill));
    uniqueNames(pins.map(pin=>pin.name),'名册技能');
    const profile={specialty:field(specialty,'岗位'),responsibility:field(responsibility,'职责'),skills:pins};
    return this.store.change((state,log)=>{
      const target=roleOf(state,role);
      if (JSON.stringify(target.profile)!==JSON.stringify(profile)) {
        target.profile=profile;
        log('role.profile',{role,profile});
      }
      return {value:profile};
    });
  }
  readSkill({jobId,name}) {
    return this.store.change((state,log)=>{
      const job=state?.jobs[jobId];
      if (!job || !['dispatching','active','uncertain'].includes(job.state) || job.threadId!==process.env.CODEX_THREAD_ID)
        throw Error('须在执行该任务的原员工聊天中读取');
      const pin=job.skills?.find(item=>item.name===name);
      if (!pin) throw Error('任务未指定该技能');
      const content=readPin(this,pin);
      job.skillReads??=[];
      if (!job.skillReads.some(item=>item.digest===pin.digest && item.name===name)) {
        const receipt={name,version:pin.version,digest:pin.digest,threadId:job.threadId,at:new Date().toISOString()};
        job.skillReads.push(receipt);log('skill.read',{jobId,...receipt});
      }
      return {value:content};
    });
  }
  brief({id,stageId,message,sourceRef}) {
    const row={id:field(id,'简报 ID'),stageId:field(stageId,'阶段'),message:field(message,'进展'),sourceRef:field(sourceRef,'进展依据')};
    if (row.message.length>1500) throw Error('进展简报限 1500 字');
    return this.store.change((state,log)=>{
      const stage=stageOf(state);
      state.briefs??=[];
      if (state.briefs.some(item=>item.id===row.id)) return {value:stableRecord(state.briefs,row)};
      if (stage.id!==stageId || !['working','reviewing','blocked'].includes(stage.status)) throw Error('请在当前阶段交正式报告前发进展简报');
      stableRecord(state.briefs,row);log('stage.brief',row);
      return {value:row};
    });
  }
  feedback({id,category,text,sourceRef,owner,scenario,expected}) {
    if (!['defect','change','experience'].includes(category)) throw Error('反馈类型无效');
    const row={id:field(id,'反馈 ID'),category,text:field(text,'反馈原文'),sourceRef:field(sourceRef,'反馈出处'),owner};
    if (category==='defect' || scenario!==undefined || expected!==undefined) {
      row.scenario=field(scenario,'复现动作');row.expected=field(expected,'预期结果');
    }
    return this.store.change((state,log)=>{
      roleOf(state,owner);state.feedback??=[];
      const previous=state.feedback.some(item=>item.id===row.id);
      const saved=stableRecord(state.feedback,row);
      if (!previous) log('feedback.recorded',{stageId:state.stage?.id,...row});
      return {value:saved};
    });
  }
  regression({jobId,feedbackId,outcome,evidence,version}) {
    if (!['pass','fail','unverified'].includes(outcome)) throw Error('回归结果无效');
    return this.store.change((state,log)=>{
      const job=state?.jobs[jobId];
      if (job?.terminationIntent || job?.completionIntent || !job?.regressions?.some(check=>check.id===feedbackId) || job.threadId!==process.env.CODEX_THREAD_ID ||
          !['dispatching','active','uncertain'].includes(job.state)) throw Error('须由已分配此回归的原员工记录');
      const result={feedbackId,outcome,evidence:field(evidence,'实际结果或未测原因'),version:field(version,'所测版本')};
      job.checks??=[];
      const last=job.checks.findLast(item=>item.feedbackId===feedbackId);
      if (!last || last.outcome!==outcome || last.evidence!==result.evidence || last.version!==result.version) {
        state.checkSequence=(state.checkSequence??0)+1;
        job.checks.push({...result,sequence:state.checkSequence});log('feedback.checked',{jobId,...result});
      }
      return {value:result};
    });
  }
  latestChecks(state) {
    const latest=new Map();
    for (const job of Object.values(state.jobs)) {
      if (job.stageId!==state.stage.id || job.state!=='done') continue;
      for (const check of job.checks??[]) {
        const prior=latest.get(check.feedbackId);
        if (!prior || (prior.check.sequence??0)<=(check.sequence??0)) latest.set(check.feedbackId,{job,check});
      }
    }
    return latest;
  }
  openRegressions(state) {
    return [...this.latestChecks(state).values()].filter(({check})=>check.outcome!=='pass');
  }
  resumePending(state,log) {
    for (const job of Object.values(state.jobs)) {
      if (job.stageId===state.stage.id && job.followupNeeded?.length) this.scheduleFollowups(state,log,job);
    }
  }
  scheduleFollowups(state,log,job) {
    const stage=stageOf(state);
    if (!stage.policy || !['working','reviewing'].includes(stage.status) || job.kind!=='work' || job.stageId!==stage.id) return;
    const repair=job.followup?.type==='fix';
    const latest=this.latestChecks(state);
    const checks=repair ? [job.followup.feedbackId] : [...new Set((job.checks??[]).map(c=>c.feedbackId))];
    const origin=state.jobs[repair || job.followup?.type==='retest' ? job.followup.origin : job.fromJob];
    const knownOwner=origin?.stageId===stage.id && state.roles[origin?.role]?.kind==='worker' && origin.kind==='work';
    job.followupNeeded=[];
    for (const feedbackId of checks) {
      const failure=latest.get(feedbackId);
      if (failure?.check.outcome!=='fail' || failure.job.id!==(repair?job.followup.failedJob:job.id)) continue;
      const tester=repair?job.followup.tester:job.role;
      if (!knownOwner || tester===origin.role || state.roles[tester]?.kind!=='worker') {
        job.followupNeeded.push({feedbackId,reason:'confirm_owner'});
        log('regression.needs_manager',{jobId:job.id,feedbackId,reason:'confirm_owner'});
        continue;
      }
      const type=repair?'retest':'fix',id=nextId(type,job.id,feedbackId);
      if (state.jobs[id]?.followup?.parent===job.id) continue;
      const attempt=(job.followup?.attempt??0)+(repair?0:1);
      if (attempt>2 || (stage.policy.workLimit && workUsed(state)>=stage.policy.workLimit)) {
        const reason=attempt>2?'review_required':'work_limit';
        job.followupNeeded.push({feedbackId,reason});
        log('regression.needs_manager',{jobId:job.id,feedbackId,reason});
        continue;
      }
      const scenario=failure.job.regressions.find(r=>r.id===feedbackId);
      const followup={type,parent:job.id,origin:origin.id,failedJob:failure.job.id,feedbackId,tester,attempt};
      const incoming={from:job.role,sourceRef:job.sourceRefResult,...job.workEvidence};
      const target=roleOf(state,repair?tester:origin.role);
      queueJob(state,log,stage,target,{id,kind:'work',source:'regression',sourceRef:job.sourceRefResult,fromJob:job.id,incoming,followup,
        text:(repair?'请用原场景复测修复。':'请修复原任务 '+origin.id+' 的问题。')+'反馈 '+feedbackId+'：'+scenario.scenario+'。预期：'+scenario.expected+'。上次实际结果：'+failure.check.evidence+'（'+failure.check.version+'）。',
        ...(repair?{regressions:[scenario]}:{handoff:{to:tester,acceptance:scenario.expected,output:'修复产物及验证方法'}}),
        ...((repair?failure.job:origin).scope && {scope:(repair?failure.job:origin).scope}),
        ...((repair?failure.job:origin).modelPlan && {modelPlan:(repair?failure.job:origin).modelPlan}),
        ...((repair?failure.job:origin).skills?.length && {skills:(repair?failure.job:origin).skills})});
      log('regression.followup',{id,...followup});
    }
  }
  configure() {
    const state = needed(this.status());
    const agents = Object.fromEntries(Object.values(state.roles).map(role => [role.id,
      { name: role.title, worker: 'boss-desktop', use: 'codex', access: role.kind === 'worker' ? 'edit' : 'read' }]));
    const rules = Object.values(state.roles).map(role => ({ name: role.id,
      when: { source: 'boss', types: [`role.${role.id}`] }, to: role.id, cwd: this.root,
      group: role.id, tell: 'never', resume: true, prompt: '由 BOSS 插件将任务原文投递到已绑定的 Codex 持久聊天；遵守当前阶段门禁。' }));
    const singles = rules.map(rule => {
      const name = `single-${createHash('sha256').update(rule.name).digest('hex')}`;
      return { ...rule, name, group: name, when: { ...rule.when, source: 'boss-single' }, parallel: 1 };
    });
    this.loop.configure({ timezone: 'Asia/Shanghai', sources: { boss: { name: 'BOSS 插件' }, 'boss-single': { name: 'BOSS 单任务' } },
      agents, channels: {}, askFirst: ['阶段报告后的下一阶段工作'], rules: [...rules, ...singles], elsewhere: [] });
  }
  teamBoard() { return board(this.status()); }
  trace({id}) {
    const jobs=needed(this.status()).jobs;
    return safeTrace(Object.hasOwn(jobs,id) && jobs[id]);
  }
  agreement({id,text,sourceRef,roles=[],supersedes}) {
    const row={id:field(id,'决定 ID'),text:field(text,'决定内容'),sourceRef:field(sourceRef,'原话出处'),roles:uniqueNames(roles,'适用角色').sort(),
      ...(supersedes!==undefined && {supersedes:field(supersedes,'被替代决定')})};
    return this.store.change((state,log)=>{
      needed(state); state.agreements??=[];
      for (const role of row.roles) roleOf(state,role);
      const priorRow=state.agreements.find(item=>item.id===row.id);
      if (priorRow && priorRow.supersedes!==row.supersedes) throw Error('同一决定 ID 的替代关系冲突');
      if (priorRow) return {value:stableRecord(state.agreements,row)};
      if (row.supersedes) {
        const prior=applicable(state).find(item=>item.id===row.supersedes);
        if (!prior || JSON.stringify(prior.roles)!==JSON.stringify(row.roles)) throw Error('只能替代适用角色相同的现行决定');
      }
      state.agreements.push(row);log('agreement.recorded',row);return {value:row};
    });
  }
  raiseLimit({stageId,workLimit,opinion,sourceRef}) {
    positive(workLimit,'派工上限');
    const proof={stageId,workLimit,opinion:field(opinion,'BOSS 意见'),sourceRef:field(sourceRef,'批示出处')};
    return this.store.change((state,log)=>{
      const stage=stageOf(state);
      if (stage.id!==stageId || !['working','reviewing'].includes(stage.status) || !stage.policy?.workLimit) throw Error('当前阶段不能追加派工额度');
      if (workLimit===stage.policy.workLimit && JSON.stringify(stage.lastIncrease)===JSON.stringify(proof)) return {value:proof};
      if (workLimit<=stage.policy.workLimit) throw Error('新上限须高于当前上限');
      stage.policy.workLimit=workLimit;stage.lastIncrease=proof;log('stage.limit_raised',proof);
      this.resumePending(state,log);
      return {value:proof};
    });
  }
  reviewPass({jobId,axis,verdict,evidence}) {
    if (!Object.hasOwn(axisNames,axis) || !['pass','block','needs_evidence'].includes(verdict)) throw Error('审查项目或结论无效');
    return this.store.change((state,log)=>{
      const stage=stageOf(state), job=state.jobs[jobId];
      if (!job?.submissionId || job.id!==stage.delivery?.reviewTaskId || !inFlight.has(job.state) ||
          job.threadId!==process.env.CODEX_THREAD_ID || stage.status!=='reviewing' || job.completionIntent || job.terminationIntent)
        throw Error('须在当前交付的原审查员聊天中记录');
      job.passes??={};
      if (axis==='quality' && !job.passes.requirements) throw Error('先核对需求符合性');
      const row={verdict,evidence:field(evidence,'审查依据')};
      if (job.passes[axis] && JSON.stringify(job.passes[axis])!==JSON.stringify(row)) throw Error('本次交付已登记不同的审查记录');
      if (!job.passes[axis]) {job.passes[axis]=row;log('review.axis',{jobId,version:job.version,axis,...row});}
      return {value:row};
    });
  }
  startStage({ id, title, goal, acceptance, policy }) {
    nonempty(id, '阶段 ID'); nonempty(title, '阶段名称'); nonempty(goal, '目标');
    if (!Array.isArray(acceptance) || !acceptance.length || acceptance.some(x => typeof x !== 'string' || !x.trim())) throw new Error('需要可验证的验收条件');
    return this.store.change((state, log) => {
      needed(state);
      if (state.stage && state.stage.status !== 'approved') throw new Error('当前阶段尚未得到 BOSS 批复，不能开始下一阶段');
      if (state.stages.some(x => x.id === id) || state.stage?.id === id) throw new Error('阶段 ID 已存在');
      if (Object.values(state.jobs).some(x => !terminal.has(x.state))) throw new Error('仍有未结束任务');
      if (state.stage) state.stages.push(state.stage);
      state.stage = { id, title, goal, acceptance, ...(policy!==undefined && {policy:stagePolicy(policy)}), status: 'working', delivery: null, review: null, report: null, stalled: 0, stalledByBlocker: {} };
      log('stage.started', state.stage); return { value: state.stage };
    });
  }
  enqueue({ role, text, kind = 'work', source = 'coordinator', sourceRef = null, id = randomUUID(), modelPlan, materials, skillNames=[], handoff, feedbackIds=[], fromJob, scope }) {
    nonempty(text, '任务内容');
    routeEvent({ id, role, text });
    if (/^(fix|retest)-[a-f0-9]{24}$/.test(id)) throw Error('该任务 ID 前缀用于自动复测');
    modelPlan = modelFields(modelPlan, '计划发送配置');
    materials = materialsOf(materials);
    scope=normalizeScope(scope,this.root);
    skillNames=uniqueNames(skillNames,'任务技能'); feedbackIds=uniqueNames(feedbackIds,'回归 ID');
    if (handoff!==undefined) handoff={acceptance:field(handoff.acceptance,'验收动作'),to:field(handoff.to,'交接对象'),output:field(handoff.output,'预期产物')};
    if (!['work', 'review', 'discussion', 'report'].includes(kind)) throw new Error('任务类型无效');
    const job = this.store.change((state, log) => {
      const target = roleOf(state, role); const stage = stageOf(state);
      if (Object.hasOwn(state.jobs, id)) {
        const existing = state.jobs[id];
        if (JSON.stringify(existing.scope)!==JSON.stringify(scope) || existing.fromJob!==fromJob || existing.text !== text || existing.role !== role || existing.kind !== kind ||
            existing.source !== source || existing.sourceRef !== sourceRef ||
            JSON.stringify(existing.modelPlan) !== JSON.stringify(modelPlan) ||
            JSON.stringify(existing.materials) !== JSON.stringify(materials) || JSON.stringify(existing.handoff)!==JSON.stringify(handoff) ||
            JSON.stringify(existing.skills?.map(s=>s.name)??[])!==JSON.stringify(skillNames) ||
            JSON.stringify(existing.regressions?.map(f=>f.id)??[])!==JSON.stringify(feedbackIds)) throw new Error('同一事件 ID 的内容冲突');
        return { value: existing };
      }
      if (!allowed(stage, { stageId: stage.id, kind }))
        throw new Error('阶段等待批复或已结束，只允许讨论与解释');
      if (target.kind === 'manager' && kind === 'work')
        throw new Error('请直接启动原经理聊天进行调度；普通任务槽不用于启动经理');
      if (kind === 'review' && target.kind !== 'reviewer') throw new Error('审查任务只能派给独立审查员');
      if (kind === 'work' && target.kind === 'reviewer') throw new Error('审查员不承担实现工作');
      if (handoff) roleOf(state,handoff.to);
      let incoming;
      if (fromJob!==undefined) {
        const prior=state.jobs[field(fromJob,'前序任务')];
        if (prior?.state!=='done' || prior.handoff?.to!==role || !prior.workEvidence) throw Error('前序任务尚未交付给此员工');
        incoming={from:prior.role,sourceRef:prior.sourceRefResult,...prior.workEvidence};
      }
      const skills=selectPins(target.profile,skillNames);
      const regressions=feedbackIds.map(key=>{
        const feedback=state.feedback?.find(item=>item.id===key);
        if (!feedback?.scenario) throw Error('反馈尚无回归场景：'+key);
        return {id:key,scenario:feedback.scenario,expected:feedback.expected};
      });
      return { value: queueJob(state, log, stage, target, { id, text, kind, source, sourceRef, modelPlan, materials,
        ...(scope && {scope}),...(incoming && {fromJob,incoming}),...(skills.length && {skills}),...(handoff && {handoff}),...(regressions.length && {regressions}) }) };
    });
    this.flush(); return job;
  }
  /** 提交到上游采用稳定事件 ID；崩溃后重复 flush 也不会重复派活。 */
  flush() {
    this.configure();
    for (const job of Object.values(needed(this.status()).jobs).filter(x => x.state === 'queued' && !x.loopEvent)) {
      this.store.change((state, log) => {
        const current = state.jobs[job.id];
        if (current.state !== 'queued' || current.loopEvent) return;
        if (!canRoute(state,current)) return;
        const problem = routeProblem(current);
        if (problem) {
          current.state = 'failed';
          current.termination = { reason: problem, confirmation: 'not_routable', evidence: '上游事件字段校验' };
          log('dispatch.closed', { ids: [current.id], outcome: 'failed', ...current.termination });
          return;
        }
        const event = this.loop.ingest(routingSource(current), routeEvent(current));
        current.routedAt=new Date().toISOString(); current.loopEvent = event.event; log('event.routed', { id: current.id, event });
      });
    }
  }
  recoverGate() {
    return this.store.change((state, log) => {
      const gate = needed(state).gateIntent;
      if (!gate) return { value: false };
      this.loop.finish(gate.native.run, gate.native.token, { outcome: 'cancelled', summary: '阶段门禁关闭，未向聊天派发。' });
      const stage = stageOf(state);
      for (const id of gate.ids) {
        const job = state.jobs[id];
        if (allowed(stage, job, state.roles[job.role])) {
          // 新路由事件使用独立 lane，原任务 ID 与历史保持不变。
          job.routingId = `reroute-${randomUUID()}`;
          job.loopEvent = null; job.loopRun = null; job.state = 'queued';
          log('dispatch.requeued', { id, previousRun: gate.native.run, routingId: job.routingId });
        } else {
          job.state = 'held';
          log('dispatch.held', { ids: [id], reason: '阶段门禁关闭或经理须直接启动' });
        }
      }
      delete state.gateIntent;
      return { value: true };
    });
  }
  recoverLegacyGate(state, log) {
    const queued = Object.values(state.jobs).filter(job => job.state === 'queued' && job.loopEvent);
    if (!queued.length) return;
    const { tables } = this.loop.snapshot();
    const oldCancellations = new Set(Object.values(tables.runs)
      .filter(run => run.state === 'cancelled' && run.summary === '阶段门禁关闭，保留任务原文，未向聊天派发。')
      .map(run => run.id));
    const cancelledEvents = new Set(Object.values(tables.run_events)
      .filter(link => oldCancellations.has(link.run_id)).map(link => link.event_id));
    const stage = stageOf(state);
    for (const job of queued) {
      if (!cancelledEvents.has(job.loopEvent)) continue;
      if (allowed(stage, job, state.roles[job.role])) {
        job.routingId = `reroute-${randomUUID()}`;
        job.loopEvent = null;
        log('dispatch.requeued', { id: job.id, reason: '恢复旧版门禁取消', routingId: job.routingId });
      } else {
        job.state = 'held';
        log('dispatch.held', { ids: [job.id], reason: '恢复旧版门禁取消' });
      }
    }
  }
  claim() {
    if (this.status()?.gateIntent) this.recoverGate();
    this.flush();
    // 已指定并行策略时，flush 仅向上游提交已取得范围和聊天名额的任务。
    // 跨两个数据库不能假装原子提交：先持久化认领意图，崩溃后使用同一 claim 重取上游令牌。
    this.store.change((state) => {
      needed(state);
      if (hasSlot(state))
        state.claimIntent ??= randomUUID();
    });
    const result = this.store.change((state, log) => {
      needed(state);
      if (!hasSlot(state) || !state.claimIntent) return { value: null };
      const native = this.loop.claim('boss-desktop', state.claimIntent);
      if (!native) {
        this.recoverLegacyGate(state, log);
        state.claimIntent = null;
        return { value: null };
      }
      const eventKeys = native.context.events.map(e => e.id);
      const candidates = Object.values(state.jobs).filter(j => eventKeys.includes(j.routingId ?? j.id) && j.state === 'queued');
      if (candidates.length !== eventKeys.length) throw new Error('上游任务缺少本地 outbox 对应记录，需检查后恢复');
      const stage = stageOf(state);
      const jobs = candidates.map(j => state.jobs[j.id]);
      for (const job of jobs) { job.state = 'dispatching'; job.loopRun = native; }
      state.claimIntent = null;
      const ids = jobs.map(j => j.id);
      if (jobs.some(j => !allowed(stage, j, state.roles[j.role]))) {
        state.gateIntent = { ids, native };
        return { value: null };
      }
      const text = jobs.map(j => {
        const materials = j.materials?.map(item => `- ${item.path}（版本 ${item.version}）`).join('\n');
        return `[来源：${j.source}；类型：${j.kind}；阶段：${j.stageId}；事件：${j.id}]\n${j.text}` +
          (materials ? `\n\n工作材料：\n${materials}` : '') + jobNotes(j) + kickoff(state,j);
      }).join('\n\n');
      const result = { ids, role: jobs[0].role, threadId: jobs[0].threadId, text, run: native.run,
        ...(jobs[0].modelPlan && { modelPlan: jobs[0].modelPlan }) };
      log('dispatch.claimed', result); return { value: result };
    });
    if (!result && this.status()?.gateIntent) this.recoverGate();
    return result;
  }
  claimStatus() {
    let jobs = Object.values(needed(this.status()).jobs);
    for (;;) {
      const heldBefore = jobs.filter(job => job.state === 'held').length;
      const result = this.claim();
      if (result) return { status: 'claimed', ...result };
      jobs = Object.values(needed(this.status()).jobs);
      const active = jobs.filter(job => inFlight.has(job.state));
      if (active.length) return { status: 'blocked', reason: 'in_flight', ids: active.map(job => job.id) };
      const queued = jobs.filter(job => job.state === 'queued');
      if (!queued.length) return { status: 'empty' };
      if (jobs.filter(job => job.state === 'held').length === heldBefore &&
          queued.some(job => job.loopEvent)) {
        return { status: 'blocked', reason: 'queued', ids: queued.map(job => job.id) };
      }
    }
  }
  markSent({ ids, turnId, sendConfig, evidence }) {
    nonempty(turnId, '真实轮次 ID');
    sendConfig = modelFields(sendConfig, '实际发送配置', true);
    return this.store.change((state, log) => {
      batch(state, ids);
      if (state.gateIntent) throw new Error('门禁正在恢复，不允许发送');
      for (const id of ids) {
        const job = state.jobs[id];
        if (!['dispatching','uncertain'].includes(job.state)) throw new Error('任务不是待发送或待核查状态');
        if (job.state === 'uncertain') nonempty(evidence, '核实已发送的宿主证据');
        if (job.turnId && job.turnId !== turnId) throw new Error('已记录的轮次 ID 不符');
        if (job.terminationIntent || job.completionIntent) throw new Error('任务正在结案');
        if (job.modelPlan && !sendConfig) throw new Error('请记录本次宿主调用实际使用的发送配置');
        job.state = 'active'; job.turnId = turnId; job.sentAt??=new Date().toISOString();
        if (sendConfig) job.sendConfig = sendConfig;
      }
      log('dispatch.sent', { ids, turnId, sendConfig, evidence }); return { value: { ids, turnId, sendConfig } };
    });
  }
  uncertain({ ids, reason }) {
    nonempty(reason, '未知状态原因');
    return this.store.change((state, log) => {
      batch(state, ids);
      if (state.gateIntent) throw new Error('门禁正在恢复，该批未发送');
      for (const id of ids) {
        const job = state.jobs[id]; if (!job || !['dispatching','active'].includes(job.state)) throw new Error('无法标记该任务');
        job.state = 'uncertain';
      }
      log('dispatch.uncertain', { ids, reason }); return { value: { ids, reason } };
    });
  }
  closeDispatch({ ids, outcome, confirmation, reason, evidence, turnId }) {
    if (!['failed', 'cancelled'].includes(outcome)) throw new Error('结案结果必须为 failed 或 cancelled');
    if (!['not_sent', 'terminated'].includes(confirmation)) throw new Error('须核实未发送或轮次已终止');
    reason = nonempty(reason, '结案原因'); evidence = nonempty(evidence, '宿主证据');
    if (confirmation === 'terminated') turnId = nonempty(turnId, '终止的轮次 ID');
    else if (turnId !== undefined) throw new Error('未发送的任务不能有轮次 ID');
    const closure = { outcome, confirmation, reason, evidence, ...(turnId && { turnId }) };
    const result = this.store.change((state, log) => {
      const jobs = batch(state, ids);
      if (state.gateIntent) throw new Error('该批次由阶段门禁结案');
      if (jobs.every(job => job.state === outcome && JSON.stringify(job.termination) === JSON.stringify(closure)))
        return { value: { duplicate: true } };
      for (const job of jobs) {
        if (!inFlight.has(job.state) || job.completionIntent || job.result) throw new Error('该任务不能终止');
        if (confirmation === 'not_sent' && job.turnId) throw new Error('已有发送轮次，须核实轮次终止');
        if (job.turnId && job.turnId !== turnId) throw new Error('终止的轮次 ID 不符');
        if (job.terminationIntent && JSON.stringify(job.terminationIntent) !== JSON.stringify(closure))
          throw new Error('结案内容与已保存意图冲突');
        job.terminationIntent = closure;
      }
      log('dispatch.closing', { ids, ...closure });
      return { value: null };
    });
    if (result) return result;
    return this.store.change((state, log) => {
      const jobs = batch(state, ids);
      if (jobs.every(job => job.state === outcome)) return { value: { duplicate: true } };
      // 上游 failed 会自动重试。本地已核实结案，必须取消上游执行以释放槽位。
      this.loop.finish(jobs[0].loopRun.run, jobs[0].loopRun.token, { outcome: 'cancelled', summary: clip(reason, 450) });
      for (const job of jobs) {
        job.state = outcome; job.termination = closure;
        if (turnId) job.turnId = turnId;
        delete job.terminationIntent;
      }
      log('dispatch.closed', { ids, ...closure });
      return { value: { ids, state: outcome } };
    });
  }
  complete({ ids, text, sourceRef, workEvidence }) {
    nonempty(text, '原始回复'); nonempty(sourceRef, '原始回复位置');
    workEvidence=deliveryEvidence(workEvidence);
    const jobs = batch(needed(this.status()), ids);
    for (const job of jobs) {
      if (job.skills?.some(pin=>!job.skillReads?.some(read=>read.name===pin.name && read.digest===pin.digest))) throw Error('分配的技能尚缺原聊天读取记录');
      if ((job.skills?.length || job.handoff || job.regressions?.length) && !workEvidence) throw Error('专业任务需要提交实际产物、验证和剩余事项');
      const pinned=job.skills??[], used=workEvidence?.skillUse??[];
      if (used.length!==pinned.length || pinned.some(pin=>!used.some(item=>item.name===pin.name))) throw Error('使用证据必须逐项对应任务固定的技能');
      if (job.regressions?.some(check=>!job.checks?.some(result=>result.feedbackId===check.id))) throw Error('尚缺分配的回归结果');
    }
    if (!jobs.length || jobs.some(x => !x || !['active','uncertain','done'].includes(x.state))) throw new Error('任务未启动');
    if (new Set(jobs.map(j => j.loopRun.run)).size !== 1) throw new Error('回执混合了不同轮次');
    if (jobs.every(x => x.state === 'done')) {
      if (jobs.some(x => x.result !== text || x.sourceRefResult !== sourceRef || JSON.stringify(x.workEvidence)!==JSON.stringify(workEvidence))) throw new Error('完成回执冲突');
      return { duplicate: true };
    }
    // 先保留完整回执意图；上游摘要受长度限制，不能拿相同摘要冒充同一份原文。
    this.store.change((state, log) => {
      for (const job of batch(state, ids)) {
        if (job.state==='done') {
          if (job.result!==text || job.sourceRefResult!==sourceRef || JSON.stringify(job.workEvidence)!==JSON.stringify(workEvidence)) throw Error('完成回执冲突');
          continue;
        }
        if (job.terminationIntent || !['active','uncertain','done'].includes(job.state)) throw new Error('任务已结案或正在结案');
        if (job.requiresAxes && job.id===state.stage?.delivery?.reviewTaskId) reviewConclusion(job.passes);
        if (job.submissionId && !job.turnId) throw new Error('请先用 sent 补记核实的审查轮次 ID');
        if (job.completionIntent && (job.completionIntent.text !== text || job.completionIntent.sourceRef !== sourceRef || JSON.stringify(job.completionIntent.workEvidence)!==JSON.stringify(workEvidence)))
          throw new Error('完整回执与已保存的提交意图冲突');
        job.completionIntent = { text, sourceRef, ...(workEvidence && {workEvidence}) };
      }
    });
    this.loop.finish(jobs[0].loopRun.run, jobs[0].loopRun.token, { outcome: 'done', summary: clip(text, 450), session: jobs[0].threadId });
    return this.store.change((state, log) => {
      if (batch(state, ids).every(j => j.state === 'done')) return { value: { duplicate: true } };
      for (const id of ids) { state.jobs[id].state = 'done'; state.jobs[id].completedAt=new Date().toISOString(); state.jobs[id].result = text; if (workEvidence) state.jobs[id].workEvidence=workEvidence; state.jobs[id].sourceRefResult = sourceRef; delete state.jobs[id].completionIntent; }
      for (const id of ids) this.scheduleFollowups(state,log,state.jobs[id]);
      if (ids.some(id=>state.jobs[id].checks?.length)) {
        const latest=this.latestChecks(state);
        for (const j of Object.values(state.jobs)) {
          if (j.stageId===state.stage.id && j.followupNeeded?.length) {
            j.followupNeeded=j.followupNeeded.filter(({feedbackId})=>latest.get(feedbackId)?.check.outcome==='fail' &&
              latest.get(feedbackId)?.job.id===(j.followup?.type==='fix'?j.followup.failedJob:j.id));
          }
        }
      }
      log('message.received', { ids, role: jobs[0].role, threadId: jobs[0].threadId, text, sourceRef });
      return { value: { ids, state: 'done' } };
    });
  }
  deliver({ role, summary, files, evidence, sourceRef, submissionId = randomUUID(), modelPlan, skillNames=[] }) {
    nonempty(summary, '交付说明'); nonempty(evidence, '验证依据'); nonempty(sourceRef, '员工原始报告位置');
    const shot = snapshot(this.root, files);
    nonempty(submissionId, '交付 ID');
    modelPlan = modelFields(modelPlan, '计划发送配置');
    skillNames=uniqueNames(skillNames,'审查任务技能');
    const reviewTaskId = `review-${submissionId}`;
    const result = this.store.change((state, log) => {
      const stage = stageOf(state);
      const submitted = { role, summary, evidence, sourceRef, ...(stage.policy && {checkSequence:state.checkSequence??0}), ...shot, submissionId, reviewTaskId };
      if (stage.delivery?.submissionId === submissionId) {
        if (JSON.stringify(stage.delivery) !== JSON.stringify(submitted) ||
            JSON.stringify(state.jobs[reviewTaskId]?.modelPlan) !== JSON.stringify(modelPlan) ||
            JSON.stringify(state.jobs[reviewTaskId]?.skills?.map(s=>s.name)??[])!==JSON.stringify(skillNames))
          throw new Error('相同交付 ID 的内容冲突');
        return { value: { ...shot, submissionId, reviewTaskId } };
      }
      if (!['working','reviewing'].includes(stage.status)) throw new Error('当前阶段不接受成果修改');
      if (roleOf(state, role).kind !== 'worker') throw new Error('需要员工交付');
      const reviewer = Object.values(state.roles).find(x => x.kind === 'reviewer');
      if (!reviewer) throw new Error('须先绑定独立审查员，交付未保存');
      if (Object.hasOwn(state.jobs, reviewTaskId)) throw new Error('交付 ID 已使用');
      const unresolved=this.openRegressions(state).map(({job,check})=>check.feedbackId+'（'+check.version+'，'+job.id+'）：'+check.evidence);
      stage.delivery = submitted;
      stage.review = null; stage.report = null; stage.status = 'reviewing';
      log('delivery.submitted', { stageId: stage.id, ...stage.delivery });
      queueJob(state, log, stage, reviewer, {
        ...(skillNames.length && {skills:selectPins(reviewer.profile,skillNames)}),
        ...(stage.policy?.twoPassReview && {requiresAxes:true}),
        id: reviewTaskId, kind: 'review', source: role, sourceRef, submissionId, version: shot.version, modelPlan,
        text: `审查阶段 ${stage.title}。验收：${stage.acceptance.join('；')}。交付 ID ${submissionId}。成果版本 ${shot.version}。文件：${shot.files.map(f => f.path).join('、')}。员工原始报告：${sourceRef}。请独立读取实际成果和验证依据；回复通过/阻断/待补证据，列出依据与解除条件。不得修改实现。` + (stage.policy?.twoPassReview?' 用 boss_review_pass 依次记录 requirements 和 quality 的结论与依据。':'') + (unresolved.length?'\n待核对的复测记录：'+unresolved.join('；'):''),
      });
      return { value: { ...shot, submissionId, reviewTaskId } };
    });
    this.flush();
    return result;
  }
  review({ submissionId, reviewTaskId, version, verdict, findings = [], evidence, sourceRef, progress = true }) {
    if (!['pass','block','needs_evidence'].includes(verdict)) throw new Error('审查结论无效');
    nonempty(evidence, '审查依据'); nonempty(sourceRef, '审查原文位置');
    if (!Array.isArray(findings)) throw new Error('审查问题必须为数组');
    for (const item of findings) for (const key of ['id','requirement','evidence','release']) nonempty(item[key], `问题 ${key}`);
    if (verdict === 'pass' && findings.length) throw new Error('仍有阻断问题不能通过');
    if (verdict === 'block' && !findings.length) throw new Error('否决必须附具体问题');
    return this.store.change((state, log) => {
      const stage = stageOf(state);
      if (stage.status !== 'reviewing' || !stage.delivery) throw new Error('当前没有待审成果');
      const current = snapshot(this.root, stage.delivery.files.map(x => x.path));
      if (version !== stage.delivery.version || version !== current.version) throw new Error('成果已变化，需要重新交付和审查');
      if (stage.policy && stage.delivery.checkSequence!==(state.checkSequence??0)) throw Error('交付后复测记录已更新，须重新交付审查');
      const task = this.reviewReceipt(state, stage, { submissionId, reviewTaskId, version, sourceRef });
      if (task.requiresAxes && verdict!==reviewConclusion(task.passes)) throw Error('总评须与需求、质量两项结论一致');
      if (verdict==='pass' && stage.policy && this.openRegressions(state).length) throw Error('仍有未通过或未验证的回归，请登记阻断或补证');
      const review = { version, verdict, ...(task.passes && {passes:task.passes}), findings, evidence, sourceRef, submissionId, reviewTaskId, reviewer: task.role, turnId: task.turnId };
      stage.review = review;
      // 只延续上一轮仍存在的问题；其他问题的新增或解除不能清空其连续次数。
      // 实际问题和无明细的缺证据状态使用不同命名空间，避免 ID 碰撞。
      const blockerKeys = findings.length
        ? [...new Set(findings.map(f => `finding:${f.id}`))].sort()
        : ['system:evidence-missing'];
      const previous = stage.stalledByBlocker ?? {};
      stage.stalledByBlocker = verdict === 'pass' || progress !== false ? {}
        : Object.fromEntries(blockerKeys.map(key => [key, (previous[key] ?? 0) + 1]));
      stage.stalled = Math.max(0, ...Object.values(stage.stalledByBlocker));
      delete stage.blockerKey;
      stage.status = stage.stalled >= 2 ? 'blocked' : 'working';
      log('review.recorded', { stageId: stage.id, ...review, progress, stalled: stage.stalled,
        stalledByBlocker: stage.stalledByBlocker }); return { value: review };
    });
  }
  reviewReceipt(state, stage, { submissionId, reviewTaskId, version, sourceRef }) {
    const delivery = stage.delivery;
    const task = Object.hasOwn(state.jobs, reviewTaskId) && state.jobs[reviewTaskId];
    const reviewer = task && state.roles[task.role];
    if (!submissionId || submissionId !== delivery.submissionId || !reviewTaskId || reviewTaskId !== delivery.reviewTaskId ||
        version !== delivery.version || !task || task.state !== 'done' || task.kind !== 'review' ||
        task.stageId !== stage.id || task.submissionId !== submissionId || task.version !== version ||
        reviewer?.kind !== 'reviewer' || task.threadId !== reviewer.threadId ||
        !task.turnId || !task.result?.trim() || task.sourceRefResult !== sourceRef) {
      throw new Error('需要本次交付对应的独立审查任务及已完成的真实回执；旧记录须重新交付审查');
    }
    return task;
  }
  report({ completed, incomplete, verification, next, sourceRef }) {
    for (const [key,value] of Object.entries({completed,incomplete,verification,next,sourceRef})) nonempty(value, key);
    return this.store.change((state, log) => {
      const stage = stageOf(state);
      if (!['working','blocked'].includes(stage.status) || !stage.review || !stage.delivery) throw new Error('报告前需要完成独立审查，或明确的受阻审查记录');
      if (Object.values(state.jobs).some(x => x.stageId === stage.id && !terminal.has(x.state))) throw new Error('仍有未结束任务，不能冻结阶段报告');
      if (stage.policy && stage.delivery.checkSequence!==(state.checkSequence??0)) throw Error('审查后的复测记录已更新，须重新交付审查');
      this.reviewReceipt(state, stage, stage.review);
      const current = snapshot(this.root, stage.delivery.files.map(x => x.path));
      if (current.version !== stage.review.version) throw new Error('审查后的成果发生变化，不能沿用旧结论');
      const checks=Object.values(state.jobs).filter(job=>job.stageId===stage.id && job.checks?.length)
        .flatMap(job=>job.checks.map(check=>({...check,jobId:job.id,sourceRef:job.sourceRefResult??null})));
      if (stage.review.verdict==='pass' && stage.policy && this.openRegressions(state).length) throw Error('复测仍有未解决项，须重新审查');
      const report = { format:2, checks, ...(stage.review.passes && {passes:stage.review.passes}), reviewOriginal:state.jobs[stage.review.reviewTaskId].result, id: randomUUID(), version: current.version, completed, incomplete, verification, next, sourceRef,
        submissionId: stage.review.submissionId, reviewTaskId: stage.review.reviewTaskId,
        employeeReport: stage.delivery.sourceRef, reviewRecord: stage.review.sourceRef, reviewVerdict: stage.review.verdict };
      stage.report = report; stage.status = 'awaiting_boss';
      log('report.submitted', { stageId: stage.id, ...report }); return { value: report };
    });
  }
  /** 仅暴露给所有者 CLI。MCP 不暴露批复工具；执行此方法仍需真实用户明确批复。 */
  decide({ reportId, version, decision, opinion, acceptedBlockers = [], userMessageRef }) {
    nonempty(opinion, 'BOSS 批示意见'); nonempty(userMessageRef, '用户批复来源');
    if (!Array.isArray(acceptedBlockers) || acceptedBlockers.some(x => typeof x !== 'string' || !x.trim()))
      throw new Error('接受的阻断必须是逐项 ID 数组');
    if (!['approve','revise','stop'].includes(decision)) throw new Error('批复类型无效');
    return this.store.change((state, log) => {
      const stage = stageOf(state);
      if (stage.status !== 'awaiting_boss' || stage.report?.id !== reportId || stage.report.version !== version) throw new Error('批复对应的报告已失效');
      if (decision === 'approve' && snapshot(this.root, stage.delivery.files.map(x => x.path)).version !== version)
        throw new Error('报告后成果已变化，需要退回修改并重新报告');
      if (decision === 'approve' && stage.review.verdict !== 'pass') {
        const required = stage.review.findings.length ? stage.review.findings.map(f => f.id) : ['evidence-missing'];
        if (required.some(id => !acceptedBlockers.includes(id))) throw new Error('需逐项明确接受未解决阻断，普通继续不能覆盖审查');
      }
      const approval = { reportId, version, decision, opinion, acceptedBlockers, userMessageRef, at: new Date().toISOString() };
      state.approvals.push(approval); stage.status = {approve:'approved',revise:'working',stop:'stopped'}[decision];
      if (decision === 'revise') {
        stage.review = null; stage.report = null; stage.stalled = 0; stage.stalledByBlocker = {};
        delete stage.blockerKey;
      }
      log('boss.decided', { stageId: stage.id, ...approval }); return { value: approval };
    });
  }
  close() { this.store.close(); this.loop?.close(); }
}
