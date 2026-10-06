// Rotina longa com a janela de 24h do WhatsApp FECHADA: o template corta em 900
// caracteres e as perguntas do fim sumiam (caso real 02/10/2026, rotina de 1556
// caracteres chegou com 901). Agora o conteúdo inteiro vai por e-mail e o
// WhatsApp só avisa. Fetch stubado: nada sai pra rede. Roda com: node routine-wa-long-email.test.mjs
import assert from 'node:assert/strict';
process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = '1';
process.env.WA_VERIFY_TOKEN = 'v';

const wa = [];
globalThis.fetch = async (_url, opts) => {
  wa.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ messages: [{ id: `wamid.${wa.length}` }] }) };
};
const { sendWhatsAppProactive, whatsappWindowOpen, WA_TEMPLATE_MAX, setWaHooks } = await import('./web/whatsapp.mjs');
const { createScheduledDelivery } = await import('./web/scheduled-delivery.mjs');

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

// 1) Janela fechada + texto maior que o template: inteiro por e-mail, WA só avisa.
fechada(); reset();
let rec = await deliverRoutine(rotina(), longa);
assert.equal(emails.length, 1); assert.ok(emails[0].text.includes('Question 3: what would you change?')); n++;
assert.equal(wa.length, 1); assert.equal(wa[0].type, 'template');
const aviso = wa[0].template.components[0].parameters[0].text;
// Sem agente: frase fixa + explicação da janela de 24h, sem saudação (o template já tem).
assert.equal(aviso, `O "Aquece diário de inglês" de hoje ficou pronto. ${J}`);
assert.ok(aviso.length < WA_TEMPLATE_MAX); n++;
assert.equal(rec.fullContent, 'email'); n++;
// O thread do WhatsApp guarda o aviso que ele viu + o conteúdo marcado como
// e-mail: se ele pedir lá "o conteúdo", o assistente sabe qual é (caso 02/10/2026).
assert.deepEqual(threads, [{ channel: 'whatsapp', body: `${aviso}\n\nConteúdo completo (enviado por e-mail):\n\n${longa}` }]); n++;

// 2) Janela aberta: mensagem de sessão aceita texto longo, nada de e-mail.
aberta(); reset();
await deliverRoutine(rotina(), longa);
assert.equal(emails.length, 0); assert.equal(wa[0].type, 'text'); n++;

// 2b) Janela aberta mas maior que 3500: vai por e-mail, e o aviso NÃO fala de
// janela de 24h (seria mentira com a janela aberta).
aberta(); reset();
await deliverRoutine(rotina(), 'x '.repeat(1800));
assert.equal(emails.length, 1); assert.equal(wa[0].type, 'text');
assert.ok(wa[0].text.body.includes('grande demais para mandar por aqui') && !wa[0].text.body.includes('24h')); n++;

// 3) Janela fechada mas texto curto: cabe no template, segue pelo WhatsApp.
fechada(); reset();
await deliverRoutine(rotina(), 'Hoje: um podcast curto. Responda por áudio.');
assert.equal(emails.length, 0); assert.equal(wa.length, 1); assert.equal(wa[0].type, 'template'); n++;

// 4) Sem e-mail cadastrado: não tem pra onde desviar, vai pelo template como antes.
fechada(); reset();
await deliverRoutine(rotina({ email: null }), longa);
assert.equal(emails.length, 0); assert.equal(wa.length, 1); n++;

// 5) Com o agente disponível, ele preenche SÓ o tema de hoje (senão seria igual
// toda noite) numa frase fixa; a explicação do e-mail vem depois, fixa.
const pedidos = [];
let resposta = 'O futuro do trabalho com a IA.';
const comAgente = createScheduledDelivery({ ...deps, runAgentMessageDraft: async (target, task) => {
  if (task.includes('vai ser entregue por e-mail')) return task.split('\n\n---\n')[1]; // nada a adaptar
  pedidos.push({ target, task }); return resposta;
} });
fechada(); reset();
rec = await comAgente.deliverRoutine(rotina(), longa);
assert.equal(pedidos.length, 1); assert.deepEqual(pedidos[0].target, { agent_id: 'a1', user_id: 'u1' });
assert.ok(pedidos[0].task.includes('Question 3: what would you change?')); n++;
assert.ok(pedidos[0].task.includes('"O conteúdo de hoje é sobre ___."') && pedidos[0].task.includes('no máximo 8')); n++;
assert.equal(wa[0].template.components[0].parameters[0].text, `O conteúdo de hoje é sobre o futuro do trabalho com a IA. ${J}`); n++;
assert.equal(emails.length, 1); assert.equal(rec.fullContent, 'email'); n++;
assert.ok(threads[0].body.startsWith(`O conteúdo de hoje é sobre o futuro do trabalho com a IA. ${J}\n\nConteúdo completo`)); n++;
// Nome próprio/sigla no começo do tema não vira minúscula; a frase segue o idioma da pessoa.
resposta = 'IA nos call centres'; fechada(); reset();
await comAgente.deliverRoutine(rotina({ user_language: 'en' }), longa);
assert.ok(pedidos.at(-1).task.includes("Today's content is about ___.") && pedidos.at(-1).task.includes('em English'));
assert.ok(wa[0].template.components[0].parameters[0].text.startsWith("Today's content is about IA nos call centres. Since WhatsApp")); n++;

// 6) Tema inutilizável: a frase telegráfica do teste de 02/10, longo demais, com
// saudação, mais de 8 palavras, ou erro. Cai na frase fixa com o título.
for (const ruim of [async () => 'Episódio de 6 Minute English sobre o futuro do trabalho: se a IA vai acabar com empregos',
  async () => 'x'.repeat(2000), async () => 'Oi, Ana! o futuro do trabalho',
  async () => 'o futuro do trabalho e a semana de quatro dias na prática', async () => { throw new Error('modelo fora'); }]) {
  const d = createScheduledDelivery({ ...deps, runAgentMessageDraft: ruim });
  fechada(); reset();
  await d.deliverRoutine(rotina(), longa);
  assert.equal(wa[0].template.components[0].parameters[0].text, `O "Aquece diário de inglês" de hoje ficou pronto. ${J}`); n++;
}

// 7) E-mail de conteúdo escrito pro chat: "manda o áudio por aqui" não pode ir
// assim por e-mail. O agente troca só a frase do canal; o resto chega igual.
const chat = 'Hoje: BBC 6 Minute English\nhttps://www.bbc.co.uk/learningenglish/ep-241219\n' +
  'Pergunta 1: Can AI replace human agents?\n'.repeat(30) + 'Manda as três respostas em áudio por aqui que eu te corrijo. 🎧';
const viaWa = chat.replace('em áudio por aqui', 'em áudio lá no WhatsApp');
let adapta = async () => viaWa;
const adaptando = createScheduledDelivery({ ...deps, runAgentMessageDraft: async (_t, task) =>
  task.includes('vai ser entregue por e-mail') ? adapta(task) : 'IA nos call centres' });
fechada(); reset();
await adaptando.deliverRoutine(rotina(), chat);
assert.ok(emails[0].text.includes('em áudio lá no WhatsApp') && !emails[0].text.includes('por aqui')); n++;
// No WhatsApp (thread) o texto fica o original: lá "por aqui" está certo.
assert.ok(threads[0].body.endsWith(`Conteúdo completo (enviado por e-mail):\n\n${chat}`)); n++;
// Adaptação que perde link, muda linhas demais ou falha: nota fixa no topo + texto original.
for (const ruim of [async () => viaWa.replace(/https:\S+/, ''), async () => viaWa.replace(/Pergunta/g, 'Question'),
  async () => 'resumo', async () => { throw new Error('modelo fora'); }]) {
  adapta = ruim; fechada(); reset();
  await adaptando.deliverRoutine(rotina(), chat);
  assert.ok(emails[0].text.startsWith('Oi, João!\n\nEsta rotina é do WhatsApp. Ficou grande demais pra lá, então veio por e-mail. As respostas e os áudios, manda lá no WhatsApp.\n\n' + chat)); n++;
}

console.log(`ok ${n}`);
