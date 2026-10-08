import { createRespondDecisionTool } from './inbound-decision.mjs';
import { HEALTH_GUARDRAIL } from './health-guardrail.mjs';
// ── Agent ↔ Agent: bounded negotiation between two owners' assistants ──
//
// NOT open chat. It's a task/negotiation with a goal, a round cap, and an end.
// Owner A's assistant calls the tool `falar_com_agente(contato, objetivo)`; the
// tool resolves the contact (ACCEPTED connection), opens a conversation and runs
// a short sequential negotiation between a REQUESTER side (A) and a RESPONDER
// side (B), each in an ISOLATED turn (sub-agent pattern: empty history, lean
// system, own context). At the end it returns the result to owner A.
//
// Anti-loop guardrails (the core):
//  1. Asymmetric roles (A asks, B answers) — no back-and-forth peer chat.
//  2. Hard round cap (MAX_ROUNDS). Hit without closing → ends and reports.
//  3. STRUCTURED intents (ask|answer|propose|accept|decline|close) in a simple
//     state machine that detects "done" and cuts.
//  4. Dedup: if one side repeats almost the same message, it ends.
//  5. Credit budget per conversation (token cap). Exceeded → auto-close.
//  6. No initiative: the conversation only starts when A's owner asks.
//  7. Human in the loop for consequence: B NEVER commits its owner (booking,
//     actually accepting) on its own — in v1 B has no action tools; it
//     proposes and the owner decides.
//
// Each side is billed to its own owner (billA/billB), via the same credit pipeline.

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

// Normalizes text to compare for dedup (lowercase, no repeated space/punctuation).
function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+/g, '').trim();
}

// Cuts a text at a char limit (so it does not blow the context/budget).
function clip(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Builds "what this assistant knows" from the agent itself (instructions the
// owner gave) + a profile text ALREADY RESOLVED by the caller. The caller
// decides what goes into `profileText`: for side A (which speaks for its own
// owner) it's owner A's full profile; for side B (responder) it's ONLY the
// public allow-list that owner B curated — NEVER the private profile, or it
// leaks B's personal data to owner A (the transcript comes back verbatim).
// Enforcement in code, not in the prompt.
function knowledgeBlock({ ownerName, agent, profileText }) {
  const parts = [];
  if (agent?.goal) parts.push(`Role: ${clip(agent.goal, 300)}`);
  if (agent?.instructions) parts.push(`Instructions and knowledge ${ownerName} gave you:\n${clip(agent.instructions, 1400)}`);
  if (profileText) parts.push(`What you know about ${ownerName}:\n${clip(profileText, 1400)}`);
  return parts.join('\n\n');
}

// Extracts { intent, mensagem } from the model's output. Asks for JSON, but
// is tolerant: if valid JSON doesn't come back, it infers the intent by
// keywords and uses the whole text.
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

// System for side B (responder). B represents owner B and only answers about
// the request; never dumps the profile and never commits the owner on its own.
export function systemB({ ownerBName, agentB, ownerAName, ownerBPublicText, language }) {
  // profileText for side B = ONLY the public allow-list that owner B
  // curated. B's PRIVATE profile never enters here (it leaked B's personal
  // data to owner A via the transcript).
  const know = knowledgeBlock({ ownerName: ownerBName, agent: agentB, profileText: ownerBPublicText });
  return `You are ${agentB.name}, ${ownerBName}'s personal assistant. ${ownerAName}'s assistant reached out with a one-off request.
${know ? `\nWHAT YOU CAN SHARE (only what is here is shareable; if the request needs something that is NOT here, use "question" to take it to ${ownerBName}):\n${know}\n` : ''}
Your role (RESPONDER):
• Answer ONLY about the objective of the request, USING what you know above. If the requested information (availability, a preference, a piece of data) is in what you know, ACTUALLY ANSWER; do not say you "have no access" to something that is right there.
• Do NOT reveal personal information, detailed calendar, contacts or profile of ${ownerBName} beyond what is strictly necessary to fulfill the request.
• Be direct and short. One answer or ONE clarifying question, no small talk.
• You CANNOT commit ${ownerBName} (schedule a meeting, accept a proposal, take on a commitment) on your own. If the request leads there, make it clear you will need to check with ${ownerBName} first; propose, do not confirm.
• NEVER invent a role/persona for yourself ("I'm just a scheduling assistant", "I'm not a programmer", "I don't handle that") to decline or deflect. You do not know the limits of what ${ownerBName} wants to handle; do not presume them. Do not decide on your own to decline something that is ${ownerBName}'s decision.
• If the other assistant is bringing a MESSAGE, a REQUEST, a TASK or a DECISION addressed to ${ownerBName} (something that ${ownerBName} resolves, not you), or anything outside what you yourself can answer with what you know, do NOT answer on your own: use "question" to TAKE it to ${ownerBName}. In "mensagem", relay the message/request faithfully, without editorializing. I deliver it to ${ownerBName} personally and bring the answer back later.
• Same if the requested information is NOT in what you know BUT is the kind of thing ${ownerBName} would know (a preference, a personal detail, a decision only they have): use "question". Do NOT make it up and do NOT just say "I don't know".
• Only answer directly (answer) when the answer is actually in what you know above. Only use decline when it is objectively impossible to fulfill (not because you "think it is not your role"). If in doubt between answering and escalating, ESCALATE with "question".

${HEALTH_GUARDRAIL}

ALWAYS reply in JSON, one line:
{"intent":"<answer|propose|question|decline|close>","mensagem":"<your answer or the short question in ${tagIdioma(language)}>"}
- answer: you answered what was asked (the answer was in what you know).
- propose: you suggest an alternative/option (without committing the owner).
- question: it is for ${ownerBName} (a message/request/task/decision for them, or something only they would know). In "mensagem", relay it faithfully so it can be taken to them. This is the default path when it is not clearly your role to answer.
- decline: objectively impossible to fulfill (do NOT use it for "not my role"; in that case use question).
- close: matter resolved, the conversation can end.
Never use "accept" (only the owner truly accepts).`;
}

// System for side A (requester). A already has the owner's goal; drives the
// conversation to close in few rounds.
export function systemA({ ownerAName, agentA, ownerBName, objetivo, ownerAProfileText, language }) {
  const know = knowledgeBlock({ ownerName: ownerAName, agent: agentA, profileText: ownerAProfileText });
  return `You are ${agentA.name}, ${ownerAName}'s personal assistant. You are talking to ${ownerBName}'s assistant to resolve a request from your owner.

Your owner's objective: ${objetivo}
${know ? `\nWHAT YOU KNOW ABOUT ${ownerAName} (use it to propose times/options that fit their reality; do not dump it):\n${know}\n` : ''}
Your role (SOLICITANTE, the requester):
• Steer the conversation to CLOSE the objective in the fewest messages. No padding, no "hi, how are you".
• Each round, evaluate the other assistant's last reply and either (a) ask the next objective question, or (b) close if you already have what you needed, or (c) propose something concrete.
• You CANNOT accept/confirm commitments on behalf of ${ownerAName} on your own; if you reached a good proposal, CLOSE with "close", recording the proposal for your owner to decide later.
• If the other side declined or does not have the info, close politely.

${HEALTH_GUARDRAIL}

ALWAYS reply in JSON, one line:
{"intent":"<ask|propose|close>","mensagem":"<your short message in ${tagIdioma(language)}>"}
- ask: next objective question.
- propose: concrete proposal.
- close: already resolved (or no way to resolve it); record the outcome in the message.`;
}

// Roda um lado isolado (sem tools em v1) e devolve { intent, mensagem, usages }.
async function runSide({ provider, system, userInput }) {
  const reg = new ToolRegistry(); // v1: no action tools (avoids consequence without the owner)
  const { text, usages } = await runAgent({
    provider, tools: reg, system, userInput, history: [], maxSteps: 2,
  });
  return { ...parseTurn(text, system.includes('SOLICITANTE') ? 'a' : 'b'), usages: usages || [] };
}

function tokensOf(usages) {
  return (usages || []).reduce((n, u) => n + (u?.total || 0), 0);
}

// Builds the `listar_contatos` tool so the assistant ACTUALLY knows which
// people are connected (accepted connections), who is still pending, and who
// it can talk to (the other side designated an inbound assistant). Without
// this tool the assistant had no way to check the list and ended up making it up.
export function listContactsTool({ fromUser }) {
  return {
    name: 'listar_contatos',
    description: 'Lists the owner\'s connected contacts (other people whose assistants they can reach) and the invitations still pending. Use ALWAYS when the owner asks whether they are connected to someone, who their contacts are, or whether they have access to so-and-so\'s assistant, BEFORE answering. Never infer contacts from memory: check here.',
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

// Builds the `falar_com_agente` tool for owner A's assistant.
//  fromUser/fromAgent: owner A and their assistant that's calling.
//  makeProvider: () => provider (injected by the server, e.g. makePrimaryProvider).
//  bill: (userId, agentId, usages) => void — charges each side to the right owner
//        (A to owner A, B to owner B), via the same credit pipeline.
export function agentToAgentTool({ fromUser, fromAgent, makeProvider, bill, notifyOwner, originChannel }) {
  return {
    name: 'falar_com_agente',
    description: 'Talks to ANOTHER person\'s assistant (a contact of yours already connected) to handle a one-off request: check calendar availability, exchange a piece of information, align a detail. Use ONLY when the owner explicitly asked to talk to someone. Provide the person (contact name or e-mail) and a clear, closed objective. The conversation is short and bounded; it returns the outcome to the owner. Not for open-ended conversation nor for committing the owner (scheduling/accepting) without their ok.',
    parameters: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Name or e-mail of the person (already connected contact) whose assistant you want to contact.' },
        objetivo: { type: 'string', description: 'The specific, closed objective of the request, in your owner\'s language. E.g. "descobrir 3 horários livres da Ana pra um café na próxima semana".' },
        responder_em: { type: 'string', enum: ['telegram', 'whatsapp', 'email'], description: 'OPTIONAL. Channel where the owner wants to RECEIVE the reply when it comes back later (if the contact needs to check with their own owner). By default it comes back through the same channel as this request. Only fill in if the owner explicitly asked for another channel.' },
      },
      required: ['contato', 'objetivo'],
    },
    run: async ({ contato, objetivo, responder_em }) => {
      const obj = String(objetivo || '').trim();
      // Return channel: owner override, else the turn's origin channel.
      const replyChannel = ['telegram', 'whatsapp', 'email'].includes(responder_em) ? responder_em : originChannel;
      if (!obj) return 'ERRO: preciso de um objetivo claro pra falar com o assistente do contato.';
      // 1) Resolves the contact → target (accepted connection + the other side's inbound agent).
      const target = await resolveContactTarget(fromUser, contato);
      if (target.error === 'contato_nao_encontrado')
        return `Não achei "${contato}" na sua lista de contatos conectados. Você precisa ter uma conexão ACEITA com essa pessoa antes (peça pro dono conectar em Contatos).`;
      if (target.error === 'contato_ambiguo')
        return `"${contato}" casa com mais de um contato seu: ${(target.opcoes || []).map((o) => `${o.nome} (${o.email})`).join(', ')}. Pergunte ao seu dono com qual deles ele quer falar e me diga o e-mail.`;
      if (target.error === 'sem_inbound')
        return `A conexão com ${target.person || contato} existe, mas essa pessoa ainda não designou um assistente pra receber pedidos. Não dá pra falar com o assistente dela ainda.`;
      if (target.error) return `Não consegui falar com o assistente de "${contato}" (${target.error}).`;

      const { toUser, toAgent, personName } = target;
      // 2) Loads both assistants and owners.
      const agentA = await getAgentOwned(fromAgent, fromUser);
      const agentB = await getAgentOwned(toAgent, toUser);
      if (!agentB) return `O assistente de ${personName} não está mais disponível.`;
      const ownerA = await getUserById(fromUser);
      const ownerB = await getUserById(toUser);
      const ownerAName = (ownerA?.name || 'o dono').split(' ')[0];
      const ownerBName = (ownerB?.name || personName || 'o contato').split(' ')[0];

      // Side A's profile: it's owner A HIMSELF speaking via his assistant, so
      // his private profile can go in (it's not a cross-owner leak — the data is his).
      const ownerAProfileText = (await getWikiPage(fromUser, 'perfil').catch(() => null))?.body
        || (agentA && agentA.profile) || '';
      // Side B's profile (responder): we do NOT inject B's PRIVATE profile.
      // This leaked owner B's personal data to owner A (the transcript comes
      // back verbatim, and a malicious goal could extract the whole
      // profile). Allow-list: only a 'perfil_publico' page that owner B
      // explicitly curated as shareable between assistants. Without it, B
      // has no profile and escalates to its own owner via "question".
      const ownerBPublicText = (await getWikiPage(toUser, 'perfil_publico').catch(() => null))?.body || '';

      // 3) Abre a conversa.
      const convo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: obj });
      const providerA = makeProvider({userId:fromUser,agentId:fromAgent,threadId:null,kind:'agent2agent'});
      const providerB = makeProvider({userId:toUser,agentId:toAgent,threadId:null,kind:'agent2agent'});
      // Each side speaks in its OWN owner's language: A's outcome goes back
      // to owner A and B's "question" is delivered to owner B.
      const langA = (await getUserLocale(fromUser).catch(() => null))?.language;
      const langB = (await getUserLocale(toUser).catch(() => null))?.language;
      const sysA = comIdioma(systemA({ ownerAName, agentA: agentA || { name: 'Assistente' }, ownerBName, objetivo: obj, ownerAProfileText, language: langA }), langA);
      const sysB = comIdioma(systemB({ ownerBName, agentB, ownerAName, ownerBPublicText, language: langB }), langB);

      // A's first message = the goal itself (ask). Records it.
      let lastA = { intent: 'ask', mensagem: obj };
      await addConvoMsg({ convoId: convo.id, senderAgent: fromAgent, side: 'a', intent: 'ask', payload: obj });

      const transcript = []; // to build the final report for the owner
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
        const bInput = `Request from ${ownerAName}'s assistant: ${lastA.mensagem}` +
          (bCtx ? `\n\nContext so far:\n${bCtx}` : '');
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

        // ESCALATES TO OWNER B (ask-human loop): B does not know, but owner
        // B would. Opens a separate conversation (status awaiting_owner_b)
        // with the question stored as side A's message; owner B sees it in
        // the inbox and answers later, and the answer goes back to owner A
        // through his inbox.
        if (b.intent === 'question') {
          // The qConvo stores the ORIGIN channel of A's request: it's
          // through it that owner B's answer goes back to owner A
          // (answerExternalQuestion).
          const qConvo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: obj, originChannel: replyChannel });
          await addConvoMsg({ convoId: qConvo.id, senderAgent: fromAgent, side: 'a', intent: 'question', payload: b.mensagem });
          await updateAgentConvo(qConvo.id, { status: 'awaiting_owner_b' });
          // notifyOwner: pings owner B right away (direction A→B, with no
          // origin channel on his side → falls back to the default push resolution).
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
        // budget
        if (spent > BUDGET_TOKENS) {
          resultado = `Encerrei por limite da conversa. Última resposta de ${ownerBName}: "${b.mensagem}"`;
          status = 'resolved'; break;
        }

        // ── A avalia e conduz ──
        const aCtx = transcript.map((t) => `${t.who}: ${t.msg}`).join('\n');
        const aInput = `Conversation so far:\n${aCtx}\n\nEvaluate the last reply and steer toward closing the objective. If you already have what you needed (or there is no way to get it), close with "close".`;
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

      // Report for owner A (the tool returns this to the main assistant).
      const linhas = transcript.map((t) => `• ${t.who}: ${t.msg}`).join('\n');
      return `Conversa com o assistente de ${personName} sobre: "${obj}"\n\n${linhas}\n\nDesfecho: ${resultado}\n\n(Lembre: nada foi confirmado em nome de ninguém. Se o dono quiser fechar/aceitar algo, use a tool confirmar_com_agente — ela pede o ok explícito dele antes de valer.)`;
    },
  };
}

// Builds the `confirmar_com_agente` tool — the ACTION WITH CONSEQUENCE (Part 3).
// After a conversation (falar_com_agente) that reached a proposal, this is
// where owner A CLOSES/accepts something with the contact's assistant. It's a
// REAL action, so it goes through the confirmation guard (confirm.mjs /
// GATED_TOOLS): the assistant calls it, nothing happens, the owner needs to
// give an explicit "ok", and ONLY THEN is the decision recorded and delivered
// to side B. Side B is never automatically committed: B's assistant takes the
// decision to owner B to confirm on his side.
export function confirmAgentDecisionTool({ fromUser, fromAgent, originChannel, notifyOwner }) {
  return {
    name: 'confirmar_com_agente',
    description: 'Formalizes to a contact\'s assistant a DECISION/acceptance by your owner after a conversation between assistants (falar_com_agente). Use ONLY when there has already been a concrete proposal and the owner wants to accept/close it (e.g. accept a proposed time, confirm an arrangement). This is a real action with consequences: it ASKS for the owner\'s explicit confirmation before taking effect, and nothing is imposed on the contact without their own owner\'s ok.',
    parameters: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Name or e-mail of the person (already connected contact) whose assistant receives the decision.' },
        decisao: { type: 'string', description: 'Your owner\'s final decision/acceptance, in their language. E.g. "aceito o café na terça às 15h no Café X".' },
        responder_em: { type: 'string', enum: ['telegram', 'whatsapp', 'email'], description: 'OPTIONAL. Channel where the owner wants to RECEIVE the contact\'s reply when it comes back. By default it comes back through the same channel as this request. Only fill in if the owner asked for another channel.' },
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
      // Records the decision as a terminal convo (side A's accept) and
      // delivers it to side B. B's assistant will take this to owner B to
      // confirm. The return channel is stored in the convo (through it B's
      // answer goes back to A).
      const convo = await createAgentConvo({ fromUser, fromAgent, toUser, toAgent, objetivo: `Confirmação: ${dec}`, originChannel: replyChannel });
      await addConvoMsg({ convoId: convo.id, senderAgent: fromAgent, side: 'a', intent: 'accept', payload: dec });
      await updateAgentConvo(convo.id, { status: 'accepted', rounds: 1, resultado: dec });
      // Pings owner B right away: a decision arrived for him to confirm
      // (direction A→B, default push resolution).
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

// ── Side B: answering a decision that arrived from another owner ──
//
// Closes the cycle. When owner A confirms something (confirmar_com_agente), the
// decision stays pending in owner B's inbox (surfaced in the prompt via
// agentInbox). Owner B then has his assistant accept or decline. This tool is
// GATED: it only executes after owner B's explicit "ok" (confirm.mjs). The
// answer goes back to owner A through his answer inbox. Nothing is imposed:
// owner B is the one who decides.
export function respondDecisionTool({ fromUser, notifyOwner }) {
  return createRespondDecisionTool({fromUser,list:listInboundDecisions,respond:respondToInboundDecision,owner:getUserById,notifyOwner});
}

// ── Side B (owner): answering a QUESTION that a contact's assistant raised ──
//
// Ask-human loop (Phase 2). When A's assistant asked something that B's
// assistant did not know but owner B would, the question stays pending in
// owner B's inbox (surfaced in the prompt via agentInbox). Owner B answers
// here; the answer goes back to A's assistant through his answer inbox. It is
// NOT gated: the owner himself typing the answer is already the authorization,
// and the tool only passes along information (it does not close a commitment).
export function respondExternalQuestionTool({ fromUser, fromAgent, notifyOwner }) {
  return {
    name: 'responder_pergunta_externa',
    description: 'Answers a QUESTION that a contact\'s assistant raised for your owner and that is awaiting an answer (something only your owner would know). Use when your owner gives you the answer to that pending question. The answer goes back to the contact\'s assistant. It only relays information; it does not close a commitment.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Question identifier, exactly as it appears in the inbox between assistants (e.g. [id: 3f2a…]). Use ALWAYS when there is more than one pending question: it is what guarantees the answer goes to the right question.' },
        para: { type: 'string', description: 'Name or e-mail of the contact whose assistant asked (optional if there is only one pending question).' },
        resposta: { type: 'string', description: 'Your owner\'s answer to the question, in their language.' },
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
      // Pings owner A back, on the ORIGIN channel of his request (direction B→A).
      // One line with the answer that A's assistant received.
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

// Accepting/declining a pending FRIEND REQUEST (contact connection), through a
// conversation with the owner himself. It's not gated: the owner saying
// "aceita fulano" already IS the authorization. It's the only acceptance path
// (there is no link/token in the email).
export function acceptContactTool({ fromUser }) {
  return {
    name: 'aceitar_contato',
    description: `Accepts a pending FRIEND REQUEST (contact connection) that another person sent you on ${marca().nome}. Use when your owner says to accept someone's invitation. Once accepted, your assistants can talk to each other.`,
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Name or e-mail of who invited you (optional if there is only one pending request).' },
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
    description: 'Declines a pending FRIEND REQUEST (contact connection) that another person sent you. Use when your owner says to decline/ignore someone\'s invitation.',
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Name or e-mail of who invited you (optional if there is only one pending request).' },
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

// Starting a FRIEND REQUEST (contact connection): the owner asks to connect
// with someone by their signup email. It's not gated (it only creates a
// pending invite, nothing happens until the other side accepts). `notify`
// (optional) notifies the invitee by email — the same notification as the
// Connections screen; it lives in the server (where sending email is in
// scope) and is passed as a callback.
export function inviteContactTool({ fromUser, notify }) {
  return {
    name: 'convidar_contato',
    description: `Sends a CONNECTION REQUEST (friendship) to another person who already has an account on ${marca().nome}, using their sign-up e-mail. Use when your owner says they want to connect with someone (e.g. "conecta eu com fulano@email"). Creates a pending invitation; nothing happens until the other person accepts (they accept by talking to their assistant). Once accepted, your assistants can talk to each other and share apps. The person must ALREADY have an account on ${marca().nome}; if they do not, tell the owner. This is NOT inviting someone to collaborate on an app (that is convidar_colaborador, and only after being connected).`,
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Sign-up e-mail of the person the owner wants to connect with.' },
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
        try { await notify(toUserId); } catch { /* notification is best-effort */ }
      }
      return JSON.stringify({ ok: true, note: 'Convite de conexão enviado. A pessoa vai receber um aviso e, quando aceitar (falando com o assistente dela), vocês ficam conectados.' });
    },
  };
}
