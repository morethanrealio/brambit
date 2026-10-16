// ── Approximate anchor for app file editing (deterministic, pure) ──
// The editing protocol requires the model to reproduce a snippet of the file
// byte for byte. Measured in production (12 real refusals from the
// naval-strike task, 2026-09-19): 33% of the edits were refused for "snippet
// not found" and the refusal asked for a re-read, which the anti-loop guard
// counts as lack of progress — 12 refusals + 167 re-reads until the task died.
// The differences were in spacing/indentation, not location: the real
// similarity was between 93,9% and 96,7%.
//
// Here the HOST resolves the location, instead of making the model copy
// again. Three guards, all measured on the bench with the app's real file:
//   1. THRESHOLD 0,90 similarity (Levenshtein over normalized text).
//      0,95 would only solve 7 of the 12 real cases; 0,98 solves zero (= today).
//   2. MARGIN 0,10 over the best NON-overlapping candidate: if two places in
//      the file look equally like the snippet, it refuses instead of guessing.
//   3. Minimum BODY of 12 alphanumeric characters: a punctuation-only anchor
//      ("} }") matches 100% anywhere. Without this guard, 2 false positives.
// Bench result: 12/12 on real refusals, 0/98 false positives with a snippet
// from another file, 0/163 wrong locations on corrupted snippets.
//
// Nothing here executes code or touches disk; input is data, never instruction.

export const LIMIAR_PADRAO = 0.90;
export const MARGEM_PADRAO = 0.10;
export const CORPO_MINIMO = 12;

const normLinha = l => l.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
export const normalizar = s => s.split('\n').map(normLinha).join('\n').trim();
export const corpoDaAncora = s => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) n++; } return n; };

// Levenshtein with two rows (O(min) memory). No recursion, no regex.
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let p = new Int32Array(n + 1), c = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) p[j] = j;
  for (let i = 1; i <= m; i++) {
    c[0] = i; const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    const t = p; p = c; c = t;
  }
  return p[n];
}
export const similaridade = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length));

// Cheap pre-filter: character multiset distance (rough upper bound on
// similarity). Only used to pick which windows deserve a Levenshtein pass;
// the verdict always comes from Levenshtein.
function bagDe(s) { const v = new Int32Array(128); for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) & 127]++; return v; }
function bagSim(v, w, lenV, lenW) {
  if (!lenV || !lenW) return 0;
  let dif = 0; for (let i = 0; i < 128; i++) dif += Math.abs(v[i] - w[i]);
  return 1 - dif / (lenV + lenW);
}

/**
 * Finds where `trecho` is inside `texto`, tolerating spacing differences.
 * Returns {ok:true, inicio, fim, similaridade, trecho_no_arquivo} (indexes in
 * characters in the ORIGINAL text) or {ok:false, motivo, ...diagnóstico}.
 */
export function resolverAncora(texto, trecho, opcoes = {}) {
  const limiar = opcoes.limiar ?? LIMIAR_PADRAO;
  const margem = opcoes.margem ?? MARGEM_PADRAO;
  const corpoMin = opcoes.corpoMinimo ?? CORPO_MINIMO;
  const maxAlvo = opcoes.maxAlvoChars ?? 8000;
  const maxJanelas = opcoes.maxJanelas ?? 600;
  if (typeof texto !== 'string' || typeof trecho !== 'string') return { ok: false, motivo: 'entrada_invalida' };
  const alvo = normalizar(trecho);
  if (!alvo) return { ok: false, motivo: 'trecho_vazio' };
  if (corpoDaAncora(trecho) < corpoMin) return { ok: false, motivo: 'corpo_insuficiente' };
  if (alvo.length > maxAlvo) return { ok: false, motivo: 'trecho_longo' };

  const linhas = texto.split('\n');
  const offs = new Array(linhas.length); { let p = 0; for (let i = 0; i < linhas.length; i++) { offs[i] = p; p += linhas[i].length + 1; } }
  const nl = linhas.map(normLinha);
  const bagAlvo = bagDe(alvo);
  const L = trecho.split('\n').length;
  const larguras = [...new Set([Math.max(1, L - 1), L, L + 1])].filter(w => w <= linhas.length);

  // 1st pass: scores every window with the pre-filter, sliding the counts.
  const pre = [];
  for (const w of larguras) {
    const bag = new Int32Array(128); let len = 0;
    const entra = i => { const s = nl[i]; for (let k = 0; k < s.length; k++) bag[s.charCodeAt(k) & 127]++; len += s.length; };
    const sai = i => { const s = nl[i]; for (let k = 0; k < s.length; k++) bag[s.charCodeAt(k) & 127]--; len -= s.length; };
    for (let i = 0; i < w; i++) entra(i);
    for (let i = 0; i + w <= linhas.length; i++) {
      if (i > 0) { sai(i - 1); entra(i + w - 1); }
      // \n between the window's lines counts on both sides; close enough.
      pre.push({ i, w, p: bagSim(bag, bagAlvo, len + w - 1, alvo.length) });
    }
  }
  if (!pre.length) return { ok: false, motivo: 'sem_candidato' };
  pre.sort((a, b) => b.p - a.p);
  if (pre[0].p < limiar - 0.25) return { ok: false, motivo: "sem_candidato" };
  // Work cap: each Levenshtein costs ~len(target)² comparisons. Without this
  // cap, a 40-line anchor in a 12-thousand-line file took 20s.
  const teto = Math.max(4, Math.min(maxJanelas, Math.floor((opcoes.orcamento ?? 40e6) / (alvo.length * alvo.length))));
  const corte = Math.max(pre[0].p - 0.2, limiar - 0.2);
  const escolhidas = pre.filter(x => x.p >= corte).slice(0, teto);

  // Length in characters of the window [i, i+w) in the original text.
  const spanDe = (i, w) => ({ ini: offs[i], fim: offs[i + w - 1] + linhas[i + w - 1].length });
  const medir = ({ i, w }) => { const { ini, fim } = spanDe(i, w); return { s: similaridade(normalizar(texto.slice(ini, fim)), alvo), ini, fim }; };

  // 2nd pass: Levenshtein only on the plausible windows.
  const cands = escolhidas.map(medir).sort((a, b) => b.s - a.s);
  const best = cands[0];
  if (!best) return { ok: false, motivo: "sem_candidato" };
  if (best.s < limiar) return { ok: false, motivo: "sem_candidato", melhor_similaridade: Number(best.s.toFixed(3)) };
  // The rival comes from its OWN pool of windows that do not overlap the
  // best one: neighbors shifted by one line always overlap, so without this
  // pool the work cap could hide the real competitor and turn into a wrong
  // acceptance exactly in the ambiguous case.
  const fora = x => { const { ini, fim } = spanDe(x.i, x.w); return fim <= best.ini || ini >= best.fim; };
  const rival = pre.filter(x => x.p >= corte && fora(x)).slice(0, teto).map(medir).sort((a, b) => b.s - a.s)[0];
  if (rival && best.s - rival.s < margem) return { ok: false, motivo: "ambiguo", melhor_similaridade: Number(best.s.toFixed(3)), rival_similaridade: Number(rival.s.toFixed(3)) };
  return { ok: true, inicio: best.ini, fim: best.fim, similaridade: Number(best.s.toFixed(3)), trecho_no_arquivo: texto.slice(best.ini, best.fim) };
}
