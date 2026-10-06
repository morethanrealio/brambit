// Saídas ricas do atendimento ao público: o que um plugin (porta
// atendimentoPublico) pode mandar no lugar do texto do modelo. Cada canal decide
// como entrega; quem não sabe entregar um tipo usa o texto de textoDasSaidas.
//
// Tipos:
//  {tipo:'texto', texto}
//  {tipo:'imagem', url, legenda?}            url https
//  {tipo:'botao', texto, rotulo, url, imagem?}  botão que abre um link (url https);
//                                            imagem (https) vai no topo da mensagem
//  {tipo:'template', nome, idioma?, componentes?}  template aprovado do canal
//
// Imagem, botão e template aceitam `reserva`: texto que o canal manda no lugar
// quando não consegue entregar aquela saída (ex.: a Meta recusa o template).
//
// O que vem do plugin passa por aqui antes de sair: tipo desconhecido, url que
// não é https ou campo vazio derrubam só aquela saída.
export const SAIDAS_MAX = 10;
export const SAIDA_TEXTO_MAX = 4000;
export const LEGENDA_MAX = 1024;
export const ROTULO_MAX = 20;       // botão de link no WhatsApp aceita até 20
export const COMPONENTES_MAX = 20000; // chars do JSON dos componentes de um template

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
  return null;
}

export function normalizarSaidas(saidas) {
  if (!Array.isArray(saidas)) return [];
  return saidas.slice(0, SAIDAS_MAX).map(normalizar).filter(Boolean);
}

// Versão em texto: vai pro histórico (o modelo vê o que a pessoa recebeu) e pro
// canal que não entrega o tipo rico.
export function textoDasSaidas(saidas) {
  return saidas.map((s) => {
    if (s.tipo === 'texto') return s.texto;
    if (s.tipo === 'imagem') return s.legenda ? `[imagem] ${s.legenda}` : '[imagem]';
    if (s.tipo === 'botao') return `${s.texto}\n[${s.rotulo}: ${s.url}]`;
    return `[mensagem pronta: ${s.nome}]`;
  }).join('\n\n');
}
