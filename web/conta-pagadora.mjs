// Paying account port: WHO pays for what a person spends. The core records
// usage (usage_events) and closes video billing always through here; the person
// is who used it (user_id), the paying account is stamped in org_id.
//  transacao(pool,{userId,orgId},run) → runs run(client, orgIdQuePaga) in a
//    transaction with the account locks (travas-de-conta.mjs) and returns what
//    run returns. orgId undefined = the implementation decides; an explicit orgId
//    forces the account (null = personal). With no userId and no orgId,
//    run(pool,null) outside a transaction.
// In the open version no company pays (orgIdQuePaga is always null); a plugin
// can make the company the person belongs to pay.
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
