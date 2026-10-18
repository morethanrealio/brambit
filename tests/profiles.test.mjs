// Usage profiles (web/profiles.mjs): which requests each profile answers. The
// public-support list is a security boundary, so a route added to the owner's
// app must not answer there by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readProfile, routeAllowed, redirectFor } from '../web/profiles.mjs';
import { createPermissionsFromEnv } from '../web/permissions.mjs';
import { APP_PAGES, PUBLIC_SUPPORT_PAGE, movedPagePath } from '../web/page-paths.mjs';

const allowed = (current, method, pathname, registered = false) => routeAllowed(method, pathname, { registered, current });

test('readProfile: complete by default, rejects an unknown name', () => {
  assert.equal(readProfile(undefined), 'complete');
  assert.equal(readProfile(' Public-Support '), 'public-support');
  assert.throws(() => readProfile('family'), /BRAMBIT_PROFILE/);
});

test('complete answers everything', () => {
  for (const p of ['/public-support', '/api/publico/agentes', '/api/agents', '/chats']) assert.equal(allowed('complete', 'GET', p), true);
});

test('personal turns off only public support', () => {
  for (const p of ['/public-support', '/public-support.html', '/api/publico/agentes', '/api/public/messages']) assert.equal(allowed('personal', 'GET', p, true), false, p);
  for (const p of ['/chats', '/api/agents', '/api/chat', '/api/me']) assert.equal(allowed('personal', 'GET', p), true, p);
});

test('public-support: the owner app is off, the public channels and the account stay', () => {
  const off = [['GET', '/api/agents'], ['POST', '/api/chat'], ['GET', '/api/agent/get'], ['POST', '/api/agent/delete'],
    ['GET', '/api/routines'], ['POST', '/api/mobile/connect', true], ['POST', '/api/onboard/intro', true], ['GET', '/api/media']];
  for (const [m, p, reg] of off) assert.equal(allowed('public-support', m, p, !!reg), false, `${m} ${p}`);
  const on = [['POST', '/api/agent'], ['GET', '/api/me'], ['POST', '/api/login'], ['POST', '/api/wa/webhook'], ['GET', '/api/usage'],
    ['GET', '/api/publico/agentes', true], ['POST', '/api/public/messages', true], ['GET', '/api/admin/settings', true], ['POST', '/api/signup', true],
    ['GET', '/public-support'], ['GET', '/login'], ['GET', '/usage']];
  for (const [m, p, reg] of on) assert.equal(allowed('public-support', m, p, !!reg), true, `${m} ${p}`);
});

test('public-support: the owner pages lead to /public-support', () => {
  assert.equal(allowed('public-support', 'GET', '/chats'), false);
  assert.equal(redirectFor('GET', '/chats', 'public-support'), '/public-support');
  assert.equal(redirectFor('GET', '/settings', 'public-support'), '/public-support');
  assert.equal(redirectFor('POST', '/chats', 'public-support'), null);
  assert.equal(redirectFor('GET', '/chats', 'complete'), null);
});

// Links with the old Portuguese paths are already out in e-mails and messages.
test('old page paths lead to pages that still exist', () => {
  for (const [from, to] of [['/inicio', '/chats'], ['/conversas', '/chats'], ['/habilidades-apps', '/skills-and-apps'],
    ['/config', '/settings'], ['/atendimento', '/public-support'], ['/atendimento.html', '/public-support']]) {
    assert.equal(movedPagePath('GET', from), to, from);
  }
  for (const from of ['/nova', '/assistentes', '/memoria', '/conexoes', '/contatos', '/arquivos', '/creditos']) {
    const to = movedPagePath('HEAD', from);
    assert.ok(APP_PAGES.has(to) || to === PUBLIC_SUPPORT_PAGE, `${from} -> ${to}`);
  }
  assert.equal(movedPagePath('POST', '/inicio'), null);
  assert.equal(movedPagePath('GET', '/chats'), null);
});

test('public-support closes sign-up even when BRAMBIT_SIGNUP is open', async () => {
  assert.equal(await createPermissionsFromEnv({ signup: '', admin: 'owner@example.com', profile: 'public-support' }).filaDeEspera(), true);
  assert.equal(await createPermissionsFromEnv({ signup: '', admin: 'owner@example.com', profile: 'complete' }).filaDeEspera(), false);
});
