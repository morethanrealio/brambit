// Porta 3: ciclo de vida. O núcleo só avisa o que aconteceu (emitir) e agenda as
// tarefas de fundo que a implementação plugada pedir; o que fazer com cada aviso é
// decisão de quem instala. No Brambs: bônus de indicação, boas-vindas, parados da
// semana, aviso de crédito e a rede de segurança da cobrança (eventos-brambs.mjs).
// Na versão aberta ninguém se inscreve e nada acontece.
//  Eventos:
//   conta_criada {userId,origem}: conta nova (origem email, convite, google ou
//     apple). O cadastro espera quem se inscreve antes de seguir.
//   primeira_mensagem {userId}: mensagem de GENTE numa conversa sem histórico
//     (rotina, cockpit e webhook não contam). Repete a cada conversa nova, então
//     quem se inscreve tem que ser idempotente.
//   exclusao_pedida {userId}: a pessoa pediu pra apagar a conta; chega ANTES de
//     a conta fechar. Quem se inscreve pode devolver {campos,aviso}: os campos
//     entram na resposta do pedido e o aviso no fim da mensagem (no Brambs, a
//     assinatura cancelada ou o aviso de que o cancelamento ficou pendente).
//   exclusao_final {userId}: o prazo venceu e a conta vai ser destruída; chega
//     antes do DELETE, que é a última chance de achar o que é da conta lá fora.
//   banco_pronto {}: o esquema subiu no boot. Quem emite não espera, então o
//     inscrito que quiser segurar algo agenda em segundo plano.
//   cofre_pronto {}: o boot já tentou abrir o cofre (vault.mjs) e cifrou os
//     segredos legados do núcleo; quem se inscreve cifra os dele. O cofre pode
//     não ter aberto: conferir vaultEnabled(). O boot espera.
//   whatsapp_reprovada {wamid,errorCode,errorTitle,errorMessage}: a Meta
//     aceitou uma mensagem (HTTP 200) e reprovou depois, no webhook de status
//     (no Brambs, o envio de campanha com esse wamid vira failed). O webhook
//     espera.
//  Tarefas: {nome,primeiraEmMs,aCadaMs,rodar}. Agendadas com unref, então não
//   seguram o processo vivo.
//  emitir resolve com o que cada inscrito devolveu, na ordem da inscrição.
//  Erro de quem se inscreve vai pro log e nunca volta pro núcleo (o lugar dele
//  na lista fica undefined): um bônus que falha não pode derrubar a resposta da
//  pessoa.
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
  // Nome desconhecido aqui só loga: quem emite está no meio de um turno.
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
// Liga a implementação plugada: {inscricoes:{evento:[fn]}, tarefas:[...]}.
// Evento desconhecido falha aqui, no boot, e não no primeiro uso.
export function ligarCicloDeVida(eventos,{inscricoes={},tarefas=[]}={}){
 for(const [nome,fns] of Object.entries(inscricoes))for(const fn of [].concat(fns))eventos.inscrever(nome,fn);
 for(const t of tarefas)eventos.agendar(t);
 return eventos;
}
// Todo cadastro passa por aqui: cria a conta (criar = createUser ou outra função
// do db que devolve a linha ou null) e avisa conta_criada. Espera quem se
// inscreve, então a conta já sai do cadastro com o que quem instala dá a uma
// conta nova (no Brambs, o primeiro mês grátis no Básico).
export const criadorDeConta=(eventos)=>async(criar,dados,origem)=>{
 const user=await criar(dados);
 if(user)await eventos.emitir('conta_criada',{userId:user.id,origem});
 return user;
};
