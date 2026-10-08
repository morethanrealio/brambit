// ── MCP client (Model Context Protocol) ──
// Connects the core to a remote MCP server via the "Streamable HTTP" transport
// (a single endpoint, JSON-RPC 2.0 over POST; the response comes as application/json
// OR text/event-stream). Lists the server's tools and returns each one in the
// SAME shape as the core's tools ({ name, description, parameters, run }), so
// they enter the tool-loop with no change to the harness.
//
// This is what allows plugging in Slack/Notion/Trello/etc. without hand-coding each one:
// the service exposes an MCP server, we just point to the URL (and an auth header
// when needed).

import { fetchExterno } from './net-guard.mjs';

const PROTOCOL_VERSION = '2025-06-18';

// Makes a JSON-RPC call and returns the `result` (or throws on `error`).
// Accepts a plain JSON response or SSE (grabs the 1st data: with the id we requested).
async function rpc(url, { id, method, params, headers = {}, notify = false }) {
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id, method, params };
  // fetchExterno, not fetch: the URL here belongs to the USER (they paste it in Connections) and
  // this call goes out from the backend, which is INSIDE the VPC. Without a guard, pointing to
  // 169.254.169.254 or 127.0.0.1 would make the server fetch, on the user's behalf,
  // something they can't reach from outside, and it would still hand over their Bearer in plain
  // text if the URL were http. The guard requires https + a public address and
  // revalidates on every redirect. Timeout too: an MCP server that doesn't respond
  // was holding up the whole turn.
  const r = await fetchExterno(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  }, { timeoutMs: 30_000 });
  // Notification (no id): server responds 202 with no body. Just returns the session.
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

// Scans an SSE body and returns the JSON-RPC object whose id matches the request.
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
    } catch { /* ignores keep-alives and non-JSON lines */ }
  }
  return null;
}

// Joins the content returned by tools/call into text for the model to read.
function renderToolResult(result) {
  if (!result) return '';
  const parts = result.content || [];
  const text = parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? JSON.stringify(p.resource) : ''))
    .filter(Boolean)
    .join('\n');
  if (text) return result.isError ? `ERRO: ${text}` : text;
  // Some servers return structuredContent instead of textual content.
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

// Confirmation card sentence for an MCP call: which tool, from which
// connector and with which arguments (summarized), so the owner knows what they're approving.
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
 * Connects to an MCP server and returns its tools already in the core's shape.
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
  catch { /* some servers don't require it; proceeds */ }

  // 3) tools/list.
  const listed = await rpc(url, { id: 2, method: 'tools/list', params: {}, headers: sessionHeaders });
  const mcpTools = listed.result?.tools || [];

  const prefix = label ? `${label}_` : '';
  const tools = mcpTools.map((t) => ({
    name: (prefix + t.name).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64),
    description: t.description || `Tool ${t.name} (via MCP${label ? ' ' + label : ''}).`,
    parameters: t.inputSchema || { type: 'object', properties: {} },
    // We don't know what an external server's tool does: it might write,
    // delete or send. Every call goes through the confirmation card (gateTool).
    // The server's own readOnlyHint annotation doesn't clear anything: it's the server
    // talking about itself, and the decision to skip the card has to be ours.
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

// Just lists a server's tools (to validate config without running anything).
export async function mcpListTools(cfg) {
  const { tools, serverInfo } = await mcpConnect(cfg);
  return { serverInfo, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
}
