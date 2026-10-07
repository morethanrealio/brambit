// ── Cliente MCP (Model Context Protocol) ──
// Conecta o core a um servidor MCP remoto pela transport "Streamable HTTP"
// (um único endpoint, JSON-RPC 2.0 por POST; a resposta vem em application/json
// OU text/event-stream). Lista as tools do servidor e devolve cada uma no
// MESMO shape das tools do core ({ name, description, parameters, run }), então
// elas entram no tool-loop sem nenhuma mudança no harness.
//
// Isso é o que permite plugar Slack/Notion/Trello/etc. sem codar cada um na mão:
// o serviço expõe um servidor MCP, a gente só aponta a URL (e um header de auth
// quando precisa).

import { fetchExterno } from './net-guard.mjs';

const PROTOCOL_VERSION = '2025-06-18';

// Faz uma chamada JSON-RPC e devolve o `result` (ou lança no `error`).
// Aceita resposta JSON pura ou SSE (pega o 1º data: com o id que pedimos).
async function rpc(url, { id, method, params, headers = {}, notify = false }) {
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id, method, params };
  // fetchExterno, não fetch: a URL aqui é do USUÁRIO (ele cola em Conexões) e
  // esta chamada sai do backend, que está DENTRO da VPC. Sem guarda, apontar pro
  // 169.254.169.254 ou pro 127.0.0.1 fazia o servidor buscar, pelo usuário,
  // coisa que ele não alcança de fora, e ainda entregava o Bearer dele em texto
  // puro se a URL fosse http. A guarda exige https + endereço público e
  // revalida a cada redirect. Timeout junto: servidor MCP que não responde
  // segurava o turno inteiro.
  const r = await fetchExterno(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  }, { timeoutMs: 30_000 });
  // Notificação (sem id): servidor responde 202 sem corpo. Só devolve a sessão.
  const session = r.headers.get('mcp-session-id') || headers['mcp-session-id'] || null;
  if (notify) return { session };
  if (!r.ok) throw new Error(`MCP ${method} ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const ct = r.headers.get('content-type') || '';
  let payload;
  if (ct.includes('text/event-stream')) {
    payload = parseSseForId(await r.text(), id);
  } else {
    payload = await r.json();
  }
  if (!payload) throw new Error(`MCP ${method}: resposta vazia`);
  if (payload.error) throw new Error(`MCP ${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return { result: payload.result, session };
}

// Varre um corpo SSE e devolve o objeto JSON-RPC cujo id casa com o pedido.
function parseSseForId(text, id) {
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    try {
      const obj = JSON.parse(data);
      if (obj.id === id) return obj;
    } catch { /* ignora keep-alives e linhas não-JSON */ }
  }
  return null;
}

// Junta o conteúdo devolvido por tools/call num texto pro modelo ler.
function renderToolResult(result) {
  if (!result) return '';
  const parts = result.content || [];
  const text = parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? JSON.stringify(p.resource) : ''))
    .filter(Boolean)
    .join('\n');
  if (text) return result.isError ? `ERRO: ${text}` : text;
  // Alguns servidores devolvem structuredContent em vez de content textual.
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

// Frase do cartão de confirmação de uma chamada MCP: qual ferramenta, de qual
// conector e com quais argumentos (resumidos), pro dono saber o que aprova.
export function describeMcpCall(label, toolName, args = {}, lang = '') {
  let resumo = '';
  try { resumo = JSON.stringify(args ?? {}); } catch { resumo = ''; }
  if (resumo === '{}') resumo = '';
  if (resumo.length > 300) resumo = resumo.slice(0, 297) + '...';
  const de = label ? (/^en/.test(lang) ? ` from the "${label}" connector` : /^es/.test(lang) ? ` del conector "${label}"` : ` do conector "${label}"`) : '';
  const com = resumo ? (/^en/.test(lang) ? ` with ${resumo}` : /^es/.test(lang) ? ` con ${resumo}` : ` com ${resumo}`) : '';
  const verbo = /^en/.test(lang) ? 'run the tool' : /^es/.test(lang) ? 'usar la herramienta' : 'usar a ferramenta';
  return `${verbo} "${toolName}"${de}${com}`;
}

/**
 * Conecta a um servidor MCP e devolve suas tools já no shape do core.
 * @param {{ url:string, headers?:object, label?:string }} cfg
 * @returns {Promise<{ tools:object[], serverInfo:object }>}
 */
export async function mcpConnect({ url, headers = {}, label = '' }) {
  // 1) initialize → capabilities + (geralmente) header mcp-session-id.
  const init = await rpc(url, {
    id: 1, method: 'initialize', headers,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'brambs', version: '0.1' },
    },
  });
  const session = init.session;
  const sessionHeaders = {
    ...headers,
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    ...(session ? { 'mcp-session-id': session } : {}),
  };

  // 2) notifications/initialized (handshake completo).
  try { await rpc(url, { method: 'notifications/initialized', notify: true, headers: sessionHeaders }); }
  catch { /* alguns servidores não exigem; segue */ }

  // 3) tools/list.
  const listed = await rpc(url, { id: 2, method: 'tools/list', params: {}, headers: sessionHeaders });
  const mcpTools = listed.result?.tools || [];

  const prefix = label ? `${label}_` : '';
  const tools = mcpTools.map((t) => ({
    name: (prefix + t.name).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64),
    description: t.description || `Tool ${t.name} (via MCP${label ? ' ' + label : ''}).`,
    parameters: t.inputSchema || { type: 'object', properties: {} },
    // Não sabemos o que uma ferramenta de servidor externo faz: ela pode gravar,
    // apagar ou enviar. Toda chamada passa pelo cartão de confirmação (gateTool).
    // A anotação readOnlyHint do próprio servidor não libera nada: é o servidor
    // falando de si mesmo, e a decisão de pular o cartão tem que ser nossa.
    requiresConfirmation: true,
    describeConfirmation: (args, lang) => describeMcpCall(label, t.name, args, lang),
    async run(args) {
      let callId = 100;
      const res = await rpc(url, {
        id: ++callId, method: 'tools/call',
        params: { name: t.name, arguments: args || {} },
        headers: sessionHeaders,
      });
      return renderToolResult(res.result);
    },
  }));

  return { tools, serverInfo: init.result?.serverInfo || {} };
}

// Só lista as tools de um servidor (pra validar config sem rodar nada).
export async function mcpListTools(cfg) {
  const { tools, serverInfo } = await mcpConnect(cfg);
  return { serverInfo, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
}
