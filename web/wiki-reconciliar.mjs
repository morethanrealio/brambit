// ── MEMÓRIA v2, R1+R3: conciliador de escrita ──
// Antes de gravar um fato novo, procura o MESMO assunto em todas as páginas. Se já
// está dito, não grava de novo (R1: a tool do turno e o housekeeping escreviam os
// dois a mesma coisa). Se uma linha diz o valor antigo, atualiza ELA em vez de
// acrescentar outra, e corrige as outras páginas que repetem o valor antigo (R3:
// cada assunto numa página só). Desligado por padrão: MEMORIA_RECONCILIAR=1.
//
// O modelo só DECIDE e aponta o trecho; a linha nova é montada aqui com replace,
// então fora do trecho ela é a velha letra por letra (mesma regra de corrigirPerdedora).
import { makeMemoriaModel } from './memoria-modelo.mjs';

export const reconciliarLigado = () => process.env.MEMORIA_RECONCILIAR === '1';

const MAX_CAND = 8;
const RESERVADAS = new Set(['atualizacoes']);
const STOP = new Set(('que com para por uma uns umas dos das nos nas num numa pelo pela pelos pelas ele ela eles elas '
  + 'seu sua seus suas meu minha tem ter foi ser sao esta estao isso esse essa este mais muito mas nao sim como quando '
  + 'onde tambem sempre ja ate sobre entre depois antes usuario usuaria pessoa dono dona gosta prefere the and for').split(' '));

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpa = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim();

// Palavras com peso: número pesa 3 (datas, tamanhos, valores), nome próprio 2, resto 1.
export function termos(texto) {
  const out = new Map();
  for (const bruto of String(texto || '').split(/[^\p{L}\p{N}]+/u)) {
    const w = semAcento(bruto).toLowerCase();
    if (!w || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    const peso = /\d/.test(w) ? 3 : /^\p{Lu}/u.test(bruto) ? 2 : 1;
    out.set(w, Math.max(out.get(w) || 0, peso));
  }
  return out;
}

// Linhas candidatas (puro): as que mais dividem termos com a informação nova.
// Fica de fora: página reservada, cabeçalho e a seção de links gerada do perfil.
export function candidatas(paginas, consulta, { excluir = [] } = {}) {
  const Q = termos(consulta);
  if (!Q.size) return [];
  const fora = new Set(excluir.map((l) => limpa(l).toLowerCase()));
  const achadas = [];
  for (const [slug, body] of Object.entries(paginas || {})) {
    if (RESERVADAS.has(slug)) continue;
    for (const l of String(body || '').split('\n')) {
      if (l.trimStart().startsWith('## Mais detalhe')) break;
      const t = l.trim();
      if (!t || t.startsWith('#') || limpa(t).length < 8 || fora.has(limpa(t).toLowerCase())) continue;
      const L = termos(t);
      let score = 0;
      for (const [w, p] of Q) if (L.has(w)) score += p;
      if (score >= 2) achadas.push({ pagina: slug, linha: t, score });
    }
  }
  return achadas.sort((a, b) => b.score - a.score).slice(0, MAX_CAND);
}

const palavras = (s) => new Set(semAcento(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /\d/.test(w)));

// Aplica um {de, para} numa linha. Devolve a linha nova ou null se o trecho não
// está na linha, é quase a linha inteira (numa linha longa) ou não muda nada.
export function trocarTrecho(linha, de, para) {
  const d = String(de || ''), p = String(para || '').trim();
  if (!d.trim() || !p || !linha.includes(d)) return null;
  const P = palavras(linha);
  if (P.size > 5 && palavras(d).size > Math.ceil(P.size * 0.6)) return null;
  const nova = linha.replace(d, p);
  return nova === linha ? null : nova;
}

const SYS = `Você cuida da memória de longo prazo de uma pessoa. Chegou uma informação NOVA pra gravar. Abaixo estão linhas que JÁ estão na memória e podem falar do mesmo assunto. Decida uma "acao":
- "nada": uma das linhas JÁ diz a informação nova (mesmo sentido e mesmo valor, mesmo com outras palavras). Informe qual em "na_linha".
- "atualizar": uma linha fala do MESMO assunto com um valor que a informação nova SUBSTITUI (mudou ou foi corrigido). Essa é a "principal".
- "novo": nenhuma linha diz isso nem é substituída. Inclui quando só falam de coisa parecida ou quando as duas podem ser verdade juntas (gosta de A e também de B; teve um cachorro e agora tem outro).
Em "outras", liste as linhas (fora a principal) que continuam afirmando como ATUAL o valor que a informação nova desmente. Linha que só menciona o assunto sem afirmar o valor antigo NÃO entra.
Pra principal e cada outra: "de" = cópia EXATA, caractere por caractere, do MENOR pedaço da linha que fica errado; "para" = o que entra no lugar, no mesmo estilo da linha. O resto da linha são outros dados verdadeiros e fica como está.
Na dúvida entre "atualizar" e "novo", escolha "novo": nunca troque uma linha que pode continuar verdadeira.
Devolva SÓ JSON: {"acao":"nada|atualizar|novo","assunto":"chave_curta_em_snake_case","na_linha":N,"principal":{"id":N,"de":"...","para":"..."},"outras":[{"id":N,"de":"...","para":"..."}]}`;

async function decidir(novaInfo, cands, { soOutras = false } = {}) {
  const r = await makeMemoriaModel().forBillingPhase({ kind: 'housekeeping' }).complete({
    system: SYS, tools: [],
    messages: [{ role: 'user', content: [
      `Informação nova: ${novaInfo}`,
      soOutras ? 'Essa informação já tem uma linha própria que o sistema troca sozinho: responda acao "novo" e preencha só "outras".' : '',
      'Linhas da memória:',
      ...cands.map((c, i) => `[${i}] (${c.pagina}) ${c.linha}`),
    ].filter(Boolean).join('\n') }],
  });
  try { return JSON.parse(String(r.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { return null; }
}

// Decide o destino de UMA op (add ou definir). Devolve um plano, sem tocar o banco:
//   { acao:'nada', cand }                         a info já está na linha `cand`
//   { acao:'atualizar', cand, nova, assunto }     a linha `cand` vira `nova`
//   { acao:'novo' }                               segue o caminho de sempre
// e, em todos, `outras`: [{ cand, nova }] com as repetições do valor antigo.
export async function planejarOp(op, paginas, { linhaPropria = '', valorAntigo = '' } = {}) {
  const tipo = String(op?.op || '').toLowerCase();
  const texto = tipo === 'definir' ? limpa(op.valor) : limpa(op.texto);
  const assuntoTxt = tipo === 'definir' ? String(op.assunto || '').replace(/_/g, ' ') : '';
  const cands = candidatas(paginas, `${assuntoTxt} ${texto} ${valorAntigo}`, { excluir: linhaPropria ? [linhaPropria] : [] });
  if (!cands.length) return { acao: 'novo', outras: [] };
  const info = tipo === 'definir'
    ? `${assuntoTxt}: ${texto}${valorAntigo ? ` (antes era: ${valorAntigo})` : ''}`
    : texto;
  const j = await decidir(info, cands, { soOutras: !!linhaPropria });
  if (!j) return { acao: 'novo', outras: [], erro: 'json_invalido' };
  const pegar = (x) => (Number.isInteger(x?.id) && cands[x.id] ? cands[x.id] : null);
  const principal = pegar(j.principal);
  const outras = [];
  for (const o of Array.isArray(j.outras) ? j.outras : []) {
    const c = pegar(o);
    if (!c || c === principal) continue;
    const nova = trocarTrecho(c.linha, o.de, o.para);
    if (nova) outras.push({ cand: c, nova, de: o.de });
  }
  if (!linhaPropria && j.acao === 'nada' && Number.isInteger(j.na_linha) && cands[j.na_linha]) {
    // Guarda contra perder fato: "já está" só vale se a linha tem a maior parte
    // das palavras da informação nova.
    const N = [...palavras(texto)], L = palavras(cands[j.na_linha].linha);
    const tem = N.filter((w) => L.has(w)).length;
    if (N.length && tem / N.length >= 0.5) return { acao: 'nada', cand: cands[j.na_linha], outras };
    return { acao: 'novo', outras, erro: 'nada_sem_base' };
  }
  if (!linhaPropria && j.acao === 'atualizar' && principal) {
    const nova = trocarTrecho(principal.linha, j.principal.de, j.principal.para);
    if (nova) return { acao: 'atualizar', cand: principal, nova, de: j.principal.de, para: String(j.principal.para).trim(), assunto: j.assunto, outras };
    return { acao: 'novo', outras, erro: 'trecho_invalido' };
  }
  return { acao: 'novo', outras };
}
