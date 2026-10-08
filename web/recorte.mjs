// ── Declared truncation ──
//
// Several platform paths deliver to the model only the beginning of a large
// text (script output, command output, email body, file). Cutting
// is legitimate, what's not allowed is cutting IN SILENCE: without a marker, the model treats
// half a result as the whole result and answers confidently about what it
// never read. This is exactly what happened with page reading (59% of the page
// never arrived and no one, neither the model nor the user, knew it).
//
// Rule: whoever cuts, warns. This module is the single way to do that.

// Returns the cut body and the marker separately, so whoever assembles the text
// can choose where to fit the warning.
export function recortar(texto, teto, rotulo = 'saída') {
  const t = String(texto ?? '');
  if (!(teto > 0) || t.length <= teto) return { corpo: t, corte: '', truncado: false };
  return {
    corpo: t.slice(0, teto),
    // The raw number matters: it's what lets the model tell the user "I saw the
    // first X of Y" instead of making up that it saw everything.
    corte: `\n[...${rotulo} truncada: mostrei ${teto} de ${t.length} caracteres]`,
    truncado: true,
  };
}

// Shortcut for whoever just wants the ready-made string.
export function comAviso(texto, teto, rotulo = 'saída') {
  const { corpo, corte } = recortar(texto, teto, rotulo);
  return corpo + corte;
}
