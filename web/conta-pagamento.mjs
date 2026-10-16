// Operator payment account port: an Asaas account that WHOEVER INSTALLS opens
// in the user's name (the managed payment account a plugin opens for the user).
// The Asaas connector with a key the user stored in the vault is the core's and
// works without it. In the open version there is no operator account
// (createContaPagamentoSimples); a plugin can provide one.
//
//  escolherConta(conns) → which vault Asaas connection the money tools move:
//    { conexao, contaBrambs, rotulo, ambigua } or null. conns is the user's raw
//    connections list.
//  garantirWebhook({userId,cred,publicBase}) → sets up the account's receipt
//    webhook before an outgoing payment. cred() returns the chosen account.
//  ferramentasDoCofre({userId,cred,brasil,imagensDoTurno}) → { livres,
//    comConfirmacao }: tools that join the vault group; the second group only
//    runs after the owner's "go ahead".
//  rotuloDoCofre(rotulo,{brasil}) → text the model reads to decide whether to
//    open the vault group.
//  apresentacao({mensagem,historico,idioma}) → null, or the turn's mandatory
//    identification: { anexo, meta, comTexto(texto), entrada(userInput),
//    indisponivel({userId,grupo,brasil}) → text or null }. meta marks the reply
//    in history so the identification isn't repeated.
//  instrucoes(nomes) → extra prompt lines; nomes = Set of the turn's tools.
export const METODOS_CONTA_PAGAMENTO=['escolherConta','garantirWebhook','ferramentasDoCofre','rotuloDoCofre','apresentacao','instrucoes'];
export function conferirContaPagamento(c){
 const faltam=METODOS_CONTA_PAGAMENTO.filter(m=>typeof c?.[m]!=='function');
 if(faltam.length)throw Error('Porta de conta de pagamento incompleta: '+faltam.join(', '));
 return c;
}
// Vault Asaas connections, in vault order.
export const conexoesAsaas=(conns)=>(conns||[]).filter((c)=>String(c?.provider||'').toLowerCase()==='asaas'
 &&['apikey','token','basic'].includes(c?.kind));
export function createContaPagamentoSimples(){
 return conferirContaPagamento({
  escolherConta:(conns)=>{
   const asaas=conexoesAsaas(conns);
   if(!asaas.length)return null;
   return {conexao:asaas[0],contaBrambs:false,rotulo:asaas[0].label||'conta Asaas própria',ambigua:asaas.length>1};
  },
  garantirWebhook:async()=>({skipped:true,reason:'conta_asaas_propria'}),
  ferramentasDoCofre:()=>({livres:[],comConfirmacao:[]}),
  rotuloDoCofre:(rotulo)=>rotulo,
  apresentacao:()=>null,
  instrucoes:()=>[],
 });
}
