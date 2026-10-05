// Porta 2 (permissões): o que o operador limita por conta. O núcleo pergunta,
// quem instala responde. No Brambs a resposta vem do plano (permissoes-brambs.mjs);
// na versão aberta o padrão é sem limite de apps e o disco fixo do ctl.
//
//  bloqueioDeApp({ownerUserId,atuais,appClient}) → null (pode criar app NOVO) ou
//    {ok:false,error,agente,...}: error vai pra pessoa, agente pro modelo. Só é
//    chamado pra app novo; editar app que já existe nunca passa por aqui.
//  discoDoAppMb(dono) → MB de disco dos apps do dono (o ctl aplica por usuário).
//    dono = linha do users, ou null se a leitura falhou.
//  filaDeEspera() → true quando o cadastro está fechado: conta nova só entra com
//    liberação, código de indicação ou convite de empresa. Erro aqui = aberto.
//  liberadoNoCadastro(email) → true quando o e-mail passa mesmo com o cadastro
//    fechado (no Brambs, a whitelist do beta). Padrão: false.
//  entrarNaFila({email,name,referrerCode,reason}) → quem bateu no cadastro
//    fechado: {mensagem} (pôs na fila; a mensagem vai pra pessoa) ou null (não
//    há fila; o cadastro é recusado). reason: sem_codigo, sem_convite ou
//    codigo_invalido. Padrão: null.
//  podeRecusarTreino(userId) → true quando a conta pode tirar as conversas do
//    treino de modelo (o botão aparece e a rota aceita). Padrão: false, porque a
//    versão aberta não treina nada e o botão não faz sentido.
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
