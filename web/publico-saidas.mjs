// Rich outputs for public support: what a plugin (atendimentoPublico
// port) can send instead of the model's text. Each channel decides
// how to deliver it; whoever doesn't know how to deliver a type uses textoDasSaidas's text.
//
// Types:
//  {tipo:'texto', texto}
//  {tipo:'imagem', url, legenda?}            https url
//  {tipo:'botao', texto, rotulo, url, imagem?}  button that opens a link (https url);
//                                            image (https) goes at the top of the message
//  {tipo:'template', nome, idioma?, componentes?}  channel's approved template
//  {tipo:'data', nome, data}                 structured data for a page that
//                                            renders it itself (a product card, a
//                                            command for a widget); `nome` says what
//                                            it is, `data` is a plain JSON object
//
// Image, button, template and data accept `reserva`: text the channel sends instead
// when it can't deliver that output (e.g. Meta rejects the template; WhatsApp
// has no use for data, so it sends the reserve or nothing).
//
// What comes from the plugin passes through here before going out: an unknown type, a url that
// isn't https or an empty field drop just that output.
import { hostInSites, withoutLinksOutside } from './links.mjs';

export { withoutLinksOutside };

export const SAIDAS_MAX = 10;
export const SAIDA_TEXTO_MAX = 4000;
export const LEGENDA_MAX = 1024;
export const ROTULO_MAX = 20;       // WhatsApp link button accepts up to 20
export const COMPONENTES_MAX = 20000; // chars of the JSON of a template's components
export const DATA_MAX = 8000;         // chars of the JSON of a data output
const NOME = /^[a-z][a-z0-9_.-]{0,63}$/;

const corte = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const https = (v) => {
  try { const u = new URL(String(v)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
};

function normalizar(s) {
  const r = normalizarTipo(s);
  const reserva = r && r.tipo !== 'texto' ? corte(s.reserva, SAIDA_TEXTO_MAX) : '';
  return r && reserva ? { ...r, reserva } : r;
}

function normalizarTipo(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.tipo === 'texto') { const texto = corte(s.texto, SAIDA_TEXTO_MAX); return texto ? { tipo: 'texto', texto } : null; }
  if (s.tipo === 'imagem') {
    const url = https(s.url); if (!url) return null;
    const legenda = corte(s.legenda, LEGENDA_MAX);
    return { tipo: 'imagem', url, ...(legenda ? { legenda } : {}) };
  }
  if (s.tipo === 'botao') {
    const url = https(s.url), texto = corte(s.texto, LEGENDA_MAX), rotulo = corte(s.rotulo, ROTULO_MAX);
    const imagem = s.imagem === undefined ? null : https(s.imagem);
    if (s.imagem !== undefined && !imagem) return null;
    return url && texto && rotulo ? { tipo: 'botao', texto, rotulo, url, ...(imagem ? { imagem } : {}) } : null;
  }
  if (s.tipo === 'template') {
    const nome = String(s.nome ?? '');
    const idioma = s.idioma === undefined ? 'pt_BR' : String(s.idioma);
    if (!/^[a-z0-9_]{1,512}$/.test(nome) || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(idioma)) return null;
    const componentes = s.componentes === undefined ? [] : s.componentes;
    if (!Array.isArray(componentes) || JSON.stringify(componentes).length > COMPONENTES_MAX) return null;
    return { tipo: 'template', nome, idioma, componentes };
  }
  if (s.tipo === 'data') {
    const nome = String(s.nome ?? '');
    if (!NOME.test(nome) || !s.data || typeof s.data !== 'object' || Array.isArray(s.data)) return null;
    let json;
    try { json = JSON.stringify(s.data); } catch { return null; }
    if (json.length > DATA_MAX) return null;
    return { tipo: 'data', nome, data: JSON.parse(json) };
  }
  return null;
}

export function normalizarSaidas(saidas) {
  if (!Array.isArray(saidas)) return [];
  return saidas.slice(0, SAIDAS_MAX).map(normalizar).filter(Boolean);
}

// Text version: goes to the history (the model sees what the person received) and to
// the channel that doesn't deliver the rich type.
export function textoDasSaidas(saidas) {
  return saidas.map((s) => {
    if (s.tipo === 'texto') return s.texto;
    if (s.tipo === 'imagem') return s.legenda ? `[imagem] ${s.legenda}` : '[imagem]';
    if (s.tipo === 'botao') return `${s.texto}\n[${s.rotulo}: ${s.url}]`;
    if (s.tipo === 'data') return s.reserva || `[data: ${s.nome}]`;
    return `[mensagem pronta: ${s.nome}]`;
  }).join('\n\n');
}

// The owner's "sites the assistant may send people to": a button to another
// site becomes its text, and addresses of other sites leave the texts.
// Templates and data outputs are the plugin's own and pass as they are.
export function keepLinksToSites(saidas, sites) {
  const limpa = (v) => withoutLinksOutside(v, sites);
  return saidas.map((s) => {
    const r = { ...s };
    if (s.reserva) { r.reserva = limpa(s.reserva); if (!r.reserva) delete r.reserva; }
    if (s.tipo === 'texto') { r.texto = limpa(s.texto); return r.texto ? r : null; }
    if (s.tipo === 'imagem' && s.legenda) { r.legenda = limpa(s.legenda); if (!r.legenda) delete r.legenda; }
    if (s.tipo === 'botao') {
      const texto = limpa(s.texto);
      if (!hostInSites(s.url, sites)) return texto ? { tipo: 'texto', texto } : null;
      r.texto = texto || s.rotulo;
    }
    return r;
  }).filter(Boolean);
}
