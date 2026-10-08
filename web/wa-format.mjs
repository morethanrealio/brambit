// The model writes Markdown (**bold**, # heading, [text](url)) even with the
// system prompt asking for *bold*: in the 30 days up to 2026-10-02, 1249 of 1841
// WhatsApp thread replies had **, 591 had a # heading and 121 a
// [text](url) link. WhatsApp doesn't understand Markdown and showed the raw symbols
// (2026-10-01 routine). Here the text is converted to WhatsApp formatting right
// before sending; what gets saved in the conversation stays Markdown (the web renders it).
//
// Code block (```), inline code (`) and URLs pass through intact: WhatsApp
// already understands ``` and `, and a __ or ** inside a URL isn't formatting.
// Tables stay as they are (no WhatsApp equivalent).

const PROTEGIDO = /```[\s\S]*?```|`[^`\n]+`/g;
// URL ends before a * or ~ stuck to the end: in **https://x.com** the asterisks
// are formatting, not part of the link.
const URL = /https?:\/\/[^\s<>"'`)\]]+?(?=[*~]*(?:[\s<>"'`)\]]|$))/g;
// Masked CPF/CNPJ (***.365.199-**): the asterisks are the mask, not bold.
const MASCARA = /(?<![\w*])[\d*]{2,3}\.[\d*]{3}\.[\d*]{3}(?:\/[\d*]{4})?-[\d*]{2}(?![\w*])/g;

export function markdownParaWa(text) {
  const guardados = [];
  const guardar = (s) => `\u0000${guardados.push(s) - 1}\u0000`;

  let t = String(text ?? '');

  // Link becomes "text (url)"; if the text is already the url itself, just the url. Needs
  // to run before protecting URLs, otherwise the link's final ")" gets lost.
  t = t.replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, rotulo, url) => {
    const r = rotulo.trim();
    const nu = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!r || nu(r) === nu(url)) return url;
    return `${r} (${url})`;
  });

  t = t.replace(PROTEGIDO, guardar).replace(MASCARA, guardar);
  // A link alone between marks (**url**) goes out without the mark: the link stays clickable.
  const links = [];
  t = t.replace(URL, (u) => `\u0001${links.push(u) - 1}\u0001`)
    .replace(/(\*{1,3}|__|~~)(\u0001\d+\u0001)\1/g, '$2');

  t = t
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_, titulo) => `**${titulo.replace(/\*\*|__/g, '')}**`)
    .replace(/\*\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*\*/g, '*$1*')
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, '*$1*')
    .replace(/(^|[^\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])/g, '$1*$2*')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '~$1~');

  return t
    .replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i) => guardados[Number(i)]);
}
