// Helpers puros pro payload de mensagem do Gmail (sem rede): usados
// pelo conector Google e pela rotina de busca de e-mail (email-search-runtime).
// Módulo-folha de propósito: quem só precisa ler o payload não puxa o
// connectors.mjs inteiro (pdf-parse, Drive, etc.).

import { normalizeEmailBody, limitEmailBody, EMAIL_BODY_INPUT_LIMIT } from './email-body.mjs';

// Decodifica base64url (Gmail/Docs usam isso nos corpos).
function b64url(data, charset='utf-8') {
  try {
    const bytes=Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    try { return new TextDecoder(charset).decode(bytes); }
    catch { return bytes.toString('utf8'); }
  }
  catch { return ''; }
}

export function readGmailBody(payload, { maxChars=6000 } = {}) {
  let nodes=0, remaining=EMAIL_BODY_INPUT_LIMIT, limited=false;
  const empty=()=>({text:'',links:[],partial:false});
  function read(p,depth=0) {
    if (!p) return empty();
    if (++nodes>512 || depth>64) {limited=true;return empty();}
    const disposition=(p.headers || []).find(h=>h.name?.toLowerCase()==='content-disposition')?.value || '';
    // Texto de anexo não substitui o corpo; mensagens encaminhadas anexadas
    // também não são misturadas à mensagem que se está lendo.
    const mime=String(p.mimeType || '').toLowerCase().split(';')[0].trim();
    if (p.filename || /^\s*attachment\b/i.test(disposition) || mime==='message/rfc822') return empty();
    if (mime==='text/plain' || mime==='text/html') {
      if (!p.body?.data) return {...empty(),partial:!!p.body?.attachmentId};
      const encoded=String(p.body.data);
      const cap=Math.ceil(remaining*4/3)+4;
      const typeHeader=(p.headers || []).find(h=>h.name?.toLowerCase()==='content-type')?.value || '';
      const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(typeHeader)?.[1];
      const raw=b64url(encoded.slice(0,cap),charset);
      const result=normalizeEmailBody(raw.slice(0,remaining),mime);
      if(encoded.length>cap || raw.length>remaining) limited=true;
      remaining=Math.max(0,remaining-raw.length);
      return result;
    }
    const children=[];
    const parts=mime==='multipart/alternative' ? [...(p.parts || [])].sort((a,b)=>Number(b.mimeType==='text/plain')-Number(a.mimeType==='text/plain')) : p.parts || [];
    for(const child of parts) {
      if(nodes>=512) {limited=true;break;}
      children.push({mime:child.mimeType,value:read(child,depth+1)});
    }
    if (mime==='multipart/alternative') {
      const chosen=children.find(c=>c.mime==='text/plain' && c.value.text) || children.find(c=>c.value.text);
      // Uma só representação do texto, mas os botões do HTML continuam úteis
      // mesmo quando existe uma alternativa text/plain.
      return {text:chosen?.value.text || '',links:children.flatMap(c=>c.value.links),partial:children.some(c=>c.value.partial)};
    }
    return {text:children.map(c=>c.value.text).filter(Boolean).join('\n\n'),links:children.flatMap(c=>c.value.links),partial:children.some(c=>c.value.partial)};
  }
  const result=read(payload);
  result.partial ||= limited;
  return limitEmailBody(result,maxChars);
}

// Compatibilidade com consumidores que só precisam do texto normalizado.
export function extractGmailBody(payload) {
  return readGmailBody(payload,{maxChars:EMAIL_BODY_INPUT_LIMIT}).body;
}

// Anda no payload do Gmail e junta os anexos (parts com filename + attachmentId).
export function collectAttachments(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    out.push({ attachmentId: payload.body.attachmentId, filename: payload.filename, mimeType: payload.mimeType || '', size: payload.body.size || 0 });
  }
  for (const p of payload.parts || []) collectAttachments(p, out);
  return out;
}
