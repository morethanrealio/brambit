import { createRespondDecisionTool } from './inbound-decision.mjs';
import { HEALTH_GUARDRAIL } from './health-guardrail.mjs';
// ── Agente ↔ Agente: negociação delimitada entre assistentes de dois donos ──
//
// NÃO é chat aberto. É uma tarefa/negociação com objetivo, teto de rodadas e fim.
// O assistente do dono A chama a tool `falar_com_agente(contato, objetivo)`; a
// tool resolve o contato (conexão ACEITA), abre uma conversa e roda uma
// negociação sequencial e curta entre um lado SOLICITANTE (A) e um lado
// RESPONDENTE (B), cada um num turno ISOLADO (padrão sub-agente: history vazio,
// system enxuto, contexto próprio). No fim devolve ao dono A o resultado.
//
// Guardrails anti-loop (o núcleo):
//  1. Papéis assimétricos (A pede, B responde) — sem peer-chat de ida e volta.
//  2. Teto rígido de rodadas (MAX_ROUNDS). Bateu sem fechar → encerra e reporta.
//  3. Intents ESTRUTURADOS (ask|answer|propose|accept|decline|close) numa máquina
//     de estado simples que detecta "acabou" e corta.
//  4. Dedup: se um lado repete quase a mesma mensagem, encerra.
//  5. Orçamento de crédito por conversa (teto de tokens). Estourou → auto-close.
//  6. Sem iniciativa: a conversa só nasce quando o dono de A pede.
//  7. Humano no loop pra consequência: B NUNCA compromete o dono (marcar, aceitar
//     de verdade) sozinho — em v1 B não tem tools de ação; propõe e o dono decide.
//
// Cada lado é cobrado no dono dele (billA/billB), via o mesmo pipeline de crédito.

import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import {
  resolveContactTarget, getAgentOwned, getUserById, getWikiPage,
  createAgentConvo, addConvoMsg, updateAgentConvo, respondToInboundDecision, listInboundDecisions,
  answerExternalQuestion, listContacts, resolveContactRequest, inviteContact, getUserLocale,
} from './db.mjs';
import { comIdioma, tagIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

const MAX_ROUNDS = Number(process.env.A2A_MAX_ROUNDS || 3);      // rodadas (1 rodada = A fala, B fala)
const BUDGET_TOKENS = Number(process.env.A2A_BUDGET_TOKENS || 40000); // teto de tokens por conversa
const INTENTS = ['ask', 'answer', 'propose', 'accept', 'decline', 'close', 'question'];

// Normaliza texto pra comparar dedup (minúsculo, sem espaço/pontuação repetida).
function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+/g, '').trim();
}

// Corta um texto num limite de chars (pra não estourar o contexto/orçamento).
function clip(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Monta o "o que este assistente sabe" a partir do próprio agente (instruções que
// o dono deu) + um texto de perfil JÁ RESOLVIDO pelo caller. O caller decide o
// que entra em `profileText`: pro lado A (que fala do próprio dono) é o perfil
// completo do dono A; pro lado B (respondente) é APENAS a allow-list pública que
// o dono B curou — NUNCA o perfil privado, senão vaza dado pessoal de B pro dono
// A (o transcript volta verbatim). Enforcement em código, não em prompt.
function knowledgeBlock({ ownerName, agent, profileText }) {
  const parts = [];
  if (agent?.goal) parts.push(`Função: ${clip(agent.goal, 300)}`);
  if (agent?.instructions) parts.push(`Instruções e conhecimento que ${ownerName} te deu:\n${clip(agent.instructions, 1400)}`);
  if (profileText) parts.push(`O que você sabe sobre ${ownerName}:\n${clip(profileText, 1400)}`);
  return parts.join('\n\n');
}

// Extrai { intent, mensagem } da saída do modelo. Pede JSON, mas é tolerante:
// se não vier JSON válido, infere o intent por palavras-chave e usa o texto todo.
function parseTurn(raw, side) {
  const text = String(raw || '').trim();
  // tenta achar um bloco JSON
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const intent = INTENTS.includes(o.intent) ? o.intent : null;
      const mensagem = String(o.mensagem || o.message || '').trim();
      if (intent && mensagem) return { intent, mensagem };
      if (mensagem) return { intent: inferIntent(mensagem, side), mensagem };
    } catch { /* cai no fallback abaixo */ }
  }
  return { intent: inferIntent(text, side), mensagem: text };
}

function inferIntent(msg, side) {
  const t = norm(msg);
  if (/\b(aceito|combinado|fechado|pode marcar|confirmo)\b/.test(t)) return 'accept';
  if (/\b(recuso|não posso|nao posso|não dá|nao da|infelizmente não|inviável)\b/.test(t)) return 'decline';
  if (/\b(encerr|obrigad|era isso|resolvido|valeu)\b/.test(t)) return 'close';
  if (/\b(que tal|proponho|sugiro|poderia ser|opção)\b/.test(t)) return 'propose';
  return side === 'a' ? 'ask' : 'answer';
}

// System do lado B (respondente). B representa o dono B e responde SÓ sobre o
// pedido; nunca despeja o perfil e nunca compromete o dono sozinho.
export function systemB({ ownerBName, agentB, ownerAName, ownerBPublicText, language }) {
  // profileText do lado B = SÓ a allow-list pública que o dono B curou. O perfil
  // PRIVADO de B nunca entra aqui (vazava dado pessoal de B pro dono A via transcript).
  const know = knowledgeBlock({ ownerName: ownerBName, agent: agentB, profileText: ownerBPublicText });
  return `Você é ${agentB.name}, o assistente pessoal de ${ownerBName}. O assistente de ${ownerAName} entrou em contato com um pedido pontual.
${know ? `\nO QUE VOCÊ PODE COMPARTILHAR (só o que está aqui é compartilhável — se o pedido precisa de algo que NÃO está aqui, use "question" pra levar a ${ownerBName}):\n${know}\n` : ''}
Seu papel (RESPONDENTE):
• Responda APENAS sobre o objetivo do pedido, USANDO o que você sabe acima. Se a informação pedida (disponibilidade, uma preferência, um dado) está no que você sabe, RESPONDA de fato — não diga que "não tem acesso" a algo que está aí.
• NÃO revele informações pessoais, agenda detalhada, contatos ou perfil de ${ownerBName} além do estritamente necessário pra atender o pedido.
• Seja direto e curto. Uma resposta ou UMA pergunta de esclarecimento, não bate-papo.
• Você NÃO pode comprometer ${ownerBName} (marcar reunião, aceitar proposta, assumir compromisso) por conta própria. Se o pedido levar a isso, deixe claro que vai precisar confirmar com ${ownerBName} antes — proponha, não confirme.
• NUNCA invente um papel/persona pra você ("sou só um assistente de agenda", "não sou programador", "não lido com isso") pra recusar ou desviar. Você não sabe os limites do que ${ownerBName} quer atender; não os presuma. Não decida sozinho recusar algo que é decisão de ${ownerBName}.
• Se o outro assistente está trazendo um RECADO, um PEDIDO, uma TAREFA ou uma DECISÃO endereçada a ${ownerBName} (algo que quem resolve é ${ownerBName}, não você) — ou qualquer coisa fora do que você mesmo consegue responder com o que sabe — NÃO responda por conta própria: use "question" pra LEVAR isso a ${ownerBName}. Em "mensagem" repasse o recado/pedido fielmente, sem editorializar. Eu entrego pro próprio ${ownerBName} e trago a resposta depois.
• Idem se a informação pedida NÃO está no que você sabe MAS é o tipo de coisa que ${ownerBName} saberia (uma preferência, um dado pessoal, uma decisão que só ele tem): use "question". NÃO invente e NÃO diga só "não sei".
• Só responda direto (answer) quando a resposta está de fato no que você sabe acima. Só use decline quando é objetivamente impossível atender (não porque você "acha que não é seu papel"). Se estiver em dúvida entre responder e escalar, ESCALE com "question".

${HEALTH_GUARDRAIL}

Responda SEMPRE em JSON, uma linha:
{"intent":"<answer|propose|question|decline|close>","mensagem":"<sua resposta ou a pergunta curta em ${tagIdioma(language)}>"}
- answer: você respondeu o que foi perguntado (a resposta estava no que você sabe).
- propose: você sugere uma alternativa/opção (sem comprometer o dono).
- question: é pra ${ownerBName} (recado/pedido/tarefa/decisão pra ele, ou algo que só ele saberia). Em "mensagem" repasse fielmente pra levar pra ele. Este é o caminho padrão quando não é claramente seu papel responder.
- decline: objetivamente impossível atender (NÃO use pra "não é meu papel"; nesse caso use question).
- close: assunto resolvido, pode encerrar.
Nunca use "accept" (só o dono aceita de verdade).`;
}

// System do lado A (solicitante). A já tem o objetivo do dono; conduz a conversa
// pra fechar em poucas rodadas.
export function systemA({ ownerAName, agentA, ownerBName, objetivo, ownerAProfileText, language }) {
  const know = knowledgeBlock({ ownerName: ownerAName, agent: agentA, profileText: ownerAProfileText });
  return `Você é ${agentA.name}, o assistente pessoal de ${ownerAName}. Você está falando com o assistente de ${ownerBName} pra resolver um pedido do seu dono.

Objetivo do seu dono: ${objetivo}
${know ? `\nO QUE VOCÊ SABE SOBRE ${ownerAName} (use pra propor horários/opções que caibam na realidade dele — não despeje):\n${know}\n` : ''}
Seu papel (SOLICITANTE):
• Conduza a conversa pra FECHAR o objetivo no menor número de mensagens. Sem enrolação, sem "oi tudo bem".
• A cada rodada, avalie a última resposta do outro assistente e ou (a) faça a próxima pergunta objetiva, ou (b) encerre se já tem o que precisava, ou (c) proponha algo concreto.
• Você NÃO pode aceitar/confirmar compromissos em nome de ${ownerAName} sozinho — se chegou numa proposta boa, ENCERRE com "close" registrando a proposta pro seu dono decidir depois.
• Se o outro lado recusou ou não tem a info, encerre educadamente.

${HEALTH_GUARDRAIL}

Responda SEMPRE em JSON, uma linha:
{"intent":"<ask|propose|close>","mensagem":"<sua fala curta em ${tagIdioma(language)}>"}
- ask: próxima pergunta objetiva.
- propose: proposta concreta.
- close: já resolveu (ou não tem como) — registre o desfecho na mensagem.`;
}

// Roda um lado isolado (sem tools em v1) e devolve { intent, mensagem, usages }.
async function runSide({ provider, system, userInput }) {
  const reg = new ToolRegistry(); // v1: sem tools de ação (evita consequência sem dono)
  const { text, usages } = await runAgent({
    provider, tools: reg, system, userInput, history: [], maxSteps: 2,
  });
  return { ...parseTurn(text, system.includes('SOLICITANTE') ? 'a' : 'b'), usages: usages || [] };
}

function tokensOf(usages) {
  return (usages || []).reduce((n, u) => n + (u?.total || 0), 0);
}

// Constrói a tool `listar_contatos` pra o assistente saber, de FATO, quais
// pessoas estão conectadas (conexões aceitas), quem ainda está pendente, e com
// quais dá pra falar (o outro lado designou um assistente de entrada). Sem essa
// tool o assistente não tinha como consultar a lista e acabava inventando.
export function listContactsTool({ fromUser }) {
  return {
    name: 'listar_contatos',
    description: 'Lista os contatos conectados do dono (outras pessoas cujos assistentes ele pode acionar) e os convites ainda pendentes. Use SEMPRE que o dono perguntar se está conectado a alguém, quem são seus contatos, ou se tem acesso ao assistente de fulano ANTES de responder. Nunca deduza contatos da memória: consulte aqui.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      let contacts;
      try { contacts = await listContacts(fromUser); }
      catch (e) { return `Não consegui consultar seus contatos agora (${e?.message || e}).`; }
      if (!contacts || !contacts.length) return 'Você ainda não tem nenhum contato conectado nem convite pendente.';
      const accepted = contacts.filter((c) => c.status === 'accepted');
      const pending = contacts.filter((c) => c.status === 'pending');
      const lines = [];
      if (accepted.length) {
        lines.push('CONECTADOS (conexão aceita):');
        for (const c of accepted) {
          const nome = c.personName || c.personEmail || 'contato';
          const podeFalar = c.theirInboundAgent
            ? 'dá pra falar com o assistente dele(a)'
            : 'ainda NÃO dá pra falar (essa pessoa não designou um assistente de entrada)';
          lines.push(`• ${nome}${c.personEmail ? ` (${c.personEmail})` : ''} — ${podeFalar}.`);
        }
      } else {
        lines.push('Nenhum contato conectado ainda.');
      }
      if (pending.length) {
        lines.push('', 'CONVITES PENDENTES (ainda não aceitos dos dois lados):');
        for (const c of pending) {
          const nome = c.personName || c.personEmail || 'contato';
          lines.push(`• ${nome}${c.personEmail ? ` (${c.personEmail})` : ''} — ${c.invitedByMe ? 'você convidou, aguardando aceite.' : 'te convidou, aguardando seu aceite.'}`);
        }
      }
      return lines.join('\n');
    },
  };
}

// Constrói a tool `falar_com_agente` pra o assistente do dono A.
//  fromUser/fromAgent: dono A e o assistente dele que está chamando.
//  makeProvider: () => provider (injetado pelo server, ex makePrimaryProvider).
//  bill: (userId, agentId, usages) => void — cobra cada lado no dono certo
//        (A no dono A, B no dono B), via o mesmo pipeline de crédito.
export function agentToAgentTool({ fromUser, fromAgent, makeProvider, bill, notifyOwner, originChannel }) {
  return {
    name: 'falar_com_agente',
    description: 'Fala com o assistente de OUTRA pessoa (um contato seu já conectado) pra resolver um pedido pontual: checar disponibilidade de agenda, trocar uma informação, alinhar um detalhe. Use SOMENTE quando o dono pediu explicitamente pra falar com alguém. Informe a pessoa (nome ou e-mail do contato) e o objetivo claro e fechado. A conversa é curta e delimitada; devolve o desfecho pro dono. Não serve pra conversa aberta nem pra comprometer o dono (marcar/aceitar) sem ok dele.',
    parameters: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Nome ou e-mail da pessoa (contato já conectado) cujo assistente você quer contatar.' },
        objetivo: { type: 'string', description: 'O objetivo pontual e fechado do pedido, no idioma do seu dono. Ex: "descobrir 3 horários livres da Ana pra um café na próxima semana".' },
        responder_em: { type: 'string', enum: ['telegram', 'whatsapp', 'email'], description: 'OPCIONAL. Canal onde o dono quer RECEBER a resposta quando ela voltar depois (se o contato precisar consultar o próprio dono). Por padrão volta pelo mesmo canal deste pedido. Só preencha se o dono pediu explicitamente outro canal.' },
      },
      required: ['contato', 'objetivo'],
    },
    run: async ({ contato, objetivo, responder_em }) => {
      const obj = String(objetivo || '').trim();
      // Canal de retorno: override do dono, senão o canal de origem do turno.
      const replyChannel = ['telegram', 'whatsapp', 'email'].includes(responder_em) ? responder_em : originChannel;
      if (!obj) return 'ERRO: preciso de um objetivo claro pra falar com o assistente do contato.';
      // 1) Resolve o contato → alvo (conexão aceita + inbound agent do outro lado).
      const target = await resolveContactTarget(fromUser, contato);
      if (target.error === 'contato_nao_encontrado')
        return `Não achei "${contato}" na sua lista de contatos conectados. Você precisa ter uma conexão ACEITA com essa pessoa antes (peça pro dono conectar em Contatos).`;
      if (target.error === 'contato_ambiguo')
        return `"${contato}" casa com mais de um contato seu: ${(target.opcoes || []).map((o) => `${o.nome} (${o.email})`).join(', ')}. Pergunte ao seu dono com qual deles ele quer falar e me diga o e-mail.`;
      if (target.error === 'sem_inbound')
        return `A conexão com ${target.person || contato} existe, mas essa pessoa ainda não designou um assistente pra receber pedidos. Não dá pra falar com o assistente dela ainda.`;
      if (target.error) return `Não consegui falar com o assistente de "${contato}" (${target.error}).`;

      const { toUser, toAgent, personName } = target;
      // 2) Carrega os dois assistentes e os donos.
      const agentA = await getAgentOwned(fromAgent, fromUser);
      const agentB = await getAgentOwned(toAgent, toUser);
      if (!agentB) return `O assistente de ${personName} não está mais disponível.`;
      const ownerA = await getUserById(fromUser);
      const ownerB = await getUserById(toUser);
      const ownerAName = (ownerA?.name || 'o dono').split(' ')[0];
      const ownerBName = (ownerB?.name || personName || 'o contato').split(' ')[0];

      // Perfil do lado A: é o PRÓPRIO dono A falando via seu assistente, então o
      // perfil privado dele pode entrar (não é cross-owner leak — o dado é dele).
      const ownerAProfileText = (await getWikiPage(fromUser, 'perfil').catch(() => null))?.body
        || (agentA && agentA.profile) || '';
      // Perfil do lado B (respondente): NÃO injetamos o perfil PRIVADO de B. Isso
      // vazava dado pessoal do dono B pro dono A (o transcript volta verbatim, e um
      // objetivo malicioso extraía o perfil inteiro). Allow-list: só uma página
      // 'perfil_publico' que o dono B curou explicitamente como compartilhável entre
      // assistentes. Sem ela, B não tem perfil e escala pro próprio dono via "question".
      const ownerBPublicText = (await getWikiPage(toUser, 'perfil_publico').catch(() => null))?.body || '';

      // 3) Abre a conversa.
      const convo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: obj });
      const providerA = makeProvider({userId:fromUser,agentId:fromAgent,threadId:null,kind:'agent2agent'});
      const providerB = makeProvider({userId:toUser,agentId:toAgent,threadId:null,kind:'agent2agent'});
      // Cada lado fala no idioma do PRÓPRIO dono: o desfecho de A volta pro dono A
      // e a "question" de B é entregue ao dono B.
      const langA = (await getUserLocale(fromUser).catch(() => null))?.language;
      const langB = (await getUserLocale(toUser).catch(() => null))?.language;
      const sysA = comIdioma(systemA({ ownerAName, agentA: agentA || { name: 'Assistente' }, ownerBName, objetivo: obj, ownerAProfileText, language: langA }), langA);
      const sysB = comIdioma(systemB({ ownerBName, agentB, ownerAName, ownerBPublicText, language: langB }), langB);

      // Primeira fala de A = o próprio objetivo (ask). Registra.
      let lastA = { intent: 'ask', mensagem: obj };
      await addConvoMsg({ convoId: convo.id, senderAgent: fromAgent, side: 'a', intent: 'ask', payload: obj });

      const transcript = []; // pra montar o relatório final pro dono
      let status = 'open';
      let resultado = '';
      let spent = 0;
      let prevBMsg = '';
      let prevAMsg = norm(obj);
      let rounds = 0;

      for (let r = 0; r < MAX_ROUNDS; r++) {
        rounds = r + 1;
        // ── B responde ──
        const bCtx = transcript.map((t) => `${t.who}: ${t.msg}`).join('\n');
        const bInput = `Pedido do assistente de ${ownerAName}: ${lastA.mensagem}` +
          (bCtx ? `\n\nContexto até aqui:\n${bCtx}` : '');
        const b = await runSide({ provider:providerB, system: sysB, userInput: bInput });
        await bill?.(toUser, toAgent, b.usages);
        spent += tokensOf(b.usages);
        await addConvoMsg({ convoId: convo.id, senderAgent: toAgent, side: 'b', intent: b.intent, payload: b.mensagem });
        transcript.push({ who: `assistente de ${ownerBName}`, msg: b.mensagem });

        // dedup de B
        if (norm(b.mensagem) && norm(b.mensagem) === prevBMsg) {
          resultado = `Encerrei: o assistente de ${ownerBName} ficou repetindo a mesma resposta. Última: "${b.mensagem}"`;
          status = 'resolved'; break;
        }
        prevBMsg = norm(b.mensagem);

        // ESCALA PRO DONO B (ask-human loop): B não sabe, mas o dono B saberia.
        // Abre uma conversa separada (status awaiting_owner_b) com a pergunta
        // guardada como fala do lado A; o dono B vê na caixa e responde depois,
        // e a resposta volta pro dono A pela caixa dele.
        if (b.intent === 'question') {
          // A qConvo guarda o canal de ORIGEM do pedido de A: é por ele que a
          // resposta do dono B vai voltar pro dono A (answerExternalQuestion).
          const qConvo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: obj, originChannel: replyChannel });
          await addConvoMsg({ convoId: qConvo.id, senderAgent: fromAgent, side: 'a', intent: 'question', payload: b.mensagem });
          await updateAgentConvo(qConvo.id, { status: 'awaiting_owner_b' });
          // notifyOwner: pinga o dono B na hora (direção A→B, sem canal de origem
          // do lado dele → cai na resolução padrão de push).
          try { await notifyOwner?.(toUser, `O assistente de ${ownerAName} perguntou: ${b.mensagem}`); } catch {}
          resultado = `O assistente de ${ownerBName} não tinha essa informação, então levei a pergunta pro próprio ${ownerBName}: "${b.mensagem}". Assim que ${ownerBName} responder, a resposta chega pra você na sua caixa.`;
          status = 'escalated'; break;
        }

        // terminais vindos de B
        if (b.intent === 'decline') {
          resultado = `O assistente de ${ownerBName} não pôde atender: "${b.mensagem}"`;
          status = 'declined'; break;
        }
        if (b.intent === 'close') {
          resultado = b.mensagem;
          status = 'resolved'; break;
        }
        // orçamento
        if (spent > BUDGET_TOKENS) {
          resultado = `Encerrei por limite da conversa. Última resposta de ${ownerBName}: "${b.mensagem}"`;
          status = 'resolved'; break;
        }

        // ── A avalia e conduz ──
        const aCtx = transcript.map((t) => `${t.who}: ${t.msg}`).join('\n');
        const aInput = `Conversa até aqui:\n${aCtx}\n\nAvalie a última resposta e conduza pra fechar o objetivo. Se já tem o que precisava (ou não tem como), encerre com "close".`;
        const a = await runSide({ provider:providerA, system: sysA, userInput: aInput });
        await bill?.(fromUser, fromAgent, a.usages);
        spent += tokensOf(a.usages);
        await addConvoMsg({ convoId: convo.id, senderAgent: fromAgent, side: 'a', intent: a.intent, payload: a.mensagem });
        transcript.push({ who: `assistente de ${ownerAName} (você)`, msg: a.mensagem });
        lastA = a;

        // dedup de A
        if (norm(a.mensagem) && norm(a.mensagem) === prevAMsg) {
          resultado = `Encerrei: eu estava repetindo o mesmo ponto sem avançar. Desfecho parcial: "${a.mensagem}"`;
          status = 'resolved'; break;
        }
        prevAMsg = norm(a.mensagem);

        if (a.intent === 'close') {
          resultado = a.mensagem;
          status = 'resolved'; break;
        }
        if (spent > BUDGET_TOKENS) {
          resultado = `Encerrei por limite da conversa. Meu último ponto: "${a.mensagem}"`;
          status = 'resolved'; break;
        }
      }

      if (status === 'open') {
        // bateu o teto de rodadas sem fechar
        status = 'resolved';
        const last = transcript[transcript.length - 1];
        resultado = `Não fechamos em ${MAX_ROUNDS} rodadas. Onde parou: "${last?.msg || '(sem resposta)'}"`;
      }

      await updateAgentConvo(convo.id, { status, rounds, resultado });

      // Relatório pro dono A (a tool devolve isso pro assistente principal).
      const linhas = transcript.map((t) => `• ${t.who}: ${t.msg}`).join('\n');
      return `Conversa com o assistente de ${personName} sobre: "${obj}"\n\n${linhas}\n\nDesfecho: ${resultado}\n\n(Lembre: nada foi confirmado em nome de ninguém. Se o dono quiser fechar/aceitar algo, use a tool confirmar_com_agente — ela pede o ok explícito dele antes de valer.)`;
    },
  };
}

// Constrói a tool `confirmar_com_agente` — a AÇÃO COM CONSEQUÊNCIA (Parte 3).
// Depois de uma conversa (falar_com_agente) que chegou numa proposta, é aqui que
// o dono A FECHA/aceita algo com o assistente do contato. É uma ação REAL, então
// entra na trava de confirmação (confirm.mjs / GATED_TOOLS): o assistente chama,
// nada acontece, o dono precisa dar o "ok" explícito, e SÓ então a decisão é
// registrada e entregue ao lado B. O lado B nunca é comprometido automaticamente:
// o assistente de B leva a decisão pro dono B confirmar do lado dele.
export function confirmAgentDecisionTool({ fromUser, fromAgent, originChannel, notifyOwner }) {
  return {
    name: 'confirmar_com_agente',
    description: 'Formaliza pro assistente de um contato uma DECISÃO/aceite do seu dono depois de uma conversa entre assistentes (falar_com_agente). Use SOMENTE quando já houve uma proposta concreta e o dono quer aceitar/fechar (ex: aceitar um horário proposto, confirmar um combinado). Esta é uma ação real com consequência: ela PEDE a confirmação explícita do dono antes de valer, e nada é imposto ao contato sem o ok do dono dele.',
    parameters: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Nome ou e-mail da pessoa (contato já conectado) cujo assistente recebe a decisão.' },
        decisao: { type: 'string', description: 'A decisão/aceite fechado do seu dono, no idioma dele. Ex: "aceito o café na terça às 15h no Café X".' },
        responder_em: { type: 'string', enum: ['telegram', 'whatsapp', 'email'], description: 'OPCIONAL. Canal onde o dono quer RECEBER a resposta do contato quando ela voltar. Por padrão volta pelo mesmo canal deste pedido. Só preencha se o dono pediu outro canal.' },
      },
      required: ['contato', 'decisao'],
    },
    run: async ({ contato, decisao, responder_em }) => {
      const dec = String(decisao || '').trim();
      const replyChannel = ['telegram', 'whatsapp', 'email'].includes(responder_em) ? responder_em : originChannel;
      if (!dec) return JSON.stringify({ ok: false, error: 'Preciso da decisão fechada do dono pra confirmar com o assistente do contato.' });
      const target = await resolveContactTarget(fromUser, contato);
      if (target.error === 'contato_nao_encontrado')
        return JSON.stringify({ ok: false, error: `Não achei "${contato}" na sua lista de contatos conectados.` });
      if (target.error === 'contato_ambiguo')
        return JSON.stringify({ ok: false, error: `"${contato}" casa com mais de um contato seu: ${(target.opcoes || []).map((o) => `${o.nome} (${o.email})`).join(', ')}. Confirme com o seu dono qual é e me diga o e-mail.` });
      if (target.error === 'sem_inbound')
        return JSON.stringify({ ok: false, error: `${target.person || contato} ainda não designou um assistente pra receber pedidos.` });
      if (target.error)
        return JSON.stringify({ ok: false, error: `Não consegui confirmar com o assistente de "${contato}" (${target.error}).` });

      const { toUser, toAgent, personName } = target;
      // Registra a decisão como uma convo terminal (accept do lado A) e entrega
      // ao lado B. O assistente de B vai levar isso pro dono B confirmar. O canal
      // de retorno fica gravado na convo (por ele volta a resposta de B pro A).
      const convo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: `Confirmação: ${dec}`, originChannel: replyChannel });
      await addConvoMsg({ convoId: convo.id, senderAgent: fromAgent, side: 'a', intent: 'accept', payload: dec });
      await updateAgentConvo(convo.id, { status: 'accepted', rounds: 1, resultado: dec });
      // Pinga o dono B na hora: chegou uma decisão pra ele confirmar (direção A→B,
      // resolução padrão de push).
      const ownerA = await getUserById(fromUser).catch(() => null);
      const ownerAName = (ownerA?.name || 'um contato').split(' ')[0];
      try { await notifyOwner?.(toUser, `${ownerAName} confirmou: ${dec}. Abra o ${marca().nome} pra aceitar ou recusar.`); } catch {}
      return JSON.stringify({
        ok: true,
        person: personName,
        note: `Decisão registrada e enviada ao assistente de ${personName}. Ele vai confirmar com ${personName} do lado dele; nada é imposto sem o ok de ${personName}.`,
      });
    },
  };
}

// ── Lado B: responder uma decisão que chegou de outro dono ──
//
// Fecha o ciclo. Quando o dono A confirma algo (confirmar_com_agente), a decisão
// fica pendente na caixa do dono B (surfaçada no prompt via agentInbox). O dono B
// então manda o assistente dele aceitar ou recusar. Esta tool é GATED: só executa
// depois do "ok" explícito do dono B (confirm.mjs). A resposta volta pro dono A
// pela caixa de respostas dele. Nada é imposto: é o dono B quem decide.
export function respondDecisionTool({ fromUser, notifyOwner }) {
  return createRespondDecisionTool({fromUser,list:listInboundDecisions,respond:respondToInboundDecision,owner:getUserById,notifyOwner});
}

// ── Lado B (dono): responder uma PERGUNTA que o assistente de um contato levantou ──
//
// Ask-human loop (Fase 2). Quando o assistente de A perguntou algo que o assistente
// de B não sabia mas que o dono B saberia, a pergunta fica pendente na caixa do
// dono B (surfaçada no prompt via agentInbox). O dono B responde aqui; a resposta
// volta pro assistente de A pela caixa de respostas dele. NÃO é gated: o próprio
// dono digitando a resposta já é a autorização, e a tool só repassa informação
// (não fecha compromisso).
export function respondExternalQuestionTool({ fromUser, fromAgent, notifyOwner }) {
  return {
    name: 'responder_pergunta_externa',
    description: 'Responde uma PERGUNTA que o assistente de um contato levantou pro seu dono e que está aguardando resposta (algo que só o seu dono saberia). Use quando o seu dono te der a resposta pra essa pergunta pendente. A resposta volta pro assistente do contato. Só repassa informação, não fecha compromisso.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identificador da pergunta, exatamente como aparece na caixa entre assistentes (ex.: [id: 3f2a…]). Use SEMPRE que houver mais de uma pergunta pendente: é o que garante que a resposta vai pra pergunta certa.' },
        para: { type: 'string', description: 'Nome ou e-mail do contato cujo assistente perguntou (opcional se só houver uma pergunta pendente).' },
        resposta: { type: 'string', description: 'A resposta do seu dono pra pergunta, no idioma dele.' },
      },
      required: ['resposta'],
    },
    run: async ({ id, para, resposta }) => {
      const r = await answerExternalQuestion(fromUser, {
        id: id ? String(id).trim() : undefined,
        para: para ? String(para).trim() : undefined,
        resposta: resposta ? String(resposta).trim() : undefined,
      });
      if (r.error === 'nenhuma_pendente')
        return JSON.stringify({ ok: false, error: 'Você não tem nenhuma pergunta de contato aguardando resposta agora.' });
      if (r.error === 'ambigua')
        return JSON.stringify({ ok: false, error: 'Há mais de uma pergunta pendente. Diga de qual contato você está respondendo (nome ou e-mail).' });
      if (r.error === 'nao_encontrada')
        return JSON.stringify({ ok: false, error: `Não achei nenhuma pergunta pendente de "${para}".` });
      if (r.error === 'resposta_vazia')
        return JSON.stringify({ ok: false, error: 'Preciso da resposta pra repassar ao contato.' });
      if (r.error)
        return JSON.stringify({ ok: false, error: `Não consegui responder a pergunta (${r.error}).` });
      // Pinga o dono A de volta, no canal de ORIGEM do pedido dele (direção B→A).
      // Uma linha com a resposta que o assistente de A recebeu.
      const ownerB = await getUserById(fromUser).catch(() => null);
      const ownerBName = (ownerB?.name || r.from_name || 'seu contato').split(' ')[0];
      const linha = `${ownerBName} respondeu${r.pergunta ? ` "${r.pergunta}"` : ''}: ${r.resposta}`;
      try { await notifyOwner?.(r.to_user, linha, { channel: r.origin_channel }); } catch {}
      return JSON.stringify({
        ok: true,
        person: r.from_name,
        note: `Resposta enviada ao assistente de ${r.from_name || 'seu contato'}.`,
      });
    },
  };
}

// Aceitar/recusar um PEDIDO DE AMIZADE (conexão de contatos) pendente, por
// conversa com o próprio dono. Não é gated: o dono dizer "aceita fulano" já É a
// autorização. É o único caminho de aceite (não há link/token no e-mail).
export function acceptContactTool({ fromUser }) {
  return {
    name: 'aceitar_contato',
    description: `Aceita um PEDIDO DE AMIZADE (conexão de contatos) que outra pessoa te mandou no ${marca().nome} e que está pendente. Use quando o seu dono disser pra aceitar o convite de alguém. Depois de aceito, os assistentes de vocês podem conversar entre si.`,
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Nome ou e-mail de quem te convidou (opcional se só houver um pedido pendente).' },
      },
      required: [],
    },
    run: async ({ de }) => {
      const r = await resolveContactRequest(fromUser, { de: de ? String(de).trim() : undefined, aceitar: true });
      if (r.error === 'nenhum_pendente')
        return JSON.stringify({ ok: false, error: 'Você não tem nenhum pedido de amizade pendente agora.' });
      if (r.error === 'ambiguo')
        return JSON.stringify({ ok: false, error: 'Há mais de um pedido pendente. Diga de quem você quer aceitar (nome ou e-mail).' });
      if (r.error === 'nao_encontrado')
        return JSON.stringify({ ok: false, error: `Não achei nenhum pedido pendente de "${de}".` });
      if (r.error)
        return JSON.stringify({ ok: false, error: `Não consegui aceitar o pedido (${r.error}).` });
      return JSON.stringify({ ok: true, person: r.from_name, note: `Pronto, você e ${r.from_name || 'seu contato'} agora estão conectados. Os assistentes de vocês já podem conversar.` });
    },
  };
}

export function declineContactTool({ fromUser }) {
  return {
    name: 'recusar_contato',
    description: 'Recusa um PEDIDO DE AMIZADE (conexão de contatos) pendente que outra pessoa te mandou. Use quando o seu dono disser pra recusar/ignorar o convite de alguém.',
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Nome ou e-mail de quem te convidou (opcional se só houver um pedido pendente).' },
      },
      required: [],
    },
    run: async ({ de }) => {
      const r = await resolveContactRequest(fromUser, { de: de ? String(de).trim() : undefined, aceitar: false });
      if (r.error === 'nenhum_pendente')
        return JSON.stringify({ ok: false, error: 'Você não tem nenhum pedido de amizade pendente agora.' });
      if (r.error === 'ambiguo')
        return JSON.stringify({ ok: false, error: 'Há mais de um pedido pendente. Diga de quem você quer recusar (nome ou e-mail).' });
      if (r.error === 'nao_encontrado')
        return JSON.stringify({ ok: false, error: `Não achei nenhum pedido pendente de "${de}".` });
      if (r.error)
        return JSON.stringify({ ok: false, error: `Não consegui recusar o pedido (${r.error}).` });
      return JSON.stringify({ ok: true, person: r.from_name, note: `Ok, recusei o pedido de ${r.from_name || 'seu contato'}.` });
    },
  };
}

// Iniciar um PEDIDO DE AMIZADE (conexão de contatos): o dono pede pra conectar
// com alguém pelo e-mail de cadastro. Não é gated (só cria um convite pendente,
// nada acontece até o outro aceitar). `notify` (opcional) avisa o convidado por
// e-mail — mesma notificação da tela de Conexões; fica no server (onde o envio
// de e-mail está em escopo) e é passado como callback.
export function inviteContactTool({ fromUser, notify }) {
  return {
    name: 'convidar_contato',
    description: `Envia um PEDIDO DE CONEXÃO (amizade) pra outra pessoa que já tem conta no ${marca().nome}, pelo e-mail de cadastro dela. Use quando o seu dono disser que quer se conectar com alguém (ex: "conecta eu com fulano@email"). Cria um convite pendente; nada acontece até a outra pessoa aceitar (ela aceita falando com o assistente dela). Depois de aceito, os assistentes de vocês podem conversar entre si e compartilhar apps. A pessoa precisa JÁ ter conta no ${marca().nome}; se não tiver, avise o dono. Isso NÃO é convidar pra colaborar num app (isso é convidar_colaborador, e só depois de conectados).`,
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'E-mail de cadastro da pessoa que o dono quer conectar.' },
      },
      required: ['email'],
    },
    run: async ({ email }) => {
      let r;
      try { r = await inviteContact(fromUser, email); }
      catch (e) { return JSON.stringify({ ok: false, error: `Não consegui enviar o convite agora (${e?.message || e}).` }); }
      if (r?.error) {
        const msg = {
          email_vazio: 'Informe o e-mail da pessoa que o dono quer conectar.',
          usuario_nao_encontrado: `Não achei ninguém com esse e-mail no ${marca().nome}. A pessoa precisa já ter uma conta pra se conectar.`,
          voce_mesmo: 'Esse é o e-mail do próprio dono.',
          ja_existe: 'Vocês já têm uma conexão (aceita ou pendente).',
        }[r.error] || 'Não consegui enviar o convite.';
        return JSON.stringify({ ok: false, error: msg });
      }
      const toUserId = r.connection?.user_b;
      if (toUserId && typeof notify === 'function') {
        try { await notify(toUserId); } catch { /* notificação é best-effort */ }
      }
      return JSON.stringify({ ok: true, note: 'Convite de conexão enviado. A pessoa vai receber um aviso e, quando aceitar (falando com o assistente dela), vocês ficam conectados.' });
    },
  };
}
