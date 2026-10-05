// Porta da conta pagadora: QUEM paga o que uma pessoa gasta. O núcleo grava o
// consumo (usage_events) e fecha a cobrança de vídeo sempre por aqui; a pessoa
// é quem usou (user_id), a conta que paga é carimbada em org_id.
//  transacao(pool,{userId,orgId},run) → roda run(client, orgIdQuePaga) numa
//    transação com as travas da conta (travas-de-conta.mjs) e devolve o que run
//    devolver. orgId undefined = a implementação decide; orgId explícito força a
//    conta (null = pessoal). Sem userId e sem orgId, run(pool,null) fora de
//    transação.
// Na versão aberta ninguém paga pela empresa (orgIdQuePaga é sempre null); no
// Brambs a empresa de quem a pessoa é membro paga (credit-account-transaction.mjs).
import { emTransacao, lockCreditUser } from './travas-de-conta.mjs';

export const METODOS_CONTA_PAGADORA=['transacao'];
export function conferirContaPagadora(c){
 const faltam=METODOS_CONTA_PAGADORA.filter(m=>typeof c?.[m]!=='function');
 if(faltam.length)throw Error('Porta de conta pagadora incompleta: '+faltam.join(', '));
 return c;
}
export function createContaPagadoraSimples(){
 return conferirContaPagadora({
  transacao(pool,{userId}={},run){
   if(!userId)return run(pool,null);
   return emTransacao(pool,async client=>{await lockCreditUser(client,userId);return run(client,null);});
  },
 });
}
