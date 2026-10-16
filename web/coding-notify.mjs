// Explicit origin only. Never fall back to another channel or regenerate text
// with a paid model. The job outbox prevents retrying an unknown send.
import {codingJobReceipt} from './coding-jobs.mjs';
import { marca } from './marca.mjs';
export function createCodingNotifier({getAgent,getTelegramBot,getWhatsAppLink,waEnabled,sendTelegram,sendWhatsApp}){
 return async job=>{
  const agent=await getAgent(job.agentId,job.userId);if(!agent)return {state:'unavailable'};
  const full=String((job.state==='paused'?codingJobReceipt(job).text:job.result?.text)||'A tarefa foi interrompida; confira o andamento na conversa do app.');
  const text=`${agent.name||'Assistente'} — programação: ${full.length>2800?full.slice(0,2800)+`… O resultado completo está na conversa do app ${marca().nome}.`:full}`;
  if(job.channel==='telegram'){
    const bot=await getTelegramBot(job.userId,job.agentId);
    if(!bot?.enabled||!bot.token||!bot.chat_id)return {state:'unavailable'};
    const result=await sendTelegram(bot.token,bot.chat_id,text);
    return result?.message_id?{state:'sent',receipt:String(result.message_id)}:{state:'unknown'};
  }
  if(job.channel==='whatsapp'){
    if(!waEnabled())return {state:'unavailable'};
    const link=await getWhatsAppLink(job.userId);if(!link?.enabled||!link.wa_phone)return {state:'unavailable'};
    const result=await sendWhatsApp(link.wa_phone,text,{retryUnknown:false,templateText:text.replace(/\s+/g,' ').trim()});
    return result?.wamid?{state:'sent',receipt:result.wamid}:{state:'unknown'};
  }
  return {state:'not_requested'};
 };
}
