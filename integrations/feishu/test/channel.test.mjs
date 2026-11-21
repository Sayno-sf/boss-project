import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { Boss } from '../../../src/boss.mjs';
import { Channel } from '../channel.mjs';
import { handlers } from '../sdk.mjs';
import { enableManager } from '../manager.mjs';
import { wakePending } from '../wake.mjs';
import { managerMail } from '../checkpoint.mjs';

test('阶段内简报只产生进展消息；正式奏折独立送审，引用简报不能审批',async t=>{
  const brief={id:'tour1',stageId:'s1',message:'第一厅的路线能走通了。回程的岔口还会走错，设计师正在调标识。',sourceRef:'test:walk'};
  const f=await fixture(t,false,boss=>{
    boss.brief(brief);boss.brief(brief);
    assert.equal(boss.status().stage.status,'working');assert.equal(boss.status().stage.report,null);
  });
  assert.equal(f.cards.length,2);
  assert.match(f.cards[0],/进度简报/);assert.doesNotMatch(f.cards[0],/submit_decision/);
  assert.match(f.cards[1],/阶段奏折/);assert.match(f.cards[1],/审查员原话/);assert.match(f.cards[1],/模拟独立审核/);
  f.channel.acceptMessage(f.message('/批复 批准\n继续。'));
  await f.channel.sync(f.api);
  assert.equal(f.boss.status().approvals.length,0);
  assert.equal(f.channel.next('thread-manager').briefText,brief.message);
  assert.equal(f.channel.next('thread-manager').kind,'question');
  assert.equal(f.channel.briefDelivery(brief.id).messageId,'om_1');
  const c=f.restart();await c.sync(f.api);assert.equal(f.cards.length,2);
  assert.throws(()=>f.boss.brief({...brief,id:'later'}),/正式报告前/);
});

test('飞书只读查询离线可重投、免经理取件；引用命令仍按原消息询问经理',async t=>{
  const f=await fixture(t);
  const command=(id,text)=>{
    const event=f.message(text);
    delete event.message.parent_id;
    event.message.message_id=id;
    return event;
  };
  for (const alter of [e=>e.sender.sender_id.open_id='other',e=>e.app_id='wrong',e=>e.message.chat_type='group']) {
    const denied=command('denied','/团队');alter(denied);f.channel.acceptMessage(denied);
  }
  const query=command('lookup','/团队');
  f.channel.acceptMessage(query);f.channel.acceptMessage(query);
  assert.equal(f.channel.next('thread-manager'),null);
  const c=f.restart();
  await assert.rejects(c.sync({...f.api,reply:async()=>{throw Error('offline');}}),/offline/);
  await c.sync(f.api);await c.sync(f.api);
  assert.equal(f.replies.length,1);
  assert.equal(f.replies[0][0],'lookup');assert.match(f.replies[0][1],/隔离测试.*团队记录/s);
  assert.match(f.replies[0][1],/等你批复/);
  const id=f.boss.status().stage.delivery.reviewTaskId;
  c.acceptMessage(command('trace','/任务 '+id));c.acceptMessage(command('missing','/任务 nowhere'));
  await c.sync(f.api);assert.match(f.replies[1][1],/原始回执：test:review/);
  assert.match(f.replies[2][1],/没有查到/);assert.equal(f.boss.status().approvals.length,0);
  c.acceptMessage(f.message('/团队'));assert.equal(c.next('thread-manager').kind,'question');
});

async function fixture(t, blocked=false, beforeReport) {
  const root=mkdtempSync(join(tmpdir(),'boss-fs-test-'));
  const boss=new Boss(root);
  let channel;
  t.after(()=>{channel?.close();boss.close();rmSync(root,{recursive:true,force:true});});
  writeFileSync(join(root,'work.txt'),'模拟交付');
  boss.init('隔离测试');
  for (const kind of ['manager','reviewer','worker','technician']) boss.bindRole({kind,id:kind,title:kind,threadId:'thread-'+kind});
  boss.startStage({id:'s1',title:'模拟阶段',goal:'测试批复',acceptance:['有可验证的交付']});
  const d=boss.deliver({role:'worker',summary:'测试',files:['work.txt'],evidence:'fixture',sourceRef:'test:employee'});
  const job=boss.claim();
  boss.markSent({ids:job.ids,turnId:'review-turn'});
  boss.complete({ids:job.ids,text:'模拟独立审核',sourceRef:'test:review'});
  boss.review({...d,verdict:blocked?'block':'pass',
    findings:blocked?[{id:'B1',requirement:'检查',evidence:'问题',release:'修复'}]:[],
    evidence:'模拟验证',sourceRef:'test:review'});
  beforeReport?.(boss);
  const report=boss.report({completed:'完成检查',incomplete:'见审查',verification:'测试证据',next:'待批示',sourceRef:'test:manager'});
  const cards=[], replies=[];
  const api={sendCard:async(owner,view)=>{assert.equal(owner,'ou_boss');cards.push(view);return {message_id:'om_'+cards.length,chat_id:'oc_1'};},
    update:async(id,view)=>{cards[Number(id.slice(3))-1]=view;},reply:async(...args)=>{replies.push(args);}};
  const restart=()=>{channel?.close();channel=new Channel(boss);channel.bind('cli_app','ou_boss');return channel;};
  restart();await channel.sync(api);
  const form=(decision='approve')=>({app_id:'cli_app',event_id:'evt1',operator:{open_id:'ou_boss'},
    context:{open_message_id:'om_1',open_chat_id:'oc_1'},action:{name:'submit_decision',
      value:{reportId:report.id,version:report.version},form_value:{decision,opinion:'保留这条意见。'}}});
  const message=text=>({app_id:'cli_app',sender:{sender_type:'user',sender_id:{open_id:'ou_boss'}},
    message:{chat_type:'p2p',chat_id:'oc_1',message_id:'om_q1',message_type:'text',parent_id:'om_1',content:JSON.stringify({text})}});
  return {root,boss,channel,api,cards,replies,form,message,report,restart};
}

test('SDK 卡片事件隔天送达，桥重启后由 BOSS 批复，原经理明确接手后才更新回执',async t=>{
  const f=await fixture(t);
  const {app_id,event_id,...event}=f.form();
  const sdk=new EventDispatcher({loggerLevel:LoggerLevel.error}).register(handlers(f.channel));
  const delivery={schema:'2.0',header:{app_id,event_id,event_type:'card.action.trigger'},event};
  const submit=()=>sdk.invoke(delivery,{needCheck:false});
  assert.equal((await submit()).toast.type,'info');
  await submit();
  const c=f.restart();
  await c.sync(f.api,Date.now()+86_400_000);
  assert.equal(f.boss.status().approvals.length,1);
  assert.match(f.cards[0],/批复已收到，经理待接续/);
  assert.throws(()=>c.next('wrong'),/原经理/);
  const row=c.next('thread-manager');
  assert.equal(row.opinion,'保留这条意见。');
  assert.equal(f.boss.status().approvals[0].userMessageRef,row.sourceRef);
  c.acceptCard(f.form()); await c.sync(f.api);
  const cli=join(import.meta.dirname,'../cli.mjs');
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,args[0],f.root,...args.slice(1)],{
    env:{...process.env,CODEX_THREAD_ID:'thread-manager',NODE_NO_WARNINGS:'1'},encoding:'utf8'}));
  assert.equal(run('wait','0').id,row.id);
  assert.equal(run('ack',row.id).received,true);
  await c.sync(f.api);
  assert.match(f.cards[0],/经理已接手/);
  assert.equal(f.boss.status().approvals.length,1);
});

test('引用提问和普通“继续”不解冻；经理答复发回对应原消息',async t=>{
  const f=await fixture(t), c=f.channel;
  const event=f.message('继续？先讲讲怎么验证的。');
  c.acceptMessage(event); c.acceptMessage(event); await c.sync(f.api);
  assert.equal(f.boss.status().stage.status,'awaiting_boss');
  const question=c.next('thread-manager');
  assert.equal(question.text,'继续？先讲讲怎么验证的。');
  assert.throws(()=>c.acknowledge('thread-manager',question.id),/答复/);
  c.acknowledge('thread-manager',question.id,'跑了样例。'); await c.sync(f.api); await c.sync(f.api);
  assert.deepEqual(f.replies[0].slice(0,2),['om_q1','跑了样例。']);assert.equal(f.replies.length,1);
});

test('非所有者、其他聊天、旧版本和空意见不能形成批复',async t=>{
  const f=await fixture(t), c=f.channel;
  for (const mutate of [e=>e.operator.open_id='wrong',e=>e.context.open_chat_id='wrong',
    e=>e.context.open_message_id='wrong',e=>e.action.value.version='old',e=>e.action.form_value.opinion=' ']) {
    const e=f.form();mutate(e);assert.throws(()=>c.acceptCard(e));
  }
  const unbound=f.message('/批复 停止\n测试');
  unbound.sender.sender_id.open_id='outsider';c.acceptMessage(unbound);
  const plain=f.message('/批复 停止\n测试');delete plain.message.parent_id;c.acceptMessage(plain);
  await c.sync(f.api);assert.equal(f.boss.status().approvals.length,0);
});

test('文件改变后不可批准；改为明确退回仍可办理且卡片可恢复展示',async t=>{
  const f=await fixture(t);
  writeFileSync(join(f.root,'work.txt'),'changed');
  f.channel.acceptCard(f.form());await f.channel.sync(f.api);
  assert.match(f.replies[0][1],/成果已变化/);
  f.channel.acceptMessage(f.message('/批复 退回修改\n按新的成果重新送审。'));await f.channel.sync(f.api);
  assert.equal(f.boss.status().approvals[0].decision,'revise');
  assert.equal(f.boss.status().stage.report,null);
  assert.match(f.cards[0],/按新的成果重新送审/);
});

test('已阻断报告要求明确接受每项限制；核心提交后中断可重放且不重复批准',async t=>{
  const f=await fixture(t,true), c=f.channel;
  c.acceptCard(f.form());await c.sync(f.api);assert.equal(f.boss.status().approvals.length,0);
  const event=f.form();event.event_id='evt2';event.action.form_value.blockers='B1';
  c.acceptCard(event);
  f.boss.decide({reportId:f.report.id,version:f.report.version,decision:'approve',opinion:'保留这条意见。',
    acceptedBlockers:['B1'],userMessageRef:'feishu:om_1/action/evt2'});
  const reopened=f.restart();await reopened.sync(f.api);
  assert.equal(f.boss.status().approvals.length,1);assert.equal(reopened.next('thread-manager').id,'action/evt2');
});

test('待批报告可以换发新卡；旧卡上的明确决定仍须由同一报告版本校验',async t=>{
  const f=await fixture(t);await f.channel.sync(f.api,Date.now()+13*86_400_000);
  assert.equal(f.cards.length,2);
  f.channel.acceptCard(f.form('stop'));await f.channel.sync(f.api);
  assert.equal(f.boss.status().stage.status,'stopped');
  for (const card of f.cards) assert.match(card,/经理待接续/);
  const other=f.form();other.event_id='other';assert.throws(()=>f.channel.acceptCard(other),/已处理/);
});

test('卡片更新失败后重启可补发，BOSS 批复和经理收件仍然只登记一次',async t=>{
  const f=await fixture(t);
  f.channel.acceptCard(f.form());
  await assert.rejects(f.channel.sync({...f.api,update:async()=>{throw Error('临时断网');}}),/临时断网/);
  const c=f.restart();
  assert.equal(c.next('thread-manager').kind,'decision');
  await c.sync(f.api);assert.match(f.cards[0],/经理待接续/);
  assert.equal(f.boss.status().approvals.length,1);
});

test('经理接入说明可重复启用，并保护待批报告中的项目说明',async t=>{
  const f=await fixture(t);
  const state=f.boss.status();
  assert.throws(()=>enableManager(f.root,{...state,stage:{...state.stage,delivery:{files:[{path:'AGENTS.md'}]}}}),/待批报告/);
  assert.match(enableManager(f.root,state),/追加/);assert.match(enableManager(f.root,state),/已启用/);
});

test('私聊、引用答复和卡片批复均通知原经理；没有重复批复、提醒或跨聊天串线',async t=>{
  const f=await fixture(t);
  const dm=f.message('现在做到哪了？');delete dm.message.parent_id;
  const outsider=structuredClone(dm);outsider.sender.sender_id.open_id='ou_other';
  f.channel.acceptMessage(outsider);
  assert.equal(f.channel.next('thread-manager'),null);
  f.channel.acceptMessage(dm);f.channel.acceptMessage(dm);
  f.channel.acceptCard(f.form());
  f.channel.applyDecisions();
  const calls=[];
  const send=async (thread,root)=>{calls.push({thread,root});};
  await wakePending(f.channel,send);
  const c=f.restart();
  await wakePending(c,send);
  assert.deepEqual(calls,[{thread:'thread-manager',root:f.root}]);
  assert.equal(f.boss.status().approvals.length,1);
  const question=c.next('thread-manager');
  assert.equal(question.reportId,'');assert.equal(question.text,'现在做到哪了？');
  c.acknowledge('thread-manager',question.id,'首份报告已发。');
  await c.sync({...f.api,reply:async (id)=>{assert.equal(id,'om_q1');return {message_id:'om_bot_reply'};}});
  const decision=c.next('thread-manager');
  assert.equal(decision.kind,'decision');
  c.acknowledge('thread-manager',decision.id);
  const more=f.message('那下一步呢？');more.message.parent_id='om_bot_reply';more.message.message_id='om_q2';
  more.message.chat_id='oc_wrong';c.acceptMessage(more);assert.equal(c.next('thread-manager'),null);
  more.message.chat_id='oc_1';c.acceptMessage(more);
  await wakePending(c,send);
  assert.equal(calls.length,2);assert.equal(c.next('thread-manager').text,'那下一步呢？');
});

test('即使队列命令失败，原文保留，重启后延时重试；投递成功仍须等原经理确认',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.channel.delivery(f.report.id),{reportId:f.report.id,delivered:true,messageId:'om_1'});
  assert.equal(f.channel.delivery('其他报告').delivered,false);
  f.channel.acceptCard(f.form()); f.channel.applyDecisions();
  let sends=0;
  const send=async()=>{if (++sends===1) throw Error('CLI 暂时不可用');};
  await assert.rejects(wakePending(f.channel,send,1000),/不可用/);
  const c=f.restart();
  await wakePending(c,send,1001);assert.equal(sends,1);
  await wakePending(c,send,16000);assert.equal(sends,2);
  assert.equal(c.next('thread-manager').kind,'decision');
  await c.sync(f.api);assert.match(f.cards[0],/经理待接续/);
  c.acknowledge('thread-manager',c.next('thread-manager').id);
  await c.sync(f.api);assert.match(f.cards[0],/经理已接手/);
});

test('原经理的批复回信和卡片接手状态各自送达，重试不会多发',async t=>{
  const f=await fixture(t);
  f.channel.acceptCard(f.form('stop')); f.channel.applyDecisions();
  const row=f.channel.next('thread-manager');
  assert.throws(()=>f.channel.acknowledge('thread-manager',row.id,'普通答复'),/ack/);
  f.channel.acknowledge('thread-manager',row.id,'已按你的意见停止派工。',true);
  await assert.rejects(f.channel.sync({...f.api,reply:async()=>{throw Error('发送暂时失败');}}),/发送暂时失败/);
  assert.match(f.cards[0],/经理已接手/);
  const c=f.restart();await c.sync(f.api);await c.sync(f.api);
  assert.equal(f.replies.length,1);assert.deepEqual(f.replies[0].slice(0,2),['om_1','已按你的意见停止派工。']);
});

test('当原经理主动查件时直接读到原文，不产生聊天提醒；停查后未读来信自动排队',async t=>{
  const f=await fixture(t);
  f.channel.watch('thread-manager',2000);
  f.channel.acceptMessage(f.message('请解释理由'));
  let wakes=0;
  const send=async()=>{wakes++;};
  await wakePending(f.channel,send,1500);
  assert.equal(wakes,0);
  assert.equal(managerMail(f.boss,'thread-worker'),null);
  const readCli=(thread)=>JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'../../../src/cli.mjs'),'status','--root',f.root],
    {encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:thread,NODE_NO_WARNINGS:'1'}}));
  assert.equal(readCli('thread-worker').feishuInbox,undefined);
  const mail=readCli('thread-manager').feishuInbox;
  assert.equal(mail.text,'请解释理由');
  assert.equal(f.channel.next('thread-manager').id,mail.id);
  f.channel.acknowledge('thread-manager',mail.id,'因为已验证。');
  await wakePending(f.channel,send,2100);assert.equal(wakes,0);
  const next=f.message('另一个问题');next.message.message_id='om_new';f.channel.acceptMessage(next);
  await wakePending(f.channel,send,2200);assert.equal(wakes,1);
});
