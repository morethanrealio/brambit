// Proactive calendar change notice (27/09/2026): when an event in the person's
// calendar changes time or place, or is cancelled by SOMEONE ELSE, the
// assistant tells them on its own, in the channel they use.
//
// How it works: each cycle the platform reads the next days of the calendar and
// compares with the snapshot saved in the previous cycle (calendar_watch_snap).
// No new OAuth scope (the read already granted is enough) and no new HTTP route
// (not a Google/Microsoft push, it's our own query). Detection and text are
// deterministic: no AI model runs here.
//
// Only notifies events ORGANIZED BY SOMEONE ELSE. The organizer is who changed
// it (or the assistant itself, at their request): notifying that would be
// telling them what they did themselves.
//
// On by default for everyone with a connected calendar (27/09): only whoever
// asks the assistant to turn it off opts out (calendar_watch.enabled = false).
// No row in calendar_watch = on.
const S = 'mtr_harness';
export const JANELA_DIAS = 7;
const MAX_AGENDAS = 5;
const CAL = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CAL_FEED = /(holiday|contacts)@group\.v\.calendar\.google\.com$/i;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${S}.calendar_watch (
    user_id uuid PRIMARY KEY,
    agent_id uuid,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_run_at timestamptz,
    last_error text
  );
  CREATE TABLE IF NOT EXISTS ${S}.calendar_watch_snap (
    user_id uuid NOT NULL,
    key text NOT NULL,
    data jsonb NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
  );`;

// ── Normalization ────────────────────────────────────────────────────────────
// Minimal snapshot of an event: only what decides whether a relevant change happened.
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

export function fotoGoogle(e) {
  const dia = !e.start?.dateTime;
  const self = (e.attendees || []).find((a) => a.self);
  return {
    titulo: e.summary || '(sem título)',
    inicio: dia ? (e.start?.date || null) : e.start?.dateTime,
    fim: dia ? (e.end?.date || null) : e.end?.dateTime,
    dia_inteiro: dia,
    local: e.location || '',
    cancelado: e.status === 'cancelled',
    // organizer.self = the organizer is the owner of this calendar.
    de_outra_pessoa: e.organizer ? !e.organizer.self : false,
    recusei: self?.responseStatus === 'declined',
  };
}

// Graph devolve dateTime sem offset no fuso pedido (Prefer: UTC).
const utc = (d) => (d?.dateTime ? `${String(d.dateTime).replace(/\.\d+$/, '').replace(/Z$/, '')}Z` : null);
export function fotoOutlook(e) {
  return {
    titulo: e.subject || '(sem título)',
    inicio: e.isAllDay ? String(e.start?.dateTime || '').slice(0, 10) : utc(e.start),
    fim: e.isAllDay ? String(e.end?.dateTime || '').slice(0, 10) : utc(e.end),
    dia_inteiro: !!e.isAllDay,
    local: e.location?.displayName || '',
    cancelado: !!e.isCancelled,
    de_outra_pessoa: e.isOrganizer === false,
    recusei: e.responseStatus?.response === 'declined',
  };
}

// ── Difference between two snapshots ──────────────────────────────────────────
// `atual` null = the event no longer exists (deleted/removed from the calendar).
export function mudancas(antes, atual) {
  if (!antes || !antes.de_outra_pessoa || antes.recusei || antes.cancelado) return [];
  if (!atual || atual.cancelado) return [{ tipo: 'cancelado' }];
  if (atual.recusei) return [];
  const out = [];
  const horaMudou = antes.dia_inteiro !== atual.dia_inteiro
    || (antes.dia_inteiro ? antes.inicio !== atual.inicio || antes.fim !== atual.fim
      : ms(antes.inicio) !== ms(atual.inicio) || ms(antes.fim) !== ms(atual.fim));
  if (horaMudou) out.push({ tipo: 'horario' });
  if ((antes.local || '').trim() !== (atual.local || '').trim()) out.push({ tipo: 'local' });
  return out;
}

// ── Texto ───────────────────────────────────────────────────────────────────
function quando(f, tz) {
  if (!f?.inicio) return '?';
  if (f.dia_inteiro) {
    const [, m, d] = f.inicio.split('-');
    return `${d}/${m} (dia inteiro)`;
  }
  const d = new Date(f.inicio);
  const data = d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return `${data.replace('.', '')} às ${hora}`;
}

export function linhaAviso({ antes, atual, lista }, tz = 'America/Sao_Paulo') {
  const t = `"${antes.titulo}"`;
  if (lista.some((m) => m.tipo === 'cancelado')) {
    return `${t}, que era ${quando(antes, tz)}, foi cancelado ou saiu da sua agenda.`;
  }
  const partes = [];
  if (lista.some((m) => m.tipo === 'horario')) partes.push(`mudou de ${quando(antes, tz)} para ${quando(atual, tz)}`);
  if (lista.some((m) => m.tipo === 'local')) partes.push(atual.local ? `o local agora é ${atual.local}` : 'ficou sem local definido');
  const ref = lista.some((m) => m.tipo === 'horario') ? '' : ` (${quando(atual, tz)})`;
  return `${t}${ref}: ${partes.join(' e ')}.`;
}

export function textoAviso(itens, tz) {
  if (!itens.length) return '';
  if (itens.length === 1) return `Mudança na sua agenda: ${linhaAviso(itens[0], tz)}`;
  return `Mudanças na sua agenda:\n\n${itens.map((i) => `• ${linhaAviso(i, tz)}`).join('\n')}`;
}

// ── Leitura das agendas ─────────────────────────────────────────────────────
class HttpErro extends Error { constructor(status, msg) { super(`${status}: ${msg}`); this.status = status; } }

async function getJson(fetchImpl, url, bearer, headers = {}) {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${bearer}`, ...headers } });
  if (!r.ok) throw new HttpErro(r.status, (await r.text()).slice(0, 200));
  return r.json();
}

// Returns { eventos: Map(key -> snapshot), completas: Set(calendar prefix) }.
// A calendar only enters `completas` if it was read in full, with no error and no
// leftover page: only for those does the ABSENCE of an event count as "gone".
async function lerGoogle({ fetchImpl, token, account, de, ate }) {
  const bearer = await token();
  const lista = await getJson(fetchImpl, `${CAL}/users/me/calendarList?minAccessRole=owner&maxResults=50`, bearer);
  const cals = (lista.items || []).filter((c) => c.id && !c.deleted && !CAL_FEED.test(c.id))
    .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)).slice(0, MAX_AGENDAS);
  const eventos = new Map();
  const completas = new Set();
  const buscar = {};
  for (const c of cals) {
    const prefixo = `g:${account}:${c.id}:`;
    const p = new URLSearchParams({ timeMin: de, timeMax: ate, singleEvents: 'true', showDeleted: 'true', maxResults: '250' });
    try {
      const r = await getJson(fetchImpl, `${CAL}/calendars/${encodeURIComponent(c.id)}/events?${p}`, bearer);
      for (const e of r.items || []) eventos.set(prefixo + e.id, fotoGoogle(e));
      if (!r.nextPageToken) completas.add(prefixo);
    } catch { /* calendar outside this cycle; its absence doesn't count */ }
    buscar[prefixo] = async (id) => {
      try { return fotoGoogle(await getJson(fetchImpl, `${CAL}/calendars/${encodeURIComponent(c.id)}/events/${encodeURIComponent(id)}`, bearer)); }
      catch (e) { if (e.status === 404 || e.status === 410) return null; throw e; }
    };
  }
  return { eventos, completas, buscar };
}

async function lerOutlook({ fetchImpl, token, de, ate }) {
  const bearer = await token();
  const prefixo = 'm:default:';
  const sel = 'id,subject,start,end,location,isAllDay,isCancelled,isOrganizer,responseStatus';
  const h = { Prefer: 'outlook.timezone="UTC"' };
  const eventos = new Map();
  const completas = new Set();
  const r = await getJson(fetchImpl, `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(de)}&endDateTime=${encodeURIComponent(ate)}&$top=250&$select=${sel}`, bearer, h);
  for (const e of r.value || []) eventos.set(prefixo + e.id, fotoOutlook(e));
  if (!r['@odata.nextLink']) completas.add(prefixo);
  const buscar = {
    [prefixo]: async (id) => {
      try { return fotoOutlook(await getJson(fetchImpl, `${GRAPH}/me/events/${encodeURIComponent(id)}?$select=${sel}`, bearer, h)); }
      catch (e) { if (e.status === 404 || e.status === 410) return null; throw e; }
    },
  };
  return { eventos, completas, buscar };
}

// ── Motor ───────────────────────────────────────────────────────────────────
// deps: pool, googleAccounts(userId) -> [{email, token()}], microsoftToken(userId) -> token()|null,
// timezone(userId), notify(userId, text), fetchImpl, now().
export function createCalendarWatch(deps) {
  const { pool, notify, fetchImpl = fetch, now = () => Date.now(), log = console } = deps;
  let pronto = null;
  const schema = () => (pronto ||= pool.query(SCHEMA).catch((e) => { pronto = null; throw e; }));

  async function setEnabled(userId, agentId, enabled) {
    await schema();
    await pool.query(
      `INSERT INTO ${S}.calendar_watch (user_id, agent_id, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, agent_id = COALESCE(EXCLUDED.agent_id, ${S}.calendar_watch.agent_id), updated_at = now()`,
      [userId, agentId || null, !!enabled],
    );
    // Turning it off discards the snapshot: when turned back on, the first read becomes the new baseline and
    // doesn't trigger a notice for everything that changed while it was off.
    if (!enabled) await pool.query(`DELETE FROM ${S}.calendar_watch_snap WHERE user_id = $1`, [userId]);
  }

  async function status(userId) {
    await schema();
    const { rows } = await pool.query(`SELECT enabled, last_run_at, last_error FROM ${S}.calendar_watch WHERE user_id = $1`, [userId]);
    return rows[0] || { enabled: true };
  }

  // One cycle for a person. Returns the items that were notified (or would be, in dryRun).
  async function checarUsuario(userId, { dryRun = false } = {}) {
    await schema();
    const t0 = now();
    const de = new Date(t0).toISOString();
    const ate = new Date(t0 + JANELA_DIAS * 86400_000).toISOString();
    const fontes = [];
    for (const a of (await deps.googleAccounts(userId)) || []) fontes.push(() => lerGoogle({ fetchImpl, token: a.token, account: a.email, de, ate }));
    const msToken = await deps.microsoftToken(userId);
    if (msToken) fontes.push(() => lerOutlook({ fetchImpl, token: msToken, de, ate }));
    // Candidate with no readable calendar at all (e.g.: only Gmail granted): nothing to do.
    if (!fontes.length) return { itens: [], erros: [] };

    const eventos = new Map();
    const completas = new Set();
    const buscar = {};
    const erros = [];
    for (const f of fontes) {
      try {
        const r = await f();
        for (const [k, v] of r.eventos) eventos.set(k, v);
        for (const c of r.completas) completas.add(c);
        Object.assign(buscar, r.buscar);
      } catch (e) { erros.push(String(e?.message ?? e).slice(0, 160)); }
    }

    const { rows } = await pool.query(`SELECT key, data FROM ${S}.calendar_watch_snap WHERE user_id = $1`, [userId]);
    const antes = new Map(rows.map((r) => [r.key, r.data]));
    const itens = [];
    const gravar = new Map();
    const apagar = [];
    const prefixoDe = (k) => Object.keys(buscar).find((p) => k.startsWith(p));

    for (const [key, foto] of antes) {
      let atual = eventos.get(key);
      if (atual === undefined) {
        // Already ended: left the window because it passed, not because it changed.
        const fim = foto.dia_inteiro ? ms(`${foto.fim}T23:59:59Z`) : ms(foto.fim);
        if (fim != null && fim <= t0) { apagar.push(key); continue; }
        const p = prefixoDe(key);
        // Calendar not read in full this cycle: can't claim it's gone.
        if (!p || !completas.has(p)) continue;
        // Disappeared from the window: it may have been deleted or rescheduled outside it.
        try { atual = await buscar[p](key.slice(p.length)); } catch { continue; }
      }
      const lista = mudancas(foto, atual);
      if (lista.length) itens.push({ antes: foto, atual, lista });
      if (!atual || atual.cancelado) apagar.push(key);
      else if (ms(atual.fim || atual.inicio) != null && ms(atual.fim || atual.inicio) < t0 - 86400_000) apagar.push(key);
      else if (JSON.stringify(atual) !== JSON.stringify(foto)) gravar.set(key, atual);
    }
    // New event enters the snapshot silently: the first time is baseline, not a change.
    for (const [key, foto] of eventos) if (!antes.has(key) && !foto.cancelado) gravar.set(key, foto);

    if (dryRun) return { itens, erros };
    if (itens.length) {
      const tz = (await deps.timezone(userId)) || 'America/Sao_Paulo';
      await notify(userId, textoAviso(itens, tz));
    }
    for (const [key, data] of gravar) {
      await pool.query(
        `INSERT INTO ${S}.calendar_watch_snap (user_id, key, data, seen_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, key) DO UPDATE SET data = EXCLUDED.data, seen_at = now()`,
        [userId, key, JSON.stringify(data)],
      );
    }
    if (apagar.length) await pool.query(`DELETE FROM ${S}.calendar_watch_snap WHERE user_id = $1 AND key = ANY($2::text[])`, [userId, apagar]);
    await pool.query(
      `INSERT INTO ${S}.calendar_watch (user_id, last_run_at, last_error) VALUES ($1, now(), $2)
       ON CONFLICT (user_id) DO UPDATE SET last_run_at = now(), last_error = EXCLUDED.last_error`,
      [userId, erros.length ? erros.join(' | ') : null],
    );
    return { itens, erros };
  }

  let rodando = false;
  async function tick() {
    if (rodando) return { pulado: true };
    rodando = true;
    let avisos = 0;
    try {
      await schema();
      // Whoever has a connected calendar (Google with calendar scope or Outlook with
      // Calendars.*; an old token with no recorded scope counts), minus whoever turned it off.
      // The fine-grained per-account filter lives in deps.googleAccounts/microsoftToken.
      const { rows } = await pool.query(
        `SELECT c.user_id FROM (
           SELECT user_id FROM ${S}.google_accounts WHERE scope ~ 'auth/calendar'
           UNION
           SELECT user_id FROM ${S}.oauth_tokens WHERE provider = 'microsoft' AND (scope IS NULL OR scope ~* 'calendars[.]')
         ) c
         JOIN ${S}.users u ON u.id = c.user_id AND u.deleted_at IS NULL
         WHERE NOT EXISTS (SELECT 1 FROM ${S}.calendar_watch w WHERE w.user_id = c.user_id AND NOT w.enabled)`,
      );
      for (const { user_id } of rows) {
        try { avisos += (await checarUsuario(user_id)).itens.length ? 1 : 0; }
        catch (e) { log.error?.('[calendar-watch]', user_id, e?.message ?? e); }
      }
      return { usuarios: rows.length, avisos };
    } finally { rodando = false; }
  }

  return { setEnabled, status, checarUsuario, tick };
}
