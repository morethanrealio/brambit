import test from 'node:test';
import assert from 'node:assert/strict';
import { codingJobReceipt } from './web/coding-jobs.mjs';

test('recibo inicial de programação é curto, humano e não expõe fila interna', () => {
  const receipt = codingJobReceipt({
    id: 'job', state: 'queued', kind: 'basic', stage: null,
    updatedAt: 1, notification: null,
  });
  assert.equal(receipt.text, 'Vou começar agora e te aviso assim que concluir.');
  assert.doesNotMatch(receipt.text, /registrado|aguardando execução|fila/i);
});
