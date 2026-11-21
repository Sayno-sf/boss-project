#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Boss } from './boss.mjs';
import { managerMail } from '../integrations/feishu/checkpoint.mjs';
import manifest from '../plugin.json' with { type: 'json' };

const args = process.argv.slice(2);
const command = args.shift();
const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
if (!command || command === 'help' || command === '--help') {
  console.log(`BOSS ${manifest.version} — 持久角色聊天与阶段审批\n\nnode src/cli.mjs <command> --root <project> [--input <JSON file>]\n\n只读：status, messages, report-view, team-board, task-trace\n团队：profile, read-skill, brief, feedback, regression, agreement, review-pass\n控制：init, bind, stage, assign, discuss, claim, sent, uncertain, complete, close-dispatch, deliver, review, report\n所有者：raise-limit, decide（必须有用户明确批复与意见；不通过 MCP 暴露）\n\n直接启动原经理聊天调度。claim 返回 claimed、blocked 或 empty。发送后用 sent 记录真实轮次，完成后用 complete 记录原文。状态不明用 uncertain，核实未发送或已终止后可用 close-dispatch。deliver 返回 submissionId、reviewTaskId 和 version，review 须携带这三项与已完成审查回执的 sourceRef。`);
  process.exit(0);
}
let boss;
try {
  const root = resolve(option('root') ?? process.cwd());
  const inputFile = option('input');
  const input = inputFile ? JSON.parse(readFileSync(resolve(inputFile), 'utf8')) : {};
  boss = new Boss(root, { readOnly: ['status', 'messages', 'report-view', 'team-board', 'task-trace'].includes(command),
    ...(option('state-dir') && { stateDir: resolve(option('state-dir')) }) });
  const operations = {
    init: () => boss.init(input.name ?? option('name') ?? 'BOSS 项目'),
    status: () => boss.status(), messages: () => boss.messages(Number(option('after') ?? 0)),
    'team-board': () => boss.teamBoard(), 'task-trace': () => boss.trace(input),
    agreement: () => boss.agreement(input), 'review-pass': () => boss.reviewPass(input),
    'raise-limit': () => boss.raiseLimit(input),
    'report-view': () => boss.reportView(),
    profile: () => boss.profile(input), 'read-skill': () => boss.readSkill(input),
    brief: () => boss.brief(input), feedback: () => boss.feedback(input), regression: () => boss.regression(input),
    bind: () => boss.bindRole(input), stage: () => boss.startStage(input),
    assign: () => boss.enqueue(input), discuss: () => boss.enqueue({ ...input, kind: 'discussion' }),
    claim: () => boss.claimStatus(), sent: () => boss.markSent(input), uncertain: () => boss.uncertain(input),
    'close-dispatch': () => boss.closeDispatch(input),
    complete: () => boss.complete(input), deliver: () => boss.deliver(input), review: () => boss.review(input),
    report: () => boss.report(input), decide: () => boss.decide(input),
  };
  if (!Object.hasOwn(operations, command)) throw new Error(`未知命令 ${command}；运行 help 查看入口`);
  const result=operations[command]();
  const mail=managerMail(boss);
  console.log(JSON.stringify({ ok: true, result, ...(mail && {feishuInbox:mail}) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1;
} finally { boss?.close(); }
