// ── Corte declarado ──
//
// Vários caminhos da plataforma entregam ao modelo só o começo de um texto
// grande (saída de script, saída de comando, corpo de e-mail, arquivo). Cortar
// é legítimo, o que não pode é cortar EM SILÊNCIO: sem marcador, o modelo trata
// meio resultado como resultado inteiro e responde com confiança sobre o que
// nunca leu. Foi exatamente o que aconteceu na leitura de página (59% da página
// nunca chegava e ninguém, nem o modelo nem o usuário, sabia disso).
//
// Regra: quem corta, avisa. Este módulo é o jeito único de fazer isso.

// Devolve o corpo cortado e o marcador separados, pra quem monta o texto
// escolher onde encaixar o aviso.
export function recortar(texto, teto, rotulo = 'saída') {
  const t = String(texto ?? '');
  if (!(teto > 0) || t.length <= teto) return { corpo: t, corte: '', truncado: false };
  return {
    corpo: t.slice(0, teto),
    // O número cru importa: é o que deixa o modelo dizer ao usuário "vi os
    // primeiros X de Y" em vez de inventar que viu tudo.
    corte: `\n[...${rotulo} truncada: mostrei ${teto} de ${t.length} caracteres]`,
    truncado: true,
  };
}

// Atalho pra quem só quer a string pronta.
export function comAviso(texto, teto, rotulo = 'saída') {
  const { corpo, corte } = recortar(texto, teto, rotulo);
  return corpo + corte;
}
