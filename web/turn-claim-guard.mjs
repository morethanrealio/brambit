import { tagIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// A resposta curta e isolada a uma proposta deve encerrar a proposta. Não tenta
// interpretar frases que tragam um pedido novo ("não, faça X em vez disso").
export function standaloneRefusal(value) {
  if (/[?¿]/.test(String(value || ''))) return false;
  const text = fold(value);
  // Frases completas: adicionar "precisa/fazer/nada" à lista de palavras
  // aceitas abaixo também aceitaria pedidos novos ou condições por acidente.
  // O seletor de confirmação continua responsável pelo alvo e pelo escopo.
  if (/^(?:por favor )?nao (?:(?:precisa|e preciso|e necessario)(?: mais)? (?:fazer (?:mais )?(?:nada|isso)|continuar)|faca (?:mais )?nada)(?: por favor| obrigad[oa])?$/.test(text)
    || /^(?:please )?(?:no need to (?:do (?:anything(?: else)?|that)|continue|proceed)|(?:you )?(?:don t|do not) (?:need to )?do (?:anything(?: else)?|that)|do nothing)(?: please| thanks| thank you)?$/.test(text)
    || /^(?:por favor )?no (?:(?:hace falta|es necesario|necesitas) (?:hacer (?:nada|eso)|continuar)|hagas nada)(?: por favor| gracias)?$/.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const allowed = new Set(['nao','no','nope','nah','pare','para','chega','cancela','cancele','isso','obrigado','obrigada','por','favor','quero','faca','faz','mais']);
  if (words.some((word) => !allowed.has(word))) return false;
  return words.some((word) => ['nao','no','nope','nah','pare','para','chega','cancela','cancele'].includes(word));
}

export function refusalAcknowledgement(language = 'pt-BR') {
  return ({
    en: 'Understood. I will not make or propose that change again unless you reopen the subject.',
    es: 'Entendido. No haré ni volveré a proponer ese cambio, salvo que vuelvas a abrir el tema.',
  })[tagIdioma(language)] || 'Entendido. Não vou fazer nem propor essa alteração novamente, a menos que você reabra o assunto.';
}

// Histórico contém resultados reais, mas antigos. Uma alegação temporal explícita
// sem nenhuma consulta neste turno é objetivamente falsa e não pode ser entregue.
export function enforceFreshCheckClaims(text, { toolCounts = {}, language = 'pt-BR' } = {}) {
  const value = String(text || '');
  if (Object.keys(toolCounts || {}).length) return value;
  const freshClaim = /\b(?:verifiquei|verificado|confirmei|confirmado|consultei|consultado|chequei|checado|conferi|conferido|checked|verified|confirmed|consulted|comprob[eé]|verifiqu[eé]|confirm[eé])\b[^\n.!?]{0,120}\b(?:agora|neste turno|just now|right now|ahora)\b/iu;
  if (!freshClaim.test(value)) return value;
  const correction = freshCheckCorrection(language);
  const kept = value.split('\n').filter((line) => !freshClaim.test(line)).join('\n').trim();
  return [kept, correction].filter(Boolean).join('\n\n');
}

export function freshCheckCorrection(language = 'pt-BR') {
  return ({
    en: 'I did not consult any tool in this turn, so I cannot present that state as checked now.',
    es: 'No consulté ninguna herramienta en este turno, así que no puedo presentar ese estado como verificado ahora.',
  })[tagIdioma(language)] || 'Não consultei nenhuma ferramenta neste turno, então não posso apresentar esse estado como verificado agora.';
}

// Pré-filtro largo para o Jev (#48): só pergunta quando o texto tem verbo de
// conferência. A regra acima exige "agora" e perde "Acabei de conferir sua agenda".
export const FRESH_CHECK_HINT = /\b(?:verific|confer|consult|chequ|chec|olhei|busquei|pesquisei|acessei|checked|verified|looked|consulted|comprob)\w*/iu;

// Última barreira contra a colisão Gmail x mailer da plataforma. O histórico de
// uma thread longa pode repetir a afirmação antiga mesmo com a regra correta no
// system. Só remove linhas que afirmam positivamente uma dependência entre a
// entrega da ROTINA e permissão/Gmail; frases corretas ("não depende") ficam.
export function enforceRoutineEmailContract(text, { language='pt-BR' }={}) {
 const lines=String(text||'').split('\n');let removed=false;
 let kept=lines.filter(line=>{
  const f=fold(line);
  if(!/\brotina\b/.test(f)||!/\b(?:gmail|permissao|envio de e mail)\b/.test(f))return true;
  if(/\b(?:nao depende|nao usa|nunca usa|independente|outro sistema)\b/.test(f))return true;
  const falseDependency=/\b(?:depende|precisa|necessari[oa]|impossivel|desligad[oa]|ligar|ativar)\b/.test(f);
  if(!falseDependency)return true;removed=true;return false;
 });
 if(!removed)return String(text||'');
 // A pergunta de ativar Gmail costuma vir na linha imediatamente seguinte à
 // justificativa falsa. Sem a justificativa ela ainda devolveria ao usuário a
 // mesma ação errada, então sai junto — somente quando a linha falsa existiu.
 kept=kept.filter(line=>!/\b(?:posso|quer que eu|confirma).{0,80}\b(?:ligar|ativar|habilitar)\b/i.test(fold(line)));
 const out=kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
 const correction=({
  en:`Routine email is sent by the ${marca().nome} platform mailer; it does not use the user’s Gmail, does not depend on Gmail sending permission, and does not create a draft.`,
  es:`El correo de una rutina lo envía la plataforma ${marca().nome}; no usa el Gmail del usuario, no depende del permiso de envío de Gmail y no crea borradores.`,
 })[tagIdioma(language)]||`O e-mail de uma rotina é enviado pelo mailer da plataforma ${marca().nome}; não usa o Gmail do usuário, não depende da permissão de envio do Gmail e não cria rascunho.`;
 return [out,correction].filter(Boolean).join('\n\n');
}
