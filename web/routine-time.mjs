// Routine time = hour + MINUTE. Before, only the full hour existed: the owner who
// asked for "every day at 10:30 pm" got a routine at 10 pm and still had to accept
// the change (2026-10-01 case). The minute is its own column (routines.minute,
// default 0), so an old routine keeps meaning exactly what it was.
//
// Editing rule: passing `hora` without `minuto` means FULL hour ("change to
// 8am" on a 10:30 pm routine becomes 08:00, not 08:30). Passing only `minuto` keeps
// the stored hour.

const vazio = (v) => v === undefined || v === null || v === '';

// Validates raw hour/minute from the tool. Returns { hour?, minute? } with only what came,
// or { error } in pt-BR (text that reaches the model and, sometimes, the owner).
export function parseRoutineTime({ hora, minuto } = {}) {
  const out = {};
  if (!vazio(hora)) {
    const h = Number(hora);
    if (!Number.isInteger(h) || h < 0 || h > 23) return { error: 'Hora inválida. Use um número inteiro de 0 a 23 (hora local).' };
    out.hour = h;
    out.minute = 0;
  }
  if (!vazio(minuto)) {
    const m = Number(minuto);
    if (!Number.isInteger(m) || m < 0 || m > 59) return { error: 'Minuto inválido. Use um número inteiro de 0 a 59 (ex: 22h30 = hora 22, minuto 30).' };
    out.minute = m;
  }
  return out;
}

const dois = (n) => String(Number(n) || 0).padStart(2, '0');

// "22h", "22h30" (pt). sep=':' gives "22:00"/"22:30" (en/es and the screen).
export function routineTimeLabel(hour, minute, sep = 'h') {
  const m = Number(minute) || 0;
  if (sep === 'h') return `${dois(hour)}h${m ? dois(m) : ''}`;
  return `${dois(hour)}${sep}${dois(m)}`;
}

// Same label from the tool's raw args (confirmation card). Without an hour:
// null, the caller decides the default. Only minute (editing): ":30".
export function routineArgsTimeLabel(args = {}, sep = 'h') {
  if (vazio(args.hora)) return vazio(args.minuto) ? null : `:${dois(args.minuto)}`;
  return routineTimeLabel(args.hora, vazio(args.minuto) ? 0 : args.minuto, sep);
}

// Minutes since local midnight of the routine's stored time.
export const routineMinuteOfDay = (r) => Number(r.hour) * 60 + (Number(r.minute) || 0);

// criar_rotina card substitution key: re-proposing the SAME routine
// (same title) closes the old pending card instead of stacking two almost
// identical cards in the conversation (2026-10-01 case: 2 cards, the old one at 10:30 pm).
export const routineSupersedeKey = (a = {}) => String(a.titulo || '').trim().toLowerCase() || null;
