// Spend by slice, so the assistant can answer questions like
// "how much did I spend today?", "and on the 15th?", "how much did the last 3
// replies cost?". Added 27/09/2026.
//
// Unit: 'creditos' (a credit-based plugin) sums usage_events.bill_credits, the
// billed credit, same as the balance; 'usd' (core, no credits) sums cost_usd,
// the real cost. The spend port, which hands the tool to the turn, picks it.
//
// By period: summed in the São Paulo time zone. Covers the whole history.
//
// By reply: usage_events.turn_id does NOT group a reply (each model call and
// each search writes its own id). What delimits a reply is the turn
// measurement (task_measurements, source='conversation'): same person, same
// thread, between started_at and finished_at. Search, sub-agent and image of
// the reply fall in that window with its thread_id. Measured since 21/09.
const S = 'mtr_harness';
const TZ = 'America/Sao_Paulo';
const NAO_CONSUMO = ['admin-grant', 'purchase', 'referral'];
const MAX_DIAS = 366;
const MAX_RESPOSTAS = 20;
// Folga depois do fim da resposta: a última linha de uso é gravada logo depois
// de o turno ser marcado como encerrado.
const FOLGA_FIM = '5 seconds';

const CATEGORIAS = {
  chat: 'conversa (raciocínio do assistente)',
  whatsapp: 'conversa (raciocínio do assistente)',
  telegram: 'conversa (raciocínio do assistente)',
  email: 'conversa (raciocínio do assistente)',
  slack: 'conversa (raciocínio do assistente)',
  search: 'buscas na web',
  subagent: 'pesquisas e tarefas delegadas',
  image: 'imagens',
  video: 'vídeos',
  tts: 'áudio gerado',
  stt: 'transcrição de áudio',
  housekeeping: 'manutenção da memória',
  compact: 'manutenção da memória',
  routine: 'rotinas automáticas',
  wa_msg: 'envio de mensagens no WhatsApp',
  discovery: 'mensagens por iniciativa do assistente',
  broadcast: 'mensagens por iniciativa do assistente',
  onboard: 'configuração inicial',
  agent2agent: 'conversa com outros assistentes',
};
// The total is what matters to the user; the per-category split is an internal
// detail and only goes in the reply if asked (29/09/2026). The data still comes
// complete so the assistant can answer "on what?" without a new query.
const ORIENTACAO_TOTAL = 'Responda só com o total de créditos (e o total de cada dia ou de cada resposta, se a pergunta for sobre vários). NÃO mostre a divisão por categoria (onde_foi) a não ser que a pessoa pergunte em que foi gasto ou peça o detalhamento.';
const UNIDADES = {
  creditos: { campo: 'creditos', soma: 'COALESCE(sum(bill_credits), 0)::int', valor: (v) => Number(v) || 0, orientacao: ORIENTACAO_TOTAL },
  // Custo em US$ tem frações de centavo; 4 casas bastam pra uma resposta curta.
  usd: { campo: 'usd', soma: 'COALESCE(sum(cost_usd), 0)::float8', valor: (v) => Math.round((Number(v) || 0) * 1e4) / 1e4,
    orientacao: 'Responda só com o total em US$ (e o total de cada dia ou de cada resposta, se a pergunta for sobre vários). NÃO mostre a divisão por categoria (onde_foi) a não ser que a pessoa pergunte em que foi gasto ou peça o detalhamento.' },
};
const CANAIS = { chat: 'app', whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'e-mail', slack: 'Slack' };

export function categoriaDe(kind) { return CATEGORIAS[kind] || 'outros'; }

// Agrupa linhas {kind, <campo>} por categoria, maior primeiro.
export function porCategoria(linhas, campo = 'creditos', valor = (v) => v) {
  const acc = new Map();
  for (const l of linhas) {
    const c = Number(l[campo]) || 0;
    if (!c) continue;
    const k = categoriaDe(l.kind);
    acc.set(k, (acc.get(k) || 0) + c);
  }
  return [...acc].map(([categoria, v]) => ({ categoria, [campo]: valor(v) })).sort((a, b) => b[campo] - a[campo]);
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
export function validarPeriodo(de, ate) {
  if (!DIA.test(de || '') || !DIA.test(ate || '')) return 'Datas no formato AAAA-MM-DD.';
  const a = Date.parse(de + 'T00:00:00Z'), b = Date.parse(ate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Data inválida.';
  if (a > b) return 'A data inicial é depois da final.';
  if ((b - a) / 86400_000 + 1 > MAX_DIAS) return `Período de até ${MAX_DIAS} dias.`;
  return null;
}

export function createCreditSpend(pool, { unidade = 'creditos' } = {}) {
  const U = UNIDADES[unidade];
  if (!U) throw Error('unidade de gasto desconhecida: ' + unidade);
  const { campo, valor } = U;
  const total = (linhas) => valor(linhas.reduce((s, r) => s + (Number(r[campo]) || 0), 0));
  async function porPeriodo({ userId, de, ate }) {
    const erro = validarPeriodo(de, ate);
    if (erro) return { erro };
    const { rows } = await pool.query(
      `SELECT to_char(ts AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS dia, kind, ${U.soma} AS ${campo}
         FROM ${S}.usage_events
        WHERE user_id = $1 AND model <> ALL($4::text[])
          AND ts >= ($2::date::timestamp AT TIME ZONE '${TZ}')
          AND ts <  (($3::date + 1)::timestamp AT TIME ZONE '${TZ}')
        GROUP BY 1, 2`,
      [userId, de, ate, NAO_CONSUMO],
    );
    const out = { periodo: { de, ate }, ['total_' + campo]: total(rows), onde_foi: porCategoria(rows, campo, valor), orientacao: U.orientacao };
    if (de !== ate) {
      const dias = new Map();
      for (const r of rows) dias.set(r.dia, (dias.get(r.dia) || 0) + (Number(r[campo]) || 0));
      out.por_dia = [...dias].filter(([, c]) => c).sort(([a], [b]) => a.localeCompare(b)).map(([dia, c]) => ({ dia, [campo]: valor(c) }));
    }
    return out;
  }

  async function ultimasRespostas({ userId, agentId, n, excluirTurnoId = null }) {
    const lim = Math.min(MAX_RESPOSTAS, Math.max(1, Math.floor(Number(n) || 1)));
    const { rows: turnos } = await pool.query(
      `SELECT id, thread_id, started_at, finished_at
         FROM ${S}.task_measurements
        WHERE source = 'conversation' AND user_id = $1 AND agent_id = $2
          AND finished_at IS NOT NULL AND ($3::uuid IS NULL OR id <> $3::uuid)
        ORDER BY started_at DESC LIMIT $4`,
      [userId, agentId, excluirTurnoId, lim],
    );
    const respostas = [];
    for (const t of turnos) {
      const { rows } = await pool.query(
        `SELECT kind, ${U.soma} AS ${campo}
           FROM ${S}.usage_events
          WHERE user_id = $1 AND thread_id = $2 AND model <> ALL($5::text[])
            AND ts >= $3 AND ts <= $4::timestamptz + interval '${FOLGA_FIM}'
          GROUP BY 1`,
        [userId, t.thread_id, t.started_at, t.finished_at, NAO_CONSUMO],
      );
      const canal = rows.map((r) => CANAIS[r.kind]).find(Boolean) || null;
      respostas.push({
        quando: new Date(t.started_at).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        canal,
        duracao_segundos: Math.round((new Date(t.finished_at) - new Date(t.started_at)) / 1000),
        [campo]: total(rows),
        onde_foi: porCategoria(rows, campo, valor),
      });
    }
    return {
      respostas,
      ['total_' + campo]: total(respostas),
      orientacao: U.orientacao,
      observacao: 'Da mais recente pra mais antiga. A resposta que você está dando agora não entra (ainda não terminou). O detalhe por resposta existe a partir de 21/09/2026.',
    };
  }

  return { porPeriodo, ultimasRespostas };
}

// The turn's consultar_gasto tool, in the unit of `spend`. The spend port
// (ferramentas) hands it out, right after the balance ones. Read-only, no
// price, so it's the same on the iOS app. By default the assistant gives only
// the total; per-category split only on request (29/09).
const O_QUE_MOSTRA = {
  creditos: 'Shows how many credits were spent',
  usd: 'Shows how much was spent in US$ (actual cost of the models and services used)',
};
const NUMEROS = {
  creditos: 'The numbers are the credit actually charged: answer with them, without rounding up or estimating.',
  usd: 'The numbers are the actual recorded cost, in US$: answer with them, without rounding up or estimating.',
};
export function ferramentaConsultarGasto({ spend, unidade = 'creditos', userId, agentId, turnId }) {
  return {
    name: 'consultar_gasto',
    description: `${O_QUE_MOSTRA[unidade]}, with the total and the breakdown by category (conversation, web searches, research, images, routines...). Use when the person asks how much they spent or how much something cost. By default answer ONLY the total; the breakdown by category is detail and only comes in if the person asks what it was spent on or asks for the breakdown. Two modes: (1) by period, passing de/ate as YYYY-MM-DD in the Brasília time zone (today = de and ate both equal to today's date; "ontem", "dia 15", "semana passada" you convert into dates); the total is for the whole account, adding up all assistants; (2) by response, passing ultimas_respostas = N to see the cost of YOUR last N responses (1 = the response before this one, which is the case of "quanto custou essa busca que você fez"). ${NUMEROS[unidade]}`,
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Start date YYYY-MM-DD (period mode).' },
        ate: { type: 'string', description: 'End date YYYY-MM-DD, inclusive (period mode).' },
        ultimas_respostas: { type: 'integer', minimum: 1, maximum: 20, description: 'How many of your last responses to detail (response mode).' },
      },
      additionalProperties: false,
    },
    run: async ({ de, ate, ultimas_respostas } = {}) => {
      if (ultimas_respostas) return spend.ultimasRespostas({ userId, agentId, n: ultimas_respostas, excluirTurnoId: turnId });
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      return spend.porPeriodo({ userId, de: de || ate || hoje, ate: ate || de || hoje });
    },
  };
}
