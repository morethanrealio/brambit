// Deriva um uuid ESTÁVEL de um identificador externo (ex: id de sessão do
// Stripe). Serve pra guardar uma referência de fora numa coluna uuid sem
// perder a idempotência: a mesma entrada devolve sempre o mesmo uuid.
// Formato de UUID v5 (sha1 + bits de versão/variante), sem dependência.
// Mora aqui (e não só no server.mjs) porque a entrada na empresa também
// precisa dele pra achar de onde veio cada pacote (org-join-refund.mjs).
import { createHash } from 'node:crypto';

export function uuidDe(externo) {
  const h = createHash('sha1').update(String(externo)).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // versão 5
  h[8] = (h[8] & 0x3f) | 0x80; // variante RFC 4122
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
