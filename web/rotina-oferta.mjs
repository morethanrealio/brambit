// ── Oferta de rotina na CONVERSA (núcleo; C2, passo 11a4) ──────────────────────
// O assistente oferta deixar algo rodando sozinho, na deixa dele, pela tool
// oferecer_rotina. A régua (opt-out + 3 dias) e o livro de ofertas são do núcleo
// (routineOfferGate e ${S}.routine_offers no db.mjs). O que a distribuição pode
// somar é a EVIDÊNCIA de sobre o que a pessoa conversa: a porta
// assuntosConversados(userId) → [{assunto, n, dias, ultimo, padroes}], em que
// `padroes` são os ids do CATALOGO que aquele assunto sustenta. Sem a porta, a
// lista vem vazia e o bloco usa a regra genérica. O painel que oferta em lote
// (diagnóstico por modelo, foto do lote, rascunho) é da distribuição.

import { routineOfferGate, pool, S } from './db.mjs';

// Fatos do lado CONVERSA da oferta de rotina (rotina-oferta.mjs): capacidade (o
// que ela tem conectado) e o que já roda sozinho pra ela. Roda a cada turno de
// quem passa na régua, então sai numa consulta só. Os assuntos conversados vêm
// da porta assuntosConversados.
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
       -- Só ROTINAS (Marcos 25/09: lembrete não tem nada a ver com rotina). A
       -- lista serve só pra não reoferecer o mesmo assunto; ter muitas rotinas
       -- não impede oferecer outra.
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


// Catálogo de padrões, derivado das rotinas VIVAS de produção (01/09/2026), não
// inventado. `requer` é a capacidade sem a qual a rotina nasceria quebrada.
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

// ── Força da EVIDÊNCIA: decidida por DADO, nunca pelo modelo ──
// Contagem de turnos não separa hábito de episódio. O que separa é em quantos
// DIAS DIFERENTES o assunto apareceu e quão recente foi o último. Caso 02/09:
// 6 turnos num único dia, 40 dias atrás, voltaram como "confiança alta".
export function forcaDoAssunto(a, hoje = new Date()) {
  const dias = Number(a?.dias || 0);
  const idade = diasAtras(a?.ultimo, hoje);
  if (dias >= 3 && idade <= 30) return 'alta';
  if (dias >= 2 && idade <= 45) return 'media';
  return 'baixa';
}

// Meio-dia BRT pra idade em dias não oscilar com o horário em que o lote roda.
export function diasAtras(ymd, hoje = new Date()) {
  if (!ymd) return 999;
  const t = Date.parse(`${String(ymd).slice(0, 10)}T12:00:00-03:00`);
  if (Number.isNaN(t)) return 999;
  return Math.max(0, Math.floor((hoje.getTime() - t) / 86400_000));
}

export const ORDEM_DA_FORCA = { alta: 3, media: 2, baixa: 1 };

// Capacidade vem do ESCOPO concedido, não do fato de ter login Google: quem
// entrou só com "entrar com Google" não tem agenda nem e-mail pra ler.
export function capacidadesDe(c) {
  const out = [];
  const esc = `${c.g_scope || ''} ${c.ms_scope || ''}`.toLowerCase();
  if (/calendar/.test(esc)) out.push('calendario');
  if (/gmail|mail\.read|mail\.send/.test(esc)) out.push('email');
  if (c.tem_tracker) out.push('tracker');
  return out;
}

// O bom senso NÃO é pedido ao modelo por adjetivo ("seja sensível"): ele vem de
// (a) o bloco só existir pra quem passa na régua do livro
// de ofertas, e (b) a única forma de ofertar ser a tool, que registra e fecha a
// janela sozinha. Sobra pro prompt exatamente uma decisão: o MOMENTO.
// O QUE ofertar sai daqui, não do modelo. Critério: o padrão do catálogo que a
// pessoa (a) consegue executar — capacidade conectada — e (b) tem lastro num
// assunto que ela de fato conversa, com força pelo menos MÉDIA (2+ dias
// diferentes, recente). É a mesma régua de evidência do painel, só que aplicada
// na hora, por pessoa.
// Sem evidência suficiente devolve null de propósito: aí o prompt volta pra
// regra genérica de antes. Preencher o buraco com um padrão qualquer só pra ter
// o que oferecer é exatamente a oferta genérica que a gente não quer.
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
  // Sem teto por quantidade (Marcos 25/09): com 2 ou 30 rotinas, o assistente
  // continua mostrando que pode ajudar. Só barram o opt-out e os 3 dias.
  const gate = await routineOfferGate(userId);
  if (!gate.pode) return '';

  // Mais consultas só pra quem passou na régua acima (hoje ~3 de 4 das pessoas
  // ativas). Se o banco falhar aqui, o turno NÃO cai: o bloco só perde a
  // sugestão concreta e volta a ser o genérico.
  let alvo = null;
  let agendados = [];
  try {
    const f = await getRoutineNudgeFacts(userId);
    agendados = f.agendados;
    const assuntos = assuntosConversados ? await assuntosConversados(userId) : [];
    alvo = escolherPadraoDaVez(capacidadesDe(f), assuntos);
  } catch { /* sem dado, segue no genérico */ }

  const L = ['AGENDAMENTO AUTOMÁTICO (contexto interno, NUNCA comente isto):'];
  if (agendados.length) {
    L.push(`Rotinas que já rodam sozinhas pra ele: ${agendados.join('; ')}. Não ofereça o mesmo assunto de novo; uma rotina de OUTRO assunto continua valendo, não importa quantas ele já tenha.`);
  } else {
    L.push('Este dono não tem NENHUMA rotina rodando: hoje você só age quando ele te chama.');
  }
  if (alvo) {
    // A escolha vem pronta pra sobrar pro modelo só o MOMENTO e as palavras, que
    // é onde ele é bom. Quando ele tinha que descobrir sozinho O QUE ofertar,
    // saíram 3 ofertas em 433 turnos elegíveis (medido 10/09).
    L.push(`O que mais faz sentido oferecer pra esta pessoa (já escolhido a partir do que ela conversa e do que ela tem conectado, não é chute): ${alvo.o}. Ao chamar a tool, use padrao="${alvo.padrao}".`);
    L.push(`Lastro: ${alvo.evidencia}.`);
    L.push('DEIXA: basta a conversa ENCOSTAR nesse assunto, não precisa vir um "todo dia". Aí, no fim da sua resposta normal, emende a oferta em uma ou duas linhas, chamando antes a tool oferecer_rotina. Se surgir outra coisa repetitiva antes disso, ofereça essa outra.');
  } else {
    L.push('Se, no que ele está pedindo AGORA, aparecer algo que se repete (ele já pediu a mesma coisa antes, ou disse "todo dia"/"toda semana"/"sempre que"), ofereça deixar isso rodando sozinho, usando a tool oferecer_rotina.');
  }
  L.push('REGRAS: nunca do nada nem mudando de assunto; nunca interrompa o que ele pediu pra ofertar, primeiro resolva, a oferta vai no fim; no máximo UMA oferta, sem insistir se ele não responder; se ele disser que não quer esse tipo de sugestão, chame dispensar_oferta_de_rotina e não toque mais no assunto.');
  L.push('Se agora não é a hora, simplesmente não ofereça: não existe cota a cumprir.');
  return L.join('\n');
}

// Texto que a tool devolve depois de registrar a oferta. O convite em si é
// escrito pelo assistente, na voz dele; aqui só ficam os limites de copy, os
// mesmos do convite do painel.
export function ofertaRegistrada(titulo) {
  return `Oferta registrada ("${titulo}"). Agora faça o convite VOCÊ, com as suas palavras, em no máximo 2 linhas: `
    + 'diga concretamente o que você passaria a fazer e quando, e pergunte se pode deixar rodando. '
    + 'NÃO crie a rotina agora (espere ele topar), NÃO diga que já está feito, NÃO mencione meta, campanha, teste ou plataforma, '
    + 'e emende no assunto que ele trouxe em vez de abrir um bloco novo.';
}
