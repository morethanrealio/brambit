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
