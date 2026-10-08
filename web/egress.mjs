// ── Single egress point ──
// Wraps the global `fetch` and logs, once per host, WHO called and WHERE it
// went. Serves two purposes:
//
//   1. today: a running proof of the egress inventory (the list below). A host
//      that shows up in the log and isn't in the list below is a finding.
//   2. later (Phase 4): the SAME list becomes a network fence. `EGRESS_MODE=block`
//      makes a host outside the list fail instead of going out.
//
// The log NEVER includes path, query, header or body, nor a token: only
// hostname, port (when it isn't 443) and the module that called. A signed S3
// URL and an API key travel in the path/query, so logging the full URL would
// create the exact leak this file exists to prevent.
//
// Coverage: everything that goes through `fetch()` (that's the case for
// ~all ~60 modules and the providers). Does NOT go through here, since it
// doesn't use fetch:
//   - `web/kms.mjs` (IMDS + KMS via `https.request`)
//   - `web/avscan.mjs` (clamd via `net.connect`)
//   - `email.mjs`/`mailer.mjs`'s SMTP/IMAP (nodemailer/imap socket)
//   - Postgres (`pg`)
// These four are fixed, known destinations, not model-routed.
//
// Import ONCE, as early as possible, in `web/server.mjs`.

import path from 'path';
import { assertDeepSeekEgress } from '../core-proto/deepseek/scope.mjs';
import { marca } from './marca.mjs';

// Expected hosts, from the 2026-08-27 inventory. Each entry matches the exact
// host OR any subdomain of it. A new integration goes in here in the same
// commit that adds it (and in the inventory's corresponding line). The
// installation's own domains don't go here: they come from the brand
// (hostsDeSaida), read at use time by hostsPermitidos().
export const EGRESS_ALLOW = [
  // infra
  'amazonaws.com',            // S3, KMS, IMDS
  // modelos
  'api.deepseek.com',
  'api.together.xyz',
  'api.deepinfra.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  // busca
  'serpapi.com',
  'api.tavily.com',
  'vertexaisearch.cloud.google.com',
  // search result thumbnail, checked by `imageServed` (server.mjs:45)
  // before becoming a card photo. Only the result's URL goes out, nothing from the user.
  'gstatic.com',
  // canais
  'graph.facebook.com',
  // Meta's CDN from where media RECEIVED on WhatsApp is downloaded
  // (`whatsapp.mjs:218`). Attention: this GET carries our `WA_TOKEN`.
  'lookaside.fbsbx.com',
  'api.telegram.org',
  'api.resend.com',
  'exp.host',
  // login and billing
  'accounts.google.com',
  'oauth2.googleapis.com',
  'api.stripe.com',
  // connectors the user turns on
  'googleapis.com',
  'api.github.com',
  'github.com',
  'slack.com',
  'graph.microsoft.com',
  'login.microsoftonline.com',
  'api.linkedin.com',
  'www.linkedin.com',
  'api.nuvemshop.com.br',
  'www.tiendanube.com',
  'api.notion.com',
  'secure.splitwise.com',
  'app.startinfinity.com',
  'api.asaas.com',
  'api.appstoreconnect.apple.com',
  // MCP server configured by the user (table `mcp_servers`). The host is
  // ARBITRARY by design: the user pastes the URL and that server's tools enter
  // the tool loop, receiving arguments that may hold their content. Today only
  // this one exists (since 26/06). In Phase 4, `block` must read `mcp_servers`
  // instead of relying on this fixed line, or new user MCPs will start
  // failing.
  'mcp.deepwiki.com',
];

const MODE = (process.env.EGRESS_MODE || 'log').toLowerCase();

// Internal network and localhost aren't egress: sandbox runnerd, Postgres,
// Comfy and the local panel. Stay out of the log so it doesn't drown out
// what matters.
function isInternal(host) {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || host === '::1' || host === '[::1]') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export const hostsPermitidos = () => [...marca().hostsDeSaida, ...EGRESS_ALLOW];

function isAllowed(host) {
  const h = String(host).toLowerCase();
  return hostsPermitidos().some((a) => h === a || h.endsWith('.' + a));
}

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// Who called: the first stack frame that is OUR file and isn't this module.
function callerModule() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack || '';
  Error.stackTraceLimit = limit;
  for (const line of stack.split('\n').slice(2)) {
    // Accepts both forms V8 uses: `(/path/x.mjs:1:2)` and
    // `file:///path/x.mjs:1:2` (ESM module top-level frame).
    const m = line.match(/(?:file:\/\/)?(\/[^\s():]+\.mjs):\d+:\d+/);
    if (!m) continue;
    const file = m[1].replace(/^\/+/, '/');
    if (file.endsWith('/web/egress.mjs')) continue;
    if (file.includes('/node_modules/')) continue;
    if (!file.startsWith(ROOT)) continue;
    return path.relative(ROOT, file);
  }
  return '?';
}

// host -> { calls, vias:Set, lastWarn }
const seen = new Map();

export function egressHosts() {
  return [...seen.entries()]
    .map(([host, s]) => ({ host, calls: s.calls, vias: [...s.vias], conhecido: isAllowed(host) }))
    .sort((a, b) => b.calls - a.calls);
}

let installed = false;

export function installEgress() {
  if (installed) return;
  const orig = globalThis.fetch;
  if (typeof orig !== 'function') {
    console.error('[egress] fetch global ausente; ponto de saída NÃO instalado');
    return;
  }
  installed = true;

  globalThis.fetch = function fetch(input, init) {
    let host = '';
    let port = '';
    try {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      const u = new URL(raw);
      host = u.hostname.toLowerCase();
      port = u.port && u.port !== '443' ? ':' + u.port : '';
    } catch {
      // Relative URL or exotic object: not an egress to an external host.
      return orig.call(this, input, init);
    }

    try { assertDeepSeekEgress(host); } catch (error) { return Promise.reject(error); }
    if (!isInternal(host)) {
      const known = isAllowed(host);
      let s = seen.get(host);
      if (!s) {
        s = { calls: 0, vias: new Set(), lastWarn: 0 };
        seen.set(host, s);
      }
      s.calls++;
      const via = callerModule();
      const novoVia = !s.vias.has(via);
      s.vias.add(via);

      if (!known) {
        // Host outside the inventory: always warns (with a ceiling of 1/min per
        // host, so a loop doesn't drown out the journal).
        const now = Date.now();
        if (now - s.lastWarn > 60_000) {
          s.lastWarn = now;
          console.warn(`[egress] FORA DO INVENTARIO host=${host}${port} via=${via} calls=${s.calls} mode=${MODE}`);
        }
        if (MODE === 'block') {
          return Promise.reject(new Error(`[egress] host bloqueado: ${host} (via ${via}). Entre no inventário antes.`));
        }
      } else if (novoVia) {
        // Known host: one line per (host, module), just to prove who goes out.
        console.log(`[egress] host=${host}${port} via=${via}`);
      }
    }

    return orig.call(this, input, init);
  };

  console.log(`[egress] ponto de saída instalado (mode=${MODE}, ${hostsPermitidos().length} hosts no inventário)`);
}

installEgress();
