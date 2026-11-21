import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { briefCard, decisions, reportCard, reportData } from './card.mjs';
import { nextMail } from './checkpoint.mjs';

const jobLabels={queued:'排队中',dispatching:'待确认送达',active:'已送达，等回执',uncertain:'待核实',done:'已完成',failed:'失败',cancelled:'已取消',held:'已搁置'};
const pendingLabels={confirm_owner:'需要确认原负责人',review_required:'两次修复后仍未通过',work_limit:'工作项额度已用完'};
const stageLabels={working:'进行中',reviewing:'审查中',awaiting_boss:'等你批复',blocked:'受阻',approved:'已批准',stopped:'已停止'};
function statusReply(boss,text) {
  const lines=[];
  if (text==='/团队') {
    const {project,stage,roles,pending,latestBrief}=boss.teamBoard();
    lines.push(project+' · 团队记录',stage ? stage.title+'（'+stageLabels[stage.status]+'）' : '还没有开始阶段。');
    if (stage) lines.push('本阶段已登记 '+stage.used+' 项工作，'+(stage.limit?'上限 '+stage.limit+' 项。':'尚未设置项数上限。'));
    for (const role of roles) lines.push(role.title+'：'+(role.tasks.map(j=>j.id+' '+jobLabels[j.state]).join('、')||'没有已登记的在办任务')+(role.lastDelivery?'。最近交付 '+role.lastDelivery:''));
    if (pending.length) lines.push('待经理处理：'+pending.map(p=>p.feedbackId+'（'+p.jobId+'，'+pendingLabels[p.reason]+'）').join('、'));
    if (latestBrief) lines.push('最近一次经理简报：'+latestBrief);
  } else {
    const match=/^\/任务(?:\s+([^\s]+))?$/u.exec(text);
    if (!match) return null;
    if (!match[1]) return '请发 /任务 加任务编号。发 /团队 可以查在办任务。';
    let job;
    try {job=boss.trace({id:match[1]});} catch {return '本项目没有查到这个任务编号。';}
    lines.push(job.id+' · '+jobLabels[job.state],'负责人：'+job.role,'交办内容：'+job.task);
    if (job.queuedAt) lines.push('入队：'+job.queuedAt);
    if (job.sentAt) lines.push('送达原聊天：'+job.sentAt);
    if (job.completedAt) lines.push('收到回执：'+job.completedAt);
    if (job.evidence) lines.push('最近验证：'+job.evidence.validation);
    if (job.fromJob) lines.push('接自：'+job.fromJob);
    if (job.sourceRef) lines.push('原始回执：'+job.sourceRef);
  }
  return lines.join('\n').slice(0,3000);
}
const day = 86_400_000;
const required = (v, msg) => { if (typeof v !== 'string' || !v.trim()) throw Error(msg); return v; };
const stableId = key => createHash('sha256').update(key).digest('hex').slice(0,32);
const current = (state,report) => state.stage?.status === 'awaiting_boss' &&
  state.stage.report?.id === report.id && state.stage.report.version === report.version;
const ref = row => 'feishu:' + row.message_id + '/' + row.id;

// 此库只记录卡片、入站原文和经理接手凭据。阶段和最终批复始终以 Boss.decide 的事务为准。
export class Channel {
  constructor(boss) {
    this.boss = boss;
    const state = boss.status();
    if (!state || state.root !== boss.root) throw Error('请指定已初始化的 BOSS 项目');
    this.manager = Object.values(state.roles).find(role => role.kind === 'manager')?.threadId;
    if (!this.manager) throw Error('请先绑定项目的原经理聊天');
    this.db = new DatabaseSync(join(boss.stateDir,'feishu.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), project TEXT, app TEXT, owner TEXT);
      CREATE TABLE IF NOT EXISTS cards (uuid TEXT PRIMARY KEY, report_id TEXT NOT NULL, payload TEXT NOT NULL,
        created INTEGER NOT NULL, message_id TEXT UNIQUE, chat_id TEXT, displayed TEXT);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, message_id TEXT NOT NULL,
        report_id TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
        received INTEGER NOT NULL, taken INTEGER, answer TEXT, sent INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS wakes (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, retry_after INTEGER, queued INTEGER);
      CREATE TABLE IF NOT EXISTS manager_watch (id INTEGER PRIMARY KEY CHECK(id=1), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS brief_receipts (brief_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,chat_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_context (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, report_id TEXT NOT NULL);`);
  }
  bind(app, owner) {
    required(app,'缺少 App ID'); required(owner,'缺少 BOSS open_id');
    const project = this.boss.status().id;
    this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?,?,?)').run(project,app,owner);
    const row=this.db.prepare('SELECT * FROM binding').get();
    if (row.app!==app || row.owner!==owner || row.project!==project) throw Error('项目已绑定其他应用或 BOSS');
    this.app=app; this.owner=owner;
  }
  byCard(mid) { return this.db.prepare('SELECT * FROM cards WHERE message_id=?').get(mid ?? ''); }
  delivery(reportId) {
    const row=this.db.prepare('SELECT message_id FROM cards WHERE report_id=? AND message_id IS NOT NULL ORDER BY created DESC LIMIT 1').get(reportId);
    return {reportId,delivered:Boolean(row),messageId:row?.message_id??null};
  }
  briefDelivery(id) {
    const row=this.db.prepare('SELECT message_id FROM brief_receipts WHERE brief_id=?').get(id);
    return {briefId:id,delivered:Boolean(row),messageId:row?.message_id??null};
  }
  saveInput(id,kind,card,body) {
    required(id,'缺少飞书事件或消息 ID');
    this.db.prepare('INSERT OR IGNORE INTO inbox(id,kind,message_id,report_id,sender,body,state,received) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,kind,card.message_id,card.report_id,this.owner,JSON.stringify(body),kind==='decision'?'received':'ready',Date.now());
  }
  acceptCard(e) {
    if (!this.owner || e.app_id!==this.app || e.operator?.open_id!==this.owner) throw Error('仅绑定的 BOSS 可批复');
    const card=this.byCard(e.context?.open_message_id);
    if (!card || card.chat_id!==e.context?.open_chat_id) throw Error('无法识别报告卡片');
    const report=JSON.parse(card.payload), action=e.action, form=action?.form_value;
    if (action?.value?.reportId!==report.id || action.value.version!==report.version ||
      action.name!=='submit_decision' || !form || !Object.hasOwn(decisions,form.decision)) throw Error('报告或决定无效');
    required(form.opinion,'请填写批示意见');
    if (form.blockers != null && typeof form.blockers!=='string') throw Error('限制 ID 格式无效');
    const id='action/'+required(e.event_id,'缺少飞书事件 ID');
    const duplicate=this.db.prepare('SELECT 1 FROM inbox WHERE id=?').get(id);
    if (!duplicate && !current(this.boss.status(),report)) throw Error('这份报告已处理或已替换');
    this.saveInput(id,'decision',card,{decision:form.decision,opinion:form.opinion,blockers:form.blockers ?? ''});
  }
  acceptMessage(e) {
    const msg=e.message;
    if (!this.owner || e.app_id!==this.app || e.sender?.sender_type!=='user' || e.sender.sender_id?.open_id!==this.owner ||
      msg?.chat_type!=='p2p' || msg.message_type!=='text') return;
    if (!msg.chat_id || !msg.message_id) return;
    const parent=msg.parent_id || msg.root_id;
    const card=this.byCard(parent);
    const previous=parent && !card ? this.db.prepare('SELECT * FROM reply_context WHERE message_id=?').get(parent) : null;
    const brief=parent && !card && !previous ? this.db.prepare("SELECT brief_id,message_id,chat_id,'' AS report_id FROM brief_receipts WHERE message_id=?").get(parent) : null;
    const context=card || previous || brief;
    if (parent && (!context || context.chat_id!==msg.chat_id)) return;
    const {text}=JSON.parse(msg.content);
    required(text,'缺少问题原文');
    const id='message/'+required(msg.message_id,'缺少消息 ID');
    const answer=!parent && statusReply(this.boss,text.trim());
    if (answer) {
      this.db.prepare("INSERT OR IGNORE INTO inbox(id,kind,message_id,report_id,sender,body,state,received,answer) VALUES(?,'status',?,'',?,?,'answered',?,?)")
        .run(id,msg.message_id,this.owner,JSON.stringify({text,chatId:msg.chat_id}),Date.now(),answer);
      return;
    }
    const stamp=/^\/批复 (批准|退回修改|停止)\r?\n([\s\S]+)$/u.exec(text);
    if (card && stamp && stamp[2].trim()) {
      const decision=Object.entries(decisions).find(([,label])=>label===stamp[1])[0];
      this.saveInput(id,'decision',card,{decision,opinion:stamp[2],blockers:'',text});
    } else {
      const subject=brief && this.boss.status().briefs?.find(item=>item.id===brief.brief_id);
      this.saveInput(id,'question',context??{message_id:msg.message_id,report_id:''},{text,chatId:msg.chat_id,
        ...(subject && {briefId:subject.id,briefText:subject.message})});
    }
  }
  applyDecisions() {
    for (const row of this.db.prepare("SELECT * FROM inbox WHERE state='received' ORDER BY rowid").all()) {
      const report=JSON.parse(this.byCard(row.message_id).payload);
      const {decision,opinion,blockers}=JSON.parse(row.body);
      // 若上次已写入 BOSS、尚未更新收件箱便断电，按原始来源恢复，不再执行第二次批复。
      if (!this.boss.status().approvals.some(a=>a.userMessageRef===ref(row))) {
        try {
          this.boss.decide({reportId:report.id,version:report.version,decision,opinion,
            acceptedBlockers:blockers.split(/[,，\s]+/u).filter(Boolean),userMessageRef:ref(row)});
        } catch (error) {
          if (error.code) throw error; // 数据库忙等临时故障保留待重试
          this.db.prepare("UPDATE inbox SET state='rejected',error=? WHERE id=?").run(error.message,row.id);
          continue;
        }
      }
      this.db.prepare("UPDATE inbox SET state='ready' WHERE id=?").run(row.id);
    }
  }
  forManager(thread) {
    if (!thread || thread!==this.manager) throw Error('请在项目登记的原经理聊天中执行');
  }
  next(thread) {
    this.forManager(thread);
    return nextMail(this.db);
  }
  watch(thread,until) {
    this.forManager(thread);
    this.db.prepare('INSERT INTO manager_watch VALUES(1,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires').run(until);
  }
  acknowledge(thread,id,answer,decisionNote=false) {
    this.forManager(thread);
    const row=this.db.prepare("SELECT * FROM inbox WHERE id=? AND state='ready'").get(id);
    if (!row) throw Error('收件不存在或尚未处理');
    if (decisionNote && row.kind!=='decision') throw Error('提问请用 answer 答复');
    if (row.kind==='question' || decisionNote) required(answer,'请填写给 BOSS 的答复');
    if (row.kind==='decision' && answer!==undefined && !decisionNote) throw Error('批复请用 ack 确认接手');
    if (row.taken && (answer??null)!==row.answer) throw Error('该消息已接手，答复内容不同');
    this.db.prepare('UPDATE inbox SET taken=coalesce(taken,?),answer=? WHERE id=?').run(Date.now(),answer??null,id);
  }
  view(card,state) {
    const report=JSON.parse(card.payload);
    const approval=state.approvals.find(a=>a.reportId===report.id && a.version===report.version);
    const active=current(state,report);
    let status=active?'等待你的批复。':'报告已替换或已结束。';
    if (approval) {
      const row=this.db.prepare("SELECT * FROM inbox WHERE kind='decision' AND report_id=?").all(report.id)
        .find(x=>ref(x)===approval.userMessageRef);
      const receipt=row ? (row.taken?'经理已接手':'经理待接续') : '已在 BOSS 中登记';
      status='批复已收到，'+receipt+'。\n'+decisions[approval.decision]+'：'+approval.opinion;
    }
    return reportCard(report,status,active);
  }
  async sync(api, now=Date.now()) {
    this.applyDecisions();
    const state=this.boss.status(), stage=state.stage;
    if (stage?.status==='awaiting_boss' && stage.report) {
      const prev=this.db.prepare('SELECT * FROM cards WHERE report_id=? ORDER BY created DESC LIMIT 1').get(stage.report.id);
      // 飞书卡片交互有平台有效期。仍待批时换发新卡，BOSS 报告本身不设等待窗口。
      if (!prev || now-prev.created>=12*day) this.db.prepare('INSERT INTO cards(uuid,report_id,payload,created) VALUES(?,?,?,?)')
        .run(randomUUID(),stage.report.id,JSON.stringify(reportData(state)),now);
    }
    const errors=[];
    for (const brief of state.briefs??[]) {
      if (this.db.prepare('SELECT 1 FROM brief_receipts WHERE brief_id=?').get(brief.id)) continue;
      const phase=[stage,...state.stages].find(item=>item?.id===brief.stageId);
      try {
        const view=briefCard(state.name,phase?.title??brief.stageId,brief.message);
        const sent=await api.sendCard(this.owner,JSON.stringify(view),stableId(state.id+'/brief/'+brief.id));
        this.db.prepare('INSERT INTO brief_receipts VALUES(?,?,?)').run(brief.id,required(sent.message_id,'缺少简报消息 ID'),required(sent.chat_id,'缺少会话 ID'));
      } catch (error) {errors.push(error.message);}
    }
    for (const card of this.db.prepare('SELECT * FROM cards WHERE created>? ORDER BY created DESC').all(now-14*day)) {
      try {await this.syncCard(api,card,state);} catch (error) {errors.push(error.message);}
    }
    const mail=this.db.prepare(`SELECT i.*, c.chat_id AS card_chat FROM inbox i LEFT JOIN cards c ON c.message_id=i.message_id
      WHERE i.sent IS NULL AND (i.answer IS NOT NULL OR i.state='rejected' OR
      (i.taken IS NOT NULL AND i.kind='decision' AND c.created<=?)) ORDER BY i.rowid`).all(now-14*day);
    for (const row of mail) {
      const replyTo=row.kind==='question'?row.id.slice('message/'.length):row.message_id;
      const text=row.error?'批复未生效：'+row.error:(row.answer??'此报告的批复，经理已接手。');
      try {
        const sent=await api.reply(replyTo,text,stableId(ref(row)));
        const chatId=JSON.parse(row.body).chatId || row.card_chat;
        if (sent?.message_id && chatId) this.db.prepare('INSERT OR IGNORE INTO reply_context VALUES(?,?,?)')
          .run(sent.message_id,chatId,row.report_id);
        this.db.prepare('UPDATE inbox SET sent=? WHERE id=?').run(now,row.id);
      } catch (error) { errors.push(error.message); }
    }
    if (errors.length) throw Error(errors.join(' / '));
  }
  async syncCard(api,card,state) {
      const view=JSON.stringify(this.view(card,state));
      const source=state.approvals.find(a=>a.reportId===card.report_id)?.userMessageRef;
      const received=this.db.prepare("SELECT * FROM inbox WHERE kind='decision' AND taken IS NOT NULL AND sent IS NULL AND report_id=?").all(card.report_id)
        .find(row=>ref(row)===source);
      if (view===card.displayed) return;
      if (!card.message_id) {
        if (!current(state,JSON.parse(card.payload))) return;
        const sent=await api.sendCard(this.owner,view,card.uuid);
        this.db.prepare('UPDATE cards SET message_id=?,chat_id=?,displayed=? WHERE uuid=?')
          .run(required(sent.message_id,'缺少卡片 ID'),required(sent.chat_id,'缺少会话 ID'),view,card.uuid);
      } else {
        await api.update(card.message_id,view);
        this.db.prepare('UPDATE cards SET displayed=? WHERE uuid=?').run(view,card.uuid);
      }
      if (received && !received.answer) this.db.prepare('UPDATE inbox SET sent=? WHERE id=?').run(Date.now(),received.id);
  }
  close() { this.db.close(); }
}
