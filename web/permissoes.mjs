// Port 2 (permissions): what the operator limits per account. The core asks,
// whoever installs it answers (e.g. a plan-based plugin); in the open version
// the default is no app limit and ctl's fixed disk.
//
//  bloqueioDeApp({ownerUserId,atuais,appClient}) → null (may create a NEW app) or
//    {ok:false,error,agente,...}: error goes to the person, agente to the model.
//    Only called for a new app; editing an existing app never goes through here.
//  discoDoAppMb(dono) → MB of disk for the owner's apps (ctl applies it per user).
//    dono = users row, or null if the read failed.
//  filaDeEspera() → true when sign-up is closed: a new account only gets in with
//    approval, a referral code or a company invite. Error here = open.
//  liberadoNoCadastro(email) → true when the email gets in even with sign-up
//    closed (e.g. a beta allowlist). Default: false.
//  entrarNaFila({email,name,referrerCode,reason}) → someone hit closed sign-up:
//    {mensagem} (queued; the message goes to the person) or null (no queue;
//    sign-up is refused). reason: sem_codigo, sem_convite or codigo_invalido.
//    Default: null.
//  podeRecusarTreino(userId) → true when the account can opt its conversations
//    out of model training (the button shows and the route accepts). Default:
//    false, since the open version trains nothing and the button makes no sense.
export const METODOS_PERMISSOES=['bloqueioDeApp','discoDoAppMb','filaDeEspera','liberadoNoCadastro','entrarNaFila','podeRecusarTreino'];
export function conferirPermissoes(p){
 const faltam=METODOS_PERMISSOES.filter(m=>typeof p?.[m]!=='function');
 if(faltam.length)throw Error('Porta de permissões incompleta: '+faltam.join(', '));
 return p;
}
export function createPermissoesSimples({maxApps=null,discoMb=200,cadastroFechado=false}={}){
 return conferirPermissoes({
  async bloqueioDeApp({atuais}){
   if(maxApps===null||atuais<maxApps)return null;
   const error=`Esta instalação permite ${maxApps} app${maxApps===1?'':'s'} por pessoa e já há ${atuais}.`;
   return {ok:false,error,agente:`Teto de apps atingido (${atuais}/${maxApps}). NÃO tente publicar de novo. Ofereça apagar um app que não é mais usado (apagar_sistema).`,teto:maxApps,atuais};
  },
  discoDoAppMb:()=>discoMb,
  filaDeEspera:async()=>cadastroFechado,
  liberadoNoCadastro:async()=>false,
  entrarNaFila:async()=>null,
  podeRecusarTreino:async()=>false,
 });
}
