// editar_nota confirmation card: shows ONLY the lines that change, not the
// whole note. Reason (2026-09-30, shopping-list case): the card
// used to dump the entire new note, the person couldn't find what they were
// approving in the middle of it and would send the correction again, stacking proposals.
//
// Stays exact: every line that leaves and every line that enters shows up, in its
// literal form. What's omitted is only what stays the same. Pure function, no database, so it can
// be tested on its own.

// Above this, the comparison table weighs too much; the card goes back to showing
// the whole new note, which is the previous behavior and is still correct.
const LIMITE_CELULAS = 2_000_000;

// Comparison of two sequences (longest common subsequence). Returns [op, item]
// with op '=' (unchanged), '-' (leaves) or '+' (enters), in order; null if too big
// to compare.
function diffSeq(a, b) {
  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini += 1;
  let fa = a.length, fb = b.length;
  while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa -= 1; fb -= 1; }
  const A = a.slice(ini, fa), B = b.slice(ini, fb), n = A.length, m = B.length;
  if (n * m > LIMITE_CELULAS) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = a.slice(0, ini).map((l) => ['=', l]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push(['=', A[i]]); i += 1; j += 1; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push(['-', A[i]]); i += 1; }
    else { ops.push(['+', B[j]]); j += 1; }
  }
  while (i < n) { ops.push(['-', A[i]]); i += 1; }
  while (j < m) { ops.push(['+', B[j]]); j += 1; }
  for (const l of a.slice(fa)) ops.push(['=', l]);
  return ops;
}

// Line-by-line comparison of the entire text.
export function diffLinhas(antes, depois) {
  return diffSeq(String(antes ?? '').split('\n'), String(depois ?? '').split('\n'));
}

const TEXTOS = {
  'pt-BR': {
    label: (t) => `editar a nota do Space "${t}"`,
    intro: (t) => `editar a nota do Space "${t}". Só mudam estas linhas (➖ sai, ➕ entra); o resto da nota fica como está:`,
    secao: (h) => `Em "${h}":`,
    espacos: 'O texto continua o mesmo; só muda o espaçamento entre as linhas.',
    tag: (de, para) => `Tag: "${de}" → "${para}"`,
    soTag: (t, de, para) => `mudar a tag da nota do Space "${t}" de "${de}" para "${para}"`,
    inteira: (t, nova) => `trocar a nota do Space "${t}" por: "${nova}"`,
    semTag: '(sem tag)',
  },
  en: {
    label: (t) => `edit the note in the Space "${t}"`,
    intro: (t) => `edit the note in the Space "${t}". Only these lines change (➖ removed, ➕ added); the rest of the note stays as it is:`,
    secao: (h) => `In "${h}":`,
    espacos: 'The text stays the same; only the spacing between lines changes.',
    tag: (de, para) => `Tag: "${de}" → "${para}"`,
    soTag: (t, de, para) => `change the tag of the note in the Space "${t}" from "${de}" to "${para}"`,
    inteira: (t, nova) => `replace the note in the Space "${t}" with: "${nova}"`,
    semTag: '(no tag)',
  },
  es: {
    label: (t) => `editar la nota del Space "${t}"`,
    intro: (t) => `editar la nota del Space "${t}". Solo cambian estas líneas (➖ sale, ➕ entra); el resto de la nota queda igual:`,
    secao: (h) => `En "${h}":`,
    espacos: 'El texto sigue igual; solo cambia el espacio entre las líneas.',
    tag: (de, para) => `Etiqueta: "${de}" → "${para}"`,
    soTag: (t, de, para) => `cambiar la etiqueta de la nota del Space "${t}" de "${de}" a "${para}"`,
    inteira: (t, nova) => `reemplazar la nota del Space "${t}" por: "${nova}"`,
    semTag: '(sin etiqueta)',
  },
};

// A markdown heading ("## Lista Atual") splits the note into sections. The comparison is
// done section by section, matching each one by its title path ("Lista
// Atual › Supermercado"), and not over the note as a running whole: in a list where the whole
// week goes into the history, a running comparison finds it shorter to say that the
// history titles "moved up" over the items (exact, but unreadable; a real
// case from the 2026-09-30 routine). Per section, the card says what the person did:
// the items left Supermercado and entered the history for that date.
const titulo = (l) => { const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(l); return m ? { nivel: m[1].length, nome: m[2] } : null; };

function secoes(texto) {
  const lista = [{ chave: '', nome: null, pai: null, cabecalho: null, linhas: [] }];
  const caminho = [], vistas = new Map();
  for (const l of texto.split('\n')) {
    const h = titulo(l);
    if (!h) { lista.at(-1).linhas.push(l); continue; }
    while (caminho.length && caminho.at(-1).nivel >= h.nivel) caminho.pop();
    const pai = caminho.at(-1) ? caminho.map((c) => c.nome) : null;
    caminho.push(h);
    // Same path repeated in the note (two "### Supermercado" in the same place):
    // the occurrence goes into the key so one doesn't match the other.
    const base = caminho.map((c) => `${'#'.repeat(c.nivel)} ${c.nome}`).join('\u0001');
    const n = (vistas.get(base) || 0) + 1; vistas.set(base, n);
    lista.push({ chave: n > 1 ? `${base}\u0002${n}` : base, nome: caminho.map((c) => c.nome), pai, cabecalho: l, linhas: [] });
  }
  return lista;
}

// Lines that change, each with the section it belongs to: [rotulo, op, linha].
// null if some comparison exceeds the limit.
function mudancas(antes, depois) {
  const A = secoes(antes), B = secoes(depois);
  const porChave = (lista) => new Map(lista.map((s) => [s.chave, s]));
  const mA = porChave(A), mB = porChave(B);
  const ordem = diffSeq(A.map((s) => s.chave), B.map((s) => s.chave));
  if (!ordem) return null;
  // The card calls the section by its own title; only when the same title exists
  // in more than one place in the note does it come with the path ("Casa › Mercado").
  const usos = new Map();
  for (const sec of [...A, ...B]) if (sec.nome) usos.set(sec.nome.at(-1), (usos.get(sec.nome.at(-1)) || new Set()).add(sec.nome.join('\u0001')));
  const rotulo = (caminho) => !caminho ? null : usos.get(caminho.at(-1))?.size > 1 ? caminho.join(' › ') : caminho.at(-1);
  const out = [];
  for (const [op, chave] of ordem) {
    if (op === '=') {
      const ops = diffSeq(mA.get(chave).linhas, mB.get(chave).linhas);
      if (!ops) return null;
      for (const [o, l] of ops) if (o !== '=') out.push([rotulo(mB.get(chave).nome), o, l]);
      continue;
    }
    // A whole section entering or leaving: the title itself shows up, under the parent section.
    const sec = (op === '+' ? mB : mA).get(chave);
    out.push([rotulo(sec.pai), op, sec.cabecalho]);
    for (const l of sec.linhas) out.push([rotulo(sec.pai), op, l]);
  }
  return out.filter(([, , l]) => l.trim());
}

// The same adjustments updateSpaceEntry writes (trim), so we compare what
// actually goes into the database. `depois` null = text doesn't change (only the tag).
// Throws an error when there's nothing to change: the gate returns this to the model
// instead of asking for confirmation of an empty edit.
export function cartaoEdicaoNota({ espaco, antes, depois, tagAntes, tagDepois }) {
  if (depois == null && tagDepois == null) throw Error('Diga o novo texto ou a nova tag pra eu editar.');
  const corpoAntes = String(antes ?? '').trim();
  const corpoDepois = depois == null ? corpoAntes : String(depois).trim();
  const tAntes = String(tagAntes ?? '').trim();
  const tDepois = tagDepois == null ? tAntes : String(tagDepois).trim();
  const mudaTag = tDepois !== tAntes;
  if (corpoDepois === corpoAntes && !mudaTag) throw Error('A nota já está exatamente assim; não há o que editar.');
  const lista = corpoDepois === corpoAntes ? [] : mudancas(corpoAntes, corpoDepois);
  const labels = {}, confirmationTexts = {};
  for (const [lang, t] of Object.entries(TEXTOS)) {
    labels[lang] = t.label(espaco);
    const tag = mudaTag ? t.tag(tAntes || t.semTag, tDepois || t.semTag) : null;
    if (!lista) { confirmationTexts[lang] = [t.inteira(espaco, corpoDepois), tag].filter(Boolean).join('\n\n'); continue; }
    if (corpoDepois === corpoAntes) { confirmationTexts[lang] = t.soTag(espaco, tAntes || t.semTag, tDepois || t.semTag); continue; }
    const linhas = [];
    let rotuloAtual;
    for (const [rotulo, op, l] of lista) {
      if (rotulo !== rotuloAtual) {
        if (linhas.length) linhas.push('');
        if (rotulo) linhas.push(t.secao(rotulo));
        rotuloAtual = rotulo;
      }
      linhas.push(`${op === '-' ? '➖' : '➕'} ${l}`);
    }
    confirmationTexts[lang] = [t.intro(espaco), linhas.length ? linhas.join('\n') : t.espacos, tag]
      .filter(Boolean).join('\n\n');
  }
  return { labels, confirmationTexts };
}
