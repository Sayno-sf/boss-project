import { Client, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { randomBytes } from 'node:crypto';

export async function identify(appId, appSecret) {
  const ws=new WSClient({appId,appSecret,loggerLevel:LoggerLevel.error});
  const code='配对 '+randomBytes(6).toString('hex');
  let done,timer;
  const result=new Promise(resolve=>{done=resolve;});
  const events=new EventDispatcher({loggerLevel:LoggerLevel.error}).register({
    'im.message.receive_v1':async e=>{
      const msg=e.message;
      if (e.app_id===appId && e.sender?.sender_type==='user' && msg?.chat_type==='p2p' &&
        msg.message_type==='text' && JSON.parse(msg.content).text===code) done(e.sender.sender_id.open_id);
    },
  });
  console.log('请在 5 分钟内私聊飞书机器人，发送：'+code);
  try {
    timer=setTimeout(()=>done(null),300_000);
    await ws.start({eventDispatcher:events});
    const owner=await result;
    if (!owner) throw Error('配对超时，请检查机器人可用范围和接收消息事件后重试');
    return owner;
  } finally {clearTimeout(timer);ws.close({force:true});}
}

export function handlers(channel) {
  return {
    'im.message.receive_v1': async event => channel.acceptMessage(event),
    'card.action.trigger': async event => {
      try {
        channel.acceptCard(event);
        return {toast:{type:'info',content:'已收到提交，请查看报告上的处理结果。'}};
      } catch (error) {
        if (error.code) throw error;
        return {toast:{type:'error',content:error.message}};
      }
    },
  };
}

export function feishuClient(channel, appId, appSecret) {
  const options={appId,appSecret,loggerLevel:LoggerLevel.error};
  const client=new Client(options), ws=new WSClient(options);
  const data=async request=>{
    const result=await request;
    if (result.code!==0) throw Error('飞书接口错误 '+result.code+' '+result.msg);
    return result.data;
  };
  return {
    start:()=>ws.start({eventDispatcher:new EventDispatcher({loggerLevel:LoggerLevel.error}).register(handlers(channel))}),
    connection:()=>ws.getConnectionStatus().state,
    close:()=>ws.close({force:true}),
    sendCard:(owner,content,uuid)=>data(client.im.message.create({params:{receive_id_type:'open_id'},
      data:{receive_id:owner,msg_type:'interactive',content,uuid}})),
    update:(id,content)=>data(client.im.message.patch({path:{message_id:id},data:{content}})),
    reply:(id,text,uuid)=>data(client.im.message.reply({path:{message_id:id},
      data:{msg_type:'text',content:JSON.stringify({text}),uuid}})),
  };
}
