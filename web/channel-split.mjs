// Quebra uma resposta em mensagens de no máximo `max` chars pra canais com teto
// por mensagem (WhatsApp, Telegram, Slack). Nada é descartado: a resposta longa
// vira várias mensagens, na ordem. Antes (até 29/09/2026) cada canal cortava a
// partir de um teto total (8 balões no WhatsApp, 12k chars no Telegram e no
// Slack) e colava "[…resposta muito longa, cortei o resto]".
//
// Fronteira preferida: parágrafo, depois linha, depois espaço (pra não partir
// palavra), e só então corte seco. Uma fronteira só vale se estiver na segunda
// metade do pedaço, senão sairia uma mensagem curtinha. O corte seco nunca parte
// um emoji (par substituto) e não cai dentro de uma URL: recua pro começo dela,
// a não ser que a URL sozinha passe do teto.

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

function recuarDeUrl(rest, cut) {
  URL_RE.lastIndex = 0;
  for (let m; (m = URL_RE.exec(rest)) && m.index < cut;) {
    const fim = m.index + m[0].length;
    if (m.index < cut && cut < fim) return m.index > 0 ? m.index : cut;
  }
  return cut;
}

export function splitMessage(text, max) {
  if (!(max > 1)) throw new Error('splitMessage: max inválido');
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ']) {
      const i = rest.lastIndexOf(sep, max);
      if (i > max * 0.5) { cut = i + sep.length; break; }
    }
    if (cut <= 0) {
      cut = recuarDeUrl(rest, max);
      const cp = rest.charCodeAt(cut - 1);
      if (cp >= 0xd800 && cp <= 0xdbff) cut -= 1;
    }
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}
