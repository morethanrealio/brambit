// Deterministic channel rendering; no hidden LLM rewrite or channel switch.
export function curationPackets(channel,text) {
 if(typeof text!=='string'||!text.trim()||text.length>64000)throw Error('Curadoria vazia ou longa demais.');
 if(channel==='email'||channel==='none'||channel==='app')return [text];
 if(!['whatsapp','telegram'].includes(channel))throw Error('Canal de curadoria inválido.');
 // Preserve reading structure in a WhatsApp session. The transport produces a
 // separate single-line template variable only when the channel requires it.
 const body=channel==='whatsapp'?text.split(/(https?:\/\/[^\s]+)/g).map(part=>/^https?:\/\//.test(part)?part:part.replace(/[#*_`]/g,'')).join('').replace(/[ \t]+/g,' ').trim():text;
 const max=channel==='whatsapp'?750:3400;
 const parts=[];let rest=body;
 while(rest.length>max){let at=rest.lastIndexOf('\n\n',max);if(at<max/2)at=Math.max(rest.lastIndexOf('\n',max),rest.lastIndexOf(' ',max));if(at<max/2)throw Error('Link ou palavra não cabe no canal; não truncar.');parts.push(rest.slice(0,at).trim());rest=rest.slice(at+1).trimStart();}
 if(rest)parts.push(rest);
 if(parts.length>30)throw Error('Curadoria excede limite de mensagens do canal; ajuste o resumo.');
 return parts.map((p,i)=>parts.length===1?p:`(${i+1}/${parts.length}) ${p}`);
}
export async function sendCurationChannel(r,edition,{email,telegram,whatsapp,app}) {
 const channel=r.channel||'none';
 const parts=curationPackets(channel,edition.text); // Validate ALL chunks before the first send.
 const ids=[];
 for(const part of parts){
  let receipt;
  if(channel==='email')receipt=await email(r,part);
  else if(channel==='telegram')receipt=await telegram(r,part);
  else if(channel==='whatsapp')receipt=await whatsapp(r,part); // same plain text in template/session
  else receipt=await app(r,edition);
  if(receipt?.ok!==true||receipt.skipped||typeof receipt.id!=='string'||!receipt.id)throw Error('Canal não confirmou a entrega completa.');
  ids.push(receipt.id);
 }
 const id=ids.join(',');if(id.length>1000)throw Error('Comprovante excede limite seguro.');
 return {ok:true,id};
}
