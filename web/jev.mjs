// Classificador de intenção Jev (TypeSafe System One) nas travas de palavra-chave.
//
// Regra de uso (Marcos 28/09): o Jev melhora a LEITURA da intenção, mas nunca
// autoriza sozinho uma ação que grava, envia, apaga ou publica. Nos pontos em que
// a trava dispara uma ação, o Jev só pode VETAR um disparo errado da regra; o que
// ele acha a mais vai para o modelo, que passa pelo cartão de confirmação.
//
// Sem TYPESAFE_API_KEY, com JEV_TRAVAS=0, em erro ou em timeout, devolve null e
// quem chamou segue com a regra antiga: nunca fica pior que hoje.
// As perguntas e os critérios são os do eval 28/09 (projetos/evals/travas-2026-09-28),
// 150/158 acertos contra 90/158 das regras.

const URL_JEV = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 2000;

export function jevEnabled() {
  return !!process.env.TYPESAFE_API_KEY && process.env.JEV_TRAVAS !== '0';
}

// Uma pergunta `choice`. Devolve o rótulo escolhido (uma das chaves de criteria) ou null.
export async function jevChoice({ state, instructions, criteria, trava = '' }) {
  if (!jevEnabled()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(URL_JEV, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify({ state: String(state || '').slice(0, 1400), model: process.env.JEV_MODEL || 'jev-latest',
        questions: { q: { type: 'choice', instructions, criteria } } }),
    });
    if (!r.ok) { console.warn(`[jev] ${trava} HTTP ${r.status}: segue a regra fixa`); return null; }
    const choice = (await r.json())?.answers?.q?.choice;
    if (!Object.hasOwn(criteria, choice)) return null;
    console.log(`[jev] ${trava} -> ${choice} (${Date.now() - t0}ms)`);
    return choice;
  } catch (e) {
    console.warn(`[jev] ${trava} ${e?.name === 'AbortError' ? 'timeout' : 'erro'}: segue a regra fixa`);
    return null;
  } finally { clearTimeout(timer); }
}

// Estado no formato do eval: contexto fixo, última fala do assistente, mensagem do dono.
function conversa({ fato = '', focus = '', previousAssistantText = '', message = '' }) {
  const lines = [];
  if (fato) lines.push('Contexto: ' + fato);
  if (focus) lines.push(`App em foco na conversa: ${focus}.`);
  lines.push('Conversa:');
  if (previousAssistantText) lines.push(`[assistente]: ${String(previousAssistantText).slice(-600)}`);
  lines.push(`[usuário]: ${message}`);
  return lines.join('\n');
}
const DONO = 'Classifique a ÚLTIMA mensagem do usuário (dono do assistente) considerando o contexto.';
const ASSISTENTE = 'Classifique a ÚLTIMA mensagem do assistente (dono do assistente) considerando o contexto.';

// #3 controle de tarefa de programação em segundo plano.
export function jevCodingControl({ message, app = '', previousAssistantText = '' }) {
  return jevChoice({ trava: '#3', instructions: DONO,
    state: conversa({ message, previousAssistantText,
      fato: `Existe uma tarefa de programação${app ? ` do app "${app}"` : ''} em segundo plano. O dono também usa jornada de descoberta, lembretes e lista de pendências.` }),
    criteria: { status_job: 'pergunta como está/andamento da tarefa de programação em segundo plano', cancelar_job: 'manda parar/cancelar a tarefa de programação', retomar_job: 'manda continuar/retomar a tarefa de programação', nenhuma: 'outra coisa (jornada, lembrete, pendência, pergunta sobre o app, relato de bug)' } });
}

// #7 turno de recuperação de app sem crédito.
export function jevAppEmergency({ message, apps = [] }) {
  return jevChoice({ trava: '#7', instructions: DONO,
    state: conversa({ message,
      fato: `Os créditos do dono ACABARAM.${apps.length ? ` Apps publicados dele: ${apps.map(a => `"${a}"`).join(', ')}.` : ''} Sem crédito, só se abre um turno de recuperação (logs/histórico/voltar versão) se ele relata que um app DELE publicado quebrou ou regrediu.` }),
    criteria: { recuperar_app: 'relata que um app/sistema publicado dele quebrou, sumiu dado, regrediu ou não abre', nenhuma: 'qualquer outra coisa (site de terceiros, link, exercício, conversa)' } });
}

// #12 o turno mira um app básico do dono (tira o sandbox do turno)?
export function jevAppFocus({ message, apps = [], focus = '' }) {
  return jevChoice({ trava: '#12', instructions: DONO,
    state: conversa({ message, focus,
      // Só os nomes: contar ao Jev que o sandbox some quando é app puxou a resposta
      // pra "app" (prova em prod 28/09: 9/13 com a frase, 12/13 sem).
      fato: `Apps básicos do dono: ${apps.map(a => `"${a}"`).join(', ')}.` }),
    criteria: { app: 'operar/editar/publicar/consultar um app DELE', codigo_sandbox: 'gerar arquivo ou rodar código (QR code, planilha, conversão)', imagem: 'gerar imagem ilustrativa', nenhuma: 'conversa, arquivo, documento ou outro assunto' } });
}

// #32 memória permanente x notas da jornada.
export function jevPermanentMemory({ message, previousAssistantText = '' }) {
  return jevChoice({ trava: '#32', instructions: DONO,
    state: conversa({ message, previousAssistantText,
      fato: 'Jornada de descoberta ativa: o relato do dia vai para as notas da jornada; a memória permanente só com pedido explícito do dono.' }),
    criteria: { memoria_permanente: 'o dono pede para guardar/alterar/apagar algo na memória permanente', notas_jornada: 'relato do dia a dia para a jornada', nenhuma: 'nenhuma escrita (pergunta, leitura)' } });
}

// #43 resposta do assistente promete trabalho de programação sem ter chamado a tool.
export function jevCodingPromise(text) {
  return jevChoice({ trava: '#43', instructions: ASSISTENTE,
    state: `Contexto: Texto é a resposta do ASSISTENTE num turno em que ele NÃO chamou ferramenta de programação.\nResposta do assistente:\n${text}`,
    criteria: { promessa: 'afirma que está/vai construir ou alterar agora (trabalho em andamento)', nao_promessa: 'oferece, pede info, condiciona ou fala de trabalho passado' } });
}

// #48 resposta do assistente diz que verificou algo agora sem ter chamado nenhuma tool.
export function jevFreshCheckClaim(text) {
  return jevChoice({ trava: '#48', instructions: ASSISTENTE,
    state: `Contexto: Texto é a resposta do ASSISTENTE num turno em que ele NÃO chamou nenhuma ferramenta.\nResposta do assistente:\n${text}`,
    criteria: { alegacao_falsa: 'afirma ter verificado/consultado algo agora', ok: 'não afirma verificação feita agora' } });
}
