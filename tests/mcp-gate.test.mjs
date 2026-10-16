// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Offline: fake in-memory MCP server + the real gate. An MCP connector
// tool cannot run without the confirmation card: the server belongs to a third party and
// may write, delete, or send. No tools/call goes out before the owner confirms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './compras.mjs' && context.parentURL?.endsWith('/web/confirm.mjs')) {
      return {
        url: 'data:text/javascript,export function descreverCarrinho(){throw Error("unused offline")};export function plataformaDoCarrinho(){throw Error("unused offline")}',
        shortCircuit: true,
      };
    }
    if (specifier === './net-guard.mjs' && context.parentURL?.endsWith('/web/mcp.mjs')) {
      return { url: 'data:text/javascript,export const fetchExterno=(...a)=>globalThis.__fakeMcp(...a)', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { mcpConnect, describeMcpCall } = await import('../web/mcp.mjs');
const { gateTool, peekPending, takePending, isReactionConfirmable } = await import('../web/confirm.mjs');

// Minimal MCP server: initialize, tools/list, and tools/call. Records every call.
function fakeServer(tools) {
  const calls = [];
  globalThis.__fakeMcp = async (_url, opts) => {
    const msg = JSON.parse(opts.body);
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (msg.method === 'initialize') result = { serverInfo: { name: 'fake' } };
    else if (msg.method === 'tools/list') result = { tools };
    else if (msg.method === 'tools/call') {
      calls.push(msg.params);
      result = { content: [{ type: 'text', text: `apaguei ${msg.params.arguments.id}` }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
      status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
    });
  };
  return calls;
}

const APAGAR = { name: 'delete-page', description: 'Apaga uma página.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };

test('MCP tool becomes a confirmation request and only calls the server after the yes', async (t) => {
  const thread = 'mcp-portao-1';
  t.after(() => takePending(thread));
  const calls = fakeServer([APAGAR]);
  const { tools } = await mcpConnect({ url: 'https://mcp.example/x', label: 'notion' });
  assert.equal(tools[0].name, 'notion_delete_page');

  const out = await gateTool(tools[0], thread).run({ id: 'p42' });
  assert.match(out, /AÇÃO PENDENTE DE CONFIRMAÇÃO \(NÃO foi executada\)/);
  assert.equal(calls.length, 0, 'nothing can go to the server before confirmation');

  const pend = peekPending(thread);
  assert.equal(pend.name, 'notion_delete_page');
  assert.equal(pend.label, 'usar a ferramenta "delete-page" do conector "notion" com {"id":"p42"}');

  const claimed = takePending(thread);
  assert.equal(await claimed.run(claimed.args), 'apaguei p42');
  assert.deepEqual(calls, [{ name: 'delete-page', arguments: { id: 'p42' } }]);
});

test("the server's readOnlyHint does not release the card: we decide", async (t) => {
  const thread = 'mcp-portao-2';
  t.after(() => takePending(thread));
  const calls = fakeServer([{ ...APAGAR, annotations: { readOnlyHint: true } }]);
  const { tools } = await mcpConnect({ url: 'https://mcp.example/x', label: 'notion' });
  assert.match(await gateTool(tools[0], thread).run({ id: 'p1' }), /PENDENTE/);
  assert.equal(calls.length, 0);
});

test('dynamic name without the marker stays outside the gate; with the marker it requires text, not 👍', async () => {
  const solta = { name: 'qualquer_coisa', run: async () => 'rodou' };
  assert.equal(gateTool(solta, 'mcp-portao-3'), solta);
  assert.equal(isReactionConfirmable('notion_delete_page'), false);
});

test('card phrase: language, connector and long arguments summarized', () => {
  assert.equal(describeMcpCall('wiki', 'search', {}, 'en'), 'run the tool "search" from the "wiki" connector');
  assert.equal(describeMcpCall('', 'buscar', { q: 'x' }, 'es-ES'), 'usar la herramienta "buscar" con {"q":"x"}');
  const longo = describeMcpCall('n', 't', { texto: 'a'.repeat(1000) });
  assert.ok(longo.length < 400 && longo.endsWith('...'));
});
