// Bounded repair, not a task queue or a semantic verifier. No I/O, per-turn state.
export const PROTOCOL_CODES = new Set(['missing_call_id', 'invalid_tool_name', 'unknown_tool',
  'duplicate_call_id', 'invalid_calls_shape', 'invalid_json_args', 'invalid_args_shape', 'unstructured_tool_call','output_truncated']);
export function protocolCode(res) {
  return res?.stop === 'end' && !res.toolCalls?.length && res.protocolError?.retryable === true &&
    PROTOCOL_CODES.has(res.protocolError.code) ? res.protocolError.code : null;
}
export const CODING_TOOLS = new Set(['construir_app', 'codar']);
export function codingAvailable(defs = []) {
  return defs.some(t => CODING_TOOLS.has(t.name) || t.name === 'abrir_ferramentas');
}
export const CODING_EXECUTION_POLICY = `
[coding execution]
A final answer ends the turn; it does not start background work. To build/change or resume/check/validate the draft of an app already authorized, call construir_app; for other coding work, codar, with the context and requirements from the conversation. If they are not in the current catalog, first open abrir_ferramentas({grupo:"codigo"}); if unavailable, explain what prevents it, do not invent a call. Never say you are building or will report back later unless you started a real execution. If you cannot start, say so now. These tools are synchronous: when they return, describe the result or what prevented it, not work still running. Do not ask again for an authorization already given; clarify only indispensable requirements. Publishing and other protected actions still require their own confirmations. Never use a resume to publish automatically or to ignore a cancellation.`;
export const PROTOCOL_REPAIR = `
[protocol recovery: one attempt]
The last answer was rejected before ANY call in that batch ran. Use only names present in the tools available NOW, unique non-empty IDs and valid JSON object arguments; do not imitate names from the history. For an app use construir_app, not the sub-agent's internal tools. Keep the user's request and most recent decision; do not ask them to repeat everything. The earlier valid calls of this turn already happened: check their results, do NOT repeat them. Do not execute error text or translate tool names by guessing. This note grants no new authorization: all gates, limits and cancellations still apply. If you cannot proceed, answer honestly without promising future execution.`;
export const PROMISE_REPAIR = `
[answer NOT sent yet: one attempt]
You announced code building, resuming or checking/validation as in progress or starting right away, but did not call construir_app/codar in this turn. That text did not start a job. Handle the most recent request: if the work was already authorized and there is enough context, run the right tool; if something prevents it, explain it. Do not repeat actions already done or publish without its own confirmation. Do not ask for a new "go" just to replace the unkept promise. End with the real state, not a promise of background work.`;

// Context signals select a coding task; they are NOT evidence of execution or
// authorization. Only recent conversation is used, not arbitrary tool payloads.
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const codingTarget = s => /\b(?:app|aplicativo|codigo|rascunho|lint|build|compilacao|compilar|debug|publicar_sistema|construir_app)\b/.test(s);
export function codingTurnContext(messages = []) {
  return messages.filter(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-4).map(m => m.content.slice(-1600)).join('\n');
}
function resumePromise(s, codingContext) {
  // Questions, plans, negation and historical reports remain responses, not jobs.
  // A condition AFTER a committed action only gates the later publication:
  // "vou validar agora e, se passar, peço confirmação" still promises validation.
  const clause = s.split(/\s+e,?\s+se\b|;\s*se\b/)[0];
  if (/\b(?:nao|nunca|apos|depois|antes|amanha|ontem|poderia|preciso|posso|aguardo)\b/.test(clause) ||
      /^(?:se|quando|caso|assim que|na proxima etapa|ele|ela|voce|o usuario|o assistente)\b/.test(clause)) return false;
  const implicit = /\b(?:essa|esta|esse|este)\s+(?:verificacao|validacao|checagem|revisao|teste|trabalho)\b|\b(?:de onde parei|daqui|isso)\b/.test(clause);
  if (!codingTarget(clause) && !(codingContext && implicit)) return false;
  const immediate = /\b(?:agora|ja|neste turno|deixa comigo|em breve)\b/.test(clause);
  const verb = '(?:retomar|continuar|recomecar|verificar|reconferir|conferir|validar|testar|revisar)';
  if (immediate && new RegExp(`\\b(?:vou|vamos)\\s+(?:(?:ja|agora)\\s+)?${verb}\\b`).test(clause)) return true;
  if (immediate && /^(?:(?:eu|nos)\s+)?(?:(?:ja|agora)\s+)?(?:retomo|continuo|recomeco|verifico|reconfiro|confiro|valido|testo|reviso)\b/.test(clause)) return true;
  if (/\b(?:estou|to|estamos)\s+(?:retomando|continuando|verificando|conferindo|reconferindo|validando|testando|revisando)\b/.test(clause)) return true;
  return /\b(?:verificacao|validacao|checagem|revisao|teste)\b/.test(clause) &&
    /\b(?:esta|segue)\s+(?:em andamento|rodando)\b/.test(clause);
}

// Narrow PT patterns observed in coding conversations. Quotes, code, questions,
// negations and conditional plans are not evidence of an execution claim.
export function codingPromise(text, defs = [], context = '') {
  if (!codingAvailable(defs)) return false;
  let plain = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const codingContext = codingTarget(norm(plain)) || codingTarget(norm(context));
  const chunks = plain.split(/\n|(?<=[.!?])\s+/);
  let example = false;
  for (const raw of chunks) {
    const s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
      .replace(/\s+e\s+(?:ja\s+)?(?:te|lhe)\s+aviso\s+quando\b.*$/, '');
    if (!s) { example = false; continue; }
    if (/^(?:exemplo|rascunho|citacao|texto sugerido)\s*:/.test(s)) { example = true; continue; }
    if (example || /^>/.test(s) || s.includes('?')) continue;
    if (resumePromise(s, codingContext)) return true;
    if (/\b(?:nao|nunca|se|quando|apos|depois|antes|poderia|preciso|posso|quer|aguardo)\b/.test(s)) continue;
    const verb = '(?:construir|codar|programar|implementar|desenvolver|alterar|corrigir)';
    if (new RegExp(`\\b(?:vou|vamos)\\s+(?:(?:ja|agora)\\s+)?${verb}\\b`).test(s) && /\b(?:agora|ja|deixa comigo)\b/.test(s)) return true;
    if (/\b(?:estou|to|estamos|ja estou|ja estamos)\s+(?:construindo|codando|programando|implementando|desenvolvendo)\b/.test(s)) return true;
    // Past work can be true without a new call in this turn. Only a claim of a
    // fresh start belongs here; historical completion uses other evidence paths.
    if (/\b(?:agora|neste turno)\b/.test(s) && /\b(?:ja comecei|ja iniciei|comecei|iniciei)\s+(?:a\s+)?(?:construir|codar|programar|implementar|desenvolver|construcao|implementacao)\b/.test(s)) return true;
  }
  return false;
}
export function codingFallback(turnLog) {
  const attempted = turnLog.some(c => CODING_TOOLS.has(c.name));
  return attempted
    ? 'A chamada de programação deste turno terminou, mas não tenho confirmação de que o pedido foi concluído nem de que continuará automaticamente. O resultado precisa ser conferido antes de anunciar conclusão ou publicação.'
    : 'Não iniciei uma nova execução de programação neste turno. Seu pedido continua na conversa, mas esta resposta não colocou a construção para rodar. Não vou te pedir que aguarde um trabalho que não iniciei.';
}
export function protocolFallback(turnLog) {
  return 'Não consegui continuar: a chamada de ferramenta retornou em formato inválido e foi bloqueada.' +
    (turnLog.length ? ' As chamadas anteriores deste turno não foram desfeitas; seus resultados continuam no contexto. Não vou repeti-las automaticamente.' : ' Nenhuma ferramenta foi executada neste turno.') +
    ' Não há uma nova execução iniciada por esta resposta.';
}
// Full normalized args, unlike the older anti-loop's truncated preview. Never log.
export function executionSignature(call) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return call.name + '\n' + JSON.stringify(stable(call.args ?? {}));
}

// A nested coding worker must not be told to call a principal-only tool.
export function protocolRepairFor(defs,code){
 const names=new Set(defs.map(t=>t.name));
 let text=PROTOCOL_REPAIR;
 if(!names.has('construir_app'))text=text.replace('For an app use construir_app, not the sub-agent\'s internal tools.',names.has('editar_arquivo_do_app')?'Use the tools available in this executor; make a small change on the current base, without rewriting whole files.':'Use only the tools in this catalog and the evidence already gathered; record a concise review when that tool is available.');
 if(code==='output_truncated')text+=' The answer was cut off at this call\'s limit. No action from the incomplete batch ran. Split the operation or shorten the review, without repeating earlier effects and without announcing completion.';
 return text;
}
