// Port 3: lifecycle. The core only announces what happened (emitir) and
// schedules the background tasks the plugged implementation asks for; what to do
// with each event is up to whoever installs it (e.g. a plugin sending referral
// bonuses, welcome messages, inactivity nudges, credit warnings).
// In the open version nobody subscribes and nothing happens.
//  Events:
//   conta_criada {userId,origem}: new account (origin email, invite, google or
//     apple). Sign-up waits for subscribers before going on.
//   primeira_mensagem {userId}: a HUMAN message in a conversation with no history
//     (routine, cockpit and webhook don't count). Repeats for each new
//     conversation, so subscribers must be idempotent.
//   exclusao_pedida {userId}: the person asked to delete the account; arrives
//     BEFORE the account closes. A subscriber may return {campos,aviso}: campos
//     go into the request's response and aviso at the end of the message (e.g.
//     the subscription cancelled, or a notice that cancellation is pending).
//   exclusao_final {userId}: the grace period ended and the account will be
//     destroyed; arrives before the DELETE, the last chance to find what's outside.
//   banco_pronto {}: the schema came up at boot. The emitter doesn't wait, so a
//     subscriber that wants to hold something schedules it in the background.
//   cofre_pronto {}: boot already tried to open the vault (vault.mjs) and
//     encrypted the core's legacy secrets; subscribers encrypt their own. The
//     vault may not have opened: check vaultEnabled(). Boot waits.
//   whatsapp_reprovada {wamid,errorCode,errorTitle,errorMessage}: Meta accepted
//     a message (HTTP 200) and rejected it later, in the status webhook (e.g. a
//     plugin marks the campaign send with that wamid as failed). The webhook
//     waits.
//  Tasks: {nome,primeiraEmMs,aCadaMs,rodar}. Scheduled with unref, so they
//   don't keep the process alive.
//  emitir resolves with what each subscriber returned, in subscription order.
//  A subscriber's error goes to the log and never back to the core (its slot
//  in the list is undefined): a failing bonus must not take down the person's
//  reply.
export const EVENTOS=['conta_criada','primeira_mensagem','exclusao_pedida','exclusao_final','banco_pronto','cofre_pronto','whatsapp_reprovada'];
export function createEventos({log=console.error}={}){
 const inscritos=new Map(EVENTOS.map(n=>[n,[]]));
 const isolado=(rotulo,fn,dados)=>Promise.resolve().then(()=>fn(dados)).catch(e=>log(rotulo,e?.message??e));
 return {
  inscrever(nome,fn){
   if(!inscritos.has(nome))throw Error('Evento desconhecido: '+nome);
   if(typeof fn!=='function')throw Error('Inscrição sem função: '+nome);
   inscritos.get(nome).push(fn);
  },
  // An unknown name here just logs: whoever emits it is mid-turn.
  emitir(nome,dados){
   const fns=inscritos.get(nome);
   if(!fns){log('[eventos] evento desconhecido:',nome);return Promise.resolve([]);}
   return Promise.all(fns.map(fn=>isolado(`[eventos] ${nome}:`,fn,dados)));
  },
  agendar({nome,primeiraEmMs,aCadaMs=0,rodar}){
   if(typeof rodar!=='function')throw Error('Tarefa sem função: '+nome);
   const vez=()=>isolado(`[${nome}]`,rodar);
   setTimeout(vez,primeiraEmMs).unref();
   if(aCadaMs)setInterval(vez,aCadaMs).unref();
  },
 };
}
// Wires the plugged-in implementation: {inscricoes:{evento:[fn]}, tarefas:[...]}.
// An unknown event fails here, at boot, not on first use.
export function ligarCicloDeVida(eventos,{inscricoes={},tarefas=[]}={}){
 for(const [nome,fns] of Object.entries(inscricoes))for(const fn of [].concat(fns))eventos.inscrever(nome,fn);
 for(const t of tarefas)eventos.agendar(t);
 return eventos;
}
// Every sign-up goes through here: creates the account (criar = createUser or
// another db function returning the row or null) and emits conta_criada. Waits
// for subscribers, so the account leaves sign-up with whatever the installer
// gives a new account (e.g. a free first month on a plan).
export const criadorDeConta=(eventos)=>async(criar,dados,origem)=>{
 const user=await criar(dados);
 if(user)await eventos.emitir('conta_criada',{userId:user.id,origem});
 return user;
};
