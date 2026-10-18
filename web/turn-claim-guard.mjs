import { tagIdioma } from './locale.mjs';
import { marca } from './brand.mjs';

const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// A short, isolated reply to a proposal should close the proposal. It doesn't try to
// interpret sentences that bring a new request ("no, do X instead").
export function standaloneRefusal(value) {
  if (/[?¿]/.test(String(value || ''))) return false;
  const text = fold(value);
  // Full sentences: adding "precisa/fazer/nada" to the list of accepted
  // words below would also accidentally accept new requests or conditions.
  // The confirmation selector remains responsible for the target and the scope.
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

// History contains real, but old, results. An explicit temporal claim
// with no query in this turn is objectively false and can't be delivered.
// A query counts whether the model called a tool (toolCounts) or the platform
// ran it for the turn outside the model's tool calls (platformChecks: the
// "busca_email" routine pre-search, native search sources). Until 2026-10-11
// only toolCounts counted, so a routine whose emails the platform had just
// fetched got "I did not consult any tool" (cases of 05/10 and 07/10).
export function enforceFreshCheckClaims(text, { toolCounts = {}, platformChecks = [], language = 'pt-BR' } = {}) {
  const value = String(text || '');
  if (consultedThisTurn(toolCounts, platformChecks)) return value;
  const lines = value.split('\n');
  // The correction itself reads as a claim ("consultei ... neste turno",
  // "verificado agora"): matching it moved the Jev notice below the email
  // sources and was logged as a cut that changed nothing.
  const isClaim = (line) => FRESH_CLAIM.test(line) && !isFreshCheckCorrection(line);
  if (!lines.some(isClaim)) return value;
  const kept = lines.filter((line) => !isClaim(line)).join('\n').trim();
  const out = kept.split('\n').some(isFreshCheckCorrection) ? kept : [kept, freshCheckCorrection(language)].filter(Boolean).join('\n\n');
  return onlyMoved(value, out) ? value : out;
}

const FRESH_CLAIM = /\b(?:verifiquei|verificado|confirmei|confirmado|consultei|consultado|chequei|checado|conferi|conferido|checked|verified|confirmed|consulted|comprob[eé]|verifiqu[eé]|confirm[eé])\b[^\n.!?]{0,120}\b(?:agora|neste turno|just now|right now|ahora)\b/iu;

const FRESH_CHECK_CORRECTION = {
  'pt-BR': 'Não consultei nenhuma ferramenta neste turno, então não posso apresentar esse estado como verificado agora.',
  en: 'I did not consult any tool in this turn, so I cannot present that state as checked now.',
  es: 'No consulté ninguna herramienta en este turno, así que no puedo presentar ese estado como verificado ahora.',
};

export function freshCheckCorrection(language = 'pt-BR') {
  return FRESH_CHECK_CORRECTION[tagIdioma(language)] || FRESH_CHECK_CORRECTION['pt-BR'];
}

const isFreshCheckCorrection = (line) => Object.values(FRESH_CHECK_CORRECTION).includes(String(line || '').trim());

const consultedThisTurn = (toolCounts, platformChecks) =>
  Object.keys(toolCounts || {}).length > 0 || [...(platformChecks || [])].length > 0;

// Same lines, only in another order: not a cut. Delivering it would change
// nothing for the reader and would still count as a filter intervention.
function onlyMoved(before, after) {
  const lines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean).sort();
  const a = lines(before), b = lines(after);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Broad pre-filter for Jev (#48): only asks when the text has a checking
// verb. The rule above requires "agora" and misses "Acabei de conferir sua agenda".
export const FRESH_CHECK_HINT = /\b(?:verific|confer|consult|chequ|chec|olhei|busquei|pesquisei|acessei|checked|verified|looked|consulted|comprob)\w*/iu;

// Jev (#48): catches the "I just checked" claim that the rule misses. Only adds
// the correction, never removes anything (there's no way to know the exact
// line). The judge only sees the text, so it is asked only when nothing was
// consulted in the turn, by the model or by the platform; otherwise its
// premise ("no tool was called") would be false. `judge` is null when Jev is off.
export async function judgeFreshCheckClaim(text, { toolCounts = {}, platformChecks = [], language = 'pt-BR', judge = null } = {}) {
  const value = String(text || '');
  if (!judge || consultedThisTurn(toolCounts, platformChecks) || !FRESH_CHECK_HINT.test(value)) return text;
  // Already carries the correction (or the rule will handle it): asking again
  // would only duplicate or move the same notice.
  if (value.split('\n').some(isFreshCheckCorrection)) return text;
  if (enforceFreshCheckClaims(value, { toolCounts, platformChecks, language }) !== value) return text;
  if (await judge(value) !== 'alegacao_falsa') return text;
  return [value.trim(), freshCheckCorrection(language)].join('\n\n');
}

// Last barrier against the Gmail x platform-mailer collision. A long thread's
// history can repeat the old claim even with the correct rule in the
// system. Only removes lines that positively assert a dependency between
// ROUTINE delivery and Gmail permission; correct sentences ("doesn't depend") stay.
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
 // The question to enable Gmail usually comes on the line immediately following the
 // false justification. Without the justification it would still return the
 // same wrong action to the user, so it goes out together — only when the false line existed.
 kept=kept.filter(line=>!/\b(?:posso|quer que eu|confirma).{0,80}\b(?:ligar|ativar|habilitar)\b/i.test(fold(line)));
 const out=kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
 const correction=({
  en:`Routine email is sent by the ${marca().nome} platform mailer; it does not use the user’s Gmail, does not depend on Gmail sending permission, and does not create a draft.`,
  es:`El correo de una rutina lo envía la plataforma ${marca().nome}; no usa el Gmail del usuario, no depende del permiso de envío de Gmail y no crea borradores.`,
 })[tagIdioma(language)]||`O e-mail de uma rotina é enviado pelo mailer da plataforma ${marca().nome}; não usa o Gmail do usuário, não depende da permissão de envio do Gmail e não cria rascunho.`;
 return [out,correction].filter(Boolean).join('\n\n');
}
