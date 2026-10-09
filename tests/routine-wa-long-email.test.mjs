// These cases expect the Portuguese texts on an instance whose default language is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Long routine with the WhatsApp 24h window CLOSED: the template cuts at 900
// characters and the questions at the end disappeared (real case 2026-10-02, a 1556-character
// routine arrived with 901). Now the entire content goes by e-mail and
// WhatsApp only notifies. Fetch stubbed: nothing goes out to the network. Run with: node tests/routine-wa-long-email.test.mjs
import assert from 'node:assert/strict';
process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = '1';
process.env.WA_VERIFY_TOKEN = 'v';

const wa = [];
globalThis.fetch = async (_url, opts) => {
  wa.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ messages: [{ id: `wamid.${wa.length}` }] }) };
};
const { sendWhatsAppProactive, whatsappWindowOpen, WA_TEMPLATE_MAX, setWaHooks } = await import('../web/whatsapp.mjs');
const { createScheduledDelivery } = await import('../web/scheduled-delivery.mjs');

const emails = [], threads = [];
const deps = {
  sendEmail: async (m) => { emails.push(m); return { ok: true, id: 'email-1' }; },
  waEnabled: () => true,
  getWhatsAppLinkForUser: async () => ({ wa_phone: '5511000000000' }),
  sendWhatsAppProactive,
  whatsappProse: async (_ctx, t) => t,
  persistProactiveToThread: async (r, body) => { threads.push({ channel: r.channel, body }); },
  whatsappWindowOpen, whatsappTemplateMax: WA_TEMPLATE_MAX,
};
const { deliverRoutine } = createScheduledDelivery(deps);

const rotina = (extra = {}) => ({ id: 'r1', user_id: 'u1', agent_id: 'a1', agent_name: 'Bento', user_name: 'João Souza',
  title: 'Aquece diário de inglês', channel: 'whatsapp', email: 'joao@example.invalid', ...extra });
const J = 'Como o WhatsApp tem limite de caracteres para mensagens depois de 24h de inatividade, enviei o conteúdo completo no teu e-mail. Se você me responder agora, a janela de 24h abre novamente.';
const longa = 'Vocabulary and context for today. '.repeat(40) + 'Question 3: what would you change?';
const reset = () => { wa.length = 0; emails.length = 0; threads.length = 0; };
let n = 0;
const fechada = () => setWaHooks({ lastInboundAt: async () => new Date(Date.now() - 26 * 3600_000) });
const aberta = () => setWaHooks({ lastInboundAt: async () => new Date() });

// 1) Closed window + text longer than the template: entire thing by e-mail, WA only notifies.
fechada(); reset();
let rec = await deliverRoutine(rotina(), longa);
assert.equal(emails.length, 1); assert.ok(emails[0].text.includes('Question 3: what would you change?')); n++;
assert.equal(wa.length, 1); assert.equal(wa[0].type, 'template');
const aviso = wa[0].template.components[0].parameters[0].text;
// Without an agent: fixed phrase + explanation of the 24h window, no greeting (the template already has one).
assert.equal(aviso, `O "Aquece diário de inglês" de hoje ficou pronto. ${J}`);
assert.ok(aviso.length < WA_TEMPLATE_MAX); n++;
assert.equal(rec.fullContent, 'email'); n++;
// The WhatsApp thread keeps the notice it saw + the content marked as
// e-mail: if the person asks there for "o conteúdo", the assistant knows which one it is (case 2026-10-02).
assert.deepEqual(threads, [{ channel: 'whatsapp', body: `${aviso}\n\nConteúdo completo (enviado por e-mail):\n\n${longa}` }]); n++;

// 2) Open window: session message accepts long text, no e-mail.
aberta(); reset();
await deliverRoutine(rotina(), longa);
assert.equal(emails.length, 0); assert.equal(wa[0].type, 'text'); n++;

// 2b) Open window but longer than 3500: goes by e-mail, and the notice does NOT mention the
// 24h window (that would be a lie with the window open).
aberta(); reset();
await deliverRoutine(rotina(), 'x '.repeat(1800));
assert.equal(emails.length, 1); assert.equal(wa[0].type, 'text');
assert.ok(wa[0].text.body.includes('grande demais para mandar por aqui') && !wa[0].text.body.includes('24h')); n++;

// 3) Janela fechada mas texto curto: cabe no template, segue pelo WhatsApp.
fechada(); reset();
await deliverRoutine(rotina(), 'Hoje: um podcast curto. Responda por áudio.');
assert.equal(emails.length, 0); assert.equal(wa.length, 1); assert.equal(wa[0].type, 'template'); n++;

// 4) No e-mail registered: there's nowhere to divert to, goes via the template as before.
fechada(); reset();
await deliverRoutine(rotina({ email: null }), longa);
assert.equal(emails.length, 0); assert.equal(wa.length, 1); n++;

// 5) With the agent available, it fills in ONLY today's topic (otherwise it would be the same
// every night) in a fixed phrase; the e-mail explanation comes after, fixed.
const pedidos = [];
let resposta = 'O futuro do trabalho com a IA.';
const comAgente = createScheduledDelivery({ ...deps, runAgentMessageDraft: async (target, task) => {
  if (task.includes('it will be delivered by email')) return task.split('\n\n---\n')[1]; // nada a adaptar
  pedidos.push({ target, task }); return resposta;
} });
fechada(); reset();
rec = await comAgente.deliverRoutine(rotina(), longa);
assert.equal(pedidos.length, 1); assert.deepEqual(pedidos[0].target, { agent_id: 'a1', user_id: 'u1' });
assert.ok(pedidos[0].task.includes('Question 3: what would you change?')); n++;
assert.ok(pedidos[0].task.includes('"O conteúdo de hoje é sobre ___."') && pedidos[0].task.includes('at most 8')); n++;
assert.equal(wa[0].template.components[0].parameters[0].text, `O conteúdo de hoje é sobre o futuro do trabalho com a IA. ${J}`); n++;
assert.equal(emails.length, 1); assert.equal(rec.fullContent, 'email'); n++;
assert.ok(threads[0].body.startsWith(`O conteúdo de hoje é sobre o futuro do trabalho com a IA. ${J}\n\nConteúdo completo`)); n++;
// A proper name/acronym at the start of the topic doesn't get lowercased; the phrase follows the person's language.
resposta = 'IA nos call centres'; fechada(); reset();
await comAgente.deliverRoutine(rotina({ user_language: 'en' }), longa);
assert.ok(pedidos.at(-1).task.includes("Today's content is about ___.") && pedidos.at(-1).task.includes('in English'));
assert.ok(wa[0].template.components[0].parameters[0].text.startsWith("Today's content is about IA nos call centres. Since WhatsApp")); n++;

// 6) Unusable topic: the telegraphic phrase from the 2026-10-02 test, too long, with a
// greeting, more than 8 words, or an error. Falls back to the fixed phrase with the title.
for (const ruim of [async () => 'Episódio de 6 Minute English sobre o futuro do trabalho: se a IA vai acabar com empregos',
  async () => 'x'.repeat(2000), async () => 'Oi, Ana! o futuro do trabalho',
  async () => 'o futuro do trabalho e a semana de quatro dias na prática', async () => { throw new Error('modelo fora'); }]) {
  const d = createScheduledDelivery({ ...deps, runAgentMessageDraft: ruim });
  fechada(); reset();
  await d.deliverRoutine(rotina(), longa);
  assert.equal(wa[0].template.components[0].parameters[0].text, `O "Aquece diário de inglês" de hoje ficou pronto. ${J}`); n++;
}

// 7) E-mail with content written for chat: "manda o áudio por aqui" cannot go
// like that by e-mail. The agent swaps only the channel phrase; the rest arrives the same.
const chat = 'Hoje: BBC 6 Minute English\nhttps://www.bbc.co.uk/learningenglish/ep-241219\n' +
  'Pergunta 1: Can AI replace human agents?\n'.repeat(30) + 'Manda as três respostas em áudio por aqui que eu te corrijo. 🎧';
const viaWa = chat.replace('em áudio por aqui', 'em áudio lá no WhatsApp');
let adapta = async () => viaWa;
const adaptando = createScheduledDelivery({ ...deps, runAgentMessageDraft: async (_t, task) =>
  task.includes('it will be delivered by email') ? adapta(task) : 'IA nos call centres' });
fechada(); reset();
await adaptando.deliverRoutine(rotina(), chat);
assert.ok(emails[0].text.includes('em áudio lá no WhatsApp') && !emails[0].text.includes('por aqui')); n++;
// On WhatsApp (thread) the text stays the original: there "por aqui" is correct.
assert.ok(threads[0].body.endsWith(`Conteúdo completo (enviado por e-mail):\n\n${chat}`)); n++;
// Adaptation that loses a link, changes too many lines, or fails: fixed note at the top + original text.
for (const ruim of [async () => viaWa.replace(/https:\S+/, ''), async () => viaWa.replace(/Pergunta/g, 'Question'),
  async () => 'resumo', async () => { throw new Error('modelo fora'); }]) {
  adapta = ruim; fechada(); reset();
  await adaptando.deliverRoutine(rotina(), chat);
  assert.ok(emails[0].text.startsWith('Oi, João!\n\nEsta rotina é do WhatsApp. Ficou grande demais pra lá, então veio por e-mail. As respostas e os áudios, manda lá no WhatsApp.\n\n' + chat)); n++;
}

console.log(`ok ${n}`);
