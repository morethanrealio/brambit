// Usage profiles (web/profiles.mjs): which requests each profile answers. The
// public-support list is a security boundary, so a route added to the owner's
// app must not answer there by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readProfile, routeAllowed, redirectFor } from '../web/profiles.mjs';
import { createPermissionsFromEnv } from '../web/permissoes.mjs';

const allowed = (current, method, pathname, registered = false) => routeAllowed(method, pathname, { registered, current });

test('readProfile: complete by default, rejects an unknown name', () => {
  assert.equal(readProfile(undefined), 'complete');
  assert.equal(readProfile(' Public-Support '), 'public-support');
  assert.throws(() => readProfile('family'), /BRAMBIT_PROFILE/);
});

test('complete answers everything', () => {
  for (const p of ['/atendimento', '/api/publico/agentes', '/api/agents', '/inicio']) assert.equal(allowed('complete', 'GET', p), true);
});

test('personal turns off only public support', () => {
  for (const p of ['/atendimento', '/atendimento.html', '/api/publico/agentes', '/api/public/messages']) assert.equal(allowed('personal', 'GET', p, true), false, p);
  for (const p of ['/inicio', '/api/agents', '/api/chat', '/api/me']) assert.equal(allowed('personal', 'GET', p), true, p);
});

test('public-support: the owner app is off, the public channels and the account stay', () => {
  const off = [['GET', '/api/agents'], ['POST', '/api/chat'], ['GET', '/api/agent/get'], ['POST', '/api/agent/delete'],
    ['GET', '/api/routines'], ['POST', '/api/mobile/connect', true], ['POST', '/api/onboard/intro', true], ['GET', '/api/media']];
  for (const [m, p, reg] of off) assert.equal(allowed('public-support', m, p, !!reg), false, `${m} ${p}`);
  const on = [['POST', '/api/agent'], ['GET', '/api/me'], ['POST', '/api/login'], ['POST', '/api/wa/webhook'], ['GET', '/api/usage'],
    ['GET', '/api/publico/agentes', true], ['POST', '/api/public/messages', true], ['GET', '/api/admin/settings', true], ['POST', '/api/signup', true],
    ['GET', '/atendimento'], ['GET', '/login'], ['GET', '/usage']];
  for (const [m, p, reg] of on) assert.equal(allowed('public-support', m, p, !!reg), true, `${m} ${p}`);
});

test('public-support: the owner pages lead to /atendimento', () => {
  assert.equal(allowed('public-support', 'GET', '/inicio'), false);
  assert.equal(redirectFor('GET', '/inicio', 'public-support'), '/atendimento');
  assert.equal(redirectFor('GET', '/conversas', 'public-support'), '/atendimento');
  assert.equal(redirectFor('POST', '/inicio', 'public-support'), null);
  assert.equal(redirectFor('GET', '/inicio', 'complete'), null);
});

test('public-support closes sign-up even when BRAMBIT_SIGNUP is open', async () => {
  assert.equal(await createPermissionsFromEnv({ signup: '', admin: 'owner@example.com', profile: 'public-support' }).filaDeEspera(), true);
  assert.equal(await createPermissionsFromEnv({ signup: '', admin: 'owner@example.com', profile: 'complete' }).filaDeEspera(), false);
});
