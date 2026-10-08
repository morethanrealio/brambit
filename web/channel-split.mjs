// Splits a response into messages of at most `max` chars for channels with a cap
// per message (WhatsApp, Telegram, Slack). Nothing is discarded: the long response
// becomes several messages, in order. Before (until 2026-09-29) each channel cut
// based on a total cap (8 bubbles on WhatsApp, 12k chars on Telegram and
// Slack) and appended "[…resposta muito longa, cortei o resto]".
//
// Preferred boundary: paragraph, then line, then space (to not split a
// word), and only then a hard cut. A boundary only counts if it's in the second
// half of the chunk, otherwise it would produce a tiny message. The hard cut never splits
// an emoji (surrogate pair) and doesn't fall inside a URL: it backs off to the start
// of it, unless the URL alone exceeds the cap.

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
