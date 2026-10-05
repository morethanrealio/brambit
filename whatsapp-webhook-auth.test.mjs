import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {verifySignature, waEnabled} from './web/whatsapp.mjs';

const SEGREDO = 'segredo-de-teste';
const assinar = (corpo) => 'sha256=' + crypto.createHmac('sha256', SEGREDO).update(corpo).digest('hex');
function comEnv(env, fn) {
  const antes = {...process.env};
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return fn(); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, antes); }
}

test('sem WA_APP_SECRET o webhook recusa em vez de aceitar qualquer POST', () => {
  const corpo = Buffer.from('{"entry":[]}');
  comEnv({WA_APP_SECRET: undefined}, () => {
    assert.equal(verifySignature(corpo, assinar(corpo)), false);
    assert.equal(verifySignature(corpo, undefined), false);
  });
});

test('com secret, só a assinatura correta passa', () => {
  const corpo = Buffer.from('{"entry":[1]}');
  comEnv({WA_APP_SECRET: SEGREDO}, () => {
    assert.equal(verifySignature(corpo, assinar(corpo)), true);
    assert.equal(verifySignature(corpo, assinar(Buffer.from('outro corpo'))), false);
    assert.equal(verifySignature(corpo, 'sha256=00'), false);
    assert.equal(verifySignature(corpo, undefined), false);
  });
});

test('canal não se considera pronto sem o secret do webhook', () => {
  const base = {WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'p', WA_VERIFY_TOKEN: 'v'};
  comEnv({...base, WA_APP_SECRET: undefined}, () => assert.equal(waEnabled(), false));
  comEnv({...base, WA_APP_SECRET: SEGREDO}, () => assert.equal(waEnabled(), true));
});
