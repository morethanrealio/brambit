import { routineDaysLabel, intervalLabel } from './scheduler.mjs';
import { routineTimeLabel } from './routine-time.mjs';

// Selecting WHICH routine a tool call means, and describing it. Extracted from
// server.mjs so the normal tool registry AND the no-credit routine-management
// turn (which builds cancelar_rotina before the full registry exists) share one
// implementation. userTz localizes the cadence's window-end date. The owner-facing
// strings stay in Portuguese exactly as they were inline, to keep behaviour identical.
export function createRoutineSelect({ userTz }) {
  const routineCode = (r, rows) => {
    const id = String(r?.id || '');
    let n = 4;
    while (n < id.length && rows.filter((o) => String(o.id || '').slice(0, n) === id.slice(0, n)).length > 1) n += 2;
    return id.slice(0, n);
  };
  const routineCadence = (r) => {
    // The window end shows up in both modes: it's what the owner needs to see to know
    // the routine has a deadline (so they don't go cancel it by hand thinking it's eternal).
    const ate = r.repeat_until
      ? ` até ${new Date(r.repeat_until).toLocaleString('pt-BR', { timeZone: userTz, dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    if (r.repeat_every_min) return `a cada ${intervalLabel(r.repeat_every_min)}${ate}`;
    return `${routineDaysLabel(r.days)} às ${routineTimeLabel(r.hour, r.minute)}${ate}`;
  };
  // Resolves WHICH routine the call means: by code (`id`, exact/prefix) or by
  // title (contains). Returns { row } or { err } with an ACTIONABLE output: on
  // ambiguity it lists the candidates with code + cadence + channel, so the owner
  // can choose even when the titles are identical.
  const resolveRoutine = (rows, { id, titulo, verbo, tool }) => {
    const code = String(id || '').trim().toLowerCase().replace(/^#/, '');
    if (code) {
      const hits = rows.filter((r) => String(r.id || '').toLowerCase().startsWith(code));
      if (!hits.length) return { err: `Não achei rotina com o código "${id}". Use listar_rotinas pra ver os códigos atuais.` };
      if (hits.length > 1) return { err: `O código "${id}" bate com mais de uma rotina. Use o código inteiro que aparece no listar_rotinas.` };
      return { row: hits[0] };
    }
    const q = String(titulo || '').trim().toLowerCase();
    if (!q) return { err: `Me diga qual rotina ${verbo}: o título, ou o código (#) que aparece no listar_rotinas.` };
    const matches = rows.filter((r) => String(r.title || '').toLowerCase().includes(q));
    if (!matches.length) return { err: `Não achei rotina com "${titulo}". Use listar_rotinas pra ver os títulos.` };
    if (matches.length === 1) return { row: matches[0] };
    const opts = matches.map((m) => {
      const canal = m.channel && m.channel !== 'none' ? `, entrega no ${m.channel}` : '';
      return `• #${routineCode(m, rows)} — "${m.title}" (${routineCadence(m)}${canal})`;
    }).join('\n');
    return { err: `Achei mais de uma rotina com "${titulo}":\n${opts}\nPergunte pro dono qual é, descrevendo pela CADÊNCIA/canal (os títulos podem ser idênticos; ele não precisa ver o código). Quando ele escolher, chame ${tool} de novo passando \`id\` com o código dela.` };
  };
  return { routineCode, routineCadence, resolveRoutine };
}
