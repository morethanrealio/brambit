// ── Aviso de corte: nenhuma busca trunca em silêncio ──
//
// Caso de 07/09/2026: o usuário perguntou por um e-mail que EXISTIA e o
// assistente respondeu que não existia. Não foi alucinação do modelo: o
// `gmail_search` pedia no máximo 10 e-mails ao Google, jogava fora o
// `nextPageToken`/`resultSizeEstimate` da resposta e devolvia a lista curta como
// se fosse a busca inteira. Do ponto de vista do modelo, a busca tinha terminado.
//
// A regra que faltava, e que este módulo padroniza: uma lista truncada tem que
// vir acompanhada da informação de que é truncada. O molde é o `corte` que o
// `calendar_list` já usava (connectors.mjs:169) e que nunca foi aplicado ao
// resto: dizer quantos vieram, quantos ficaram de fora quando dá pra saber, e
// principalmente dizer que a lista NÃO prova ausência.
//
// Cuidado deliberado com número: `total` de umas APIs é exato (Slack `paging`,
// GitHub `total_count`) e de outras é estimativa grossa (Gmail
// `resultSizeEstimate`). Quem chama diz qual é qual em `aprox`, e o texto sai
// com "~" pra não transformar chute em fato.

/**
 * Monta a frase de corte, ou null quando nada foi cortado.
 *
 * @param {object} o
 * @param {number} o.mostrados  quantos itens estão indo na resposta
 * @param {number|null} o.total quantos casaram com a busca no total, se a API disser
 * @param {boolean} o.temMais   a API sinalizou que há mais (nextPageToken/@odata.nextLink)
 * @param {boolean} o.talvezMais a lista veio cheia no teto pedido e a API não diz
 *                               se há mais; é suspeita, não certeza, e o texto sai assim
 * @param {boolean} o.aprox     `total` é estimativa, não contagem exata
 * @param {string} o.oQue       "e-mails", "arquivos", "mensagens"...
 * @param {string} o.comoVerMais instrução concreta pra alcançar o resto
 */
export function avisoDeCorte({ mostrados, total = null, temMais = false, talvezMais = false, aprox = false, oQue = 'resultados', comoVerMais = '' }) {
  const n = Number(mostrados) || 0;
  const t = Number.isFinite(Number(total)) ? Number(total) : null;
  // Só é corte se sobrou coisa de fora. `total` mentiroso (menor que o que veio)
  // é ignorado: estimativa do Gmail faz isso quando a caixa é pequena.
  const faltam = t !== null && t > n ? t - n : null;
  if (faltam === null && !temMais && !talvezMais) return null;

  const quantos = faltam !== null
    ? `Vieram ${n} ${oQue}, mas a busca casou com ${aprox ? 'cerca de ' : ''}${t} no total (${aprox ? 'aproximadamente ' : ''}${faltam} ficaram de fora).`
    : temMais
      ? `Vieram ${n} ${oQue} e a busca tem MAIS resultados além destes.`
      : `Vieram ${n} ${oQue}, exatamente o teto pedido, e esta API não informa o total: PODE haver mais além destes.`;

  const naoProva = `Esta lista NÃO é a busca inteira: não achar uma coisa aqui NÃO significa que ela não existe.`;
  const comoVer = comoVerMais ? ` Pra alcançar o resto, ${comoVerMais}.` : '';
  return `${quantos} ${naoProva}${comoVer}`;
}

/**
 * Formata a resposta de uma tool de busca de forma uniforme.
 * Sem corte, mantém o formato antigo (array puro) pra não mexer no que já
 * funciona. Com corte, embrulha em objeto pra o aviso viajar junto dos itens.
 */
export function respostaDeBusca(itens, corte, vazio = 'Nada encontrado.') {
  const lista = Array.isArray(itens) ? itens : [];
  if (!lista.length) return corte ? JSON.stringify({ nota: vazio, corte }) : vazio;
  return corte ? JSON.stringify({ itens: lista, corte }) : JSON.stringify(lista);
}
