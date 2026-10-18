// Explicit origin only. Never fall back to another channel or regenerate text
// with a paid model. The job outbox prevents retrying an unknown send.
import {codingJobReceipt} from './coding-jobs.mjs';
import { marca } from './brand.mjs';
import {productI18n} from './i18n.mjs';
import {LEGACY_TEXT_LANGUAGE} from './locale.mjs';
export function createCodingNotifier({getAgent,getTelegramBot,getWhatsAppLink,waEnabled,sendTelegram,sendWhatsApp}){
 return async job=>{
  const agent=await getAgent(job.agentId,job.userId);if(!agent)return {state:'unavailable'};
  // job.language is the account language, set by the worker before delivery.
  const language=job.language||LEGACY_TEXT_LANGUAGE,{t}=productI18n();
  const full=String((job.state==='paused'?codingJobReceipt(job,language).text:job.result?.text)||t('coding.notify.fallback',language));
  const text=t('coding.notify.prefix',language,{name:agent.name||t('coding.notify.default_name',language),
    text:full.length>2800?full.slice(0,2800)+t('coding.notify.truncated',language,{brand:marca().nome}):full});
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
