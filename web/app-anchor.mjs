// ── Âncora aproximada para edição de arquivo de app (determinística, pura) ──
// O protocolo de edição exige que o modelo reproduza um trecho do arquivo byte a
// byte. Medido em produção (12 recusas reais da tarefa naval-strike, 19/09/2026):
// 33% das edições eram recusadas por "trecho não encontrado" e a recusa pedia
// releitura, que o freio anti-loop conta como falta de progresso — 12 recusas +
// 167 releituras até a tarefa morrer. As diferenças eram de espaço/indentação,
// não de lugar: a similaridade real ficou entre 93,9% e 96,7%.
//
// Aqui o HOST resolve o lugar, em vez de mandar o modelo copiar de novo. Três
// travas, todas medidas na bancada com o arquivo real do app:
//   1. LIMIAR 0,90 de similaridade (Levenshtein sobre o texto normalizado).
//      0,95 resolveria só 7 das 12 reais; 0,98 resolve zero (= hoje).
//   2. MARGEM 0,10 sobre o melhor candidato NÃO sobreposto: se dois lugares do
//      arquivo parecem igualmente com o trecho, recusa em vez de chutar.
//   3. CORPO mínimo de 12 caracteres alfanuméricos: âncora só de pontuação
//      ("} }") casa 100% em qualquer lugar. Sem essa trava, 2 falsos positivos.
// Resultado da bancada: 12/12 nas recusas reais, 0/98 falsos positivos com
// trecho de outro arquivo, 0/163 lugares errados em trechos corrompidos.
//
// Nada aqui executa código nem toca disco; entrada é dado, nunca instrução.

export const LIMIAR_PADRAO = 0.90;
export const MARGEM_PADRAO = 0.10;
export const CORPO_MINIMO = 12;

const normLinha = l => l.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
export const normalizar = s => s.split('\n').map(normLinha).join('\n').trim();
export const corpoDaAncora = s => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) n++; } return n; };

// Levenshtein com duas linhas (O(min) memória). Sem recursão, sem regex.
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

// Pré-filtro barato: distância de multiconjunto de caracteres (limite superior
// grosseiro da similaridade). Serve só pra escolher quais janelas valem um
// Levenshtein; o veredito é sempre do Levenshtein.
function bagDe(s) { const v = new Int32Array(128); for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) & 127]++; return v; }
function bagSim(v, w, lenV, lenW) {
  if (!lenV || !lenW) return 0;
  let dif = 0; for (let i = 0; i < 128; i++) dif += Math.abs(v[i] - w[i]);
  return 1 - dif / (lenV + lenW);
}

/**
 * Acha onde `trecho` está em `texto`, tolerando diferença de espaçamento.
 * Retorna {ok:true, inicio, fim, similaridade, trecho_no_arquivo} (índices em
 * caracteres no texto ORIGINAL) ou {ok:false, motivo, ...diagnóstico}.
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

  // 1ª passada: pontua toda janela pelo pré-filtro, deslizando as contagens.
  const pre = [];
  for (const w of larguras) {
    const bag = new Int32Array(128); let len = 0;
    const entra = i => { const s = nl[i]; for (let k = 0; k < s.length; k++) bag[s.charCodeAt(k) & 127]++; len += s.length; };
    const sai = i => { const s = nl[i]; for (let k = 0; k < s.length; k++) bag[s.charCodeAt(k) & 127]--; len -= s.length; };
    for (let i = 0; i < w; i++) entra(i);
    for (let i = 0; i + w <= linhas.length; i++) {
      if (i > 0) { sai(i - 1); entra(i + w - 1); }
      // \n entre as linhas da janela conta nos dois lados; aproxima o suficiente.
      pre.push({ i, w, p: bagSim(bag, bagAlvo, len + w - 1, alvo.length) });
    }
  }
  if (!pre.length) return { ok: false, motivo: 'sem_candidato' };
  pre.sort((a, b) => b.p - a.p);
  if (pre[0].p < limiar - 0.25) return { ok: false, motivo: "sem_candidato" };
  // Teto de trabalho: cada Levenshtein custa ~len(alvo)² comparações. Sem esse
  // teto, uma âncora de 40 linhas num arquivo de 12 mil linhas levava 20s.
  const teto = Math.max(4, Math.min(maxJanelas, Math.floor((opcoes.orcamento ?? 40e6) / (alvo.length * alvo.length))));
  const corte = Math.max(pre[0].p - 0.2, limiar - 0.2);
  const escolhidas = pre.filter(x => x.p >= corte).slice(0, teto);

  // Comprimento em caracteres da janela [i, i+w) no texto original.
  const spanDe = (i, w) => ({ ini: offs[i], fim: offs[i + w - 1] + linhas[i + w - 1].length });
  const medir = ({ i, w }) => { const { ini, fim } = spanDe(i, w); return { s: similaridade(normalizar(texto.slice(ini, fim)), alvo), ini, fim }; };

  // 2ª passada: Levenshtein só nas janelas plausíveis.
  const cands = escolhidas.map(medir).sort((a, b) => b.s - a.s);
  const best = cands[0];
  if (!best) return { ok: false, motivo: "sem_candidato" };
  if (best.s < limiar) return { ok: false, motivo: "sem_candidato", melhor_similaridade: Number(best.s.toFixed(3)) };
  // O rival vem de um pool PRÓPRIO de janelas que não se sobrepõem ao melhor:
  // vizinhas deslocadas de uma linha sempre se sobrepõem, então sem esse pool o
  // teto de trabalho poderia esconder o concorrente de verdade e virar um aceite
  // errado justamente no caso ambíguo.
  const fora = x => { const { ini, fim } = spanDe(x.i, x.w); return fim <= best.ini || ini >= best.fim; };
  const rival = pre.filter(x => x.p >= corte && fora(x)).slice(0, teto).map(medir).sort((a, b) => b.s - a.s)[0];
  if (rival && best.s - rival.s < margem) return { ok: false, motivo: "ambiguo", melhor_similaridade: Number(best.s.toFixed(3)), rival_similaridade: Number(rival.s.toFixed(3)) };
  return { ok: true, inicio: best.ini, fim: best.fim, similaridade: Number(best.s.toFixed(3)), trecho_no_arquivo: texto.slice(best.ini, best.fim) };
}
