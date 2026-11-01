import { parseRoutineTime } from './routine-time.mjs';
import { normalizeRoutineDays, isPauseOnlyRoutineChange } from './scheduler.mjs';
import { routineConfirmationSnapshot } from './confirmation-bindings.mjs';
import { confirmationFingerprint } from './confirmation-store.mjs';

// Editing a routine WITH NO CREDIT. Over credit the model never runs, so the only
// way to touch a routine from chat is the no-credit management turn (server.mjs).
// That turn used to carry only cancelar_rotina (pause/delete): a request to CHANGE
// a routine (time, days, channel, title, text) or to RESUME it opened the turn and
// found no tool, so the owner was told it could not be done until they topped up.
//
// This is a NARROW editar_rotina for that turn only. It reuses the same tool name,
// so the confirmation card (confirm-sentences.mjs) and the already-confirmed
// free-execution path (server.mjs) render and run exactly as for the full tool: a
// plain pause runs on the spot, any other change is proposed as a card and honored
// for free on the next turn. It deliberately leaves out curation, e-mail search,
// testar_agora, time zone and the end date: those are the rare edits, they need
// external I/O or a real test run that would spend out of budget, and for them the
// owner really does need credit. Keeping them out is also why this stays a small,
// self-contained module instead of threading the full tool's ~25 dependencies.

function normChannel(canal) {
  const c = String(canal ?? '').toLowerCase().trim();
  if (!c) return { ch: '' };
  if (['app', 'none', 'nenhum', 'so app', 'só app', 'somente app', 'nada'].includes(c)) return { ch: 'none' };
  if (!['telegram', 'email', 'whatsapp'].includes(c)) {
    return { error: `Canal "${canal}" não reconhecido. Use telegram, whatsapp, email, ou app (fica só no app, sem empurrar em canal nenhum).` };
  }
  return { ch: c };
}
const entregaLabel = (ch) => (!ch || ch === 'none' ? 'só no app' : `no ${ch}`);

function checkEditArgs(args = {}) {
  const horario = parseRoutineTime({ hora: args.hora, minuto: args.minuto });
  if (horario.error) return horario.error;
  const cad = normalizeRoutineDays(args);
  if (cad.error) return cad.error;
  const ch = normChannel(args.canal);
  if (ch.error) return ch.error;
  return null;
}

export function createNoCreditEditRoutineTool({ userId, listRoutines, updateRoutine, resolveRoutine, routineCadence }) {
  const locate = async (args) => {
    const rows = await listRoutines(userId);
    if (!rows.length) return { err: 'O dono não tem nenhuma rotina pra alterar.' };
    const sel = resolveRoutine(rows, { id: args.id, titulo: args.titulo, verbo: 'alterar', tool: 'editar_rotina' });
    if (sel.err) return { err: sel.err };
    return { row: sel.row };
  };
  return {
    name: 'editar_rotina',
    description: 'CHANGES in place a recurring routine that ALREADY EXISTS, while the owner is OUT OF CREDIT. Use it when they want to change an existing routine (switch the delivery channel, change the time or days, rename it, or change the text of what it does) or RESUME a paused one (ativa:true). Pass ONLY the fields that change; the rest stays as it is. A simple PAUSE (ativa:false, with no other change) happens right away; any other change is proposed and takes effect after the owner confirms. Never ask for a confirmation in text; calling the tool IS the proposal. If you do not know the exact title, ask the owner to name the routine. This no-credit edit does NOT support changing curation or e-mail-search criteria, the time zone, the end date, or running a test now: for any of those the owner needs to top up credits.',
    parameters: {
      type: 'object',
      properties: {
        ativa: { type: 'boolean', description: 'true to RESUME a paused routine, false to PAUSE it, without deleting history.' },
        titulo: { type: 'string', description: 'Title (or part of it) of the routine that exists TODAY, to locate which one to change.' },
        id: { type: 'string', description: 'OPTIONAL. Routine code (the #xxxx from listar_rotinas). Use it when two routines have the same or similar titles.' },
        novo_titulo: { type: 'string', description: 'OPTIONAL. New name of the routine, if renaming.' },
        o_que_fazer: { type: 'string', description: 'OPTIONAL. New instruction (what the routine does / in which format). Write it STARTING WITH THE TASK\'S VERB, never with the cadence: the cadence lives in the hora/dias fields.' },
        hora: { type: 'integer', minimum: 0, maximum: 23, description: 'OPTIONAL. New hour (0–23, local time). Without `minuto`, it becomes the top of the hour.' },
        minuto: { type: 'integer', minimum: 0, maximum: 59, description: 'OPTIONAL. Minute of the new time: "22h30" → hora 22 + minuto 30. On its own, it keeps the current hour.' },
        dias: { type: 'string', enum: ['daily', 'weekdays', 'weekends'], description: 'OPTIONAL. New block cadence: daily, weekdays (Mon–Fri) or weekends (Sat–Sun). For a specific day use dias_da_semana.' },
        dias_da_semana: { type: 'array', items: { type: 'string', enum: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'] }, description: 'OPTIONAL. New SPECIFIC days of the week ("só domingo" → ["dom"]). Takes precedence over `dias`.' },
        dias_do_mes: { type: 'array', items: { type: 'integer' }, description: 'OPTIONAL. New monthly cadence by day of the month ([5] = every day 5; [-1] = last day of the month).' },
        semana_do_mes: { type: 'integer', description: 'OPTIONAL. New monthly cadence by the Nth occurrence of the weekday; use it together with dias_da_semana (2 + ["seg"] = 2nd Monday).' },
        canal: { type: 'string', enum: ['telegram', 'email', 'whatsapp', 'app'], description: 'OPTIONAL. New delivery channel for the text the routine returns. Pass "app" to STOP pushing the message and leave the result only in the app.' },
      },
      required: [],
    },
    // Same closed rule as the full tool: only a plain pause runs without a card.
    runWithoutConfirmation: isPauseOnlyRoutineChange,
    normalizeConfirmationArgs: async (args = {}) => {
      const loc = await locate(args);
      if (loc.err) return { erro: loc.err };
      return { args: { ...args, id: loc.row.id, expected: routineConfirmationSnapshot(loc.row) } };
    },
    // READ-ONLY check before the card: refuse an invalid argument and prove the
    // routine still matches what was proposed, so the owner never confirms a
    // rounded value or a routine that changed underneath.
    preflight: async (args = {}) => {
      const erro = checkEditArgs(args);
      if (erro) return { erro };
      const loc = await locate(args);
      if (loc.err) return { erro: loc.err };
      if (args.expected && confirmationFingerprint(args.expected) !== confirmationFingerprint(routineConfirmationSnapshot(loc.row))) {
        return { erro: 'A rotina mudou desde a proposta. Confira e proponha novamente.' };
      }
      return { aviso: `É a rotina "${loc.row.title}", que hoje roda ${routineCadence(loc.row)}` };
    },
    run: async (args = {}) => {
      const { titulo, id, novo_titulo, o_que_fazer, hora, minuto, dias, dias_da_semana, dias_do_mes, semana_do_mes, canal, ativa, expected } = args;
      const loc = await locate(args);
      if (loc.err) return { ok: false, error: loc.err };
      const cur = loc.row;
      const fields = {};
      if (ativa !== undefined) {
        if (typeof ativa !== 'boolean') return { ok: false, error: 'Informe se quer pausar ou retomar.' };
        fields.enabled = ativa;
      }
      if (novo_titulo && String(novo_titulo).trim()) fields.title = String(novo_titulo).trim();
      if (o_que_fazer && String(o_que_fazer).trim()) fields.prompt = String(o_que_fazer).trim();
      const horario = parseRoutineTime({ hora, minuto });
      if (horario.error) return { ok: false, error: horario.error };
      Object.assign(fields, horario);
      const cad = normalizeRoutineDays({ dias, dias_da_semana, dias_do_mes, semana_do_mes });
      if (cad.error) return { ok: false, error: cad.error };
      if (cad.days) fields.days = cad.days;
      if (canal) {
        const canalNovo = normChannel(canal);
        if (canalNovo.error) return { ok: false, error: canalNovo.error };
        if (canalNovo.ch) fields.channel = canalNovo.ch;
      }
      if (!Object.keys(fields).length) {
        return { ok: false, error: 'Você não passou nenhuma mudança. Diga o que quer alterar na rotina (canal, horário, dias, texto ou nome).' };
      }
      // Only what ended up DIFFERENT from what's saved counts as a change, so a
      // "switch to WhatsApp" on a routine already on WhatsApp doesn't come back a ✅.
      for (const k of Object.keys(fields)) {
        if (String(cur[k] ?? '') === String(fields[k] ?? '')) delete fields[k];
      }
      if (!Object.keys(fields).length) {
        return { ok: false, error: `Nada mudou: o que você passou já é o que a rotina tem hoje (roda ${routineCadence(cur)}, entrega ${entregaLabel(cur.channel)}). Me diga o que quer que fique diferente.` };
      }
      const updated = await updateRoutine(cur.id, userId, { ...fields, ...(expected ? { expected } : {}) });
      const now = updated.routine || { ...cur, ...fields };
      return {
        ok: true,
        saida: now.enabled === false ? '' : `Agora roda ${routineCadence(now)} e entrega ${entregaLabel(now.channel)}.`,
      };
    },
  };
}
