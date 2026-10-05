// O modelo escreve Markdown (**negrito**, # título, [texto](url)) mesmo com o
// system prompt pedindo *negrito*: em 30 dias até 02/10/2026, 1249 de 1841
// respostas em thread de WhatsApp tinham **, 591 tinham título # e 121 link
// [texto](url). O WhatsApp não entende Markdown e mostrava os símbolos crus
// (rotina de 01/10). Aqui o texto vira a formatação do WhatsApp logo
// antes do envio; o que fica salvo na conversa continua Markdown (a web renderiza).
//
// Bloco de código (```), código inline (`) e URL passam intactos: o WhatsApp
// já entende ``` e `, e um __ ou ** dentro de URL não é formatação.
// Tabela fica como está (não tem equivalente no WhatsApp).

const PROTEGIDO = /```[\s\S]*?```|`[^`\n]+`/g;
// URL termina antes de * ou ~ colados no fim: em **https://x.com** os asteriscos
// são formatação, não parte do link.
const URL = /https?:\/\/[^\s<>"'`)\]]+?(?=[*~]*(?:[\s<>"'`)\]]|$))/g;
// CPF/CNPJ mascarado (***.365.199-**): os asteriscos são a máscara, não negrito.
const MASCARA = /(?<![\w*])[\d*]{2,3}\.[\d*]{3}\.[\d*]{3}(?:\/[\d*]{4})?-[\d*]{2}(?![\w*])/g;

export function markdownParaWa(text) {
  const guardados = [];
  const guardar = (s) => `\u0000${guardados.push(s) - 1}\u0000`;

  let t = String(text ?? '');

  // Link vira "texto (url)"; se o texto já é a própria url, só a url. Precisa
  // rodar antes de proteger as URLs, senão o ")" final do link se perde.
  t = t.replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, rotulo, url) => {
    const r = rotulo.trim();
    const nu = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!r || nu(r) === nu(url)) return url;
    return `${r} (${url})`;
  });

  t = t.replace(PROTEGIDO, guardar).replace(MASCARA, guardar);
  // Link sozinho entre marcas (**url**) vai sem a marca: o link fica clicável.
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
