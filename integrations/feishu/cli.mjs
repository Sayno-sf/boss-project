#!/usr/bin/env node
import { resolve,join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { Boss } from '../../src/boss.mjs';
import { Channel } from './channel.mjs';
import { wakePending } from './wake.mjs';
import { enableManager, managerGuide } from './manager.mjs';

const [command,rootArg, ...args]=process.argv.slice(2);
const help='node cli.mjs doctor|identify|serve|manager-guide|enable-manager|delivery|brief-delivery|wait|ack|answer <BOSS项目目录> [参数]\ndelivery <报告ID>，brief-delivery <简报ID>，wait [秒数]，ack <收件ID> [UTF-8回信文件]，answer <收件ID> <UTF-8答复文件>';
const print=value=>console.log(JSON.stringify(value,null,2));
async function run() {
  if (!command || command==='help' || command==='--help') { console.log(help); return; }
  if (!rootArg || !['doctor','identify','serve','manager-guide','enable-manager','delivery','brief-delivery','wait','ack','answer'].includes(command)) throw Error(help);
  const root=resolve(rootArg);
  const read=new Boss(root,{readOnly:true});
  let state;
  try {state=read.status();} finally {read.close();}
  const manager=Object.values(state?.roles??{}).find(r=>r.kind==='manager')?.threadId;
  const {FEISHU_APP_ID:appId,FEISHU_APP_SECRET:appSecret,BOSS_FEISHU_OPEN_ID:owner,CODEX_THREAD_ID:thread}=process.env;
  const missing=Object.entries({FEISHU_APP_ID:appId,FEISHU_APP_SECRET:appSecret,BOSS_FEISHU_OPEN_ID:owner})
    .filter(([,v])=>!v?.trim()).map(([k])=>k);
  const appValid=/^cli_[a-f\d]{16}$/i.test(appId) && Boolean(appSecret?.trim());
  const ownerValid=/^ou_[\w-]+$/.test(owner);
  if (command==='doctor') {
    print({project:state?.name??null,managerBound:Boolean(manager),stage:state?.stage?.status??null,missing,
      readyToConnect:Boolean(manager) && appValid && ownerValid,check:'本地配置检查'}); return;
  }
  if (!manager) throw Error('项目尚未绑定经理');
  if (command==='manager-guide') {console.log(managerGuide(root));return;}
  if (command==='enable-manager') {console.log(enableManager(root,state));return;}
  if (command==='identify') {
    if (!appValid) throw Error('请先配置飞书应用 ID 和 Secret');
    const {identify}=await import('./sdk.mjs');
    print({BOSS_FEISHU_OPEN_ID:await identify(appId,appSecret)});return;
  }
  if (command==='serve' && !(appValid && ownerValid)) {
    throw Error('请配置有效的 FEISHU_APP_ID、FEISHU_APP_SECRET、BOSS_FEISHU_OPEN_ID');
  }
  if (command!=='serve' && thread!==manager) throw Error('请在原经理聊天中运行收件命令');
  const boss=new Boss(root,{readOnly:command!=='serve'});
  let channel,api,lock;
  try {
    channel=new Channel(boss);
    if (command==='brief-delivery') {print(channel.briefDelivery(args[0]??''));return;}
    if (command==='delivery') {
      if (!args[0]) throw Error('请提供本次正式报告 ID');
      const end=Date.now()+20_000;
      let receipt=channel.delivery(args[0]);
      while (!receipt.delivered && Date.now()<end) {
        await sleep(500);
        receipt=channel.delivery(args[0]);
      }
      print(receipt); return;
    }
    if (command==='wait') {
      const seconds=Number(args[0]??60);
      if (!Number.isInteger(seconds)||seconds<0||seconds>3600) throw Error('等待秒数应在 0 至 3600 之间');
      if (args[1]==='working') channel.watch(thread,Date.now()+35_000);
      const end=Date.now()+seconds*1000;
      for (;;) {
        // A live reader can receive directly. Grace after pickup gives the manager
        // time to answer; a crashed or timed-out reader cannot suppress wake-ups forever.
        const item=channel.next(thread);
        if (item) {channel.watch(thread,Date.now()+30_000);print(item);return;}
        if (Date.now()>=end) {print({status:'等待超时，批复入口仍由飞书接收服务负责'});return;}
        channel.watch(thread,Math.min(end,Date.now()+4000));
        await sleep(Math.min(1000,end-Date.now()));
      }
    }
    if (command==='ack' || command==='answer') {
      const answer=command==='answer' || args[1]!==undefined ? readFileSync(args[1],'utf8') : undefined;
      channel.acknowledge(thread,args[0],answer,command==='ack' && answer!==undefined); print({received:true}); return;
    }
    // 一个项目一个接收进程。进程退出时 SQLite 自动释放独占锁。
    lock=new DatabaseSync(join(boss.stateDir,'feishu-listener.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    channel.bind(appId,owner);
    const {feishuClient}=await import('./sdk.mjs');
    api=feishuClient(channel,appId,appSecret);
    let stopped=false;
    const stop=()=>{stopped=true; api.close();};
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
    await api.start();
    let previousConnection;
    while (!stopped) {
      const connection=api.connection();
      if (connection!==previousConnection) {
        console.log('飞书长连接：'+connection);
        previousConnection=connection;
      }
      if (connection==='failed') throw Error('飞书连接失败，请检查凭据、应用状态及长连接设置');
      try {
        channel.applyDecisions();
        await wakePending(channel);
      } catch (error) {console.error('经理通知待重试：'+error.message);}
      if (connection==='connected') {
        try {await channel.sync(api);} catch(error) {console.error('飞书同步待重试：'+error.message);}
      }
      if (!stopped) await sleep(2500);
    }
  } finally { api?.close(); lock?.close(); channel?.close(); boss.close(); }
}
run().catch(error=>{ console.error(error.message); process.exitCode=1; });
