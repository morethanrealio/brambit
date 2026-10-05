// ── Trackers: registro estruturado de eventos datados/contáveis ──────────────
// A primitiva que substitui o "sisteminha" que hoje vive numa página de memória
// em texto livre (dias com açúcar, treinos, peso, gasto). O problema do texto:
// escrita não-determinística (confirma sem gravar), rewrite dropa linhas, o
// modelo conta "de cabeça" e erra a data. Aqui: registrar = INSERT de 1 linha
// (append-only), consultar = agregação em SQL (número pronto, o modelo nunca
// conta), event_date separado de created_at. Ver projetos/tracker-primitiva.md.

import {
  resolveOrCreateTracker, resolveTracker, listTrackers, addTrackerEvent,
  aggregateTrackerEvents, listTrackerEventsByDay, removeTrackerEvent,
  disableTracker, getUserTimezone, listAppsForUser,
} from './db.mjs';

// "Hoje" na hora local do usuário, como 'YYYY-MM-DD' (locale sv = ISO).
function todayISO(tz) {
  return new Date().toLocaleDateString('sv', { timeZone: tz || 'America/Sao_Paulo' });
}

// Aritmética de data-só (sem fuso): soma `days` a um 'YYYY-MM-DD'. Usa meio-dia
// UTC pra não escorregar de dia.
function shiftISO(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolve a data de um evento a partir do que o usuário disse. Aceita ISO
// ('YYYY-MM-DD'), vazio (=hoje) e alguns relativos comuns. Devolve ISO | null.
function resolveEventDate(data, tz) {
  const hoje = todayISO(tz);
  if (data == null || data === '') return hoje;
  const s = String(data).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'hoje') return hoje;
  if (s === 'ontem') return shiftISO(hoje, -1);
  if (s === 'anteontem') return shiftISO(hoje, -2);
  // dd/mm ou dd/mm/aaaa
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const [, dd, mm, yy] = m;
    const year = yy ? (yy.length === 2 ? `20${yy}` : yy) : hoje.slice(0, 4);
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

// Converte um `periodo` nomeado em intervalo [de, ate] (ISO). Semana = segunda
// desta semana até hoje. Devolve {} pra 'tudo'/desconhecido (sem limites).
function periodRange(periodo, tz) {
  const hoje = todayISO(tz);
  switch (String(periodo || '').trim().toLowerCase()) {
    case 'hoje': return { de: hoje, ate: hoje };
    case '7dias': case '7d': return { de: shiftISO(hoje, -6), ate: hoje };
    case '30dias': case '30d': return { de: shiftISO(hoje, -29), ate: hoje };
    case 'semana': {
      const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay(); // 0=dom
      const back = dow === 0 ? 6 : dow - 1;                  // volta até segunda
      return { de: shiftISO(hoje, -back), ate: hoje };
    }
    case 'mes': case 'mês': return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
    default: return {};
  }
}

// Tokeniza um nome em palavras normalizadas (sem acento, minúsculas).
function slugTokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter(Boolean);
}

// Palavras estruturais/genéricas que NÃO contam como sinal de colisão (senão
// qualquer "Controle de X" bateria com qualquer "Lista de Y"). Sobram os
// substantivos que de fato nomeiam a coisa (contas, gastos, treino, açúcar…).
const APP_STOP = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'para', 'por', 'no', 'na',
  'os', 'as', 'um', 'uma', 'minha', 'meu', 'minhas', 'meus', 'app', 'sistema',
  'planilha', 'controle', 'lista', 'registro', 'registros', 'dados', 'tabela',
]);

// Nível 2 (checagem determinística): antes de CRIAR um tracker novo, vê se o
// nome bate com um app/planilha que o usuário já tem. Retorna o app colidente
// ou null. Casa por substring do slug OU por token significativo compartilhado
// (>=4 letras, fora do APP_STOP). Não pega sinônimo semântico (ex: "custos" vs
// "contas"); esse caso fica pro Nível 1 (prompt, com a lista de apps no
// contexto). Best-effort: se listAppsForUser falhar, não bloqueia.
async function findAppCollision(userId, trackerName) {
  let apps = [];
  try { apps = await listAppsForUser(userId); } catch { return null; }
  if (!apps || !apps.length) return null;
  const tTok = slugTokens(trackerName);
  const tSlug = tTok.join('-');
  const tSet = new Set(tTok.filter((w) => w.length >= 4 && !APP_STOP.has(w)));
  if (!tSlug && !tSet.size) return null;
  for (const a of apps) {
    const aTok = slugTokens(`${a.label || ''} ${a.system || ''}`);
    const aSlug = aTok.join('-');
    const aSet = new Set(slugTokens(`${a.label || ''} ${a.system || ''} ${a.description || ''}`)
      .filter((w) => w.length >= 4 && !APP_STOP.has(w)));
    const sub = tSlug && aSlug && (aSlug.includes(tSlug) || tSlug.includes(aSlug));
    let shared = false;
    for (const w of tSet) if (aSet.has(w)) { shared = true; break; }
    if (sub || shared) return a;
  }
  return null;
}

// Tools do assistente pra ESTE usuário (entram no registry por requisição).
// Todas não-gated: registrar/consultar dado do próprio dono já é autorizado pelo
// pedido; e a escrita é reversível (remover_evento).
export function trackersTools(userId, agentId) {
  return [
    {
      name: 'registrar_evento',
      description: 'Registra um evento datado num "tracker" (um registro contável que o usuário mantém: dias que comeu açúcar, treinos, peso, gasto, cigarros, etc.). USE ISTO, e não a memória em texto, sempre que o usuário pedir pra anotar/marcar/registrar algo que depois ele vai querer CONTAR ou somar por período. Cada chamada grava UMA ocorrência (append-only, não sobrescreve nada). O tracker é criado automaticamente no primeiro registro. IMPORTANTE: só confirme pro usuário ("anotei") DEPOIS de receber o retorno desta tool; nunca diga que anotou sem chamá-la. ATENÇÃO: se o dado parece pertencer a um APP/planilha que o usuário já construiu (ex: ele diz "anota na minha planilha de custos" e existe um app dele de contas/custos), NÃO force um tracker: grave no app ou pergunte a ele qual é. Na dúvida entre um app existente e um acompanhamento novo, pergunte antes de gravar.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Nome do registro, ex: "açúcar", "treino", "gasto". Se não existir, é criado.' },
          data: { type: 'string', description: 'Data do evento. Aceita "YYYY-MM-DD", "hoje", "ontem", "anteontem" ou "dd/mm". Omita para hoje. Resolva relativos ("sexta") para a data ISO você mesmo, usando a data de hoje do contexto.' },
          valor: { type: 'number', description: 'Quantidade, quando fizer sentido (ex: 40 de gasto, 72.5 de peso, 3 cigarros). Omita para contar 1 ocorrência.' },
          nota: { type: 'string', description: 'Observação curta opcional (ex: "bombom depois do almoço").' },
          confirmar_novo: { type: 'boolean', description: 'Use true APENAS depois que o usuário confirmar que é pra criar um acompanhamento NOVO, separado de um app/planilha existente dele. Pula a checagem de colisão com apps e cria o tracker. Não use na primeira tentativa.' },
        },
        required: ['tracker'],
      },
      async run({ tracker, data, valor, nota, confirmar_novo }) {
        const tz = (await getUserTimezone(userId)) || 'America/Sao_Paulo';
        const eventDate = resolveEventDate(data, tz);
        if (!eventDate) return `Não entendi a data "${data}". Me diga como YYYY-MM-DD (ex: ${todayISO(tz)}), ou "hoje"/"ontem".`;
        // Nível 2: se ia CRIAR um tracker novo e o nome colide com um app do
        // usuário, não grava; devolve pergunta pro assistente checar com o dono.
        if (!confirmar_novo) {
          const existing = await resolveTracker(userId, tracker);
          if (existing.error === 'nome_vazio') return 'Preciso do nome do registro (ex: "açúcar").';
          if (existing.error === 'ambiguo') return `Tenho mais de um registro parecido: ${existing.options.join(', ')}. Qual deles?`;
          if (existing.error === 'nao_encontrado') {
            const app = await findAppCollision(userId, tracker);
            if (app) {
              return `PERGUNTE AO USUÁRIO ANTES DE GRAVAR: ele tem um app/planilha chamado "${app.label || app.system}". Este registro ("${tracker}") é pra gravar nesse app dele, ou é pra começar um acompanhamento novo e separado? Se ele confirmar que é novo, chame de novo com confirmar_novo:true. Não inventei nada ainda, nada foi gravado.`;
            }
          }
        }
        const kind = valor != null ? 'quantity' : 'count';
        const r = await resolveOrCreateTracker(userId, tracker, agentId, { kind });
        if (r.error === 'nome_vazio') return 'Preciso do nome do registro (ex: "açúcar").';
        if (r.error === 'ambiguo') return `Tenho mais de um registro parecido: ${r.options.join(', ')}. Qual deles?`;
        if (r.error) return `Não consegui abrir o registro (${r.error}).`;
        const ev = await addTrackerEvent(r.tracker.id, userId, agentId, {
          eventDate, value: valor, note: nota, source: 'chat',
        });
        const criou = r.created ? ` (registro "${r.tracker.title}" criado agora)` : '';
        const vtxt = valor != null ? ` valor ${ev.value}` : '';
        return `Registrado em "${r.tracker.title}": ${ev.eventDate}${vtxt}${criou}.`;
      },
    },
    {
      name: 'consultar_evento',
      description: 'Consulta um tracker e devolve a CONTAGEM pronta (feita em SQL, não estime). Retorna: dias = quantas datas DISTINTAS tiveram evento (use isto pra "quantos dias comeu açúcar"), eventos = nº de ocorrências, soma = total do valor (use pra gasto/quantidade). Passe um "periodo" nomeado OU um intervalo de/até. Use antes de responder qualquer pergunta de contagem sobre um registro do usuário.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Nome do registro a consultar.' },
          periodo: { type: 'string', enum: ['hoje', 'semana', '7dias', '30dias', 'mes', 'tudo'], description: '"semana" = de segunda desta semana até hoje. "mes" = do dia 1 até hoje. Omita ou "tudo" = sem limite.' },
          de: { type: 'string', description: 'Início do intervalo (YYYY-MM-DD). Ignora "periodo" se usado com "ate".' },
          ate: { type: 'string', description: 'Fim do intervalo (YYYY-MM-DD).' },
          detalhar: { type: 'boolean', description: 'Se true, inclui a quebra por dia (quais dias e quanto).' },
        },
        required: ['tracker'],
      },
      async run({ tracker, periodo, de, ate, detalhar }) {
        const tz = (await getUserTimezone(userId)) || 'America/Sao_Paulo';
        const res = await resolveTracker(userId, tracker);
        if (res.error === 'nao_encontrado') return `Você ainda não tem um registro "${tracker}". Quando você mandar anotar algo nele, eu crio.`;
        if (res.error === 'ambiguo') return `Tenho mais de um registro parecido: ${res.options.join(', ')}. Qual deles?`;
        if (res.error) return `Não consegui abrir o registro (${res.error}).`;
        const range = (de || ate) ? { de, ate } : periodRange(periodo, tz);
        const agg = await aggregateTrackerEvents(res.tracker.id, range);
        const out = {
          registro: res.tracker.title,
          periodo: range.de || range.ate ? { de: range.de || null, ate: range.ate || null } : 'tudo',
          dias: agg.dias, eventos: agg.eventos, soma: agg.soma,
        };
        if (res.tracker.unit) out.unidade = res.tracker.unit;
        if (detalhar) out.por_dia = await listTrackerEventsByDay(res.tracker.id, range);
        return JSON.stringify(out);
      },
    },
    {
      name: 'listar_trackers',
      description: 'Lista os trackers (registros contáveis) que o usuário mantém, com quantas ocorrências cada um tem e a data do último. Use quando ele perguntar "o que eu registro/acompanho" ou pra saber que registros existem antes de consultar.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const list = await listTrackers(userId);
        if (!list.length) return 'Você ainda não tem nenhum registro/tracker. Me peça pra anotar algo (ex: "anota que comi açúcar hoje") que eu começo um.';
        return JSON.stringify(list.map((t) => ({
          registro: t.title, ocorrencias: t.eventos, ultimo: t.ultimo || undefined, unidade: t.unit || undefined,
        })));
      },
    },
    {
      name: 'remover_evento',
      description: 'Remove ocorrências de um tracker: por uma data específica (apaga o que foi registrado naquele dia) ou por id. Use pra corrigir um lançamento errado ("apaga o açúcar de ontem", "eu não comi na terça"). Não reescreve o resto do histórico.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Nome do registro.' },
          data: { type: 'string', description: 'Data a remover (YYYY-MM-DD, "hoje", "ontem"). Apaga todas as ocorrências desse dia.' },
        },
        required: ['tracker', 'data'],
      },
      async run({ tracker, data }) {
        const tz = (await getUserTimezone(userId)) || 'America/Sao_Paulo';
        const res = await resolveTracker(userId, tracker);
        if (res.error === 'nao_encontrado') return `Não achei um registro "${tracker}".`;
        if (res.error === 'ambiguo') return `Tenho mais de um registro parecido: ${res.options.join(', ')}. Qual deles?`;
        if (res.error) return `Não consegui abrir o registro (${res.error}).`;
        const eventDate = resolveEventDate(data, tz);
        if (!eventDate) return `Não entendi a data "${data}".`;
        const n = await removeTrackerEvent(res.tracker.id, { eventDate });
        return n
          ? `Removi ${n} ${n === 1 ? 'lançamento' : 'lançamentos'} de "${res.tracker.title}" em ${eventDate}.`
          : `Não havia nada registrado em "${res.tracker.title}" no dia ${eventDate}.`;
      },
    },
    {
      name: 'remover_tracker',
      description: 'Desativa um tracker inteiro (some da lista; o histórico não é apagado). Use quando o usuário quiser parar de acompanhar um registro.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Nome do registro a desativar.' },
        },
        required: ['tracker'],
      },
      async run({ tracker }) {
        const res = await resolveTracker(userId, tracker);
        if (res.error === 'nao_encontrado') {
          // Roteamento: o modelo às vezes chama remover_tracker querendo apagar um
          // APP do usuário (as duas são "remover X pelo nome"). Se o nome bate com um
          // app dele, em vez do beco sem saída aponta pra ferramenta certa.
          const app = await findAppCollision(userId, tracker);
          if (app) return `"${app.label || app.system}" é um APP/sistema seu, não um registro/tracker. Pra apagar o app use a ferramenta apagar_sistema (não remover_tracker).`;
          return `Não achei um registro "${tracker}".`;
        }
        if (res.error === 'ambiguo') return `Tenho mais de um registro parecido: ${res.options.join(', ')}. Qual deles?`;
        if (res.error) return `Não consegui abrir o registro (${res.error}).`;
        await disableTracker(userId, res.tracker.id);
        return `Parei de acompanhar "${res.tracker.title}" (o histórico fica guardado, mas ele sai da lista).`;
      },
    },
  ];
}

// Texto pro system prompt: índice compacto dos trackers do usuário (progressive
// disclosure) + a regra de roteamento (usar tracker, não memória em texto, pra
// dado contável). Os eventos NÃO entram aqui; carregam via consultar_evento.
export async function trackersContext(userId) {
  const list = await listTrackers(userId);
  const lines = [
    'REGISTROS/TRACKERS (dado datado e contável do usuário: dias com açúcar, treinos, peso, gasto, etc.). Quando ele pedir pra ANOTAR/marcar algo que depois vai querer CONTAR ou somar, use registrar_evento (NUNCA guarde isso em página de memória em texto: lá a contagem fica errada). Só diga que anotou depois do retorno da tool. Pra responder "quantos/quanto", use consultar_evento (a contagem vem pronta do banco; não conte você mesmo).',
  ];
  if (list.length) {
    lines.push('Registros que o usuário já mantém:');
    for (const t of list) {
      const u = t.unit ? `, em ${t.unit}` : '';
      const last = t.ultimo ? `, último em ${t.ultimo}` : '';
      lines.push(`• ${t.title} (${t.eventos} ocorrências${u}${last})`);
    }
  }
  // Nível 1: dá ao modelo a lista de apps/planilhas do próprio usuário, pra ele
  // NÃO criar um tracker quando o dado é de um app dele, e PERGUNTAR na dúvida.
  let apps = [];
  try { apps = await listAppsForUser(userId); } catch { apps = []; }
  if (apps.length) {
    lines.push(
      `O usuário também tem estes apps/planilhas próprios: ${apps.map((a) => `"${a.label || a.system}"`).join(', ')}. `
      + 'Se o que ele mandou anotar pertence a um desses (ex: "anota na minha planilha de custos" e existe um app de contas/custos), NÃO crie tracker: grave no app dele ou pergunte qual é. Na dúvida entre um app existente e um acompanhamento novo, pergunte uma linha antes de gravar, não adivinhe.',
    );
  }
  return lines.join('\n');
}
