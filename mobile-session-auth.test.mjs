import assert from 'node:assert/strict';
import { readSid } from './web/auth.mjs';

const stale = 'a'.repeat(64);
const fresh = 'b'.repeat(64);
const req = (headers = {}) => ({ headers });

// Web continua dependendo exclusivamente do cookie HttpOnly.
assert.equal(readSid(req({ cookie: `sid=${stale}` })), stale);
assert.equal(readSid(req({ authorization: `Bearer ${fresh}` })), null);

// Mobile uses Bearer and the new session wins over any old cookie.
assert.equal(readSid(req({ 'x-brambs-mobile': '1', authorization: `Bearer ${fresh}` })), fresh);
assert.equal(readSid(req({
  'x-brambs-mobile': '1',
  authorization: `Bearer ${fresh}`,
  cookie: `sid=${stale}`,
})), fresh);

// Temporary compatibility: an old build without Bearer can still use the cookie.
assert.equal(readSid(req({ 'x-brambs-mobile': '1', cookie: `sid=${stale}` })), stale);

// Malformed Bearer never becomes a database key; a valid cookie still works.
assert.equal(readSid(req({
  'x-brambs-mobile': '1',
  authorization: 'Bearer invalido',
  cookie: `sid=${stale}`,
})), stale);

console.log('mobile session auth: cookie web preservado e Bearer mobile validado');
