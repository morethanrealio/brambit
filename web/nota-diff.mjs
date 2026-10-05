// Cartão de confirmação do editar_nota: mostra SÓ as linhas que mudam, não a
// nota inteira. Motivo (30/09/2026, caso da lista de compras): o cartão
// despejava a nota nova completa, a pessoa não achava no meio dela o que
// estava aprovando e mandava a correção de novo, empilhando propostas.
//
// Continua exato: toda linha que sai e toda linha que entra aparece, na forma
// literal. O que some é só o que fica igual. Função pura, sem banco, pra poder
// ser testada sozinha.

// Acima disso a tabela da comparação pesa demais; o cartão volta a mostrar a
// nota nova inteira, que é o comportamento de antes e continua correto.
const LIMITE_CELULAS = 2_000_000;

// Comparação de duas sequências (maior subsequência comum). Devolve [op, item]
// com op '=' (igual), '-' (sai) ou '+' (entra), na ordem; null se grande demais
// pra comparar.
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

// Comparação por linha do texto inteiro.
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

// Título markdown ("## Lista Atual") divide a nota em seções. A comparação é
// feita seção por seção, casando cada uma pelo caminho de títulos ("Lista
// Atual › Supermercado"), e não na nota corrida: numa lista em que a semana
// inteira vai pro histórico, a comparação corrida acha mais curto dizer que os
// títulos do histórico "subiram" por cima dos itens (exato, mas ilegível; caso
// real da rotina de 30/09/2026). Por seção, o cartão diz o que a pessoa fez:
// os itens saíram do Supermercado e entraram no histórico daquela data.
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
    // Mesmo caminho repetido na nota (dois "### Supermercado" no mesmo lugar):
    // a ocorrência entra na chave pra não casar uma com a outra.
    const base = caminho.map((c) => `${'#'.repeat(c.nivel)} ${c.nome}`).join('\u0001');
    const n = (vistas.get(base) || 0) + 1; vistas.set(base, n);
    lista.push({ chave: n > 1 ? `${base}\u0002${n}` : base, nome: caminho.map((c) => c.nome), pai, cabecalho: l, linhas: [] });
  }
  return lista;
}

// Linhas que mudam, cada uma com a seção a que pertence: [rotulo, op, linha].
// null se alguma comparação passar do limite.
function mudancas(antes, depois) {
  const A = secoes(antes), B = secoes(depois);
  const porChave = (lista) => new Map(lista.map((s) => [s.chave, s]));
  const mA = porChave(A), mB = porChave(B);
  const ordem = diffSeq(A.map((s) => s.chave), B.map((s) => s.chave));
  if (!ordem) return null;
  // O cartão chama a seção pelo próprio título; só quando o mesmo título existe
  // em mais de um lugar da nota é que ele vem com o caminho ("Casa › Mercado").
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
    // Seção inteira que entra ou sai: o próprio título aparece, sob a seção-mãe.
    const sec = (op === '+' ? mB : mA).get(chave);
    out.push([rotulo(sec.pai), op, sec.cabecalho]);
    for (const l of sec.linhas) out.push([rotulo(sec.pai), op, l]);
  }
  return out.filter(([, , l]) => l.trim());
}

// Os mesmos ajustes que o updateSpaceEntry grava (trim), pra comparar o que
// vai de fato pro banco. `depois` null = texto não muda (só a tag).
// Lança erro quando não há nada pra mudar: o gate devolve isso ao modelo em
// vez de pedir confirmação de uma edição vazia.
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
