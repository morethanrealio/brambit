// While a card waits, the assistant's "done" about that action is cut and the
// card says it is not done yet; what really ran in the same turn stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { presentPendingCards } from '../web/pending-action-claims.mjs';

const event = { id: 'c1', name: 'calendar_create_event', language: 'pt-BR', state: 'pending',
  confirmationText: 'Criar evento "Dentista" na agenda, quinta 14:00.' };
const session = (rows, created = rows) => ({ rows, createdIds: new Set(created.map(r => r.id)), pending: () => rows });

test('a done-claim next to its own card is cut, and the card says not done yet', () => {
  const res = presentPendingCards('Deixei o evento preparado na sua agenda: Dentista, quinta 14:00.', session([event]));
  assert.equal(res.text, '');
  assert.match(res.card, /Ainda não fiz: falta sua confirmação\. Posso seguir\?/);
});

test('a description of the proposal before the card stays', () => {
  const text = 'Deixei o evento pronto:';
  assert.equal(presentPendingCards(text, session([event])).text, text);
});

test('an action of another kind that really ran in the turn stays', () => {
  const text = 'Anotei no Space a lista de exames. Deixei o evento preparado na sua agenda.';
  const res = presentPendingCards(text, session([event]), { toolCounts: { anotar_no_espaco: 1, calendar_create_event: 1 } });
  assert.equal(res.text, 'Anotei no Space a lista de exames.');
});

test('an earlier card the text calls done is shown again', () => {
  const res = presentPendingCards('Evento "Dentista" criado na agenda.', session([event], []));
  assert.equal(res.text, '');
  assert.match(res.card, /Dentista[\s\S]*Ainda não fiz/);
});
