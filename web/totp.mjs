// TOTP (RFC 6238) sem dependência externa — usado pro segundo fator do dashboard
// admin (/metrics, /broadcast). HMAC-SHA1, passo de 30s, código de 6 dígitos.
import crypto from 'crypto';

// Decodifica uma secret em Base32 (RFC 4648, alfabeto A-Z2-7). Ignora espaços e
// padding "=". Retorna Buffer com os bytes da chave.
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('secret TOTP inválida (base32)');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// Gera o código HOTP de 6 dígitos pro contador informado.
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// Verifica um código TOTP contra a secret. Aceita janela de +/- `window` passos
// (30s cada) pra tolerar clock skew. Comparação em tempo constante.
export function verifyTotp(secret, token, { step = 30, window = 1, now = Date.now() } = {}) {
  const code = String(token || '').trim();
  if (!/^\d{6}$/.test(code)) return false;
  let keyBuf;
  try { keyBuf = base32Decode(secret); } catch { return false; }
  if (!keyBuf.length) return false;
  const counter = Math.floor(now / 1000 / step);
  const codeBuf = Buffer.from(code);
  for (let w = -window; w <= window; w++) {
    const cand = Buffer.from(hotp(keyBuf, counter + w));
    if (cand.length === codeBuf.length && crypto.timingSafeEqual(cand, codeBuf)) return true;
  }
  return false;
}
