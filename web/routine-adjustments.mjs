// A correction the person makes to a routine has to outlive the next run.
// "No leg exercises, my knee is injured" or "I am travelling until Tuesday",
// said in the chat, used to change nothing: rewriting the routine's task text
// is a heavy edit the assistant rarely made, and a memory note is not read as
// part of the task. Here each routine keeps a short list of adjustments next
// to its task text. The assistant appends one line when the person corrects
// the routine, the person sees and removes them on the Routines screen, and
// every run receives the lines that still apply, with priority over the text.
//
// The list lives in routines.config.adjustments, as
//   { id, text, at (ISO instant), until? ('YYYY-MM-DD', last local day) }
// and every write is one SQL statement that touches only that key: a run that
// records its heartbeat or an edit of the routine at the same moment never
// loses a line, and a line never rewrites the rest of the configuration.
import { randomUUID } from 'node:crypto';
import { pool, S } from './db.mjs';
import { readBody } from './http-body.mjs';

// The list is read on every run and by the person on a phone screen.
export const MAX_ADJUSTMENTS = 10;
export const ADJUSTMENT_MAX_CHARS = 240;
// Routines with their own control follow structured parameters; their
// corrections go through those parameters, not through free lines.
const OWN_CONTROL_KEYS = ['curation', 'email_search', 'flight_monitor'];

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const localDay = (timeZone, at = new Date()) => safe(() => at.toLocaleDateString('en-CA', { timeZone }), at.toISOString().slice(0, 10));

export const routineHasOwnControl = (config) => OWN_CONTROL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(config || {}, k));

// The lines that still apply today in the routine's time zone, each with the
// local day it was noted on. An expired line is ignored here and dropped from
// the database on the next write.
export function activeAdjustments(config, { timeZone, now = new Date() } = {}) {
  const list = Array.isArray(config?.adjustments) ? config.adjustments : [];
  const today = localDay(timeZone, now);
  return list
    .filter((a) => a && typeof a.id === 'string' && oneLine(a.text) && (!a.until || a.until >= today))
    .map((a) => {
      const at = new Date(a.at);
      return { id: a.id, text: oneLine(a.text), noted: Number.isNaN(at.getTime()) ? '' : localDay(timeZone, at), ...(a.until ? { until: a.until } : {}) };
    });
}

// Returns the block already with the separation ('\n\n...') or '' when it does
// not apply. `adjustments` is the output of activeAdjustments.
export function routineAdjustmentsBlock(adjustments = [], { kind, ownControl = false } = {}) {
  if (kind !== 'routine' || ownControl || !adjustments?.length) return '';
  const lines = adjustments.slice(-MAX_ADJUSTMENTS).map((a) => {
    const meta = [a.noted ? `noted ${a.noted}` : '', a.until ? `applies until ${a.until}` : ''].filter(Boolean).join(', ');
    return `- ${meta ? `(${meta}) ` : ''}${a.text.slice(0, ADJUSTMENT_MAX_CHARS)}`;
  });
  return '\n\n[ADJUSTMENTS THE PERSON ASKED FOR IN THIS ROUTINE] After this routine was created, the person asked for the changes below. They are part of the task and all of them apply TODAY: where one conflicts with the task text, the adjustment wins. Apply them silently, without listing them or saying that you applied them. When the task makes no sense today because of one of them (the person is away, sick, or asked to skip it for a while), deliver one short line saying so and why, instead of the usual content.\n'
    + lines.join('\n');
}

// SQL: today's date in the routine's own time zone, and the stored lines that
// have not expired (optionally without one of them).
const TODAY = `to_char(now() AT TIME ZONE r.tz, 'YYYY-MM-DD')`;
const STORED = `CASE WHEN jsonb_typeof(r.config->'adjustments') = 'array' THEN r.config->'adjustments' ELSE '[]'::jsonb END`;
const kept = (extra = '') => `coalesce((SELECT jsonb_agg(x.e ORDER BY x.o) FROM jsonb_array_elements(${STORED}) WITH ORDINALITY AS x(e, o) WHERE coalesce(x.e->>'until', '9999-12-31') >= ${TODAY}${extra}), '[]'::jsonb)`;

// Appends one line. Returns { ok: true, adjustment, adjustments } or
// { ok: false, code } with code INVALID_TEXT, TEXT_TOO_LONG, INVALID_DATE,
// NOT_FOUND, OWN_CONTROL, PAST_DATE or FULL (FULL carries the current lines, so
// the caller can ask which one to remove). The same text noted twice is not
// duplicated: the existing line comes back with `already: true`.
export async function addRoutineAdjustment({ routineId, userId, text, until }, db = pool, schema = S) {
  const line = oneLine(text);
  if (!line) return { ok: false, code: 'INVALID_TEXT' };
  if (line.length > ADJUSTMENT_MAX_CHARS) return { ok: false, code: 'TEXT_TOO_LONG' };
  const day = until == null || until === '' ? null : String(until).trim();
  if (day !== null && !isDay(day)) return { ok: false, code: 'INVALID_DATE' };
  const adjustment = { id: randomUUID().slice(0, 6), text: line, at: new Date().toISOString(), ...(day ? { until: day } : {}) };
  const { rows } = await db.query(
    `UPDATE ${schema}.routines r
        SET config = jsonb_set(coalesce(r.config, '{}'::jsonb), '{adjustments}', ${kept()} || jsonb_build_array($3::jsonb))
      WHERE r.id = $1 AND r.user_id = $2
        AND NOT (coalesce(r.config, '{}'::jsonb) ?| $4::text[])
        AND jsonb_array_length(${kept()}) < $5
        AND ($6::text IS NULL OR $6::text >= ${TODAY})
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${kept()}) d WHERE lower(d->>'text') = lower($7::text))
      RETURNING r.config, r.tz`,
    [routineId, userId, JSON.stringify(adjustment), OWN_CONTROL_KEYS, MAX_ADJUSTMENTS, day, line],
  );
  if (rows[0]) return { ok: true, adjustment, adjustments: activeAdjustments(rows[0].config, { timeZone: rows[0].tz }) };
  // Nothing was written: read why.
  const { rows: found } = await db.query(
    `SELECT r.config, r.tz, ${TODAY} AS today FROM ${schema}.routines r WHERE r.id = $1 AND r.user_id = $2`, [routineId, userId]);
  const row = found[0];
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (routineHasOwnControl(row.config)) return { ok: false, code: 'OWN_CONTROL' };
  if (day && day < row.today) return { ok: false, code: 'PAST_DATE', today: row.today };
  const adjustments = activeAdjustments(row.config, { timeZone: row.tz });
  const same = adjustments.find((a) => a.text.toLowerCase() === line.toLowerCase());
  if (same) return { ok: true, already: true, adjustment: same, adjustments };
  return { ok: false, code: 'FULL', adjustments };
}

// Removes one line by its id. Returns { ok: true, removed, adjustments } or
// { ok: false, code: 'NOT_FOUND', adjustments } with the lines that exist.
export async function removeRoutineAdjustment({ routineId, userId, adjustmentId }, db = pool, schema = S) {
  const id = String(adjustmentId ?? '').trim().replace(/^#/, '');
  const { rows } = await db.query(
    `WITH before AS (SELECT o.id, o.config FROM ${schema}.routines o WHERE o.id = $1 AND o.user_id = $2 FOR UPDATE)
     UPDATE ${schema}.routines r
        SET config = jsonb_set(r.config, '{adjustments}', ${kept(` AND x.e->>'id' <> $3`)})
       FROM before
      WHERE r.id = before.id
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${STORED}) d WHERE d->>'id' = $3)
      RETURNING before.config AS before, r.config, r.tz`,
    [routineId, userId, id],
  );
  if (rows[0]) {
    const removed = (rows[0].before?.adjustments || []).find((a) => a?.id === id);
    return { ok: true, removed: { id, text: oneLine(removed?.text) }, adjustments: activeAdjustments(rows[0].config, { timeZone: rows[0].tz }) };
  }
  const { rows: found } = await db.query(`SELECT r.config, r.tz FROM ${schema}.routines r WHERE r.id = $1 AND r.user_id = $2`, [routineId, userId]);
  return { ok: false, code: 'NOT_FOUND', adjustments: found[0] ? activeAdjustments(found[0].config, { timeZone: found[0].tz }) : [] };
}

// One line per adjustment for the model, with the code it needs to remove it.
const listed = (adjustments) => adjustments.map((a) => `[${a.id}] ${a.text}${a.until ? ` (applies until ${a.until})` : ''}`);

// What listar_rotinas shows under a routine: '' when there is nothing noted.
export function routineAdjustmentsListing(routine) {
  const adjustments = routineHasOwnControl(routine?.config) ? [] : activeAdjustments(routine?.config, { timeZone: routine?.tz });
  return adjustments.length ? `\nAdjustments noted on this routine (note_routine_adjustment adds, remove_routine_adjustment removes by the [code]): ${listed(adjustments).join('; ')}` : '';
}

const WHY_NOT = {
  INVALID_TEXT: 'The adjustment text is empty. Nothing was noted.',
  TEXT_TOO_LONG: `The adjustment has more than ${ADJUSTMENT_MAX_CHARS} characters. Nothing was noted: rewrite it as one short line and call again.`,
  INVALID_DATE: 'valid_until must be a real date in the YYYY-MM-DD format. Nothing was noted.',
  NOT_FOUND: 'This routine no longer exists. Nothing was noted.',
  OWN_CONTROL: 'This routine follows structured parameters (curation criteria, e-mail search or flight monitor) and takes no free adjustments. Nothing was noted: change its parameters with editar_rotina instead.',
};

// The two chat tools. They run right away, with no confirmation card: an
// adjustment is one visible, removable line, and the assistant tells the
// owner what it noted. A routine's own run never gets them (the dispatch
// removes configuration tools), so a routine cannot adjust itself.
export const ROUTINE_ADJUSTMENT_TOOLS = ['note_routine_adjustment', 'remove_routine_adjustment'];
export function createRoutineAdjustmentTools({ userId, listRoutines, resolveRoutine, routineCode, add = addRoutineAdjustment, remove = removeRoutineAdjustment }) {
  // resolveRoutine writes its message, in Portuguese, around the verb it gets.
  const routineOf = async ({ id, title }, tool, verbo = 'ajustar') => {
    const rows = await listRoutines(userId);
    if (!rows.length) return { error: 'The user has no routines.' };
    const sel = resolveRoutine(rows, { id, titulo: title, verbo, tool });
    return sel.err ? { error: sel.err } : { row: sel.row, label: `"${sel.row.title}" (#${routineCode(sel.row, rows)})` };
  };
  const which = {
    title: { type: 'string', description: 'Title (or part of it) of the routine.' },
    id: { type: 'string', description: 'OPTIONAL. Routine code (the #xxxx from listar_rotinas). Use it when two routines have the same or similar titles.' },
  };
  return [{
    name: ROUTINE_ADJUSTMENT_TOOLS[0],
    description: `Notes a lasting ADJUSTMENT on one of the user's recurring routines: one short line that every next run of that routine follows, with priority over the routine's task text. Use it when the owner corrects or reshapes WHAT a routine delivers in a way that must still hold on the next runs: a restriction ("no leg exercises, my knee is injured"), a preference ("shorter, please", "skip the quote at the end"), or a fact that changes the delivery for some days ("I am travelling until Tuesday, the hotel has no gym": pass valid_until with that Tuesday). The routine they mean is usually the one whose delivery appears just above in this conversation, under its title. Do NOT use it to change the schedule, the channel or the title, to pause or resume (that is editar_rotina or cancelar_rotina), nor when the owner asks to rewrite the whole task (editar_rotina). It takes effect right away, with no confirmation card: after it returns ok, tell the owner in one sentence what you noted (and until when, if it has an end), and that they can see or remove it on the Routines screen or by asking you. Write the line in the owner's language and self-contained, because the routine reads it without this conversation. Several separate changes are one call each. A routine keeps at most ${MAX_ADJUSTMENTS} adjustments.`,
    parameters: {
      type: 'object',
      properties: {
        ...which,
        text: { type: 'string', description: `The adjustment, as one short self-contained line in the owner's language (at most ${ADJUSTMENT_MAX_CHARS} characters). Example: "No leg exercises: knee injury."` },
        valid_until: { type: 'string', description: 'OPTIONAL. Last day the adjustment applies, as YYYY-MM-DD, when the owner gave it an end ("until Tuesday", "this week", "tomorrow only"). Without it the adjustment stays until someone removes it.' },
      },
      required: ['text'],
    },
    run: async ({ title, id, text, valid_until } = {}) => {
      const sel = await routineOf({ id, title }, ROUTINE_ADJUSTMENT_TOOLS[0]);
      if (sel.error) return { ok: false, error: sel.error };
      const out = await add({ routineId: sel.row.id, userId, text, until: valid_until });
      if (out.ok) return { ok: true, routine: sel.label, result: out.already ? 'already_noted' : 'noted', adjustment: listed([out.adjustment])[0],
        note: out.already ? 'This same adjustment was already noted. Nothing changed.' : 'Noted. The next runs of this routine follow it. Tell the owner what you noted and that it can be seen or removed on the Routines screen.' };
      if (out.code === 'PAST_DATE') return { ok: false, routine: sel.label, error: `valid_until is before today (${out.today}) in the routine's time zone. Nothing was noted.` };
      if (out.code === 'FULL') return { ok: false, routine: sel.label, adjustments: listed(out.adjustments),
        error: `This routine already has ${MAX_ADJUSTMENTS} adjustments, the limit. Nothing was noted. Show the owner the current ones and ask which to remove (remove_routine_adjustment), or offer to rewrite the routine's task with editar_rotina so it absorbs them.` };
      return { ok: false, routine: sel.label, error: WHY_NOT[out.code] || 'Nothing was noted.' };
    },
  }, {
    name: ROUTINE_ADJUSTMENT_TOOLS[1],
    description: 'Removes one adjustment noted on a recurring routine. Use it when the owner says an adjustment no longer applies ("my knee is fine now", "I am back from the trip", "forget that rule"). The adjustments of each routine and their [codes] come in listar_rotinas. It takes effect right away, with no confirmation card: after it returns ok, tell the owner in one sentence what was removed.',
    parameters: {
      type: 'object',
      properties: {
        ...which,
        adjustment: { type: 'string', description: 'Code of the adjustment to remove (the [xxxxxx] shown in listar_rotinas).' },
      },
      required: ['adjustment'],
    },
    run: async ({ title, id, adjustment } = {}) => {
      const sel = await routineOf({ id, title }, ROUTINE_ADJUSTMENT_TOOLS[1]);
      if (sel.error) return { ok: false, error: sel.error };
      const out = await remove({ routineId: sel.row.id, userId, adjustmentId: adjustment });
      if (out.ok) return { ok: true, routine: sel.label, result: 'removed', removed: out.removed.text, remaining: listed(out.adjustments),
        note: 'Removed. The next runs of this routine no longer follow it.' };
      return { ok: false, routine: sel.label, adjustments: listed(out.adjustments),
        error: out.adjustments.length ? 'No adjustment with this code on this routine. Nothing was removed. The current ones are listed in `adjustments`: call again with the right [code].' : 'This routine has no adjustments. Nothing was removed.' };
    },
  }];
}

// The Routines screen removes a line here. The scope is the signed-in person:
// the statement only finds a routine that is theirs.
export function registerRoutineAdjustmentRoutes(rotas, { remove = removeRoutineAdjustment } = {}) {
  rotas.registrar('POST', '/api/routine/adjustment/remove', async (req, res, url, ctx) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const user = await ctx.currentUser?.();
      if (!user) return reply(401, { error: 'unauthorized' });
      const { id, adjustment } = await readBody(req);
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || typeof adjustment !== 'string' || !adjustment.trim()) return reply(400, { error: 'invalid_request' });
      const out = await remove({ routineId: id, userId: user.id, adjustmentId: adjustment });
      return out.ok ? reply(200, { ok: true }) : reply(404, { error: 'adjustment_not_found' });
    } catch (e) {
      console.error('[routine adjustment]', e?.message ?? e);
      return reply(500, { error: 'adjustment_not_removed' });
    }
  });
}
