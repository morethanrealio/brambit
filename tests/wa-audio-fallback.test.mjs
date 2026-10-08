// Audio that WhatsApp refuses must not disappear: the text reply ("mandei em
// voz") goes out before the attachment, so if the upload fails the person needs to receive the
// speech as text. Real case 2026-10-02: prod without ffmpeg generated WAV, Meta
// refused it and only the confirmation arrived.
// Fetch stub: nothing goes out to the network, nothing touches the DB. Run with: node tests/wa-audio-fallback.test.mjs
process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = '1';
process.env.WA_VERIFY_TOKEN = 'v';
process.env.WA_DEBOUNCE_MS = '1';
process.env.WA_TURN_HEARTBEAT_MS = '0';

const enviadas = [];
let seq = 0;
globalThis.fetch = async (_url, opts) => {
  if (opts?.body instanceof FormData) {
    // Same as Meta: WAV is not an accepted audio type.
    if (opts.body.get('type') === 'audio/wav') return { ok: false, status: 400, json: async () => ({ error: { message: 'Param file must be a file with one of the following types: audio/ogg' } }) };
    return { ok: true, json: async () => ({ id: 'media1' }) };
  }
  enviadas.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ messages: [{ id: `wamid.${++seq}` }] }) };
};

const { createWhatsAppHandler, setWaHooks } = await import('../web/whatsapp.mjs');

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const cobrancas = [];
setWaHooks({ lastInboundAt: async () => new Date(), billMessages: async (c) => { cobrancas.push(c); } });
const db = {
  getWhatsAppLink: async () => ({ user_id: 'u1', enabled: true, active_agent_id: 'a1' }),
  listAgents: async () => [{ id: 'a1', name: 'Bot' }],
  setWhatsAppActiveAgent: async () => {}, claimWaMsg: async () => true, touchWaInbound: async () => {},
  saveWaMsgRef: async () => {}, recordWaStatus: async () => {},
};
let resposta, midia;
const handler = createWhatsAppHandler({
  runConversation: async () => resposta, reactionConfirm: async () => resposta,
  loadAgent: async () => ({ id: 'a1', name: 'Bot' }), db, transcribe: null,
  getMedia: async () => midia,
});
let mseq = 0;
const turno = async () => {
  enviadas.length = 0; cobrancas.length = 0;
  await handler.process({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1' }, messages: [{ id: `m${++mseq}`, from: '5511999999999', type: 'text', text: { body: 'me responde em áudio' } }] } }] }] });
  await new Promise((r) => setTimeout(r, 60));
};
const fala = 'Hi João, today we practice the past tense.';
const textos = () => enviadas.filter((b) => b.type === 'text').map((b) => b.text.body);
const cobrado = () => cobrancas.reduce((s, c) => s + (c.messages || 0), 0);

// 1) Refused audio (WAV): the speech arrives as text and the extra message is billed.
resposta = { text: 'Mandado em voz ✅', attachments: [{ type: 'audio', url: '/api/img?k=a', mime: 'audio/wav', key: 'a', fala }] };
midia = { buffer: Buffer.from('RIFF'), contentType: 'audio/wav' };
await turno();
t('confirmation goes out', textos()[0] === 'Mandado em voz ✅');
t('speech arrives as text when audio is refused', textos().some((s) => s.includes(fala)));
t('no audio sent', !enviadas.some((b) => b.type === 'audio'));
t('bills confirmation + speech text', cobrado() === 2);

// 2) Accepted audio (OGG): goes as audio, no duplicated text.
midia = { buffer: Buffer.from('OggS'), contentType: 'audio/ogg' };
resposta = { ...resposta, attachments: [{ ...resposta.attachments[0], mime: 'audio/ogg' }] };
await turno();
t('ogg goes as audio', enviadas.filter((b) => b.type === 'audio').length === 1);
t('ogg does not send the speech as text', !textos().some((s) => s.includes(fala)));

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
