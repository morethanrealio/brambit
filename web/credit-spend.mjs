// Gasto por recorte, pro assistente responder perguntas como
// "quanto gastei hoje?", "e no dia 15?", "quanto custaram as últimas 3 respostas?".
// Pedido do Marcos 27/09/2026.
//
// Unidade: 'creditos' (Brambs) soma usage_events.bill_credits, o crédito cobrado,
// o mesmo que o saldo usa; 'usd' (núcleo, sem crédito) soma cost_usd, o custo real.
// Quem escolhe é a porta de gasto, que é quem entrega a ferramenta ao turno.
//
// Por período: soma no fuso de SP. Vale pra todo o histórico.
//
// Por resposta: usage_events.turn_id NÃO agrupa uma resposta (cada chamada de
// modelo e cada busca grava com um id próprio). O que delimita uma resposta é a
// medição de turno (task_measurements, source='conversation'): mesma pessoa,
// mesma thread, entre started_at e finished_at. Busca, sub-agente e imagem da
// resposta caem nessa janela com o thread_id dela. Medição existe desde 21/09.
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
// Pro usuário importa o total; a divisão por categoria é detalhe interno e só
// vai pra resposta se ele pedir (Marcos 29/09/2026). Os dados continuam vindo
// completos pra o assistente responder um "em quê?" sem nova consulta.
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

// A ferramenta consultar_gasto do turno, na unidade de `spend`. Quem a entrega é
// a porta de gasto (ferramentas), logo depois das de saldo. Só leitura, sem
// preço, então vale igual no app iOS. Por padrão o assistente dá só o total;
// divisão por categoria só a pedido (Marcos 29/09).
const O_QUE_MOSTRA = {
  creditos: 'Mostra quantos créditos foram gastos',
  usd: 'Mostra quanto foi gasto em US$ (custo real dos modelos e serviços usados)',
};
const NUMEROS = {
  creditos: 'Os números são o crédito cobrado de verdade: responda com eles, sem arredondar pra cima nem estimar.',
  usd: 'Os números são o custo gravado de verdade, em US$: responda com eles, sem arredondar pra cima nem estimar.',
};
export function ferramentaConsultarGasto({ spend, unidade = 'creditos', userId, agentId, turnId }) {
  return {
    name: 'consultar_gasto',
    description: `${O_QUE_MOSTRA[unidade]}, com o total e a divisão por categoria (conversa, buscas na web, pesquisas, imagens, rotinas...). Use quando a pessoa perguntar quanto gastou ou quanto custou algo. Por padrão responda SÓ o total; a divisão por categoria é detalhe e só entra se a pessoa perguntar em que foi gasto ou pedir o detalhamento. Dois modos: (1) por período, passando de/ate em AAAA-MM-DD no fuso de Brasília (hoje = de e ate iguais à data de hoje; "ontem", "dia 15", "semana passada" você converte em datas); o total é da conta inteira, somando todos os assistentes; (2) por resposta, passando ultimas_respostas = N pra ver o custo das N últimas respostas SUAS (1 = a resposta anterior a esta, que é o caso de "quanto custou essa busca que você fez"). ${NUMEROS[unidade]}`,
    parameters: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Data inicial AAAA-MM-DD (modo período).' },
        ate: { type: 'string', description: 'Data final AAAA-MM-DD, inclusiva (modo período).' },
        ultimas_respostas: { type: 'integer', minimum: 1, maximum: 20, description: 'Quantas das suas últimas respostas detalhar (modo resposta).' },
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
