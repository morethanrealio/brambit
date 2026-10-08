// ── Routine scheduler ──
// Simple loop (1x/min) that fires routines based on TIME. Each routine
// belongs to (user + assistant), has a local time (hour + minute), days and a prompt the
// agent executes; the result goes to the user by email (chosen channel: email).
//
// Dedup: records the local DAY it ran (last_run_day). Only runs 1x per day. The
// window accepts up to 3h of delay: besides tolerating a late tick, it recovers a
// queue that was waiting on another long routine or a short service restart.
// No external cron: just Node.

import { routineMinuteOfDay } from './routine-time.mjs';

export const ROUTINE_LATE_GRACE_MIN = 180;

// Pausing, without changing anything else, is a reversible operation that reduces automation and
// cost. It can run as soon as the owner asks; resuming and any combined edit
// still require confirmation. The closed list prevents a
// change of time, channel, prompt or title from traveling hidden along with the pause.
export function isPauseOnlyRoutineChange(args = {}) {
  return args.ativa === false
    && Object.keys(args).every((key) => ['ativa', 'titulo', 'id'].includes(key));
}

// Local day (YYYY-MM-DD) and local hour/minute for an IANA timezone.
export function localParts(tz, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour === '24' ? '0' : p.hour);
  const minute = Number(p.minute);
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const dom = Number(p.day);                                    // day of the month (1..31)
  const dim = new Date(Date.UTC(Number(p.year), Number(p.month), 0)).getUTCDate(); // days in the month
  return { day, hour, minute, dow, dom, dim };
}

// ── Routine cadence (`routines.days` column, text) ──────────────────────
// The column stores the whole cadence, without a schema migration. Accepted forms:
//   'daily' | 'weekdays' | 'weekends'   legacy buckets (still valid)
//   '[1,4]'                             days of the week (0=sun .. 6=sat)
//   '{"mes":[1,15]}'                    days of the month (-1 = last day of the month)
//   '{"nth":2,"dow":[1]}'               the Nth occurrence of the day in the month (-1 = last)
// Only the trio of buckets used to exist, and because of that "every Sunday at 6pm" became weekends
// (Saturday came too) and "the second Monday of the month" wasn't expressible —
// the date condition ended up INSIDE the routine's text and it fired on the
// wrong day (audit 2026-09-04, two cases). Here the cadence goes back to being data.
export const DOW_KEYS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
const DOW_NOMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Stored text -> structured form. Never throws: a corrupted value becomes 'daily'.
export function parseRoutineDays(days) {
  let d = days ?? 'daily';
  if (typeof d === 'string') {
    const t = d.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { d = JSON.parse(t); } catch { return 'daily'; }
    } else {
      return ['daily', 'weekdays', 'weekends'].includes(t) ? t : 'daily';
    }
  }
  if (Array.isArray(d)) {
    const dow = [...new Set(d.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    return dow.length ? dow : 'daily';
  }
  if (d && typeof d === 'object') {
    if (Array.isArray(d.mes)) {
      const mes = [...new Set(d.mes.map(Number).filter((n) => Number.isInteger(n) && ((n >= 1 && n <= 31) || n === -1)))].sort((a, b) => a - b);
      return mes.length ? { mes } : 'daily';
    }
    if (d.nth !== undefined && Array.isArray(d.dow)) {
      const nth = Number(d.nth);
      const dow = [...new Set(d.dow.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
      if (dow.length && (nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) return { nth, dow };
    }
  }
  return 'daily';
}

// Does the cadence include THIS local day? (dow 0=sun, dom = day of month, dim = days in month)
export function daysMatch(days, { dow, dom, dim }) {
  const d = parseRoutineDays(days);
  if (d === 'weekdays') return dow !== 0 && dow !== 6;
  if (d === 'weekends') return dow === 0 || dow === 6;
  if (Array.isArray(d)) return d.includes(dow);
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    // -1 = last day of the month (February/30-day months come in correctly).
    // "Every day 31" in a 30-day month falls on day 30, and "day 30" in February falls on
    // the 28th/29th: the requested day doesn't exist, and silently skipping the whole month is worse
    // than delivering on the last day (that's what the person means by "every month").
    // Fires only once, because only the last day satisfies the condition.
    return d.mes.some((n) => (n === -1 || n > dim ? dom === dim : n === dom));
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    if (!d.dow.includes(dow)) return false;
    // The Nth occurrence of a weekday in the month: the 1st falls between 1 and 7, the 2nd between
    // 8 and 14, and so on. The LAST is the one without another equal one 7 days later.
    return d.nth === -1 ? dom + 7 > dim : Math.ceil(dom / 7) === d.nth;
  }
  return true; // 'daily'
}

// Tool arguments -> canonical value for the column. Returns { days } or { error }
// (ready-made text for the owner). Precedence: day of month > Nth week > day of week >
// bucket. A single cadence, so no routine exists with two conflicting rules.
export function normalizeRoutineDays({ dias, dias_da_semana, dias_do_mes, semana_do_mes } = {}) {
  const listaDow = (v) => {
    const out = [];
    for (const item of (Array.isArray(v) ? v : [v])) {
      if (item === undefined || item === null || item === '') continue;
      // Accepts a name ("seg", "segunda", "Segunda-feira") and also the dow number,
      // because the model sometimes sends 0..6 directly.
      const n = Number(item);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && String(item).trim() === String(n)) { out.push(n); continue; }
      // Strips the accent BEFORE cutting to 3: "sábado" decomposed ("sa" + accent +
      // "bado") would lose the "b" in the cut and would no longer match "sab".
      const k = String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim().slice(0, 3);
      if (!(k in DOW_KEYS)) return null;
      out.push(DOW_KEYS[k]);
    }
    return out.length ? [...new Set(out)].sort() : null;
  };
  if (dias_do_mes !== undefined && dias_do_mes !== null && String(dias_do_mes) !== '') {
    const mes = [...new Set((Array.isArray(dias_do_mes) ? dias_do_mes : [dias_do_mes])
      .map(Number).filter((n) => Number.isInteger(n) && ((n >= 1 && n <= 31) || n === -1)))].sort((a, b) => a - b);
    if (!mes.length) return { error: 'Dias do mês inválidos. Use números de 1 a 31 (ou -1 pro último dia do mês).' };
    return { days: JSON.stringify({ mes }) };
  }
  if (semana_do_mes !== undefined && semana_do_mes !== null && String(semana_do_mes) !== '') {
    const nth = Number(semana_do_mes);
    if (!(nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) {
      return { error: 'Semana do mês inválida. Use 1 a 5, ou -1 pra última do mês.' };
    }
    const dow = listaDow(dias_da_semana);
    if (!dow) return { error: 'Pra usar semana_do_mes eu preciso também do dia da semana (ex: dias_da_semana: ["seg"]).' };
    if (dow.length > 1) return { error: 'Com semana_do_mes, passe UM dia da semana só (ex: "a 2ª segunda do mês").' };
    return { days: JSON.stringify({ nth, dow }) };
  }
  if (dias_da_semana !== undefined && dias_da_semana !== null && String(dias_da_semana) !== '') {
    const dow = listaDow(dias_da_semana);
    if (!dow) return { error: 'Dias da semana inválidos. Use dom, seg, ter, qua, qui, sex, sab.' };
    return { days: JSON.stringify(dow) };
  }
  if (dias !== undefined && dias !== null && String(dias) !== '') {
    if (!['daily', 'weekdays', 'weekends'].includes(dias)) {
      return { error: 'Dias inválidos. Use daily, weekdays ou weekends, ou passe dias_da_semana/dias_do_mes.' };
    }
    return { days: dias };
  }
  return { days: null }; // nothing provided: the caller decides the default
}

// pt-BR label of an interval in minutes: "5 min", "1 hora", "2 horas", "1 dia".
// Lives here (and not in the server) because the confirmation card needs to say the
// SAME cadence that will be stored.
export function intervalLabel(min) {
  const m = Number(min);
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? '1 dia' : `${d} dias`; }
  if (m % 60 === 0) { const h = m / 60; return h === 1 ? '1 hora' : `${h} horas`; }
  return `${m} min`;
}

// Cadence (stored value OR already-normalized tool args) in Portuguese.
export function routineDaysLabel(days) {
  const d = parseRoutineDays(days);
  if (d === 'weekdays') return 'seg–sex';
  if (d === 'weekends') return 'sáb–dom';
  if (Array.isArray(d)) {
    if (d.length === 7) return 'todo dia';
    const nomes = d.map((n) => DOW_NOMES[n]);
    const artigo = (d[0] === 0 || d[0] === 6) ? 'todo' : 'toda';
    const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
    return `${artigo} ${lista}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    const nomes = d.mes.map((n) => (n === -1 ? 'último dia' : `dia ${n}`));
    const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
    // Says what the platform will do when the day doesn't exist in the month, otherwise the
    // owner confirms "every day 31" thinking February gets nothing.
    const curto = d.mes.some((n) => n > 28) ? ' (nos meses mais curtos, no último dia)' : '';
    return `todo mês no ${lista}${curto}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    const nome = DOW_NOMES[d.dow[0]];
    const ord = d.nth === -1 ? 'última' : `${d.nth}ª`;
    return `${ord} ${nome} do mês`;
  }
  return 'todo dia';
}

// Should the routine run NOW? (local hour matches, right day, hasn't run today yet.)
export function isDue(routine, at = new Date()) {
  if (!routine.enabled) return false;
  // INTERVAL mode (free-granularity recurrence): fires when next_run has already
  // passed. The window (repeat_until) is guaranteed at the moment of storing next_run — when
  // the next one would pass the end, the routine is TURNED OFF instead of getting a next_run outside
  // the window; so here it's enough to check next_run <= now.
  if (routine.repeat_every_min) {
    if (!routine.next_run) return false;
    return new Date(routine.next_run).getTime() <= at.getTime();
  }
  const parts = localParts(routine.tz, at);
  if (routine.last_run_day === parts.day) return false;     // already ran today
  if (!daysMatch(routine.days || 'daily', parts)) return false;
  const atrasoMin = parts.hour * 60 + parts.minute - routineMinuteOfDay(routine);
  return atrasoMin >= 0 && atrasoMin <= ROUTINE_LATE_GRACE_MIN;
}

// Boots the loop. Injects deps to avoid a circular import with server/db.
//   deps.listDueRoutines()  -> [{ ...routine, email, agent_name, user_name }]
//   deps.markRoutineRun(id, day)
//   deps.runRoutine(routine) -> text generated by the agent
//   deps.deliver(routine, text) -> delivery (email)
//   deps.listDueRoutineOneShots()/claimRoutineOneShot()/finishRoutineOneShot()
//      -> single future execution of the routine, without changing the normal cadence
//   deps.listDueReminders()      -> [{ ...reminder, email, user_name, agent_name }] (run_at<=now, pending)
//   deps.executeReminder(reminder) -> claim, sending and persistent result
//   deps.recoverReminderDeliveries() -> recovers claims prior to sending;
//      interrupted sends become uncertain and are never automatically repeated
export function startScheduler(deps, { intervalMs = 60_000, now = () => new Date() } = {}) {
  let running = false, stopped=false;
  let drained;let drainPromise=Promise.resolve();
  async function tick() {
    if (running || stopped) return;            // avoids overlap if a tick takes long
    running = true;
    drainPromise=new Promise(resolve=>{drained=resolve;});
    try {
      // A single snapshot of the clock for the whole batch. Before, isDue() read Date for every
      // item: if the first 8am routine took 11 minutes, the following ones were
      // re-evaluated after the window and simply skipped.
      const tickAt = now();
      if(deps.recoverRoutineExecutions)await deps.recoverRoutineExecutions();
      const routines = await deps.listDueRoutines();
      for (const r of routines) {
        if(stopped)break;
        // Window end (repeat_until) applies in BOTH modes. Before, only INTERVAL
        // mode looked at this date, so a TIME-based routine with a natural end
        // ("every day at 5am during Lent") had no way to stop: it would fire
        // forever and it fell to the owner to cancel it by hand.
        if (!r.repeat_every_min && r.repeat_until && tickAt.getTime() > new Date(r.repeat_until).getTime()) {
          await deps.markRoutineNext(r.id, null);                  // turns off, doesn't delete
          console.log(`[rotina] ${r.id} (${r.title}) closed: passed repeat_until`);
          continue;
        }
        if (!isDue(r, tickAt)) continue;
        const prepare=async()=>{
        // Marks BEFORE running: if generation fails, it doesn't keep re-firing.
        if (r.repeat_every_min) {
          // INTERVAL mode: schedules the next firing (skipping missed slots so as not to
          // fire in a burst). If the next one passes the window, THIS is the last one: it ends.
          const stepMs = Number(r.repeat_every_min) * 60_000;
          let next = new Date(r.next_run).getTime() + stepMs;
          const now = Date.now();
          while (next <= now) next += stepMs;
          if (r.repeat_until && next > new Date(r.repeat_until).getTime()) {
            await deps.markRoutineNext(r.id, null);                 // end of window: turns off
          } else {
            await deps.markRoutineNext(r.id, new Date(next).toISOString());
          }
        } else {
          const { day } = localParts(r.tz, tickAt);
          await deps.markRoutineRun(r.id, day);
        }
        };
        if(deps.executeRoutine){
          const slot=r.repeat_every_min?`interval:${new Date(r.next_run).toISOString()}`:`day:${localParts(r.tz,tickAt).day}`;
          try {await deps.executeRoutine(r,{slot,prepare,run:deps.runRoutine,deliver:deps.deliver});}
          catch(e){console.error(`[rotina] ${r.id} failed (state persisted when possible):`,e?.message??e);}
          continue;
        }
        await prepare(); // compatibility for existing isolated integrations

        try {
          const text = await deps.runRoutine(r);
          // Empty text = it ran and there's nothing to deliver (e.g. owner with no credit
          // already warned this week). Don't lie "delivered" in the log: this is exactly
          // where a routine that vanished from the person's channel gets diagnosed.
          const typed = text?.type === 'flight-monitor-v1' || text?.type === 'curation-v1';
          const body = typed ? text.text : text;
          if (body && body.trim()) {
            await deps.deliver(r, typed ? text : body.trim());
            console.log(`[rotina] ${r.id} (${r.title}) delivered to ${r.email}`);
          } else {
            console.log(`[rotina] ${r.id} (${r.title}) ran with no response — nothing delivered`);
          }
        } catch (e) {
          console.error(`[rotina] ${r.id} failed:`, e?.message ?? e);
        }
      }
      // EXTRA future execution of an existing routine. It's its own queue: a
      // reminder only sends fixed text and can never pretend it will execute the routine.
      // Claim happens before generating; an interrupted worker becomes uncertain and
      // is not automatically repeated (generation may have external effects).
      if (!stopped && deps.listDueRoutineOneShots) {
        if(deps.recoverRoutineOneShots)await deps.recoverRoutineOneShots();
        const jobs=await deps.listDueRoutineOneShots();
        for(const job of jobs){
          if(stopped)break;
          if(!await deps.claimRoutineOneShot(job.one_shot_id))continue;
          try{
            const result=await deps.executeRoutine(job,{
              slot:`once:${job.one_shot_id}`,prepare:async()=>{},run:deps.runRoutine,deliver:deps.deliver,
            });
            const status=result?.status==='completed'?'completed':result?.status==='partial'?'partial':'failed';
            await deps.finishRoutineOneShot(job.one_shot_id,status,{contentStatus:result?.contentStatus||'unknown',delivery:result?.delivery||{status:'unknown'}});
            console.log(`[rotina extra] ${job.one_shot_id} (${job.title}) finished: conteúdo=${result?.contentStatus||'unknown'} entrega=${result?.delivery?.status||'unknown'}`);
          }catch(e){
            await deps.finishRoutineOneShot(job.one_shot_id,'failed',{error:'execution_failed'}).catch(()=>{});
            console.error(`[rotina extra] ${job.one_shot_id} (${job.title}) failed:`,e?.message??e);
          }
        }
      }
      // Video generation jobs (async): advances/delivers the ones that became ready.
      // Best-effort; an error here doesn't bring down the rest of the tick.
      if (!stopped && deps.pollVideoJobs) {
        try { await deps.pollVideoJobs(); }
        catch (e) { console.error('[scheduler] pollVideoJobs failed:', e?.message ?? e); }
      }
      // The executor records an occurrence and gets the atomic claim before
      // sending. Acceptance and rescheduling are persisted together only AFTER the channel.
      if (!stopped && deps.listDueReminders) {
        if (deps.recoverReminderDeliveries) await deps.recoverReminderDeliveries();
        const reminders = await deps.listDueReminders();
        if (reminders.length && !deps.executeReminder) throw Error('Executor persistente de lembretes indisponível');
        for (const rem of reminders) {
          if(stopped)break;
          try {
            const result = await deps.executeReminder(rem);
            if (result?.status === 'skipped') continue;
            console.log(`[lembrete] ${rem.id} canal=${rem.channel} status=${result?.status || 'unknown'}`);
          } catch (e) {
            console.error(`[lembrete] ${rem.id} failed (state persisted when possible):`, e?.message ?? e);
          }
        }
      }
    } catch (e) {
      console.error('[scheduler] tick failed:', e?.message ?? e);
    } finally {
      running = false;drained?.();
    }
  }
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  console.log(`[scheduler] routines active (tick ${Math.round(intervalMs / 1000)}s)`);
  return { stop: () => {stopped=true;clearInterval(handle);return drainPromise;}, tick };
}
