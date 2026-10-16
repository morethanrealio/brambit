// The CSRF check (web/csrf.mjs): the browser's own Sec-Fetch-Site lets in a page
// of this site whose Origin an extension rewrote, and only adds a way in; the
// Origin/Referer rule keeps deciding everything else exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOwnSite } from '../web/csrf.mjs';

const req = (headers) => ({ headers: { host: 'app.example.com', ...headers } });

test('a page of this site gets in even with its Origin rewritten', () => {
  assert.equal(fromOwnSite(req({ 'sec-fetch-site': 'same-origin', origin: 'chrome-extension://abc' })), true);
  assert.equal(fromOwnSite(req({ 'sec-fetch-site': 'same-origin' })), true);
});

test('another site stays out', () => {
  for (const site of ['cross-site', 'same-site', 'none', undefined]) {
    assert.equal(fromOwnSite(req({ 'sec-fetch-site': site, origin: 'https://evil.example' })), false, String(site));
  }
  assert.equal(fromOwnSite(req({ referer: 'https://evil.example/page' })), false);
  assert.equal(fromOwnSite(req({})), false);
});

test('the Origin/Referer rule decides as before', () => {
  assert.equal(fromOwnSite(req({ origin: 'https://app.example.com' })), true);
  assert.equal(fromOwnSite(req({ referer: 'http://app.example.com/chat' })), true);
  const before = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://brand.example.com/app';
  try { assert.equal(fromOwnSite(req({ 'sec-fetch-site': 'cross-site', origin: 'https://brand.example.com' })), true); }
  finally { if (before === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = before; }
});
