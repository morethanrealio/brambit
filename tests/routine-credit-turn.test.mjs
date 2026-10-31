import assert from 'node:assert/strict';
import test from 'node:test';
import { routineManagementIntent, routineManagementSystemNote } from '../web/routine-credit-turn.mjs';

// Item 3 (2026-10-31): over credit the model never runs, so the no-credit
// routine-management turn is gated by this broad intent trigger. It must catch the
// common stop/pause/delete/edit phrasings in pt/en/es (including "para esse
// lembrete", which the retired closed-grammar rule missed) WITHOUT firing on
// ordinary messages that merely contain a routine noun and the preposition "para".

test('recognizes stop/cancel/pause/delete/edit of a routine in pt, en, es', () => {
  for (const m of [
    'cancela a rotina de reuniões',
    'para esse lembrete',
    'para com o alerta do câmbio',
    'pausa o resumo diário',
    'apaga minha rotina de compras',
    'muda o horário da rotina',
    'desliga esse aviso',
    'stop the daily summary',
    'cancel my reminder',
    'delete the routine',
    'change the schedule',
    'cancela la rutina',
    'pausa el recordatorio',
    'elimina el resumen diario',
  ]) assert.equal(routineManagementIntent(m), true, m);
});

test('does not fire without both a stop verb and a routine noun', () => {
  for (const m of [
    'bom dia',
    'qual o câmbio hoje?',
    'me manda o resumo da reunião',   // routine noun, but no stop verb
    'qual o resumo para hoje?',        // "para" is a preposition here, not the verb
    'cria uma rotina nova',            // creating is not management-over-credit
    'cancela o pedido do mercado',     // stop verb, but no routine noun
    'para de chover',                  // "para" + no routine noun
  ]) assert.equal(routineManagementIntent(m), false, m);
});

test('guards against non-strings and overly long input', () => {
  assert.equal(routineManagementIntent(null), false);
  assert.equal(routineManagementIntent(undefined), false);
  assert.equal(routineManagementIntent(42), false);
  assert.equal(routineManagementIntent('cancela a rotina ' + 'x'.repeat(600)), false);
});

test('the system note follows the language, pt-BR as default', () => {
  assert.match(routineManagementSystemNote('pt-BR'), /MODO SEM SALDO/);
  assert.match(routineManagementSystemNote('en'), /NO-BALANCE MODE/);
  assert.match(routineManagementSystemNote('es'), /MODO SIN SALDO/);
  // Unknown/absent language follows the product default (pt-BR here is the instance default via tagIdioma -> en? keep explicit).
  assert.match(routineManagementSystemNote('fr'), /NO-BALANCE MODE/);
  assert.match(routineManagementSystemNote(undefined), /NO-BALANCE MODE/);
});
