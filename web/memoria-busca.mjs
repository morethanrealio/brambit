// ── MEMORY v2, R2: on-demand search ──
// The old search (searchWikiPages) requires ALL words, literal, only in pages:
// "escola Cadu horário" doesn't find "Ela busca o Cadu na escola sempre entre 13h e 13h30"
// (missing "horário"), and "buscar Cadu" doesn't find "busca o Cadu". This one searches line by
// line in both pages AND facts (including closed ones, which are the history), without
// accents, with ANY word, and ranks: a rare word weighs more than a common one,
// and the line that matches more search words rises. Off by default: MEMORIA_BUSCA_V2=1.
import { termos } from './wiki-reconciliar.mjs';

export const buscaV2Ligada = () => process.env.MEMORIA_BUSCA_V2 === '1';

const RESERVADAS = new Set(['atualizacoes']);
const MARCA_LINKS = '## Mais detalhe';
const limpa = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim();

// Same word with a different ending ("busca"/"buscar", "colégio"/"colégios"): matches
// by the start when both have 5+ letters. A number only matches exactly.
const RADICAL = 5;
const POR_PAGINA = 3;
const casa = (a, b) => a === b || (!/\d/.test(a) && a.length >= RADICAL && b.length >= RADICAL && a.slice(0, RADICAL) === b.slice(0, RADICAL));

// Pure: receives pages {slug: {title, body}} and facts, returns the best excerpts.
export function buscarNaMemoria(paginas, fatos, consulta, { max = 10 } = {}) {
  const Q = [...termos(consulta).keys()];
  if (!Q.length) return [];
  const itens = [];
  for (const [slug, p] of Object.entries(paginas || {})) {
    if (RESERVADAS.has(slug)) continue;
    let secao = '';
    for (const l of String(p?.body || '').split('\n')) {
      if (l.trimStart().startsWith(MARCA_LINKS)) break;
      const t = l.trim();
      if (t.startsWith('#')) { secao = t.replace(/^#+\s*/, ''); continue; }
      if (!t) continue;
      // The page and section title count (at half weight): "Cadu" in the title of
      // cadu-familia makes the line "horário da escola" findable by "Cadu".
      itens.push({ tipo: 'linha', pagina: slug, secao, texto: limpa(t), contexto: `${p?.title || slug} ${secao}` });
    }
  }
  for (const f of fatos || []) {
    const encerrado = !!f.valido_ate;
    itens.push({ tipo: encerrado ? 'historico' : 'fato', pagina: f.pagina, assunto: f.assunto,
      texto: f.assunto === 'historico' ? String(f.valor) : `${f.assunto}: ${f.valor}`, contexto: '', ate: encerrado ? new Date(f.valido_ate).toISOString().slice(0, 10) : null });
  }
  const T = itens.map((it) => ({ corpo: [...termos(it.texto).keys()], ctx: [...termos(it.contexto).keys()] }));
  // Weight of each search word: rare (in few items) weighs more (idf).
  const df = Q.map((q) => T.filter((t) => t.corpo.some((w) => casa(q, w)) || t.ctx.some((w) => casa(q, w))).length);
  const idf = df.map((d) => (d ? Math.log(1 + itens.length / d) : 0));
  const pontos = itens.map((it, i) => {
    let s = 0, n = 0;
    Q.forEach((q, k) => {
      if (T[i].corpo.some((w) => casa(q, w))) { s += idf[k]; n++; }
      else if (T[i].ctx.some((w) => casa(q, w))) s += idf[k] / 2;
    });
    // Matching more search words on the same line is worth more than a loose sum.
    return { it, s: s * (1 + 0.25 * Math.max(0, n - 1)) };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  // Same phrase in the page and in the fact: shows it only once.
  // At most 3 lines per page: searching for a contact doesn't dump the whole list
  // (same minimization rule as the old search, which gave 1 excerpt per page).
  const vistos = new Set(), porPagina = new Map(), out = [];
  for (const { it } of pontos) {
    const k = it.texto.toLowerCase().replace(/^[^:]{1,60}:\s*/, '');
    if (vistos.has(k) || (porPagina.get(it.pagina) || 0) >= POR_PAGINA) continue;
    vistos.add(k); porPagina.set(it.pagina, (porPagina.get(it.pagina) || 0) + 1); out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

// Text for the model: one line per hit, with where it lives; history marked as such.
export function formatarAchados(achados) {
  if (!achados.length) return 'Nada encontrado na memória.';
  return achados.map((a) => a.tipo === 'linha'
    ? `• [${a.pagina}${a.secao ? ` › ${a.secao}` : ''}] ${a.texto}`
    : a.tipo === 'fato'
      ? `• [${a.pagina}, fato vigente] ${a.texto}`
      : `• [${a.pagina}, HISTÓRICO, deixou de valer em ${a.ate}] ${a.texto}`).join('\n');
}
