// ── Routine offer in the CONVERSATION (core; C2, step 11a4) ──────────────────────
// The assistant offers to leave something running on its own, on its own cue, via the
// oferecer_rotina tool. The guardrail (opt-out + 3 days) and the offer log are the core's
// (routineOfferGate and ${S}.routine_offers in db.mjs). What the distribution can
// add is the EVIDENCE of what the person talks about: the
// assuntosConversados(userId) port → [{assunto, n, dias, ultimo, padroes}], where
// `padroes` are the CATALOG ids that subject supports. Without the port, the
// list comes back empty and the block uses the generic rule. The panel that offers in bulk
// (per-model diagnosis, batch snapshot, draft) belongs to the distribution.

import { routineOfferGate, pool, S } from './db.mjs';

// Facts from the CONVERSATION side of the routine offer (rotina-oferta.mjs): capability (what
// they have connected) and what's already running on its own for them. Runs every turn of
// whoever passes the guardrail, so it goes in a single query. The subjects talked about come
// from the assuntosConversados port.
async function getRoutineNudgeFacts(userId) {
  const vazio = { g_scope: '', ms_scope: '', tem_tracker: false, agendados: [] };
  if (!userId) return vazio;
  const { rows } = await pool.query(
    `SELECT
       (SELECT coalesce(g.scope,'') FROM ${S}.google_tokens g
         WHERE g.user_id = $1 LIMIT 1) AS g_scope,
       (SELECT coalesce(o.scope,'') FROM ${S}.oauth_tokens o
         WHERE o.user_id = $1 AND o.provider = 'microsoft' LIMIT 1) AS ms_scope,
       EXISTS (SELECT 1 FROM ${S}.trackers tk
                WHERE tk.owner_user_id = $1 AND tk.enabled) AS tem_tracker,
       -- Only ROUTINES (25/09: a reminder is not a routine). The list only
       -- avoids re-offering the same subject; having many routines doesn't
       -- block offering another.
       coalesce((SELECT json_agg(x.t) FROM (
           SELECT title AS t FROM ${S}.routines
             WHERE user_id = $1 AND enabled ORDER BY created_at DESC LIMIT 30
         ) x), '[]'::json) AS agendados`,
    [userId],
  );
  const r = rows[0] || {};
  return {
    g_scope: r.g_scope || '', ms_scope: r.ms_scope || '', tem_tracker: !!r.tem_tracker,
    agendados: (Array.isArray(r.agendados) ? r.agendados : [])
      .map((t) => String(t || '').trim().slice(0, 80)).filter(Boolean),
  };
}


// Pattern catalog, derived from the LIVE production routines (2026-09-01), not
// made up. `requer` is the capability without which the routine would be born broken.
export const CATALOGO = [
  { id: 'digest_agenda',   o: 'Resumo da agenda do dia (o que vem, conflitos, o que preparar)',           requer: 'calendario' },
  { id: 'triagem_email',   o: 'Triagem da caixa de entrada: o que precisa de resposta e o que é ruído',   requer: 'email' },
  { id: 'digest_setor',    o: 'Resumo diário do que saiu no tema/setor que a pessoa acompanha',           requer: null },
  { id: 'monitor_preco',   o: 'Monitor de preço ou de novidade (passagem, produto, loja)',                requer: null },
  { id: 'lembrete_habito', o: 'Lembrete recorrente de um hábito (remédio, suplemento, água, exercício)',  requer: null },
  { id: 'revisao_listas',  o: 'Revisão semanal de lista de compras, cardápio ou tarefas',                 requer: null },
  { id: 'aviso_contas',    o: 'Aviso de contas, faturas e vencimentos do período',                        requer: null },
  { id: 'resumo_tracker',  o: 'Resumo periódico de algo que a pessoa já registra (tracker)',              requer: 'tracker' },
];

// ── Strength of EVIDENCE: decided by DATA, never by the model ──
// Turn count doesn't distinguish habit from episode. What distinguishes it is on how many
// DIFFERENT DAYS the subject appeared and how recent the last one was. 2026-09-02 case:
// 6 turns in a single day, 40 days ago, came back as "high confidence."
export function forcaDoAssunto(a, hoje = new Date()) {
  const dias = Number(a?.dias || 0);
  const idade = diasAtras(a?.ultimo, hoje);
  if (dias >= 3 && idade <= 30) return 'alta';
  if (dias >= 2 && idade <= 45) return 'media';
  return 'baixa';
}

// BRT noon so age in days doesn't wobble with the time the batch runs.
export function diasAtras(ymd, hoje = new Date()) {
  if (!ymd) return 999;
  const t = Date.parse(`${String(ymd).slice(0, 10)}T12:00:00-03:00`);
  if (Number.isNaN(t)) return 999;
  return Math.max(0, Math.floor((hoje.getTime() - t) / 86400_000));
}

export const ORDEM_DA_FORCA = { alta: 3, media: 2, baixa: 1 };

// Capability comes from the GRANTED SCOPE, not from having a Google login: whoever
// only signed in with "sign in with Google" has no calendar or email to read.
export function capacidadesDe(c) {
  const out = [];
  const esc = `${c.g_scope || ''} ${c.ms_scope || ''}`.toLowerCase();
  if (/calendar/.test(esc)) out.push('calendario');
  if (/gmail|mail\.read|mail\.send/.test(esc)) out.push('email');
  if (c.tem_tracker) out.push('tracker');
  return out;
}

// Good judgment is NOT asked of the model via an adjective ("be sensitive"): it comes
// from (a) the block only existing for whoever passes the offer-log
// guardrail, and (b) the only way to make an offer being the tool, which registers and closes the
// window on its own. That leaves exactly one decision for the prompt: the MOMENT.
// WHAT to offer comes from here, not from the model. Criterion: the catalog pattern the
// person (a) can run — connected capability — and (b) has grounding in a
// subject they actually talk about, with at least MEDIUM strength (2+ different
// days, recent). It's the same evidence guardrail as the panel, just applied
// on the spot, per person.
// Returns null on purpose when there's not enough evidence: then the prompt falls back to
// the earlier generic rule. Filling the gap with just any pattern to have
// something to offer is exactly the generic offer we don't want.
export function escolherPadraoDaVez(caps = [], assuntos = [], hoje = new Date()) {
  let melhor = null;
  for (const p of CATALOGO) {
    if (p.requer && !caps.includes(p.requer)) continue;
    for (const a of assuntos) {
      if (!(a.padroes || []).includes(p.id)) continue;
      const f = forcaDoAssunto(a, hoje);
      if (f === 'baixa') continue;
      const dias = Number(a.dias || 0);
      const melhorQue = !melhor
        || ORDEM_DA_FORCA[f] > ORDEM_DA_FORCA[melhor.confianca]
        || (ORDEM_DA_FORCA[f] === ORDEM_DA_FORCA[melhor.confianca] && dias > melhor.dias);
      if (!melhorQue) continue;
      melhor = {
        padrao: p.id, o: p.o, confianca: f, assunto: a.assunto, dias,
        evidencia: `"${a.assunto}": ${a.n} turnos em ${dias} dia(s) diferentes, último há ${diasAtras(a.ultimo, hoje)}d`,
      };
    }
  }
  return melhor;
}

export async function routineNudgeContext(userId, { assuntosConversados } = {}) {
  if (!userId) return '';
  // No cap by count (25/09): with 2 or 30 routines, the assistant keeps
  // showing it can help. Only the opt-out and the 3 days block it.
  const gate = await routineOfferGate(userId);
  if (!gate.pode) return '';

  // More queries only for whoever passed the ruler above (today ~3 of 4 active
  // people). If the database fails here, the turn does NOT fall: the block only loses the
  // concrete suggestion and goes back to being generic.
  let alvo = null;
  let agendados = [];
  try {
    const f = await getRoutineNudgeFacts(userId);
    agendados = f.agendados;
    const assuntos = assuntosConversados ? await assuntosConversados(userId) : [];
    alvo = escolherPadraoDaVez(capacidadesDe(f), assuntos);
  } catch { /* no data, falls back to generic */ }

  const L = ['AGENDAMENTO AUTOMÁTICO (contexto interno, NUNCA comente isto):'];
  if (agendados.length) {
    L.push(`Rotinas que já rodam sozinhas pra ele: ${agendados.join('; ')}. Não ofereça o mesmo assunto de novo; uma rotina de OUTRO assunto continua valendo, não importa quantas ele já tenha.`);
  } else {
    L.push('Este dono não tem NENHUMA rotina rodando: hoje você só age quando ele te chama.');
  }
  if (alvo) {
    // The choice comes ready so only the MOMENT and the words are left to the model, which
    // is where it's good. When it had to figure out by itself WHAT to offer,
    // only 3 offers came out of 433 eligible turns (measured 2026-09-10).
    L.push(`O que mais faz sentido oferecer pra esta pessoa (já escolhido a partir do que ela conversa e do que ela tem conectado, não é chute): ${alvo.o}. Ao chamar a tool, use padrao="${alvo.padrao}".`);
    L.push(`Lastro: ${alvo.evidencia}.`);
    L.push('DEIXA: basta a conversa ENCOSTAR nesse assunto, não precisa vir um "todo dia". Aí chame a tool oferecer_rotina ANTES de escrever a resposta e, depois do retorno dela, escreva a sua resposta normal completa com a oferta emendada no fim, em uma ou duas linhas. Se surgir outra coisa repetitiva antes disso, ofereça essa outra.');
  } else {
    L.push('Se, no que ele está pedindo AGORA, aparecer algo que se repete (ele já pediu a mesma coisa antes, ou disse "todo dia"/"toda semana"/"sempre que"), ofereça deixar isso rodando sozinho, usando a tool oferecer_rotina.');
  }
  L.push('REGRAS: nunca do nada nem mudando de assunto; nunca interrompa o que ele pediu pra ofertar, primeiro resolva, a oferta vai no fim; no máximo UMA oferta, sem insistir se ele não responder; se ele disser que não quer esse tipo de sugestão, chame dispensar_oferta_de_rotina e não toque mais no assunto.');
  L.push('Se agora não é a hora, simplesmente não ofereça: não existe cota a cumprir.');
  return L.join('\n');
}

// Text the tool returns after registering the offer. The invitation itself is
// written by the assistant, in its own voice; here only the copy limits stay, the
// same ones as the panel's invitation.
// oferecer_rotina is keepsStepText: the text written in the same step as the call is
// delivered before the final text. Until 2026-10-06 it was discarded and the return
// only asked "make the invitation," so the response to the request disappeared and only the invitation
// arrived (3 cases between 2026-10-03 and 2026-10-05). The returns warn that this text is already
// coming and ask for the complete response only if it hasn't been written yet.
const JA_ESCRITO = 'O texto que você escreveu junto desta chamada já vai ser entregue a ele, antes do que você escrever agora: não repita nada dele.';

export function ofertaRegistrada(titulo) {
  return `Oferta registrada ("${titulo}"). ${JA_ESCRITO} `
    + 'Se a sua resposta ao que ele pediu ainda não está escrita, escreva-a agora COMPLETA. No fim, faça o convite VOCÊ, com as suas palavras, em no máximo 2 linhas: '
    + 'diga concretamente o que você passaria a fazer e quando, e pergunte se pode deixar rodando. '
    + 'NÃO crie a rotina agora (espere ele topar), NÃO diga que já está feito, NÃO mencione meta, campanha, teste ou plataforma, '
    + 'e emende no assunto que ele trouxe em vez de abrir um bloco novo.';
}

export function ofertaNaoFeita(motivo) {
  return `Não ofereça agora: ${motivo}. ${JA_ESCRITO} Se ainda não respondeu ao que ele pediu, responda agora COMPLETO, sem tocar no assunto de rotina.`;
}
