import assert from 'node:assert/strict';
import { readSid } from './web/auth.mjs';

const stale = 'a'.repeat(64);
const fresh = 'b'.repeat(64);
const req = (headers = {}) => ({ headers });

// Web continua dependendo exclusivamente do cookie HttpOnly.
assert.equal(readSid(req({ cookie: `sid=${stale}` })), stale);
assert.equal(readSid(req({ authorization: `Bearer ${fresh}` })), null);

// Mobile usa Bearer e a sessão nova ganha de qualquer cookie antigo.
assert.equal(readSid(req({ 'x-brambs-mobile': '1', authorization: `Bearer ${fresh}` })), fresh);
assert.equal(readSid(req({
  'x-brambs-mobile': '1',
  authorization: `Bearer ${fresh}`,
  cookie: `sid=${stale}`,
})), fresh);

// Compatibilidade temporária: build antigo sem Bearer ainda pode usar cookie.
assert.equal(readSid(req({ 'x-brambs-mobile': '1', cookie: `sid=${stale}` })), stale);

// Bearer malformado nunca vira chave de banco; cookie válido ainda funciona.
assert.equal(readSid(req({
  'x-brambs-mobile': '1',
  authorization: 'Bearer invalido',
  cookie: `sid=${stale}`,
})), stale);

console.log('mobile session auth: cookie web preservado e Bearer mobile validado');
