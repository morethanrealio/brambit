// Offline test of the WhatsApp 24h window fix. Fetch stub: nothing goes out
// to the network. Run with: node wa-window.test.mjs
process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = '1';
process.env.WA_VERIFY_TOKEN = 'v';

const chamadas = [];
let seq = 0;
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  chamadas.push(body);
  return { ok: true, json: async () => ({ messages: [{ id: `wamid.${++seq}` }] }) };
};

const wa = await import('./web/whatsapp.mjs');
const { setWaHooks, sendWhatsAppProactive, retryProactiveAsTemplate } = wa;

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const ultimo = () => chamadas[chamadas.length - 1];
const reset = () => { chamadas.length = 0; };

// 1) OPEN window (inbound 1h ago) -> session message, formatting preserved.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
let r = await sendWhatsAppProactive('5511999999999', 'linha1\nlinha2');
t('open window uses session', r.via === 'session' && ultimo().type === 'text');
t('session preserves line break', ultimo().text.body.includes('\n'));
t('session returns ID and parts', r.wamid === 'wamid.'+seq && r.wamids.length === 1);

// 2) CLOSED window (inbound 30h ago) -> template, WITHOUT trying session first.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 30 * 3600_000) });
r = await sendWhatsAppProactive('5511999999999', 'linha1\nlinha2');
t('closed window goes straight to template', r.via === 'template' && r.reason === 'janela-fechada');
t('closed window does not try session', chamadas.length === 1 && ultimo().type === 'template');
t('template returns ID for correlation', r.wamid === 'wamid.'+seq && r.wamids[0] === r.wamid);

// 3) Nunca escreveu (null) -> template.
reset();
setWaHooks({ lastInboundAt: async () => null });
r = await sendWhatsAppProactive('5511999999999', 'oi');
t('no known inbound goes via template', r.via === 'template');

// 4) Edge: 23h55 is still session; 23h56 no longer is (5 min margin).
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - (24 * 3600_000 - 6 * 60_000)) });
t('23h54 is still session', (await sendWhatsAppProactive('5511999999999', 'oi')).via === 'session');
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - (24 * 3600_000 - 4 * 60_000)) });
t('23h56 is already template', (await sendWhatsAppProactive('5511999999999', 'oi')).via === 'template');

// 5) Hook unavailable (DB error) -> degrades to the old behavior (session).
reset();
setWaHooks({ lastInboundAt: async () => { throw new Error('db fora'); } });
r = await sendWhatsAppProactive('5511999999999', 'oi');
t('error in hook degrades to session', r.via === 'session' && ultimo().type === 'text');

// 6) Safety net for 131047: session accepted (200) and rejected afterward.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
r = await sendWhatsAppProactive('5511988888888', 'conteudo perdido');
const wamid = `wamid.${seq}`;
t('session stored for retry', r.via === 'session');
reset();
t('retry resends via template', (await retryProactiveAsTemplate(wamid, '5511988888888')) === true);
t('template carries the same content', ultimo().type === 'template'
  && JSON.stringify(ultimo()).includes('conteudo perdido'));

// 7) No loop: the same wamid doesn't resend twice, and template is never stored.
reset();
t('retry is idempotent', (await retryProactiveAsTemplate(wamid, '5511988888888')) === false);
t('retry of unknown wamid does nothing', (await retryProactiveAsTemplate('wamid.zzz', '55119')) === false);
setWaHooks({ lastInboundAt: async () => null });
await sendWhatsAppProactive('5511977777777', 'via template');
const wamidTpl = `wamid.${seq}`;
t('template does not enter the retry queue', (await retryProactiveAsTemplate(wamidTpl, '5511977777777')) === false);

// 8) Failure of one part doesn't prove the others failed. A long message
// must not resend the entire body via the async fallback.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
r = await sendWhatsAppProactive('5511966666666', 'a'.repeat(9000));
const parte2 = `wamid.${seq}`, parte1 = `wamid.${seq - 1}`;
// How many parts it splits into depends on Meta's bubble cap (which already changed from 4096 to
// 1024), so what's locked down here is the rule: every sent part comes back with an id.
t('long message became multiple parts', chamadas.length > 1);
t('returns ALL IDs of the long message', r.wamids.length === chamadas.length && r.wamids[r.wamids.length - 1] === 'wamid.'+seq);
reset();
const p1 = await retryProactiveAsTemplate(parte1, '5511966666666');
const p2 = await retryProactiveAsTemplate(parte2, '5511966666666');
t('long message does not duplicate accepted parts', p1 === false && p2 === false && chamadas.length === 0);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
