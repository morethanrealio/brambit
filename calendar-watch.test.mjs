import test from 'node:test';
import assert from 'node:assert/strict';
import { fotoGoogle, fotoOutlook, mudancas, textoAviso, createCalendarWatch } from './web/calendar-watch.mjs';

const ev = (o = {}) => ({ id: 'e1', summary: 'Reunião X', status: 'confirmed', organizer: { email: 'outra@x.invalid' },
  start: { dateTime: '2026-09-30T15:00:00-03:00' }, end: { dateTime: '2026-09-30T16:00:00-03:00' }, ...o });

test('horário que muda pra mesmo instante em outro offset não é mudança', () => {
  const a = fotoGoogle(ev());
  const b = fotoGoogle(ev({ start: { dateTime: '2026-09-30T18:00:00Z' }, end: { dateTime: '2026-09-30T19:00:00Z' } }));
  assert.deepEqual(mudancas(a, b), []);
});

test('mudança de horário, local e cancelamento', () => {
  const a = fotoGoogle(ev());
  assert.deepEqual(mudancas(a, fotoGoogle(ev({ start: { dateTime: '2026-09-30T16:00:00-03:00' }, end: { dateTime: '2026-09-30T17:00:00-03:00' } }))), [{ tipo: 'horario' }]);
  assert.deepEqual(mudancas(a, fotoGoogle(ev({ location: 'Sala 2' }))), [{ tipo: 'local' }]);
  assert.deepEqual(mudancas(a, fotoGoogle(ev({ status: 'cancelled' }))), [{ tipo: 'cancelado' }]);
  assert.deepEqual(mudancas(a, null), [{ tipo: 'cancelado' }]);
});

test('evento organizado pela própria pessoa, ou recusado, não avisa', () => {
  const meu = fotoGoogle(ev({ organizer: { email: 'eu@x.invalid', self: true } }));
  assert.deepEqual(mudancas(meu, null), []);
  const recusado = fotoGoogle(ev({ attendees: [{ email: 'eu@x.invalid', self: true, responseStatus: 'declined' }] }));
  assert.deepEqual(mudancas(recusado, null), []);
});

test('Outlook: organizador e UTC', () => {
  const f = fotoOutlook({ subject: 'Y', isOrganizer: false, start: { dateTime: '2026-09-30T18:00:00.0000000' }, end: { dateTime: '2026-09-30T19:00:00.0000000' }, location: { displayName: '' } });
  assert.equal(f.de_outra_pessoa, true);
  assert.equal(Date.parse(f.inicio), Date.parse('2026-09-30T18:00:00Z'));
});

test('texto do aviso no fuso da pessoa', () => {
  const antes = fotoGoogle(ev());
  const atual = fotoGoogle(ev({ start: { dateTime: '2026-09-30T16:00:00-03:00' }, end: { dateTime: '2026-09-30T17:00:00-03:00' } }));
  const t = textoAviso([{ antes, atual, lista: [{ tipo: 'horario' }] }], 'America/Sao_Paulo');
  assert.match(t, /^Mudança na sua agenda: "Reunião X": mudou de .*30\/09 às 15:00 para .*30\/09 às 16:00\.$/);
  const dois = textoAviso([{ antes, atual, lista: [{ tipo: 'horario' }] }, { antes, atual: null, lista: [{ tipo: 'cancelado' }] }], 'America/Sao_Paulo');
  assert.match(dois, /^Mudanças na sua agenda:\n\n• .*\n• "Reunião X", que era .* foi cancelado ou saiu da sua agenda\.$/);
});

// Pool em memória só com as queries que o módulo usa.
// `conectados` = quem tem agenda conectada (o que o SELECT de candidatos acharia).
function fakePool(conectados = ['u1']) {
  const snap = new Map(); const watch = new Map();
  return { snap, watch, async query(sql, p = []) {
    if (/CREATE TABLE/.test(sql)) return { rows: [] };
    if (/INSERT INTO mtr_harness.calendar_watch \(user_id, last_run_at/.test(sql)) { watch.set(p[0], { enabled: watch.get(p[0])?.enabled ?? true, last_run_at: 'agora' }); return { rows: [] }; }
    if (/INSERT INTO mtr_harness.calendar_watch \(/.test(sql)) { watch.set(p[0], { enabled: p[2] }); return { rows: [] }; }
    if (/FROM mtr_harness.google_accounts/.test(sql)) return { rows: conectados.filter((u) => watch.get(u)?.enabled !== false).map((user_id) => ({ user_id })) };
    if (/SELECT enabled, last_run_at/.test(sql)) return { rows: watch.has(p[0]) ? [watch.get(p[0])] : [] };
    if (/SELECT key, data FROM/.test(sql)) return { rows: [...snap].filter(([k]) => k.startsWith(p[0] + '|')).map(([k, data]) => ({ key: k.slice(p[0].length + 1), data })) };
    if (/INSERT INTO mtr_harness.calendar_watch_snap/.test(sql)) { snap.set(`${p[0]}|${p[1]}`, JSON.parse(p[2])); return { rows: [] }; }
    if (/DELETE FROM mtr_harness.calendar_watch_snap WHERE user_id = \$1 AND key/.test(sql)) { for (const k of p[1]) snap.delete(`${p[0]}|${k}`); return { rows: [] }; }
    if (/DELETE FROM mtr_harness.calendar_watch_snap/.test(sql)) { for (const k of [...snap.keys()]) if (k.startsWith(p[0] + '|')) snap.delete(k); return { rows: [] }; }
    throw Error('query inesperada ' + sql);
  } };
}

test('ciclo completo: base calada, depois avisa remarcação e remoção', async () => {
  const pool = fakePool();
  let eventos = [ev(), ev({ id: 'e2', summary: 'Almoço' })];
  const gone = new Set();
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => '' });
    if (u.pathname.endsWith('/calendarList')) return ok({ items: [{ id: 'eu@x.invalid', primary: true }] });
    const m = u.pathname.match(/\/events\/([^/]+)$/);
    if (m) return gone.has(m[1]) ? { ok: false, status: 404, text: async () => 'nf' } : ok(ev({ id: m[1] }));
    return ok({ items: eventos });
  };
  const avisos = [];
  const w = createCalendarWatch({ pool, fetchImpl, now: () => Date.parse('2026-09-27T12:00:00Z'), notify: async (u, t) => avisos.push(t),
    googleAccounts: async () => [{ email: 'eu@x.invalid', token: async () => 't' }], microsoftToken: async () => null, timezone: async () => 'America/Sao_Paulo' });
  // Sem ativar nada: ligado por padrão pra quem tem agenda conectada.
  await w.tick();
  assert.equal(avisos.length, 0);
  eventos = [ev({ start: { dateTime: '2026-09-30T17:00:00-03:00' }, end: { dateTime: '2026-09-30T18:00:00-03:00' } })];
  gone.add('e2');
  await w.tick();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /"Reunião X": mudou de/);
  assert.match(avisos[0], /"Almoço", que era .* cancelado/);
  await w.tick();
  assert.equal(avisos.length, 1, 'não repete o mesmo aviso');
  await w.setEnabled('u1', null, false);
  assert.equal(pool.snap.size, 0);
  assert.equal((await w.status('u1')).enabled, false);
  // Desligado: sai do ciclo, mesmo com mudança na agenda.
  eventos = [ev({ start: { dateTime: '2026-10-01T17:00:00-03:00' }, end: { dateTime: '2026-10-01T18:00:00-03:00' } })];
  assert.equal((await w.tick()).usuarios, 0);
  assert.equal(avisos.length, 1);
});

test('sem linha em calendar_watch = ligado; sem agenda legível não grava nada', async () => {
  const pool = fakePool(['u1']);
  const w = createCalendarWatch({ pool, fetchImpl: async () => { throw Error('não devia ler'); }, notify: async () => {},
    googleAccounts: async () => [], microsoftToken: async () => null, timezone: async () => null });
  assert.equal((await w.status('u1')).enabled, true);
  assert.deepEqual(await w.tick(), { usuarios: 1, avisos: 0 });
  assert.equal(pool.watch.size, 0);
});

test('agenda que falhou na leitura não gera aviso de sumiço', async () => {
  const pool = fakePool();
  let falha = false;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/calendarList')) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'eu@x.invalid' }] }) };
    if (falha) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => ({ items: [ev()] }) };
  };
  const avisos = [];
  const w = createCalendarWatch({ pool, fetchImpl, notify: async (u, t) => avisos.push(t),
    googleAccounts: async () => [{ email: 'eu@x.invalid', token: async () => 't' }], microsoftToken: async () => null, timezone: async () => null });
  await w.setEnabled('u1', null, true);
  await w.tick(); falha = true; await w.tick();
  assert.equal(avisos.length, 0);
});
