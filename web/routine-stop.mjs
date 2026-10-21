// Stopping a routine. However the owner says it ("stop this reminder", "cancel
// the exchange rate alert"), stopping PAUSES the routine right away: it is
// reversible, keeps the history and the settings, and needs no confirmation
// card. Deleting it for good only happens when the owner asks to delete, and
// that path still waits for their confirmation.
//
// Before this, "stop" went to a delete, which is irreversible and therefore
// gated; when the owner's reply to the card was not recognized as a yes, the
// routine kept running every day while the assistant said it had stopped.

// The confirmation gate asks this before building a card: only a permanent
// delete waits for the owner.
export const stopWithoutCard = (args = {}) => args?.permanently !== true;

export function createStopRoutineTool({ userId, listRoutines, updateRoutine, deleteRoutine, resolveRoutine, routineCode, routineCadence }) {
  return {
    name: 'cancelar_rotina',
    description: 'STOPS one of the user\'s recurring routines. By default it PAUSES the routine right away: it stops running, nothing is deleted, and it can be resumed later with editar_rotina (ativa:true). Use it whenever the owner wants a routine or a recurring reminder to stop, however they say it ("para com esse lembrete", "não precisa mais mandar o câmbio", "cancela a rotina de reuniões", "stop the daily summary"). The pause happens immediately and returns the real receipt: do not ask for confirmation first. Pass permanently:true ONLY when the owner explicitly asks to DELETE/REMOVE the routine for good ("apaga essa rotina", "exclui de vez"); only that waits for their confirmation. If they only want to CHANGE an existing routine (switch channel, time, days, text or format), do NOT stop it to recreate; use editar_rotina, which changes it in place. Pass the title of the routine (or part of it), OR the `id` (the #xxxx code from listar_rotinas) when the title does not distinguish it. If the title matches more than one routine, the tool returns the candidates with code and cadence: show them to the owner and call again with `id`.',
    parameters: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Title (or part of it) of the routine to stop.' },
        id: { type: 'string', description: 'OPTIONAL. Routine code (the #xxxx from listar_rotinas). Use it when two routines have the same or similar titles: it is what identifies it without ambiguity.' },
        permanently: { type: 'boolean', description: 'OPTIONAL. true ONLY when the owner explicitly asked to delete the routine for good. Without it the routine is paused.' },
      },
      required: [],
    },
    runWithoutConfirmation: stopWithoutCard,
    // Results are objects for the model. On the confirmed (delete) path the
    // owner reads the localized done sentence instead (confirm-sentences.mjs).
    run: async ({ titulo, id, permanently } = {}) => {
      const rows = await listRoutines(userId);
      if (!rows.length) return { ok: false, error: 'Você não tem nenhuma rotina pra cancelar.' };
      const sel = resolveRoutine(rows, { id, titulo, verbo: 'cancelar', tool: 'cancelar_rotina' });
      if (sel.err) return { ok: false, error: sel.err };
      const row = sel.row, routine = `"${row.title}" (#${routineCode(row, rows)}, ${routineCadence(row)})`;
      if (permanently === true) {
        await deleteRoutine(row.id, userId);
        return { ok: true, routine, result: 'deleted', note: 'Deleted for good. It will not run again.' };
      }
      if (row.enabled === false) return { ok: true, routine, result: 'already_paused', note: 'It was already paused and still does not run. Nothing changed.' };
      await updateRoutine(row.id, userId, { enabled: false });
      return { ok: true, routine, result: 'paused', note: 'Paused now: it no longer runs and nothing was deleted. It runs again only if the owner asks to resume it (editar_rotina ativa:true).' };
    },
  };
}

// A routine run that decides to end itself (a closed window, like a Lent
// routine) never deletes: the dispatch has no owner to confirm, so it pauses.
export function selfStopOnly(tool) {
  if (tool?.name !== 'cancelar_rotina') return tool;
  return { ...tool, run: (args = {}) => tool.run({ ...args, permanently: false }) };
}
