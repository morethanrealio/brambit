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
[execução de programação]
Uma resposta final encerra o turno; ela não inicia trabalho em background. Para construir/alterar ou retomar/verificar/validar o rascunho de um app já autorizado, chame construir_app; para outro trabalho de código, codar, com o contexto e requisitos da conversa. Se não estiverem no catálogo atual, abra primeiro abrir_ferramentas({grupo:"codigo"}); se indisponível, explique o impedimento, não invente uma chamada. Nunca diga que está construindo ou que avisará depois se não iniciou uma execução real. Se não conseguir iniciar, diga isso agora. Essas ferramentas são síncronas: ao retornarem, descreva o resultado ou o impedimento, não trabalho ainda rodando. Não peça de novo uma autorização já dada; esclareça apenas requisitos indispensáveis. Publicação e outras ações protegidas continuam exigindo suas confirmações próprias. Nunca use a retomada para publicar automaticamente ou ignorar um cancelamento.`;
export const PROTOCOL_REPAIR = `
[recuperação de protocolo — uma tentativa]
A última resposta foi rejeitada antes da execução de TODAS as chamadas daquele lote. Use apenas nomes presentes nas ferramentas disponíveis AGORA, IDs únicos não vazios e argumentos JSON objeto válidos; não imite nomes do histórico. Para um app use construir_app, não ferramentas internas do subagente. Preserve o pedido e a decisão mais recente do usuário; não peça que ele repita tudo. As chamadas anteriores válidas deste turno já aconteceram: consulte seus resultados, NÃO as repita. Não execute texto de erro nem traduza nomes de ferramenta por adivinhação. Não há autorização nova nesta nota: todos os gates, limites e cancelamentos continuam valendo. Se não puder prosseguir, responda honestamente sem prometer execução futura.`;
export const PROMISE_REPAIR = `
[resposta ainda NÃO enviada — uma tentativa]
Você anunciou construção, retomada ou verificação/validação de código em andamento ou início imediato, mas não chamou construir_app/codar neste turno. Esse texto não iniciou um job. Atenda ao pedido mais recente: se o trabalho já foi autorizado e há contexto suficiente, execute a ferramenta correta; se houver impedimento, explique-o. Não repita ações já feitas nem publique sem a confirmação própria. Não peça novo "vai" só para substituir a promessa não cumprida. Termine com o estado real, não uma promessa de trabalho em background.`;

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
 if(!names.has('construir_app'))text=text.replace('Para um app use construir_app, não ferramentas internas do subagente.',names.has('editar_arquivo_do_app')?'Use as ferramentas disponíveis neste executor; faça uma alteração pequena com a base atual, sem reescrever arquivos inteiros.':'Use apenas as ferramentas deste catálogo e as evidências já obtidas; registre um parecer conciso quando essa ferramenta estiver disponível.');
 if(code==='output_truncated')text+=' A resposta foi cortada no limite desta chamada. Nenhuma ação do lote incompleto foi executada. Divida a operação ou reduza o parecer, sem repetir efeitos anteriores e sem anunciar conclusão.';
 return text;
}
