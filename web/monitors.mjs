// ── Monitores: engine determinística de monitoramento de compras (Fase 2) ─────
// O par estruturado da rotina de monitoramento. O problema da Fase 1 (só
// comportamento): o dedup ("o que eu já avisei?") ficava na cabeça do modelo /
// no histórico da thread — soft, sujeito a re-avisar o mesmo drop. Aqui o dedup
// é uma UNIQUE em SQL: a cada rodada a rotina raspa as fontes e chama
// checar_monitor com os itens; só os que ENTRAM na tabela (ON CONFLICT DO
// NOTHING) contam como novidade. A 1ª rodada é BASELINE: registra o estado atual
// e não avisa ninguém. Ver projetos/skill-monitor-compras.md.

import {
  resolveOrCreateMonitor, resolveMonitor, listMonitors,
  recordMonitorItems, markMonitorBaseline, disableMonitor,
} from './db.mjs';

export function monitorsTools(userId, agentId) {
  return [
    {
      name: 'checar_monitor',
      description: 'Deterministic engine for a monitor (e.g. news from a brand). CALL it inside the monitoring routine: after READING the validated sources and extracting the items (each with a STABLE key = the article URL), pass the list here. The tool stores the items and returns ONLY the ones that are GENUINELY NEW (dedup is done in SQL, not in your memory): you notify the user only about those. The 1st call for a monitor is the BASELINE (records the current state and returns 0 new items: do NOT notify anything in that round). The monitor is created on first use if it does not exist (pass alvo/fontes/canal). Never invent items; pass only what you actually read in the sources.',
      parameters: {
        type: 'object',
        properties: {
          monitor: { type: 'string', description: 'Monitor name, e.g. "Zara Japão". Created if it does not exist.' },
          alvo: { type: 'string', description: 'What + market (e.g. "Zara, mercado Japão/internacional"). Used only on creation.' },
          fontes: { type: 'array', description: 'Validated sources [{url,label}], used only on creation.', items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } } } },
          canal: { type: 'string', description: 'Notification channel (whatsapp/email/telegram), used only on creation.' },
          itens: {
            type: 'array',
            description: 'Items read from the sources in THIS round. Each item: chave (stable article URL, required for dedup), data (text as it appears), titulo, url.',
            items: {
              type: 'object',
              properties: {
                chave: { type: 'string', description: 'Stable dedup key; use the article URL.' },
                data: { type: 'string', description: 'Item date as it appears in the source.' },
                titulo: { type: 'string', description: 'Short title/summary of the item.' },
                url: { type: 'string', description: 'Item link.' },
              },
              required: ['chave'],
            },
          },
        },
        required: ['monitor', 'itens'],
      },
      async run({ monitor, alvo, fontes, canal, itens }) {
        const r = await resolveOrCreateMonitor(userId, monitor, agentId, { target: alvo, sources: fontes, channel: canal });
        if (r.error === 'nome_vazio') return 'Preciso do nome do monitoramento (ex: "Zara Japão").';
        if (r.error === 'ambiguo') return `Tenho mais de um monitor parecido: ${r.options.join(', ')}. Qual deles?`;
        if (r.error) return `Não consegui abrir o monitor (${r.error}).`;
        const wasBaseline = !r.monitor.baseline_done;
        const items = (Array.isArray(itens) ? itens : []).map((i) => ({
          key: i?.chave || i?.url, date: i?.data, title: i?.titulo, url: i?.url,
        }));
        const novos = await recordMonitorItems(r.monitor.id, items);
        if (wasBaseline) {
          await markMonitorBaseline(r.monitor.id);
          return JSON.stringify({
            baseline: true,
            registrados: items.length,
            novidades: [],
            instrucao: 'Primeira rodada deste monitor: registrei o estado atual como baseline. NÃO avise o usuário nesta rodada (responda com mensagem vazia). A partir da próxima, só chega o que for novo.',
          });
        }
        return JSON.stringify({
          baseline: false,
          novidades: novos,
          instrucao: novos.length
            ? 'Estes são os itens NOVOS desde a última checagem. Avise o usuário SÓ sobre estes, texto corrido, caloroso e objetivo. Não repita nada que não esteja nesta lista.'
            : 'Nada novo desde a última checagem. Responda com mensagem VAZIA (não mande nada pro usuário).',
        });
      },
    },
    {
      name: 'listar_monitores',
      description: 'Lists the user\'s active monitors (target, channel, how many items already seen, latest). Use it to know what is already being monitored before creating another one.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const list = await listMonitors(userId);
        if (!list.length) return 'Nenhum monitoramento ativo ainda.';
        return JSON.stringify(list.map((m) => ({
          monitor: m.title || m.target, alvo: m.target || undefined, canal: m.channel || undefined,
          itens_vistos: Number(m.itens) || 0, ultimo: m.ultimo || undefined,
          baseline: m.baseline_done,
        })));
      },
    },
    {
      name: 'remover_monitor',
      description: 'Deactivates an entire monitor (stops checking; the item history is kept). Use when the user asks to stop monitoring something.',
      parameters: {
        type: 'object',
        properties: { monitor: { type: 'string', description: 'Name of the monitor to deactivate.' } },
        required: ['monitor'],
      },
      async run({ monitor }) {
        const res = await resolveMonitor(userId, monitor);
        if (res.error === 'nao_encontrado') return `Não achei um monitoramento "${monitor}".`;
        if (res.error === 'ambiguo') return `Tenho mais de um monitor parecido: ${res.options.join(', ')}. Qual deles?`;
        if (res.error) return `Não consegui abrir o monitor (${res.error}).`;
        await disableMonitor(userId, res.monitor.id);
        return `Parei de monitorar "${res.monitor.title || res.monitor.target}".`;
      },
    },
  ];
}
