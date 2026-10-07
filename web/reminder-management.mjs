import { localDateTimeInstant } from './calendar-recurrence.mjs';

export function selectReminder(rows, {id, descricao, data}, timeZone) {
  const parsedDate=data === undefined ? null : new Date(data+'T00:00:00Z');
  if (data !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10)!==data)) return {ok:false,message:'Data inválida; nada foi alterado.'};
  const query=String(descricao || '').trim().toLowerCase();
  if (!id && !query) return {ok:false,message:'Consulte os lembretes e escolha qual alterar.'};
  const matches=rows.filter(r=>(id ? r.id===id : String(r.message).toLowerCase().includes(query)) && (!data || new Date(r.run_at).toLocaleDateString('sv',{timeZone})===data));
  if (matches.length!==1) return {ok:false,code:matches.length?'AMBIGUOUS':'NOT_FOUND',message:matches.length?'Há mais de um lembrete. Pergunte qual horário/canal a pessoa quer; nenhum foi alterado.':'Não encontrei esse lembrete pendente.',opcoes:matches.map(r=>({id:r.id,mensagem:r.message,quando:r.run_at,canal:r.channel}))};
  return {ok:true,row:matches[0]};
}

export function reminderManagementTools({userId,timeZone,list,cancel,reschedule}) {
  return [
    {name:'cancelar_lembrete',description:'Cancels only the chosen reminder. Prefer the id from listar_lembretes. descricao/data are only accepted when they identify ONE target; if there are several, ask which one. Canceling a series ends the upcoming notices. For "já fiz hoje" do not cancel the series: clarify whether they want to stop the future notices.',
      parameters:{type:'object',properties:{id:{type:'string'},descricao:{type:'string'},data:{type:'string',description:'Local date YYYY-MM-DD; not enough if there is more than one on the same day.'}}},
      async run(args={}) {
        const selected=selectReminder(await list(userId),args,timeZone);
        if (!selected.ok) return JSON.stringify(selected);
        const result=await cancel(selected.row.id,userId,{expectedRunAt:selected.row.run_at,returnDetails:true});
        const done=result===true || result?.canceled===true;
        return JSON.stringify({ok:done,id:selected.row.id,canal:selected.row.channel,inFlight:result?.inFlight===true,message:done?'Lembrete cancelado; próximos avisos interrompidos.'+(result?.inFlight?' Um envio já havia começado e ainda pode chegar.':''):'O lembrete mudou ou já foi processado. Consulte novamente; cancelamento não confirmado.'});
      }},
    {name:'editar_lembrete',description:'Reschedules ONLY the next notice of an existing reminder, without deleting/recreating it. Read listar_lembretes and pass the exact id and quando_atual. In a series, later occurrences keep the original cadence. To change the whole series, do not use this tool as if it did that. Does not change channel or text. Only confirm after ok:true.',
      parameters:{type:'object',required:['id','quando_atual','quando'],properties:{id:{type:'string'},quando_atual:{type:'string',description:'ISO instant returned by listar_lembretes.'},quando:{type:'string',description:'New local time YYYY-MM-DDTHH:mm:ss, without offset.'},fuso:{type:'string',description:'IANA time zone of the new time, if different from the user\'s.'}}},
      async run({id,quando_atual,quando,fuso}={}) {
        try {
          const runAt=localDateTimeInstant(quando,fuso || timeZone);
          const result=await reschedule(id,userId,{expectedRunAt:quando_atual,runAt});
          if (!result.ok) return JSON.stringify({ok:false,code:result.code,message:'Não foi possível remarcar com segurança. O aviso pode ter mudado ou iniciado envio; consulte os lembretes. Nenhum agendamento novo foi criado.'});
          return JSON.stringify({ok:true,id,quando:result.reminder.run_at,quando_legivel:new Date(result.reminder.run_at).toLocaleString('pt-BR',{timeZone:fuso || timeZone,dateStyle:'short',timeStyle:'short'})+` (${fuso || timeZone})`,canal:result.reminder.channel,message:'Próximo aviso remarcado. A cadência das demais ocorrências foi preservada.'});
        } catch { return JSON.stringify({ok:false,message:'Horário ou fuso inválido. Nada foi remarcado; confirme uma data/hora local válida.'}); }
      }},
  ];
}
