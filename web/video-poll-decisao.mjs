// Decisões do poller de vídeo quando a entrega NÃO deu certo. Fica fora do
// server.mjs de propósito: aqui não entra banco nem rede, só a regra, e por isso
// dá pra testar de verdade.
//
// Contexto do achado #25: o poller pega de minuto em minuto todo job com status
// 'queued' ou 'processing'. Quando o worker termina, ele baixa o mp4, sobe pro
// bucket e cobra. Se qualquer passo aí falhava, o job CONTINUAVA ativo, então na
// volta seguinte o poller baixava e subia o vídeo inteiro de novo, e de novo,
// para sempre. Pior: o dono só pode ter 1 vídeo em andamento por vez, então ele
// nunca mais conseguia pedir outro.

// Depois disso, insistir deixa de ser tentativa e vira loop. Um render de até
// 15s leva minutos, não meia hora.
export const LIMITE_ENTREGA_MS = 30 * 60 * 1000;

// O que fazer quando a cobrança devolveu "não cobrei" (settled:false).
export function decidirCobrancaNaoConcluida(reason) {
  const motivo = String(reason || '');
  // Esses dois querem dizer que o job já saiu da fila ativa por outro caminho
  // (já foi finalizado, ou sumiu). Não há loop: o próximo tick não pega mais.
  if (motivo === 'already_final' || motivo === 'not_found') return { acao: 'seguir' };
  // Os '*_needs_review' são DETERMINÍSTICOS: já existe uma cobrança amarrada
  // nesse job e a gente se recusa a cobrar de novo. Tentar daqui a um minuto dá
  // exatamente no mesmo resultado, para sempre. Então tira da fila com status
  // próprio, que é o que um humano precisa ver pra decidir, sem debitar nada.
  return { acao: 'revisar', erro: `cobranca suspensa para revisao: ${motivo || 'motivo desconhecido'}` };
}

// O que fazer quando baixar/guardar/cobrar LANÇOU erro. Falha de rede ou soluço
// do bucket merece nova tentativa; falha que persiste por meia hora, não.
export function decidirFalhaNaEntrega({ idadeMs, limiteMs = LIMITE_ENTREGA_MS, mensagem = '' } = {}) {
  const idade = Number(idadeMs);
  const texto = String(mensagem ?? '').slice(0, 300) || 'erro desconhecido';
  // Idade impossível de calcular (created_at nulo/estragado) conta como estouro:
  // sem relógio confiável não dá pra garantir que o loop termina, e loop infinito
  // é justamente o que esta função existe pra impedir.
  if (!Number.isFinite(idade)) return { acao: 'desistir', erro: `falha na entrega (sem data do pedido): ${texto}` };
  if (idade < limiteMs) return { acao: 'tentar_de_novo' };
  return { acao: 'desistir', erro: `falha na entrega apos ${Math.round(idade / 60000)} min: ${texto}` };
}
