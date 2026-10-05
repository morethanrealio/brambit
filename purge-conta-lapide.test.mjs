// Regressão: destruir uma conta excluída tem que tirar a mídia do BUCKET de verdade.
// Antes, purgeUser tentava o delete e, se o S3 falhasse, seguia em frente e apagava
// a conta: a key sumia junto com as linhas do banco e o arquivo (foto, voz, rosto
// biométrico) de alguém que pediu pra sair ficava no bucket pra sempre, sem registro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { purgarMidiaDaConta, varrerLapides } from './web/media-gc.mjs';

function criarLapidario() {
  const linhas = new Map();
  let proximo = 1;
  return {
    linhas,
    async registrarLapides(keys) {
      return keys.map((k) => {
        const id = proximo++;
        linhas.set(id, { id, s3_key: k, status: 'pending', attempts: 0 });
        return { id, s3_key: k };
      });
    },
    async settle(id, status) { const l = linhas.get(id); if (l) l.status = status; },
    async claim(limite) {
      const abertas = [...linhas.values()].filter((l) => l.status === 'pending').slice(0, limite);
      for (const l of abertas) l.attempts++;
      return abertas;
    },
    abertas() { return [...linhas.values()].filter((l) => l.status !== 'done'); },
  };
}

test('bucket fora do ar: a key da conta destruída fica registrada, não some', async () => {
  const lap = criarLapidario();
  const r = await purgarMidiaDaConta({
    keys: ['u1/foto.jpg', 'u1/rosto.png'],
    registrarLapides: lap.registrarLapides,
    deleteMedia: async () => { throw new Error('s3 500'); },
    settle: lap.settle,
  });
  assert.equal(r.total, 2);
  assert.equal(r.apagados, 0);
  assert.equal(r.pendentes, 2);
  assert.deepEqual(lap.abertas().map((l) => l.s3_key).sort(), ['u1/foto.jpg', 'u1/rosto.png']);
});

test('a lápide é gravada ANTES do primeiro delete', async () => {
  const lap = criarLapidario();
  const ordem = [];
  await purgarMidiaDaConta({
    keys: ['u1/a.jpg', 'u1/b.jpg'],
    registrarLapides: async (ks) => { ordem.push('lapide'); return lap.registrarLapides(ks); },
    deleteMedia: async () => { ordem.push('delete'); },
    settle: lap.settle,
  });
  assert.deepEqual(ordem, ['lapide', 'delete', 'delete']);
});

test('o varredor limpa depois o que o bucket recusou na destruição', async () => {
  const lap = criarLapidario();
  await purgarMidiaDaConta({
    keys: ['u1/foto.jpg'],
    registrarLapides: lap.registrarLapides,
    deleteMedia: async () => { throw new Error('s3 500'); },
    settle: lap.settle,
  });
  assert.equal(lap.abertas().length, 1, 'pré-condição: ficou pendente');
  const r = await varrerLapides({ claim: lap.claim, deleteMedia: async () => {}, settle: lap.settle });
  assert.equal(r.apagados, 1);
  assert.equal(lap.abertas().length, 0, 'depois do varredor o objeto não pode mais estar aberto');
});

test('tudo apagado: nada fica pendente', async () => {
  const lap = criarLapidario();
  const apagadas = [];
  const r = await purgarMidiaDaConta({
    keys: ['u1/a.jpg', 'u1/b.jpg', 'u1/a.jpg'],
    registrarLapides: lap.registrarLapides,
    deleteMedia: async (k) => { apagadas.push(k); },
    settle: lap.settle,
  });
  assert.equal(r.total, 2, 'key repetida não vira duas lápides');
  assert.equal(r.apagados, 2);
  assert.equal(r.pendentes, 0);
  assert.equal(lap.abertas().length, 0);
  assert.deepEqual(apagadas.sort(), ['u1/a.jpg', 'u1/b.jpg']);
});

test('conta sem mídia não grava lápide nenhuma', async () => {
  let chamou = false;
  const r = await purgarMidiaDaConta({
    keys: [],
    registrarLapides: async () => { chamou = true; return []; },
    deleteMedia: async () => { throw new Error('não devia apagar nada'); },
    settle: async () => {},
  });
  assert.equal(chamou, false);
  assert.deepEqual(r, { total: 0, apagados: 0, pendentes: 0 });
});
