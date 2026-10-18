// Item 5: a sub-agent's summary is model words, so it doesn't vouch for a link.
// What vouches is what the sub-agent's own tools returned (server.mjs collects it
// from runAgent's tool_result event). Gmail links must keep passing through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleTools } from '../web/connectors.mjs';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { emailSource } from '../web/email-evidence.mjs';
import { linksMontados } from '../web/links.mjs';

const ID = '18f2a9c0d1e2b3a4';
const CONTA = 'dono@example.invalid';
const html = '<p>Seu pedido saiu.</p><a href="https://rastreio.loja.example/pedido?id=123&amp;utm_source=email">Acompanhar pedido</a>';
const b64 = (s) => Buffer.from(s).toString('base64url');

test('Gmail links read by a sub-agent pass; a link only in its summary does not', async (t) => {
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, 'gmail.googleapis.com', 'no real network');
    return { ok: true, status: 200, json: async () => ({ id: ID, payload: { mimeType: 'text/html', headers: [{ name: 'Subject', value: 'Pedido enviado' }], body: { data: b64(html) } } }) };
  };
  const gmailRead = googleTools({ token: async () => 'MOCK_ONLY', account: CONTA, caps: { gmail: { read: true } } }).find((x) => x.name === 'gmail_read');
  const resumo = 'Achei o e-mail do pedido. Rastreio: https://correios.example/rastreio/AB123BR';
  let passo = 0;
  const provider = { name: 'offline-fake', complete: async () => (++passo === 1
    ? { stop: 'tool', toolCalls: [{ id: 't1', name: 'gmail_read', args: { id: ID } }] }
    : { stop: 'end', text: resumo }) };

  // Same wiring as the sub-agents in server.mjs (onToolOutput).
  const material = [];
  const r = await runAgent({ provider, tools: new ToolRegistry().add(gmailRead), system: 's', userInput: 'leia o e-mail',
    onEvent: (ev) => { if (ev?.type === 'tool_result') material.push(typeof ev.out === 'string' ? ev.out : JSON.stringify(ev.out)); } });
  assert.equal(r.text, resumo);

  const lido = JSON.parse(material[0]);
  const rastreio = lido.links?.[0]?.url;
  assert.ok(rastreio?.startsWith('https://rastreio.loja.example/pedido'), 'the tool returned the body link');
  const caixa = emailSource('gmail', lido, { read: true, account: CONTA }).link;
  const resposta = `Seu pedido saiu ([e-mail](${caixa}), também em https://mail.google.com/mail/u/0/#inbox/${ID}).\n`
    + `Acompanhe: ${rastreio}\nCorreios: https://correios.example/rastreio/AB123BR`;

  assert.deepEqual(linksMontados(resposta, { material, authenticatedEmailSources: [caixa] }),
    ['https://correios.example/rastreio/AB123BR']);
  // Without the code-built source list, the id the tool returned still vouches for the mailbox link.
  assert.deepEqual(linksMontados(resposta, { material }), ['https://correios.example/rastreio/AB123BR']);
});
