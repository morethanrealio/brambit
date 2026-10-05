import { compile } from 'html-to-text';

// O limite de leitura incide sobre conteúdo útil, nunca sobre CSS/markup.
// Limites de parsing são separados e também tornam a leitura parcial.
export const EMAIL_BODY_INPUT_LIMIT = 1_000_000;
const OMITTED = '[conteúdo omitido por limite de leitura]';
const clean = s => String(s || '').replace(/\r/g,'').replace(/\u00a0/g,' ')
  .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();

export function emailBodyUrl(value) {
  const s=String(value || '').trim();
  if (!s || s.length>4096 || /[\u0000-\u0020\u007f]/.test(s)) return null;
  try {
    const url=new URL(s);
    return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function labelOf(element, depth=0) {
  if (depth>32) return '';
  if (element.type==='text') return element.data || '';
  if (['script','style'].includes(element.name)) return '';
  if (element.name==='img') return element.attribs?.alt || '';
  return (element.children || []).map(e=>labelOf(e,depth+1)).join(' ');
}

const htmlText=compile({
  wordwrap:false,
  limits:{maxInputLength:undefined,maxDepth:128,maxChildNodes:10000,ellipsis:OMITTED},
  selectors:[
    {selector:'head',format:'skip'}, {selector:'script',format:'skip'}, {selector:'style',format:'skip'},
    {selector:'a',format:'emailLink'}, {selector:'img',format:'emailImage'},
    ...['h1','h2','h3','h4','h5','h6'].map(selector=>({selector,options:{uppercase:false}})),
  ],
  formatters:{
    emailImage(element,walk,builder) { builder.addInline(element.attribs?.alt || ''); },
    emailLink(element,walk,builder) {
      walk(element.children,builder);
      const url=emailBodyUrl(element.attribs?.href);
      if (!url) return;
      const label=clean(labelOf(element) || element.attribs?.title).replace(/\s+/g,' ').slice(0,180);
      if (!builder.metadata.links.has(url)) builder.metadata.links.set(url,{label:label || 'Link no e-mail',url});
      // URLs ficam no campo links: rodapés e redirecionamentos compridos não
      // consomem novamente o limite do texto nem escondem o prazo da compra.
      if (!label) builder.addInline('[link no e-mail]');
    },
  },
});

export function normalizeEmailBody(value, mimeType='text/plain') {
  const raw=String(value || ''), links=new Map();
  const input=raw.slice(0,EMAIL_BODY_INPUT_LIMIT);
  const html=String(mimeType).toLowerCase().includes('html');
  const text=clean(html ? htmlText(input,{links}) : input);
  if (!html) for (const match of text.matchAll(/https?:\/\/[^\s<>"\]]+/gi)) {
    const url=emailBodyUrl(match[0].replace(/[.,;!?)]+$/,''));
    if (url && !links.has(url)) links.set(url,{label:'Link no e-mail',url});
  }
  return {text,links:[...links.values()],partial:raw.length>EMAIL_BODY_INPUT_LIMIT || text.includes(OMITTED)};
}

export function limitEmailBody(content, maxChars=6000) {
  const text=content.text || '';
  const unique=new Map((content.links || []).map(link=>[link.url,link]));
  // Botões úteis à tarefa sobrevivem mesmo quando o template tem muito rodapé.
  const relevant=link=>/acompanh|rastrei|tracking|track[-_/ ]|pedido|orders?|entrega|shipment/i.test(link.label+' '+link.url);
  const links=[...unique.values()].sort((a,b)=>Number(relevant(b))-Number(relevant(a)));
  return {body:text.slice(0,maxChars),chars:text.length,truncated:!!content.partial || text.length>maxChars,
    links:links.slice(0,20),links_truncated:links.length>20};
}
