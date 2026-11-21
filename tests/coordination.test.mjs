import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Boss } from '../src/boss.mjs';
import { reportCard, reportData } from '../integrations/feishu/card.mjs';

function fixture(t,policy) {
  const root=mkdtempSync(join(tmpdir(),'boss-coordination-'));
  const boss=new Boss(root),thread=process.env.CODEX_THREAD_ID;
  const connections=[boss];
  const connect=()=>{const client=new Boss(root);connections.push(client);return client;};
  t.after(()=>{
    if (thread===undefined) delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=thread;
    for (const client of connections) client.close();
    rmSync(root,{recursive:true,force:true});
  });
  boss.init('参观导览');
  for (const role of ['maker','tester','other','reviewer','manager']) {
    const kind=['reviewer','manager'].includes(role)?role:'worker';
    boss.bindRole({id:role,kind,title:role,threadId:'original-'+role});
  }
  boss.startStage({id:'visit',title:'展品导览',goal:'访客独立从入口到第二厅',acceptance:['实际走到第二厅'],policy});
  writeFileSync(join(root,'route.txt'),'入口 -> 二厅');
  return {boss,connect};
}
function send(boss,id) {
  const j=boss.claimStatus();
  assert.equal(j.status,'claimed');
  if (id) assert.deepEqual(j.ids,[id]);
  boss.markSent({ids:j.ids,turnId:'turn-'+j.ids[0]});
  process.env.CODEX_THREAD_ID=j.threadId;
  return j;
}
function done(boss,id,workEvidence) {
  return boss.complete({ids:[id],text:id+' 的原始回执',sourceRef:'chat/'+id,workEvidence});
}
const proof={artifact:'路线文件',validation:'走了一遍',remaining:'待下一环节确认'};
const read=path=>({read:[path],write:[]});
const write=path=>({read:[],write:[path]});
const task=(id,role,scope)=>({id,role,text:'检查 '+id,scope});

test('原聊天领取适用决定和首个验证；独立范围可同时认领，重叠读写和同一聊天排队',t=>{
  const {boss:b,connect}=fixture(t,{maxParallel:3,firstProof:'从参观入口走通一次'});
  const second=connect();
  const old={id:'one',text:'首页显示作品',sourceRef:'owner/1',roles:['maker']};
  b.agreement(old);
  b.agreement({...old,id:'two',text:'首页先显示作品原图',supersedes:'one'});
  assert.throws(()=>b.agreement({...old,id:'bad',roles:['tester'],supersedes:'two'}),/适用角色/);
  b.enqueue(task('write','maker',write('Exhibits')));
  b.enqueue(task('overlap','tester',read('exhibits/one')));
  b.enqueue(task('same','maker',read('docs')));
  b.enqueue(task('other','other',write('docs')));
  assert.throws(()=>b.enqueue(task('escape','tester',write('../elsewhere'))),/相对路径/);
  const a=send(b,'write');
  assert.match(a.text,/从参观入口走通一次/);assert.match(a.text,/首页先显示作品原图/);assert.doesNotMatch(a.text,/已定（one）/);
  const c=send(second,'other');assert.doesNotMatch(c.text,/已定/);
  assert.equal(b.claimStatus().status,'blocked');
  assert.deepEqual(b.trace({id:'write'}).decisions,['two']);
  assert.ok(b.trace({id:'write'}).event);assert.ok(b.trace({id:'write'}).run);
  assert.doesNotMatch(JSON.stringify(b.trace({id:'write'})),/"token"/);
  done(b,'write');send(second,'overlap');
  assert.equal(b.claimStatus().status,'blocked');
  done(b,'other');send(b,'same');done(b,'overlap');done(b,'same');
  assert.equal(b.claimStatus().status,'empty');assert.equal(b.teamBoard().stage.maxParallel,3);
});

test('工作项限额、原负责人员修复及原验证员复测跨连接可恢复，同一回执只立一项',t=>{
  const {boss:b,connect}=fixture(t,{workLimit:2,firstProof:'二厅往返'});
  b.feedback({id:'sign',category:'defect',text:'回程看不到出口',sourceRef:'owner',owner:'tester',scenario:'从二厅返程',expected:'看见出口'});
  b.enqueue({...task('build','maker'),handoff:{to:'tester',acceptance:'按路标往返',output:'导览图'}});
  send(b,'build');done(b,'build',proof);
  b.enqueue({...task('walk','tester'),fromJob:'build',feedbackIds:['sign']});
  send(b,'walk');
  b.regression({jobId:'walk',feedbackId:'sign',outcome:'fail',evidence:'走到死角',version:'v1'});
  done(b,'walk',proof);assert.ok(done(b,'walk',proof).duplicate);
  assert.deepEqual(b.teamBoard().pending,[{jobId:'walk',feedbackId:'sign',reason:'work_limit'}]);
  assert.throws(()=>b.enqueue(task('extra','other')),/上限/);
  const other=connect();
  const increase={stageId:'visit',workLimit:4,sourceRef:'owner/message',opinion:'同意一次修复和复测'};
  assert.deepEqual(other.raiseLimit(increase),other.raiseLimit(increase));
  const fix=send(other);assert.equal(fix.threadId,'original-maker');assert.match(fix.text,/走到死角/);
  assert.equal(other.trace({id:fix.ids[0]}).followup.origin,'build');
  done(other,fix.ids[0],proof);done(other,fix.ids[0],proof);
  const check=send(b);assert.equal(check.threadId,'original-tester');assert.match(check.text,/从二厅返程/);
  b.regression({jobId:check.ids[0],feedbackId:'sign',outcome:'pass',version:'v2',evidence:'找到出口'});
  done(b,check.ids[0],proof);
  assert.equal(b.teamBoard().stage.used,4);assert.deepEqual(b.teamBoard().pending,[]);
  assert.deepEqual(b.openRegressions(b.status()),[]);assert.equal(b.claimStatus().status,'empty');
});

test('连续两次修复复测仍失败，经理看到具体原因，队列不会自我循环',t=>{
  const {boss:b}=fixture(t,{});
  b.feedback({id:'return',category:'defect',text:'返程看不见路标',sourceRef:'boss/return',owner:'tester',scenario:'返程',expected:'看到路标'});
  b.enqueue({...task('map','maker'),handoff:{to:'tester',output:'导览图',acceptance:'返程有标识'}});
  send(b,'map');done(b,'map',proof);
  b.enqueue({...task('visit-return','tester'),fromJob:'map',feedbackIds:['return']});
  let last;
  for (let attempt=0;attempt<=2;attempt++) {
    const check=send(b);last=check.ids[0];assert.equal(check.role,'tester');
    b.regression({jobId:last,feedbackId:'return',outcome:'fail',evidence:'仍看不见',version:'v'+attempt});
    done(b,last,proof);
    if (attempt<2) {const fix=send(b);assert.equal(fix.role,'maker');done(b,fix.ids[0],proof);}
  }
  assert.equal(b.claimStatus().status,'empty');
  assert.deepEqual(b.teamBoard().pending,[{jobId:last,feedbackId:'return',reason:'review_required'}]);
  assert.equal(b.teamBoard().stage.used,6);
});

test('缺原实现交接的失败留给经理；旧失败不可冒充通过，较新实测可解除',t=>{
  const {boss:b}=fixture(t,{});
  b.feedback({id:'stairs',category:'defect',text:'看不清二厅楼梯',sourceRef:'owner/2',owner:'tester',scenario:'打开地图',expected:'能看清楼梯'});
  const check=(id,outcome)=>{
    b.enqueue({...task(id,'tester'),feedbackIds:['stairs']});send(b,id);
    b.regression({jobId:id,feedbackId:'stairs',outcome,version:id,evidence:id+' 实测'});done(b,id,proof);
  };
  check('attempt1','fail');
  assert.deepEqual(b.teamBoard().pending,[{jobId:'attempt1',feedbackId:'stairs',reason:'confirm_owner'}]);
  assert.equal(b.claimStatus().status,'empty');
  const delivery=b.deliver({role:'maker',summary:'导览图',files:['route.txt'],evidence:'桌面走查',sourceRef:'chat/maker'});
  const review=send(b);assert.match(review.text,/attempt1 实测/);
  for (const axis of ['requirements','quality']) b.reviewPass({jobId:review.ids[0],axis,verdict:'pass',evidence:'已检查'});
  done(b,review.ids[0]);
  const receipt={...delivery,verdict:'pass',sourceRef:'chat/'+review.ids[0],evidence:'两项核对'};
  assert.throws(()=>b.review(receipt),/回归/);
  check('attempt2','unverified');assert.throws(()=>b.review(receipt),/重新交付审查/);
  check('attempt3','pass');assert.deepEqual(b.teamBoard().pending,[]);
  assert.throws(()=>b.review(receipt),/重新交付审查/);
  const updated=b.deliver({role:'maker',summary:'导览图复测已更新',files:['route.txt'],evidence:'attempt3 实测',sourceRef:'chat/maker-new'});
  const followup=send(b,updated.reviewTaskId);
  for (const axis of ['requirements','quality']) b.reviewPass({jobId:followup.ids[0],axis,verdict:'pass',evidence:'核过新记录'});
  done(b,followup.ids[0]);assert.equal(b.review({...receipt,...updated,sourceRef:'chat/'+followup.ids[0]}).verdict,'pass');
});

test('审查双项绑定原审查员和本次交付，结论进入卡片和报告，所有者批复前保持冻结',t=>{
  const {boss:b}=fixture(t,{});
  const d=b.deliver({role:'maker',summary:'导览图画完',files:['route.txt'],evidence:'步行记录',sourceRef:'chat/maker'});
  const j=send(b,d.reviewTaskId);const row={jobId:j.ids[0],axis:'requirements',verdict:'pass',evidence:'从入口走到了二厅'};
  process.env.CODEX_THREAD_ID='original-maker';assert.throws(()=>b.reviewPass(row),/原审查员/);
  process.env.CODEX_THREAD_ID=j.threadId;
  assert.throws(()=>b.reviewPass({...row,axis:'quality'}),/先核对需求/);
  b.reviewPass(row);assert.throws(()=>done(b,j.ids[0]),/尚缺/);
  b.reviewPass({...row,axis:'quality',verdict:'needs_evidence',evidence:'手机回程还没测'});
  done(b,j.ids[0]);
  const review={...d,sourceRef:'chat/'+j.ids[0],evidence:'原审查员实走',findings:[]};
  assert.throws(()=>b.review({...review,verdict:'pass'}),/总评/);
  b.review({...review,verdict:'needs_evidence'});
  const report=b.report({completed:'第一厅能走通。',incomplete:'手机回程还没测。',verification:'审查员走过。',next:'我建议补测手机。',sourceRef:'chat/manager'});
  assert.match(b.reportView(),/实现质量：待补证据/);
  assert.match(JSON.stringify(reportCard(reportData(b.status()),'待批',true)),/手机回程还没测/);
  assert.throws(()=>b.enqueue(task('another','maker')),/批复/);
  assert.throws(()=>b.decide({reportId:report.id,version:report.version,decision:'approve',opinion:'继续',userMessageRef:'boss'}),/逐项/);
  b.decide({reportId:report.id,version:report.version,decision:'revise',opinion:'我想先看手机复测',userMessageRef:'owner/message'});
  assert.equal(b.teamBoard().stage.status,'working');
});
