#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Boss } from './boss.mjs';
import { managerMail } from '../integrations/feishu/checkpoint.mjs';
import manifest from '../plugin.json' with { type: 'json' };

const text = { type: 'string', minLength: 1 };
const list = { type: 'array', items: text };
const record = (properties, required) => ({ type:'object', properties, required, additionalProperties:false });
const taskId = { ...text, maxLength:100, pattern:'^[A-Za-z0-9#._:/@-]+$' };
const thinking = { enum:['none','minimal','low','medium','high','xhigh','max','ultra'] };
const modelPlan = record({ model:text, thinking }, ['model']);
const sendConfig = record({ model:text, thinking, hostId:text }, ['model']);
const materials = { type:'array', items:record({ path:text, version:text }, ['path','version']) };
const skill=record({name:text,version:text,directory:text,resources:list},['name','version','directory']);
const handoff=record({acceptance:text,to:text,output:text},['acceptance','to','output']);
const skillUse=record({name:text,status:{enum:['used','unused']},evidence:text},['name','status','evidence']);
const workEvidence=record({artifact:text,validation:text,remaining:text,skillUse:{type:'array',items:skillUse}},['artifact','validation','remaining']);
const positiveCount={type:'integer',minimum:1};
const policy=record({maxParallel:positiveCount,workLimit:positiveCount,twoPassReview:{type:'boolean'},firstProof:text,uncertainty:text},[]);
const scope=record({read:list,write:list},['read','write']);
const task = { scope, fromJob:text, skillNames:list, handoff, feedbackIds:list, role:text, text, source:text, sourceRef:text, id:taskId, modelPlan, materials };
const readOnly = new Set(['boss_status','boss_messages','boss_report_view','boss_team_board','boss_task_trace']);
const specs = [
  ['boss_status', '读取阶段、角色聊天和任务状态；不代表真实运行已验收', {}, [], b => b.status()],
  ['boss_messages', '读取有来源的原始派工和回复记录', { after: { type: 'integer', minimum: 0 } }, [], (b,a) => b.messages(a.after ?? 0)],
  ['boss_report_view', '只读查看中文阶段报告 Markdown', {}, [], b => b.reportView()],
  ['boss_team_board','查看项目名、阶段门禁、授权额度及各原聊天手头的任务',{},[],b=>b.teamBoard()],
  ['boss_task_trace','追踪任务的上游事件、原聊天轮次和交接证据',{id:text},['id'],(b,a)=>b.trace(a)],
  ['boss_agreement','登记带原话出处的团队决定；可替代同范围的决定',{id:text,text,sourceRef:text,roles:list,supersedes:text},['id','text','sourceRef'],(b,a)=>b.agreement(a)],
  ['boss_review_pass','在本次交付的原审查聊天中登记需求或质量结论',{jobId:text,axis:{enum:['requirements','quality']},verdict:{enum:['pass','block','needs_evidence']},evidence:text},['jobId','axis','verdict','evidence'],(b,a)=>b.reviewPass(a)],
  ['boss_init', '初始化用户明确指定的 BOSS 项目', { name: text }, ['name'], (b,a) => b.init(a.name)],
  ['boss_bind', '将用户已授权创建的真实聊天绑定到角色；不自动创建聊天', {id:text,kind:{enum:['technician','manager','reviewer','worker']},title:text,threadId:text}, ['id','kind','title','threadId'], (b,a) => b.bindRole(a)],
  ['boss_profile','为已绑定员工配置岗位、职责和可选技能版本', {role:text,specialty:text,responsibility:text,skills:{type:'array',items:skill}},['role','specialty','responsibility','skills'],(b,a)=>b.profile(a)],
  ['boss_read_skill','在任务原聊天读取指定版本并留下读取记录', {jobId:text,name:text},['jobId','name'],(b,a)=>b.readSkill(a)],
  ['boss_brief','发布本阶段有依据的进展简报；启用飞书时自动发送，无需盖章', {id:text,stageId:text,message:text,sourceRef:text},['id','stageId','message','sourceRef'],(b,a)=>b.brief(a)],
  ['boss_feedback','登记用户原话、分类及责任人；缺陷须附复现动作与期望', {id:text,category:{enum:['defect','experience','change']},text,owner:text,sourceRef:text,scenario:text,expected:text},['id','category','text','owner','sourceRef'],(b,a)=>b.feedback(a)],
  ['boss_regression','在任务原聊天登记指定反馈的回归结果与所测版本', {jobId:text,feedbackId:text,outcome:{enum:['pass','fail','unverified']},evidence:text,version:text},['jobId','feedbackId','outcome','evidence','version'],(b,a)=>b.regression(a)],
  ['boss_stage', '开始用户已授权的阶段；前一阶段必须已批复', {id:text,title:text,goal:text,acceptance:list,policy}, ['id','title','goal','acceptance'], (b,a) => b.startStage(a)],
  ['boss_assign', '提交工作任务。直接启动原经理聊天调度，派工受阶段门禁约束', {...task,kind:{enum:['work','review','report']}}, ['role','text'], (b,a) => b.enqueue(a)],
  ['boss_discuss', '排队解释或讨论', task, ['role','text'], (b,a) => b.enqueue({...a,kind:'discussion'})],
  ['boss_claim', '领取任务，返回 claimed、blocked 或 empty。claimed 含目标 threadId 与原文', {}, [], b => b.claimStatus()],
  ['boss_sent', '记录真实 turnId 和实际发送配置。对 uncertain 补记轮次时须提供已核实的宿主 evidence', {ids:list,turnId:text,sendConfig,evidence:text}, ['ids','turnId'], (b,a) => b.markSent(a)],
  ['boss_uncertain', '发送或执行状态未知时停止自动重派，等待核查原聊天', {ids:list,reason:text}, ['ids','reason'], (b,a) => b.uncertain(a)],
  ['boss_complete', '记录已真实完成的聊天原文及出处，不能拿摘要伪造原文', {ids:list,text,sourceRef:text,workEvidence}, ['ids','text','sourceRef'], (b,a) => b.complete(a)],
  ['boss_close_dispatch', '根据宿主证据结案。terminated 必须携带实际 turnId；not_sent 不得携带 turnId', {ids:list,outcome:{enum:['failed','cancelled']},confirmation:{enum:['not_sent','terminated']},reason:text,evidence:text,turnId:text}, ['ids','outcome','confirmation','reason','evidence'], (b,a) => b.closeDispatch(a)],
  ['boss_deliver', '交付并生成独立审查任务，返回 submissionId、reviewTaskId 和 version；可提供稳定 submissionId 重试', {role:text,summary:text,files:list,evidence:text,sourceRef:text,submissionId:{...taskId,maxLength:93},modelPlan,skillNames:list}, ['role','summary','files','evidence','sourceRef'], (b,a) => b.deliver(a)],
  ['boss_review', '以本次交付及已完成的独立审查任务回执登记结论', {submissionId:text,reviewTaskId:text,version:text,verdict:{enum:['pass','block','needs_evidence']},findings:{type:'array',items:record({id:text,requirement:text,evidence:text,release:text}, ['id','requirement','evidence','release'])},evidence:text,sourceRef:text,progress:{type:'boolean'}}, ['submissionId','reviewTaskId','version','verdict','evidence','sourceRef'], (b,a) => b.review(a)],
  ['boss_report', '提交简明阶段报告并关闭后续开发派工，等待 BOSS 决定与意见', {completed:text,incomplete:text,verification:text,next:text,sourceRef:text}, ['completed','incomplete','verification','next','sourceRef'], (b,a) => b.report(a)],
];
const validate = (v,s) => {
  if (s.enum) return s.enum.includes(v);
  if (s.type === 'string') return typeof v === 'string' && v.trim().length >= (s.minLength ?? 0) &&
    v.length <= (s.maxLength ?? Infinity) && (!s.pattern || new RegExp(s.pattern).test(v));
  if (s.type === 'integer') return Number.isSafeInteger(v) && v >= (s.minimum ?? -Infinity);
  if (s.type === 'boolean') return typeof v === 'boolean';
  if (s.type === 'array') return Array.isArray(v) && v.every(x => validate(x,s.items));
  if (s.type === 'object') return v && typeof v === 'object' && !Array.isArray(v) &&
    s.required.every(k => Object.hasOwn(v,k)) && Object.entries(v).every(([k,x]) => s.properties[k] && validate(x,s.properties[k]));
  return false;
};
const inputSchema = spec => ({type:'object',properties:{root:text,...spec[2]},required:['root',...spec[3]],additionalProperties:false});
const output = obj => process.stdout.write(JSON.stringify(obj)+'\n');
const rl = createInterface({input:process.stdin,crlfDelay:Infinity});
for await (const line of rl) {
  let request;
  try { request = JSON.parse(line); } catch { output({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}}); continue; }
  if (request.id === undefined) continue;
  const reply = result => output({jsonrpc:'2.0',id:request.id,result});
  const fail = (code,message) => output({jsonrpc:'2.0',id:request.id,error:{code,message}});
  if (request.method === 'initialize') reply({protocolVersion:request.params?.protocolVersion ?? '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'boss',version:manifest.version}});
  else if (request.method === 'ping') reply({});
  else if (request.method === 'tools/list') reply({tools:specs.map(s=>({name:s[0],description:s[1],inputSchema:inputSchema(s),annotations:{readOnlyHint:readOnly.has(s[0])}}))});
  else if (request.method === 'tools/call') {
    const spec = specs.find(s=>s[0]===request.params?.name); const args=request.params?.arguments;
    if (!spec || !validate(args,inputSchema(spec))) { fail(-32602,'工具或参数无效'); continue; }
    let boss;
    try {
      boss = new Boss(resolve(args.root), { readOnly:readOnly.has(spec[0]) }); const {root,...rest}=args;
      const result = spec[4](boss,rest);
      const content=[{type:'text',text:typeof result === 'string' ? result : JSON.stringify(result)}];
      const mail=managerMail(boss);
      if (mail) content.push({type:'text',text:'飞书待办，请原经理在本轮按项目收件说明处理：'+JSON.stringify(mail)});
      reply({content});
    } catch(error) { reply({isError:true,content:[{type:'text',text:error.message}]}); }
    finally { boss?.close(); }
  } else fail(-32601,'Unknown method');
}
