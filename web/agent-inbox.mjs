// ── Inbox between assistants (the prompt block) ──
// Decisions and questions that came from other owners' assistants, the answers
// that came back, and pending contact requests. server.mjs reads the rows; this
// turns them into the block that goes into every turn of the owner's prompt.
//
// Everything here was written by OTHER people. The contact request is the
// sharpest case: anyone who knows the owner's e-mail can send one, and the
// requester's name is whatever they typed at sign-up (no limit). Before, that
// name went in raw: a "name" with line breaks could open a fake section of the
// prompt ("SYSTEM: ...") in every turn until the owner declined the request.
// Now every name goes through nomeDeTerceiro and the free text through clip
// (one line, capped), and the block header says it's data, not instructions.

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export const NOME_MAX = 60;

// A name someone else chose, ready to sit inside the prompt: one line, no
// control or invisible characters (bidi overrides, zero-width), no quotes or
// brackets that could close the quoting around it, capped at NOME_MAX.
export function nomeDeTerceiro(s) {
  const t = String(s ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/["“”`[\]{}<>]/g, '');
  return clip(t, NOME_MAX);
}

// First name for the conversation between assistants (agent2agent.mjs), which
// puts the other owner's name all over both sub-agents' prompts.
export const primeiroNome = (nome, padrao) => nomeDeTerceiro(nome).split(' ')[0] || padrao;

const quem = (nome, email, padrao) => nomeDeTerceiro(nome) || nomeDeTerceiro(email) || padrao;

// rows: { inbound, questions, back, qBack, reqs } as the db returns them.
// Returns { block, responseIds, questionIds } (the ids are marked as seen by
// the caller after the turn).
export function inboxDigest({ inbound = [], questions = [], back = [], qBack = [], reqs = [] }, { marca }) {
  const parts = [];
  const responseIds = [];
  const questionIds = [];
  if (inbound.length) {
    const lines = inbound.map((r) => {
      const who = quem(r.from_name, r.from_email, 'um contato');
      return `- [id: ${r.id}] ${who} propôs/decidiu: "${clip(r.resultado || r.objetivo, 200)}"`;
    });
    parts.push(
      'DECISÕES AGUARDANDO SUA RESPOSTA (chegaram do assistente de outra pessoa):\n' +
      lines.join('\n') +
      '\nSe o seu dono quiser aceitar ou recusar alguma, use a tool `responder_decisao` com o id exato acima (não mostrar o id ao dono; ela pede o ok explícito dele antes de valer). Não responda sozinho: só quando o dono decidir.',
    );
  }
  // 2b: questions a contact's assistant raised for this user's owner.
  if (questions.length) {
    const lines = questions.map((r) => {
      const who = quem(r.from_name, r.from_email, 'um contato');
      // The id tags along (short prefix) because with 2+ pending questions the contact's
      // name doesn't disambiguate: without it the answer would land on the wrong question.
      return `- [id: ${String(r.id).slice(0, 8)}] o assistente de ${who} está perguntando: "${clip(r.pergunta, 240)}"`;
    });
    parts.push(
      'PERGUNTAS AGUARDANDO A RESPOSTA DO SEU DONO (o assistente de um contato precisa de uma info que só o seu dono sabe):\n' +
      lines.join('\n') +
      '\nQuando o seu dono te der a resposta, use a tool `responder_pergunta_externa` pra devolver pro contato, passando o `id` da pergunta que ele respondeu. Não invente: só responda com o que o dono disser.',
    );
  }
  if (back.length) {
    const lines = back.map((r) => {
      responseIds.push(r.id);
      const verb = r.status === 'confirmed_b' ? 'CONFIRMOU' : 'RECUSOU';
      const who = quem(r.to_name, '', 'o contato');
      const resp = clip(r.resposta, 160);
      return `- ${who} ${verb} "${clip(r.resultado || r.objetivo, 120)}"${resp ? ` — recado: "${resp}"` : ''}`;
    });
    parts.push(
      'RESPOSTAS QUE VOLTARAM DOS SEUS CONTATOS (avise o seu dono):\n' + lines.join('\n'),
    );
  }
  // 2c: answers to QUESTIONS that came back to this user's owner.
  if (qBack.length) {
    const lines = qBack.map((r) => {
      questionIds.push(r.id);
      const who = quem(r.to_name, '', 'o contato');
      return `- ${who} respondeu à sua pergunta "${clip(r.pergunta, 120)}": "${clip(r.resposta, 200)}"`;
    });
    parts.push(
      'RESPOSTAS DE PERGUNTAS QUE VOLTARAM DOS SEUS CONTATOS (avise o seu dono):\n' + lines.join('\n'),
    );
  }
  // 2d: pending FRIEND REQUESTS (contact connection) that arrived for this
  // user. Stays pending until accepted/declined, so it needs no cleanup.
  if (reqs.length) {
    const lines = reqs.map((r) => {
      // The e-mail goes whole: it's what the owner (and aceitar_contato) uses to
      // tell two requests apart. Sign-up only accepts a valid address.
      const email = clip(String(r.fromEmail || '').replace(/[\p{Cc}\p{Cf}"`<>]/gu, ''), 254);
      const who = nomeDeTerceiro(r.fromName) || email || 'alguém';
      return `- ${who}${email ? ` (${email})` : ''} quer te conectar como contato no ${marca}.`;
    });
    parts.push(
      `PEDIDOS DE AMIZADE AGUARDANDO SUA DECISÃO (alguém quer se conectar a você no ${marca}):\n` +
      lines.join('\n') +
      '\nAvise o seu dono. Se ele quiser aceitar, use a tool `aceitar_contato`; se quiser recusar, `recusar_contato`. Depois de aceito, os assistentes de vocês podem conversar entre si.',
    );
  }
  return { block: parts.join('\n\n'), responseIds, questionIds };
}
