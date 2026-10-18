// ── Truncation notice: no search truncates silently ──
//
// Case from 2026-09-07: the user asked about an email that DID EXIST and the
// assistant answered that it didn't exist. It wasn't the model hallucinating:
// `gmail_search` asked Google for at most 10 emails, discarded the response's
// `nextPageToken`/`resultSizeEstimate`, and returned the short list as if it
// were the whole search. From the model's point of view, the search had finished.
//
// The missing rule, which this module standardizes: a truncated list has to
// come along with the information that it's truncated. The template is the
// `corte` (cutoff) that `calendar_list` already used (connectors.mjs:169) and
// was never applied to the rest: state how many came back, how many were left
// out when that's knowable, and above all state that the list does NOT prove
// absence.
//
// Deliberate care with the number: `total` from some APIs is exact (Slack
// `paging`, GitHub `total_count`) and from others it's a rough estimate (Gmail
// `resultSizeEstimate`). The caller states which is which in `aprox`, and the
// text comes out with "~" so it doesn't turn a guess into a fact.

/**
 * Builds the truncation sentence, or null when nothing was cut.
 *
 * @param {object} o
 * @param {number} o.mostrados  how many items are going into the response
 * @param {number|null} o.total how many matched the search in total, if the API says so
 * @param {boolean} o.temMais   the API signaled there's more (nextPageToken/@odata.nextLink)
 * @param {boolean} o.talvezMais the list came back full at the requested ceiling and the API
 *                               doesn't say whether there's more; it's a suspicion, not a
 *                               certainty, and the text comes out that way
 * @param {boolean} o.aprox     `total` is an estimate, not an exact count
 * @param {string} o.oQue       "emails", "files", "messages"...
 * @param {string} o.comoVerMais concrete instruction for reaching the rest
 */
export function avisoDeCorte({ mostrados, total = null, temMais = false, talvezMais = false, aprox = false, oQue = 'resultados', comoVerMais = '' }) {
  const n = Number(mostrados) || 0;
  const t = Number.isFinite(Number(total)) ? Number(total) : null;
  // It's only a cutoff if something was left out. A misleading `total` (lower
  // than what came back) is ignored: Gmail's estimate does this when the mailbox
  // is small.
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
 * Formats a search tool's response uniformly.
 * Without a cutoff, keeps the old format (plain array) so as not to touch what
 * already works. With a cutoff, wraps it in an object so the notice travels
 * along with the items.
 */
export function respostaDeBusca(itens, corte, vazio = 'Nada encontrado.') {
  const lista = Array.isArray(itens) ? itens : [];
  if (!lista.length) return corte ? JSON.stringify({ nota: vazio, corte }) : vazio;
  return corte ? JSON.stringify({ itens: lista, corte }) : JSON.stringify(lista);
}
