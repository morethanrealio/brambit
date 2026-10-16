// The Content-Security-Policy of every response. Without a nonce (non-HTML
// responses: JSON, JS, CSS, media) it is strict, no inline at all. With a nonce
// (HTML pages) it allows ONLY the inline <script>/<style> stamped with that
// request's nonce, never 'unsafe-inline' in script, so injected <script>/<style>
// stays blocked. style-src-attr keeps 'unsafe-inline' because the front uses many
// style="..." attributes (not an exploitable vector; a nonce does not cover
// attributes); the plain style-src is only a fallback for browsers without CSP3
// (-elem/-attr), which modern ones ignore when the specific directives exist.
//
// The core loads nothing from another origin. A plugin that needs to (analytics,
// an ad conversion tag) widens the policy on purpose with its `csp` field
// (plugins.mjs): extra https origins for the directives below, nothing else. No
// keywords, no 'unsafe-*', no bare wildcard: a plugin can add a host, not turn
// the policy off.
export const DIRETIVAS_DE_PLUGIN = ['script-src', 'img-src', 'connect-src', 'frame-src'];
const ORIGEM = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

// {directive: [origin, ...]} → the same, validated; throws at boot otherwise.
export function conferirCsp(csp, quem = 'csp') {
  if (!csp || typeof csp !== 'object' || Array.isArray(csp)) throw Error(`${quem} precisa ser um objeto {diretiva: [origens]}`);
  for (const [k, v] of Object.entries(csp)) {
    if (!DIRETIVAS_DE_PLUGIN.includes(k)) throw Error(`${quem}: diretiva não permitida ${k} (só ${DIRETIVAS_DE_PLUGIN.join(', ')})`);
    if (!Array.isArray(v) || !v.every((o) => typeof o === 'string' && ORIGEM.test(o))) throw Error(`${quem}: ${k} aceita só origens https (ex.: https://www.example.com)`);
  }
  return csp;
}

// extras = {directive: [origin, ...]} from the plugins → buildCsp(nonce).
export function criarCsp(extras = {}) {
  const mais = (d) => [...new Set(extras[d] || [])].map((o) => ` ${o}`).join('');
  return function buildCsp(nonce) {
    const n = nonce ? ` 'nonce-${nonce}'` : '';
    return [
      "default-src 'self'",
      `script-src 'self'${n}${mais('script-src')}`,
      `style-src-elem 'self'${n}`,
      "style-src-attr 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${mais('img-src')}`,
      "font-src 'self' data:",
      `connect-src 'self'${mais('connect-src')}`,
      `frame-src 'self'${mais('frame-src')}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
  };
}
