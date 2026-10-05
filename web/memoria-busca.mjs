// ── MEMÓRIA v2, R2: busca pela demanda ──
// A busca antiga (searchWikiPages) exige TODAS as palavras, literais, só nas páginas:
// "escola Cadu horário" não acha "Ela busca o Cadu na escola sempre entre 13h e 13h30"
// (falta "horário"), e "buscar Cadu" não acha "busca o Cadu". Esta procura linha a
// linha nas páginas E nos fatos (inclusive os encerrados, que são o histórico), sem
// acento, com QUALQUER palavra, e ranqueia: palavra rara pesa mais que palavra comum,
// e a linha que junta mais palavras da busca sobe. Desligada por padrão: MEMORIA_BUSCA_V2=1.
import { termos } from './wiki-reconciliar.mjs';

export const buscaV2Ligada = () => process.env.MEMORIA_BUSCA_V2 === '1';

const RESERVADAS = new Set(['atualizacoes']);
const MARCA_LINKS = '## Mais detalhe';
const limpa = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim();

// Mesma palavra com outra terminação ("busca"/"buscar", "colégio"/"colégios"): casa
// pelo começo quando as duas têm 5+ letras. Número só casa igual.
const RADICAL = 5;
const POR_PAGINA = 3;
const casa = (a, b) => a === b || (!/\d/.test(a) && a.length >= RADICAL && b.length >= RADICAL && a.slice(0, RADICAL) === b.slice(0, RADICAL));

// Puro: recebe páginas {slug: {title, body}} e fatos, devolve os melhores trechos.
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
      // O título da página e da seção contam (com meio peso): "Cadu" no título de
      // cadu-familia torna a linha "horário da escola" achável por "Cadu".
      itens.push({ tipo: 'linha', pagina: slug, secao, texto: limpa(t), contexto: `${p?.title || slug} ${secao}` });
    }
  }
  for (const f of fatos || []) {
    const encerrado = !!f.valido_ate;
    itens.push({ tipo: encerrado ? 'historico' : 'fato', pagina: f.pagina, assunto: f.assunto,
      texto: f.assunto === 'historico' ? String(f.valor) : `${f.assunto}: ${f.valor}`, contexto: '', ate: encerrado ? new Date(f.valido_ate).toISOString().slice(0, 10) : null });
  }
  const T = itens.map((it) => ({ corpo: [...termos(it.texto).keys()], ctx: [...termos(it.contexto).keys()] }));
  // Peso de cada palavra da busca: rara (em poucos itens) pesa mais (idf).
  const df = Q.map((q) => T.filter((t) => t.corpo.some((w) => casa(q, w)) || t.ctx.some((w) => casa(q, w))).length);
  const idf = df.map((d) => (d ? Math.log(1 + itens.length / d) : 0));
  const pontos = itens.map((it, i) => {
    let s = 0, n = 0;
    Q.forEach((q, k) => {
      if (T[i].corpo.some((w) => casa(q, w))) { s += idf[k]; n++; }
      else if (T[i].ctx.some((w) => casa(q, w))) s += idf[k] / 2;
    });
    // Juntar mais palavras da busca na mesma linha vale mais que soma solta.
    return { it, s: s * (1 + 0.25 * Math.max(0, n - 1)) };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  // Mesma frase na página e no fato: mostra uma vez só.
  // No máximo 3 linhas por página: busca por um contato não despeja a lista inteira
  // (mesma regra de minimização da busca antiga, que dava 1 trecho por página).
  const vistos = new Set(), porPagina = new Map(), out = [];
  for (const { it } of pontos) {
    const k = it.texto.toLowerCase().replace(/^[^:]{1,60}:\s*/, '');
    if (vistos.has(k) || (porPagina.get(it.pagina) || 0) >= POR_PAGINA) continue;
    vistos.add(k); porPagina.set(it.pagina, (porPagina.get(it.pagina) || 0) + 1); out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

// Texto pro modelo: uma linha por achado, com onde mora; histórico marcado como tal.
export function formatarAchados(achados) {
  if (!achados.length) return 'Nada encontrado na memória.';
  return achados.map((a) => a.tipo === 'linha'
    ? `• [${a.pagina}${a.secao ? ` › ${a.secao}` : ''}] ${a.texto}`
    : a.tipo === 'fato'
      ? `• [${a.pagina}, fato vigente] ${a.texto}`
      : `• [${a.pagina}, HISTÓRICO, deixou de valer em ${a.ate}] ${a.texto}`).join('\n');
}
