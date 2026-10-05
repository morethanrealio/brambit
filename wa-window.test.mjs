// Teste offline do conserto da janela de 24h do WhatsApp. Stub do fetch: nada sai
// pra rede. Roda com: node wa-window.test.mjs
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

// 1) Janela ABERTA (inbound há 1h) -> mensagem de sessão, formatação preservada.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
let r = await sendWhatsAppProactive('5511999999999', 'linha1\nlinha2');
t('janela aberta usa sessao', r.via === 'session' && ultimo().type === 'text');
t('sessao preserva quebra de linha', ultimo().text.body.includes('\n'));
t('sessao retorna ID e partes', r.wamid === 'wamid.'+seq && r.wamids.length === 1);

// 2) Janela FECHADA (inbound há 30h) -> template, SEM tentar sessão antes.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 30 * 3600_000) });
r = await sendWhatsAppProactive('5511999999999', 'linha1\nlinha2');
t('janela fechada vai direto de template', r.via === 'template' && r.reason === 'janela-fechada');
t('janela fechada nao tenta sessao', chamadas.length === 1 && ultimo().type === 'template');
t('template retorna ID para correlacao', r.wamid === 'wamid.'+seq && r.wamids[0] === r.wamid);

// 3) Nunca escreveu (null) -> template.
reset();
setWaHooks({ lastInboundAt: async () => null });
r = await sendWhatsAppProactive('5511999999999', 'oi');
t('sem inbound conhecido vai de template', r.via === 'template');

// 4) Borda: 23h55 ainda é sessão; 23h56 já não é (margem de 5 min).
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - (24 * 3600_000 - 6 * 60_000)) });
t('23h54 ainda e sessao', (await sendWhatsAppProactive('5511999999999', 'oi')).via === 'session');
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - (24 * 3600_000 - 4 * 60_000)) });
t('23h56 ja e template', (await sendWhatsAppProactive('5511999999999', 'oi')).via === 'template');

// 5) Hook indisponível (erro de banco) -> degrada pro comportamento antigo (sessão).
reset();
setWaHooks({ lastInboundAt: async () => { throw new Error('db fora'); } });
r = await sendWhatsAppProactive('5511999999999', 'oi');
t('erro no hook degrada pra sessao', r.via === 'session' && ultimo().type === 'text');

// 6) Rede de segurança do 131047: sessão aceita (200) e reprovada depois.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
r = await sendWhatsAppProactive('5511988888888', 'conteudo perdido');
const wamid = `wamid.${seq}`;
t('sessao guardada pra retry', r.via === 'session');
reset();
t('retry reenvia por template', (await retryProactiveAsTemplate(wamid, '5511988888888')) === true);
t('template leva o mesmo conteudo', ultimo().type === 'template'
  && JSON.stringify(ultimo()).includes('conteudo perdido'));

// 7) Sem laço: o mesmo wamid não reenvia duas vezes, e template nunca é guardado.
reset();
t('retry e idempotente', (await retryProactiveAsTemplate(wamid, '5511988888888')) === false);
t('retry de wamid desconhecido nao faz nada', (await retryProactiveAsTemplate('wamid.zzz', '55119')) === false);
setWaHooks({ lastInboundAt: async () => null });
await sendWhatsAppProactive('5511977777777', 'via template');
const wamidTpl = `wamid.${seq}`;
t('template nao entra na fila de retry', (await retryProactiveAsTemplate(wamidTpl, '5511977777777')) === false);

// 8) Falha de uma parte não prova que as outras falharam. Mensagem longa
// não pode reenviar o corpo inteiro pelo fallback assíncrono.
reset();
setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 3600_000) });
r = await sendWhatsAppProactive('5511966666666', 'a'.repeat(9000));
const parte2 = `wamid.${seq}`, parte1 = `wamid.${seq - 1}`;
// Quantas partes dá depende do teto de balão da Meta (já mudou de 4096 pra
// 1024), então o que se trava aqui é a regra: toda parte enviada volta com id.
t('mensagem longa virou varias partes', chamadas.length > 1);
t('retorna TODOS os IDs da mensagem longa', r.wamids.length === chamadas.length && r.wamids[r.wamids.length - 1] === 'wamid.'+seq);
reset();
const p1 = await retryProactiveAsTemplate(parte1, '5511966666666');
const p2 = await retryProactiveAsTemplate(parte2, '5511966666666');
t('longa nao duplica partes aceitas', p1 === false && p2 === false && chamadas.length === 0);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
