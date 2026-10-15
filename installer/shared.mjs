// Brambit on your own computer for more than one person: BRAMBIT_SHARED_URL is
// the https address the others open on their own devices. Something on this same
// computer answers that address with a real certificate and passes each request
// to Brambit on 127.0.0.1 (Tailscale Serve, see "Share it with your household" in
// the README). Brambit itself keeps listening on 127.0.0.1 only.
//
// It has to be https: login cookies are Secure for anything that is not this
// computer (web/cookie-local.mjs), and browsers only allow the microphone on
// https. Empty, Brambit is for this computer only, as before.
export const SHARED_KEY = 'BRAMBIT_SHARED_URL';

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

// {} when empty, { url } (the origin, no trailing slash) or { error }.
// Without a scheme it is taken as https (casa.tail1234.ts.net).
export function sharedUrlOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return {};
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'not a web address' }; }
  if (u.protocol !== 'https:') return { error: 'it must be https://' };
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return { error: 'only the address, without a path, a query or a login' };
  if (LOOPBACK.test(u.hostname)) return { error: "it must be the address the other devices open, not this computer's own" };
  return { url: u.origin };
}

// What makes Tailscale answer this computer's https address and pass it to
// Brambit's port (it keeps doing it after a restart), and what turns it off.
export const tailscaleOn = (port) => `tailscale serve --bg ${port}`;
export const tailscaleOff = 'tailscale serve --https=443 off';
