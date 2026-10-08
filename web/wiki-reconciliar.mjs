// ── MEMORY v2, R1+R3: write reconciler ──
// Before writing a new fact, looks for the SAME subject across all pages. If it's
// already stated, doesn't write it again (R1: the turn tool and the housekeeping were both
// writing the same thing). If a line states the old value, updates IT instead of
// adding another one, and fixes the other pages that repeat the old value (R3:
// each subject lives on one page only). Off by default: MEMORIA_RECONCILIAR=1.
//
// The model only DECIDES and points at the excerpt; the new line is assembled here via replace,
// so outside the excerpt it stays letter-for-letter the old one (same rule as corrigirPerdedora).
import { makeMemoriaModel } from './memoria-modelo.mjs';

export const reconciliarLigado = () => process.env.MEMORIA_RECONCILIAR === '1';

const MAX_CAND = 8;
const RESERVADAS = new Set(['atualizacoes']);
const STOP = new Set(('que com para por uma uns umas dos das nos nas num numa pelo pela pelos pelas ele ela eles elas '
  + 'seu sua seus suas meu minha tem ter foi ser sao esta estao isso esse essa este mais muito mas nao sim como quando '
  + 'onde tambem sempre ja ate sobre entre depois antes usuario usuaria pessoa dono dona gosta prefere the and for').split(' '));

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpa = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim();

// Weighted words: number weighs 3 (dates, sizes, values), proper noun 2, rest 1.
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

// Candidate lines (pure): the ones that share the most terms with the new information.
// Excluded: reserved page, header and the generated links section of the profile.
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

// Applies a {de, para} to a line. Returns the new line or null if the excerpt isn't
// in the line, is almost the whole line (in a long line) or doesn't change anything.
export function trocarTrecho(linha, de, para) {
  const d = String(de || ''), p = String(para || '').trim();
  if (!d.trim() || !p || !linha.includes(d)) return null;
  const P = palavras(linha);
  if (P.size > 5 && palavras(d).size > Math.ceil(P.size * 0.6)) return null;
  const nova = linha.replace(d, p);
  return nova === linha ? null : nova;
}

const SYS = `You look after a person's long-term memory. A NEW piece of information has arrived to be stored. Below are lines that are ALREADY in memory and may talk about the same subject. Decide an "acao":
- "nada": one of the lines ALREADY says the new information (same meaning and same value, even in other words). Say which one in "na_linha".
- "atualizar": a line talks about the SAME subject with a value that the new information REPLACES (it changed or was corrected). That one is the "principal".
- "novo": no line says this or is replaced. This includes when they only talk about something similar or when both can be true together (likes A and also B; had one dog and now has another).
In "outras", list the lines (other than the principal) that still state as CURRENT the value the new information refutes. A line that only mentions the subject without stating the old value does NOT go in.
For the principal and each of the others: "de" = EXACT copy, character by character, of the SMALLEST piece of the line that becomes wrong; "para" = what goes in its place, in the same style and language as the line. The rest of the line is other true data and stays as it is.
When in doubt between "atualizar" and "novo", choose "novo": never replace a line that may still be true.
Return ONLY JSON: {"acao":"nada|atualizar|novo","assunto":"short_snake_case_key","na_linha":N,"principal":{"id":N,"de":"...","para":"..."},"outras":[{"id":N,"de":"...","para":"..."}]}`;

async function decidir(novaInfo, cands, { soOutras = false } = {}) {
  const r = await makeMemoriaModel().forBillingPhase({ kind: 'housekeeping' }).complete({
    system: SYS, tools: [],
    messages: [{ role: 'user', content: [
      `New information: ${novaInfo}`,
      soOutras ? 'This information already has its own line that the system replaces on its own: answer acao "novo" and fill in only "outras".' : '',
      'Memory lines:',
      ...cands.map((c, i) => `[${i}] (${c.pagina}) ${c.linha}`),
    ].filter(Boolean).join('\n') }],
  });
  try { return JSON.parse(String(r.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { return null; }
}

// Decides the destination of ONE op (add or definir). Returns a plan, without touching the database:
//   { acao:'nada', cand }                         the info is already on line `cand`
//   { acao:'atualizar', cand, nova, assunto }     line `cand` becomes `nova`
//   { acao:'novo' }                               follows the usual path
// and, in all cases, `outras`: [{ cand, nova }] with the repeats of the old value.
export async function planejarOp(op, paginas, { linhaPropria = '', valorAntigo = '' } = {}) {
  const tipo = String(op?.op || '').toLowerCase();
  const texto = tipo === 'definir' ? limpa(op.valor) : limpa(op.texto);
  const assuntoTxt = tipo === 'definir' ? String(op.assunto || '').replace(/_/g, ' ') : '';
  const cands = candidatas(paginas, `${assuntoTxt} ${texto} ${valorAntigo}`, { excluir: linhaPropria ? [linhaPropria] : [] });
  if (!cands.length) return { acao: 'novo', outras: [] };
  const info = tipo === 'definir'
    ? `${assuntoTxt}: ${texto}${valorAntigo ? ` (previously: ${valorAntigo})` : ''}`
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
    // Guard against losing a fact: "already stated" only counts if the line has most
    // of the words from the new information.
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
