// Target resolution is shared by proposal preparation and the locked write.
export function selectInboundDecision(rows, {id, de} = {}) {
  if (id != null) {
    const hit = rows.find(r => r.id === String(id).trim());
    return hit ? {row:hit} : {error:'nao_encontrada'}; // Never fall back from an explicit ID.
  }
  if (!rows.length) return {error:'nenhuma_pendente'};
  let matches=rows;
  if (de != null) {
    const q=String(de).trim().toLowerCase();
    if (!q) return {error:'nao_encontrada'};
    matches=rows.filter(r=>(r.from_email||'').toLowerCase()===q);
    if (!matches.length) matches=rows.filter(r=>(r.from_name||'').toLowerCase()===q);
    if (!matches.length) matches=rows.filter(r=>(r.from_name||'').toLowerCase().includes(q));
  }
  return matches.length===1 ? {row:matches[0]} : {error:matches.length?'ambigua':'nao_encontrada'};
}
export function decisionSnapshot(row) {
  return Object.fromEntries(['id','from_user','to_agent','origin_channel','objetivo','resultado'].map(k=>[k,row[k]??null]));
}
const sameDecision=(a,b)=>JSON.stringify(decisionSnapshot(a))===JSON.stringify(decisionSnapshot(b));
export function createInboundDecisionResponder(pool) {
  return async (userId,{id,de,accept,mensagem,expected}={})=>{
    if(typeof accept!=='boolean')return {error:'resposta_invalida'};
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const {rows}=await c.query(`SELECT c.*,u.name from_name,u.email from_email
        FROM mtr_harness.agent_convos c JOIN mtr_harness.users u ON u.id=c.from_user
        WHERE c.to_user=$1 AND c.status='accepted' ORDER BY c.id FOR UPDATE OF c`,[userId]);
      const selected=selectInboundDecision(rows,{id,de});
      if(selected.error){await c.query('ROLLBACK');return selected;}
      const hit=selected.row;
      if(expected&&!sameDecision(hit,expected)){await c.query('ROLLBACK');return {error:'alterada'};}
      const txt=String(mensagem||'').trim()||(accept?'Confirmado.':'Recusado.');
      await c.query(`INSERT INTO mtr_harness.agent_convo_msgs (convo_id,sender_agent,side,intent,payload)
        VALUES ($1,$2,'b',$3,$4)`,[hit.id,hit.to_agent,accept?'accept':'decline',txt]);
      await c.query(`UPDATE mtr_harness.agent_convos SET status=$2,updated_at=now() WHERE id=$1`,[hit.id,accept?'confirmed_b':'declined_b']);
      await c.query('COMMIT');
      return {ok:true,from_name:hit.from_name,accepted:accept,decisao:hit.resultado,to_user:hit.from_user,origin_channel:hit.origin_channel||null,resposta:txt};
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  };
}
const errors={nenhuma_pendente:'Você não tem nenhuma decisão de contato aguardando resposta agora.',ambigua:'Há mais de uma decisão pendente. Escolha a proposta pelo conteúdo e use seu identificador; só o contato pode não distinguir as propostas.',nao_encontrada:'Essa decisão não está mais pendente nesta conta. Atualize a lista antes de confirmar.',alterada:'A decisão mudou depois da proposta. Confira o novo conteúdo e peça outra confirmação.',resposta_invalida:'Informe aceitar ou recusar explicitamente.'};
export function createRespondDecisionTool({fromUser,list,respond,owner,notifyOwner}) {
  const execute=async(args,expected)=>{
    const r=await respond(fromUser,{id:args.id,de:args.de,accept:args.aceito,mensagem:args.mensagem,expected});
    if(r.error)return JSON.stringify({ok:false,error:errors[r.error]||'Não consegui responder a decisão.'});
    const user=await owner(fromUser).catch(()=>null),name=(user?.name||'seu contato').split(' ')[0];
    const line=`${name} ${r.accepted?'confirmou':'recusou'}${r.decisao?`: ${r.decisao}`:' sua proposta'}.${r.resposta&&!['Confirmado.','Recusado.'].includes(r.resposta)?` "${r.resposta}"`:''}`;
    try{await notifyOwner?.(r.to_user,line,{channel:r.origin_channel});}catch{}
    return JSON.stringify({ok:true,person:r.from_name,accepted:r.accepted,note:`Resposta de ${r.accepted?'confirmação':'recusa'} registrada para o assistente de ${r.from_name||'seu contato'}.`});
  };
  function bound(args,binding){
    if(binding?.userId!==fromUser||!binding.snapshot?.id||binding.snapshot.id!==args.id)throw Error('Não consegui revalidar a decisão. Faça uma nova proposta.');
    return {descriptor:binding,labels:binding.labels,run:()=>execute(args,binding.snapshot)};
  }
  return {
    name:'responder_decisao',
    description:'Aceita ou recusa uma decisão pendente de outro contato, somente após confirmação explícita do dono. Use o id exibido na caixa de decisões para escolher a proposta exata, inclusive quando há várias do mesmo contato.',
    parameters:{type:'object',properties:{id:{type:'string',description:'Identificador completo da decisão na caixa de pendências. Não invente.'},aceito:{type:'boolean',description:'true para aceitar, false para recusar.'},de:{type:'string',description:'Nome ou e-mail do contato, somente se identificar uma única proposta.'},mensagem:{type:'string',description:'Recado opcional ao contato.'}},required:['aceito']},
    async prepareConfirmation(args){
      if(typeof args.aceito!=='boolean')throw Error(errors.resposta_invalida);
      const selected=selectInboundDecision(await list(fromUser),args);
      if(selected.error)throw Error(errors[selected.error]);
      const r=selected.row;args.id=r.id;args.de=r.from_name||r.from_email||'seu contato';
      const content=String(r.resultado||r.objetivo||'').replace(/\s+/g,' ').trim();
      const suffix=args.mensagem?` — "${args.mensagem}"`:'';
      const labels={'pt-BR':`${args.aceito?'aceitar':'recusar'} a proposta de ${args.de}: "${content}"${suffix}`,en:`${args.aceito?'accept':'decline'} the proposal from ${args.de}: "${content}"${suffix}`,es:`${args.aceito?'aceptar':'rechazar'} la propuesta de ${args.de}: "${content}"${suffix}`};
      return bound(args,{userId:fromUser,snapshot:decisionSnapshot(r),labels});
    },
    restoreConfirmation:bound,
    // Only prepared/restored confirmations may execute this write.
    run:async()=>JSON.stringify({ok:false,error:'Prepare e confirme a proposta exata antes de responder.'}),
  };
}
