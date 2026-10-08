// Derives a STABLE uuid from an external identifier (e.g. a Stripe session
// id). Used to store an outside reference in a uuid column without
// losing idempotency: the same input always returns the same uuid.
// UUID v5 format (sha1 + version/variant bits), no dependency.
// Lives here (and not only in server.mjs) because joining a company also
// needs it to find where each package came from (org-join-refund.mjs).
import { createHash } from 'node:crypto';

export function uuidDe(externo) {
  const h = createHash('sha1').update(String(externo)).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // variante RFC 4122
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
