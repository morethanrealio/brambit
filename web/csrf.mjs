// Where a request that changes something came from (CSRF, ASVS 4.2 / CASA).
// server.mjs csrfOk lets GET/HEAD/OPTIONS and the webhooks through and asks
// fromOwnSite for everything else; the session cookie is SameSite=Lax, so this
// is defense in depth.

// This site's origins: PUBLIC_BASE_URL and the Host the request came to.
export function allowedOrigins(req) {
  const set = new Set();
  const base = process.env.PUBLIC_BASE_URL;
  if (base) { try { set.add(new URL(base).origin); } catch { /* noop */ } }
  const host = req.headers.host;
  if (host) { set.add(`https://${host}`); set.add(`http://${host}`); }
  return set;
}

// true = came from a page of this site. Sec-Fetch-Site is written by the
// browser (no page can set a Sec- header) and says "same-origin" only for this
// site's own pages; some browser extensions rewrite the Origin, which blocked
// people on their own computer. It only adds a way in: without it, or with any
// other value, the Origin/Referer check decides as it always did.
export function fromOwnSite(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const allowed = allowedOrigins(req);
  const origin = req.headers.origin;
  if (origin) return allowed.has(origin);
  // No Origin (some older browsers): falls back to Referer.
  const ref = req.headers.referer;
  if (ref) { try { return allowed.has(new URL(ref).origin); } catch { return false; } }
  // Neither Origin nor Referer on a state-changing request: reject.
  return false;
}
