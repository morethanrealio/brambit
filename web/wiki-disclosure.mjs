// Wiki search helpers (terms and the matching line's snippet). Reading a
// page returns the whole page: the clipping of financial pages went away with the
// data requested by the owner (2026-09-29). Not repeating someone else's data is a prompt rule.

const STOP = new Set([
  'a','as','o','os','de','da','das','do','dos','e','em','no','na','nos','nas','um','uma',
  'me','minha','meu','pra','para','por','favor','voce','você','tem','ai','aí','qual','quais',
  'the','a','an','of','for','my','do','you','have','la','el','los','las','mi','tienes',
]);
const SCOPE_GENERIC = new Set(['chave','pix','contato','dado','dados','financeiro','financeiros','cpf','cnpj','conta','banco','key','clave']);

const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function wikiSearchTerms(value) {
  const seen = new Set();
  const terms = [];
  for (const raw of String(value || '').match(/[\p{L}\p{N}@.+-]+/gu) || []) {
    const key = fold(raw).replace(/^[-+.]+|[-+.]+$/g, '');
    if (key.length < 3 || STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    terms.push(raw.replace(/[%_]/g, ''));
  }
  return terms.slice(0, 8);
}

function scoredLines(body, query) {
  const terms = wikiSearchTerms(query).map(fold).filter((term) => !SCOPE_GENERIC.has(term));
  if (!terms.length) return [];
  return String(body || '').split(/\r?\n/).map((line, index) => {
    const normalized = fold(line);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
    return { line: line.trim(), index, score };
  }).filter((item) => item.line && item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function matchingWikiLineSnippet(body, query) {
  const best = scoredLines(body, query)[0]?.line;
  if (best) return best.slice(0, 500);
  return String(body || '').split(/\r?\n/).find((line) => line.trim() && !/^\s*#/.test(line))?.trim().slice(0, 240) || '';
}
