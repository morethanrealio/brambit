import test from 'node:test';
import assert from 'node:assert/strict';
import { markVoiceInput, VOICE_INPUT_NOTE, voiceReplyDelivered } from './web/voice-input.mjs';
import { userSaid, isConfirmation, CHANNEL_CTX_END } from './web/confirm.mjs';

// Case from 2026-10-01: the audio arrived as plain text and the model didn't know it was speech.
test('a transcrição de áudio chega marcada como mensagem de voz', () => {
  const t = markVoiceInput('  I work as an SRE  ');
  assert.equal(t, `${VOICE_INPUT_NOTE}\n\nI work as an SRE`);
  assert.equal(markVoiceInput(''), '');
});

test('a marca não entra no que a pessoa disse: "sim" falado confirma', () => {
  assert.equal(userSaid(markVoiceInput('sim')), 'sim');
  assert.equal(isConfirmation(markVoiceInput('sim')), true);
  assert.equal(isConfirmation(markVoiceInput('pode mandar')), true);
});

test('citação + áudio: só a fala decide', () => {
  const quoted = `[O usuário está usando o recurso "responder/citar" do WhatsApp para se referir a você: "para tudo"]${CHANNEL_CTX_END}\n\n${markVoiceInput('sim')}`;
  assert.equal(userSaid(quoted), 'sim');
  assert.equal(isConfirmation(quoted), true);
});

test('lote do canal: "não" digitado antes de um áudio "sim" continua cancelando', () => {
  const batch = ['não', markVoiceInput('sim')].join('\n');
  assert.equal(isConfirmation(batch), false);
  assert.match(userSaid(batch), /não/);
});

// runRoutine → deliverRoutine only delivers text: audio generated there was lost (and still billed).
test('gerar_audio só é oferecido onde o áudio chega na pessoa', () => {
  for (const routineChannel of ['whatsapp', 'telegram', 'email']) {
    assert.equal(voiceReplyDelivered({ kind: 'routine', routineChannel }), false, routineChannel);
  }
  assert.equal(voiceReplyDelivered({ kind: 'routine', routineChannel: 'none' }), true);
  assert.equal(voiceReplyDelivered({ kind: 'chat', routineChannel: null }), true);
  assert.equal(voiceReplyDelivered(), true);
});
