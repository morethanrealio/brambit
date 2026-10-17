// The compaction ledger keeps, word for word, the lines where the person pasted
// concrete data, so the summary can't swallow them. Its detector used to know
// only Portuguese formats: an English or Spanish phone, address or price fell
// into the summary without any error, so a narrowed pattern would go unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, splitSummary } from '../web/memory.mjs';

const kept = (line) => extractFacts([{ role: 'user', content: line }]).length === 1;

test('keeps phones, addresses, prices, dates and e-mails in English, Spanish and Portuguese', () => {
  for (const line of [
    'Call me at +1 415 555 0123', 'office: 415-555-0123', 'The hotel is at 123 Main St, Springfield',
    'San Francisco, CA 94103', 'The dinner was $45 per person', 'Meeting on Friday at 3pm', 'Oct 22 works for me',
    'my email is jane.doe@example.com',
    'Mi teléfono es +34 612 345 678', 'Vivo en Calle Mayor 5, Madrid', 'Carrera 15 #93-60, Bogotá',
    'Cuesta 1500 pesos', 'Nos vemos el viernes a las 15hs', 'el 22 de octubre',
    'meu cel é (11) 98765-4321', 'Rua Augusta 1500, São Paulo', 'custa R$ 180', 'dia 22 de outubro',
  ]) assert.ok(kept(line), line);
});

test('leaves ordinary sentences to the summary', () => {
  for (const line of [
    'I think we should go with the second option', 'I may need more time on this', 'drive safe tonight',
    'I have 2 dogs and a cat', 'I scored 5 out of 10', 'set 3 reminders for me',
    'Estoy pensando en cambiar de carrera', 'quiero dar un paseo por la tarde', 'o que você lembra de mim?',
  ]) assert.ok(!kept(line), line);
});

test('only reads what the person wrote', () => {
  assert.deepEqual(extractFacts([{ role: 'assistant', content: 'Booked for Friday at 3pm, $45' }]), []);
});

// Summaries stored before the header was in English still carry the Portuguese
// one. A sweep that drops that Portuguese string would silently empty their ledger.
test('still reads the ledger of summaries stored with the old Portuguese header', () => {
  const stored = 'They planned the trip.\n\n━━ DADOS DO USUÁRIO (verbatim, não alterar) ━━\n- Rua Augusta 1500\n- voo às 9h40';
  assert.deepEqual(splitSummary(stored), { prose: 'They planned the trip.', ledger: ['Rua Augusta 1500', 'voo às 9h40'] });
});
