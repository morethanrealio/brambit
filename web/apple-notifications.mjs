// ── Sign in with Apple server-to-server notifications ──
// Apple POSTs here when a person changes how they share their Apple Account
// with the app: turns "Hide My Email" forwarding off or back on, stops using
// Sign in with Apple for the app, or deletes the Apple Account. The URL is set
// in the Apple Developer portal (the app's Sign in with Apple configuration,
// "Server-to-Server Notification Endpoint"): https://<host>/api/webhook/apple/signin.
//
// Each event only touches the email suppression list (email-suppression.mjs);
// no account is deleted or unlinked from here:
//  • email-disabled: the relay stops forwarding, the address is suppressed;
//  • email-enabled: forwarding is back, the suppression is lifted;
//  • consent-revoked, account-delete(d): Apple drops the relay along with the
//    app's access, so the user's relay address is suppressed. A real address
//    (not a relay) keeps working and is left alone.
// The body is { payload: <JWT signed by Apple> }; nothing in it is used before
// verifyAppleJws has checked the signature, the issuer and the audience.
import { appleEnabled, verifyAppleJws } from './apple-auth.mjs';
import { readRaw } from './http-body.mjs';
import { normalizeAddress, emailSuppressions } from './email-suppression.mjs';

export const APPLE_NOTIFICATIONS_PATH = '/api/webhook/apple/signin';
const MAX_BODY = 64 * 1024;
const RELAY_DOMAIN = '@privaterelay.appleid.com';
// Apple's docs name the deletion event `account-deleted`; `account-delete` is
// accepted too, as a defensive alias.
const ACCESS_ENDED = new Set(['consent-revoked', 'account-delete', 'account-deleted']);

// `events` is documented as an object; a JSON-encoded string is read as well.
// null when there is no usable event.
export function appleEvent(claims) {
  let ev = claims?.events;
  if (typeof ev === 'string') {
    try { ev = JSON.parse(ev); } catch { return null; }
  }
  return ev && typeof ev === 'object' && typeof ev.type === 'string' ? ev : null;
}

// Applies one verified notification. Returns what was done, for the log:
// 'suppressed' | 'lifted' | 'ignored'.
export async function applyAppleEvent(claims, deps = {}) {
  const ev = appleEvent(claims);
  if (!ev) return 'ignored';
  const email = normalizeAddress(ev.email);
  const suppressions = () => deps.suppressions || emailSuppressions();
  if (ev.type === 'email-disabled' && email) {
    await (await suppressions()).suppress(email, { source: 'apple', reason: ev.type });
    return 'suppressed';
  }
  if (ev.type === 'email-enabled' && email) {
    await (await suppressions()).lift(email);
    return 'lifted';
  }
  if (!ACCESS_ENDED.has(ev.type)) return 'ignored';
  // These events may come without the address: the account's own email is the
  // one we write to, looked up by the stable `sub`.
  const getUserByAppleSub = deps.getUserByAppleSub || (async (sub) => (await import('./db.mjs')).getUserByAppleSub(sub));
  const user = ev.sub ? await getUserByAppleSub(String(ev.sub)) : null;
  const relays = new Set([email, normalizeAddress(user?.email)].filter((a) => a?.endsWith(RELAY_DOMAIN)));
  for (const relay of relays) await (await suppressions()).suppress(relay, { source: 'apple', reason: ev.type });
  return relays.size ? 'suppressed' : 'ignored';
}

export function registerAppleNotifications(rotas, deps = {}) {
  rotas.registrar('POST', APPLE_NOTIFICATIONS_PATH, async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!appleEnabled()) return reply(404, { error: 'not_found' });
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(413, { error: 'payload_too_large' });
    let claims;
    try {
      const raw = await readRaw(req);
      if (raw.length > MAX_BODY) return reply(413, { error: 'payload_too_large' });
      const { payload } = JSON.parse(raw.toString('utf8') || '{}');
      claims = await (deps.verify || verifyAppleJws)(payload);
    } catch (e) {
      console.warn('[apple-notifications] rejected:', e?.message ?? e);
      return reply(400, { error: 'invalid_notification' });
    }
    try {
      const outcome = await applyAppleEvent(claims, deps);
      // Only the event type and the outcome: sub and address stay out of the log.
      console.log(`[apple-notifications] ${appleEvent(claims)?.type || 'no event'}: ${outcome}`);
      return reply(200, { ok: true });
    } catch (e) {
      console.error('[apple-notifications]', e?.message ?? e);
      return reply(500, { error: 'apple_notification_failed' });
    }
  });
}
