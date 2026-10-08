// ── Trackers: structured record of dated/countable events ──────────────
// The primitive that replaces the "little system" that today lives on a free-text
// memory page (sugar-free days, workouts, weight, spending). The problem with text:
// non-deterministic writing (confirms without saving), rewrite drops lines, the
// model counts "in its head" and gets the date wrong. Here: registrar = 1-row INSERT
// (append-only), consultar = SQL aggregation (ready-made number, the model never
// counts), event_date separate from created_at. See projetos/tracker-primitiva.md.

import {
  resolveOrCreateTracker, resolveTracker, listTrackers, addTrackerEvent,
  aggregateTrackerEvents, listTrackerEventsByDay, removeTrackerEvent,
  disableTracker, getUserTimezone, listAppsForUser,
} from './db.mjs';

// "Today" in the user's local time, as 'YYYY-MM-DD' (locale sv = ISO).
function todayISO(tz) {
  return new Date().toLocaleDateString('sv', { timeZone: tz || 'America/Sao_Paulo' });
}

// Date-only arithmetic (no timezone): adds `days` to a 'YYYY-MM-DD'. Uses UTC
// noon so it doesn't slip a day.
function shiftISO(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolves an event's date from what the user said. Accepts ISO
// ('YYYY-MM-DD'), empty (=today) and some common relative terms. Returns ISO | null.
function resolveEventDate(data, tz) {
  const hoje = todayISO(tz);
  if (data == null || data === '') return hoje;
  const s = String(data).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'hoje') return hoje;
  if (s === 'ontem') return shiftISO(hoje, -1);
  if (s === 'anteontem') return shiftISO(hoje, -2);
  // dd/mm or dd/mm/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const [, dd, mm, yy] = m;
    const year = yy ? (yy.length === 2 ? `20${yy}` : yy) : hoje.slice(0, 4);
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

// Converts a named `periodo` into a [from, to] range (ISO). Week = Monday
// of this week through today. Returns {} for 'everything'/unknown (no bounds).
function periodRange(periodo, tz) {
  const hoje = todayISO(tz);
  switch (String(periodo || '').trim().toLowerCase()) {
    case 'hoje': return { de: hoje, ate: hoje };
    case '7dias': case '7d': return { de: shiftISO(hoje, -6), ate: hoje };
    case '30dias': case '30d': return { de: shiftISO(hoje, -29), ate: hoje };
    case 'semana': {
      const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay(); // 0=dom
      const back = dow === 0 ? 6 : dow - 1;                  // goes back to Monday
      return { de: shiftISO(hoje, -back), ate: hoje };
    }
    case 'mes': case 'mês': return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
    default: return {};
  }
}

// Tokenizes a name into normalized words (no accents, lowercase).
function slugTokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter(Boolean);
}

// Structural/generic words that do NOT count as a collision signal (otherwise
// any "Controle de X" would match any "Lista de Y"). What's left are the
// nouns that actually name the thing (bills, expenses, workout, sugar…).
const APP_STOP = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'para', 'por', 'no', 'na',
  'os', 'as', 'um', 'uma', 'minha', 'meu', 'minhas', 'meus', 'app', 'sistema',
  'planilha', 'controle', 'lista', 'registro', 'registros', 'dados', 'tabela',
]);

// Level 2 (deterministic check): before CREATING a new tracker, checks whether the
// name matches an app/spreadsheet the user already has. Returns the colliding app
// or null. Matches by slug substring OR by a shared significant token
// (>=4 letters, outside APP_STOP). Doesn't catch semantic synonyms (e.g. "custos" vs
// "contas"); that case is left for Level 1 (prompt, with the list of apps in the
// context). Best-effort: if listAppsForUser fails, it doesn't block.
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

// Assistant tools for THIS user (enter the registry per request).
// All non-gated: recording/querying the owner's own data is already authorized by the
// request; and the write is reversible (remover_evento).
export function trackersTools(userId, agentId) {
  return [
    {
      name: 'registrar_evento',
      description: 'Records a dated event in a "tracker" (a countable log the user keeps: days they ate sugar, workouts, weight, spending, cigarettes, etc.). USE THIS, and not text memory, whenever the user asks to note/mark/record something they will later want to COUNT or sum by period. Each call stores ONE occurrence (append-only, overwrites nothing). The tracker is created automatically on the first record. IMPORTANT: only confirm to the user ("anotei") AFTER receiving this tool\'s result; never say you noted it without calling it. WARNING: if the data seems to belong to an APP/spreadsheet the user already built (e.g. they say "anota na minha planilha de custos" and they have a bills/costs app), do NOT force a tracker: write to the app or ask them which one. When in doubt between an existing app and a new tracker, ask before writing.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Tracker name, e.g. "açúcar", "treino", "gasto". Created if it does not exist.' },
          data: { type: 'string', description: 'Event date. Accepts "YYYY-MM-DD", "hoje", "ontem", "anteontem" or "dd/mm". Omit for today. Resolve relative dates ("sexta") to the ISO date yourself, using today\'s date from the context.' },
          valor: { type: 'number', description: 'Amount, when it makes sense (e.g. 40 of spending, 72.5 of weight, 3 cigarettes). Omit to count 1 occurrence.' },
          nota: { type: 'string', description: 'Optional short note (e.g. "bombom depois do almoço").' },
          confirmar_novo: { type: 'boolean', description: 'Use true ONLY after the user confirms they want a NEW tracker, separate from an existing app/spreadsheet of theirs. Skips the collision check with apps and creates the tracker. Do not use on the first attempt.' },
        },
        required: ['tracker'],
      },
      async run({ tracker, data, valor, nota, confirmar_novo }) {
        const tz = (await getUserTimezone(userId)) || 'America/Sao_Paulo';
        const eventDate = resolveEventDate(data, tz);
        if (!eventDate) return `Não entendi a data "${data}". Me diga como YYYY-MM-DD (ex: ${todayISO(tz)}), ou "hoje"/"ontem".`;
        // Level 2: if it was going to CREATE a new tracker and the name collides with a
        // user's app, doesn't save; returns a question for the assistant to check with the owner.
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
      description: 'Queries a tracker and returns the ready-made COUNT (done in SQL, do not estimate). Returns: dias = how many DISTINCT dates had an event (use this for "quantos dias comeu açúcar"), eventos = number of occurrences, soma = total of the value (use for spending/amount). Pass a named "periodo" OR a de/ate range. Use before answering any counting question about a user\'s tracker.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Name of the tracker to query.' },
          periodo: { type: 'string', enum: ['hoje', 'semana', '7dias', '30dias', 'mes', 'tudo'], description: '"semana" = from Monday of this week through today. "mes" = from day 1 through today. Omit or "tudo" = no limit.' },
          de: { type: 'string', description: 'Start of the range (YYYY-MM-DD). Ignores "periodo" if used with "ate".' },
          ate: { type: 'string', description: 'End of the range (YYYY-MM-DD).' },
          detalhar: { type: 'boolean', description: 'If true, includes the per-day breakdown (which days and how much).' },
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
      description: 'Lists the trackers (countable logs) the user keeps, with how many occurrences each has and the date of the latest. Use when they ask "o que eu registro/acompanho" or to know which trackers exist before querying.',
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
      description: 'Removes occurrences from a tracker: by a specific date (deletes what was recorded that day) or by id. Use to fix a wrong entry ("apaga o açúcar de ontem", "eu não comi na terça"). Does not rewrite the rest of the history.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Tracker name.' },
          data: { type: 'string', description: 'Date to remove (YYYY-MM-DD, "hoje", "ontem"). Deletes all occurrences of that day.' },
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
      description: 'Deactivates an entire tracker (it disappears from the list; the history is not deleted). Use when the user wants to stop tracking something.',
      parameters: {
        type: 'object',
        properties: {
          tracker: { type: 'string', description: 'Name of the tracker to deactivate.' },
        },
        required: ['tracker'],
      },
      async run({ tracker }) {
        const res = await resolveTracker(userId, tracker);
        if (res.error === 'nao_encontrado') {
          // Routing: the model sometimes calls remover_tracker wanting to delete an
          // APP of the user's (both are "remove X by name"). If the name matches a
          // user's app, instead of a dead end it points to the right tool.
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

// Text for the system prompt: compact index of the user's trackers (progressive
// disclosure) + the routing rule (use tracker, not text memory, for
// countable data). The events do NOT enter here; they load via consultar_evento.
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
  // Level 1: gives the model the list of the user's own apps/spreadsheets, so it
  // does NOT create a tracker when the data belongs to one of their apps, and ASKS when in doubt.
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
