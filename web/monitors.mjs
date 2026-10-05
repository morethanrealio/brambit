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
      description: 'Motor determinístico de um monitoramento (ex: novidades de uma marca). CHAME dentro da rotina de monitoramento: depois de LER as fontes validadas e extrair os itens (cada um com uma chave ESTÁVEL = a URL do artigo), passe a lista aqui. A tool grava os itens e devolve SÓ os que são GENUINAMENTE NOVOS (o dedup é feito em SQL, não na sua memória): você avisa o usuário apenas sobre esses. A 1ª chamada de um monitor é BASELINE (registra o estado atual e retorna 0 novidades: NÃO avise nada nessa rodada). O monitor é criado no primeiro uso se não existir (passe alvo/fontes/canal). Nunca invente itens; passe só o que você leu de verdade nas fontes.',
      parameters: {
        type: 'object',
        properties: {
          monitor: { type: 'string', description: 'Nome do monitoramento, ex: "Zara Japão". Se não existir, é criado.' },
          alvo: { type: 'string', description: 'O que + mercado (ex: "Zara, mercado Japão/internacional"). Usado só na criação.' },
          fontes: { type: 'array', description: 'Fontes validadas [{url,label}], usado só na criação.', items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } } } },
          canal: { type: 'string', description: 'Canal de aviso (whatsapp/email/telegram), usado só na criação.' },
          itens: {
            type: 'array',
            description: 'Itens lidos das fontes NESTA rodada. Cada item: chave (URL estável do artigo, obrigatória p/ dedup), data (texto como aparece), titulo, url.',
            items: {
              type: 'object',
              properties: {
                chave: { type: 'string', description: 'Chave estável de dedup, use a URL do artigo.' },
                data: { type: 'string', description: 'Data do item como aparece na fonte.' },
                titulo: { type: 'string', description: 'Título/resumo curto do item.' },
                url: { type: 'string', description: 'Link do item.' },
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
      description: 'Lista os monitoramentos ativos do usuário (alvo, canal, quantos itens já vistos, último). Use pra saber o que já está sendo monitorado antes de criar outro.',
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
      description: 'Desativa um monitoramento inteiro (para de checar; o histórico de itens fica guardado). Use quando o usuário pedir pra parar de monitorar algo.',
      parameters: {
        type: 'object',
        properties: { monitor: { type: 'string', description: 'Nome do monitoramento a desativar.' } },
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
