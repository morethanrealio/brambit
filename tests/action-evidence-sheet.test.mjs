import test from 'node:test';
import assert from 'node:assert/strict';
import { actionResult, actionEvidenceFor, createActionJournal } from '../web/action-evidence.mjs';

// editar_planilha now carries a typed receipt (family 'sheet') when the edit
// really saved a new file. The receipt is what keeps the model's confirmation
// from being cut to "Não consegui confirmar" by the ja_fiz_sem_prova filter.
// The guard is gated on the receipt, so a turn with no successful edit is
// untouched (contrast test below).

const saved = actionResult({ state: 'saved', id: 'asset-key-1', subject: 'Fontes.xlsx' },
  'Planilha "Fontes.xlsx" editada e já enviada ao usuário no chat.\nMudança: 4 linhas na aba Fontes.\nA versão anterior ficou na biblioteca como "Fontes (v2)".');

test('a saved spreadsheet edit produces a typed sheet receipt', () => {
  const e = actionEvidenceFor('editar_planilha', {}, saved);
  assert.deepEqual(e, { family: 'sheet', tool: 'editar_planilha', state: 'saved', subject: 'Fontes.xlsx', id: 'asset-key-1' });
});

test('a failed/ambiguous edit (plain text) gets no receipt', () => {
  assert.equal(actionEvidenceFor('editar_planilha', {}, 'ERRO: objetivo vazio.'), null);
  assert.equal(actionEvidenceFor('editar_planilha', {}, 'A edição NÃO foi aplicada porque a instrução ficou ambígua'), null);
});

test('with the receipt, the model confirmation about the spreadsheet survives', () => {
  const j = createActionJournal({ language: 'pt-BR' });
  j.toolResult({ name: 'editar_planilha', args: {} }, saved);
  const text = 'Pronto, editei a planilha e guardei a versão anterior na biblioteca.';
  const out = j.finish(text);
  assert.equal(out, text, 'the confirmation is kept verbatim');
  assert.doesNotMatch(out, /não consegui confirmar/i);
});

test('without the receipt, the same confirmation is cut to "não consegui confirmar"', () => {
  const j = createActionJournal({ language: 'pt-BR' });
  const out = j.finish('Pronto, editei a planilha e guardei a versão anterior na biblioteca.');
  assert.match(out, /não consegui confirmar/i);
});

test('the sheet receipt does not append a canned line when the model already confirmed', () => {
  const j = createActionJournal({ language: 'pt-BR' });
  j.toolResult({ name: 'editar_planilha', args: {} }, saved);
  const out = j.finish('Troquei o ano do ART-07 para 2019 na sua planilha.');
  assert.equal(out, 'Troquei o ano do ART-07 para 2019 na sua planilha.');
  assert.doesNotMatch(out, /edited and delivered|editada e enviada/i);
});
