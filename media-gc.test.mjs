// Regressão do bloco G: arquivo apagado pelo usuário tem que sumir do BUCKET,
// não só do banco. Antes, a falha do S3 era engolida e o objeto ficava lá pra
// sempre, sem nenhum registro pra tentar de novo (achados #36 e #37).
import test from 'node:test';
import assert from 'node:assert/strict';
import { apagarObjetoComLapide, varrerLapides } from './web/media-gc.mjs';

// Lápides em memória, no mesmo formato da tabela media_deletions.
function criarLapidario() {
  const linhas = new Map();
  let proximo = 1;
  return {
    linhas,
    enfileira(s3Key) { const id = proximo++; linhas.set(id, { id, s3_key: s3Key, status: 'pending', attempts: 0 }); return id; },
    async settle(id, status) { const l = linhas.get(id); if (l) l.status = status; },
    async claim(limite) {
      const abertas = [...linhas.values()].filter(l => l.status === 'pending').slice(0, limite);
      for (const l of abertas) l.attempts++;
      return abertas;
    },
    abertas() { return [...linhas.values()].filter(l => l.status !== 'done'); },
  };
}

test('S3 fora do ar: a lápide continua aberta em vez de o arquivo virar órfão', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/foto.jpg');
  const r = await apagarObjetoComLapide({
    key: 'u1/foto.jpg', tombstoneId: id,
    deleteMedia: async () => { throw new Error('s3 delete 500'); },
    settle: lap.settle,
  });
  assert.equal(r.ok, false);
  assert.equal(r.pendente, true);
  assert.equal(lap.linhas.get(id).status, 'pending', 'lápide não pode ser fechada sem o bucket confirmar');
  assert.equal(lap.abertas().length, 1);
});

test('bucket confirma: a lápide fecha', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/foto.jpg');
  const apagadas = [];
  const r = await apagarObjetoComLapide({
    key: 'u1/foto.jpg', tombstoneId: id,
    deleteMedia: async (k) => { apagadas.push(k); },
    settle: lap.settle,
  });
  assert.deepEqual(apagadas, ['u1/foto.jpg']);
  assert.equal(r.pendente, false);
  assert.equal(lap.linhas.get(id).status, 'done');
  assert.equal(lap.abertas().length, 0);
});

test('o varredor apaga de verdade quando o S3 volta', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/rosto.jpg');
  let noAr = false;
  const deleteMedia = async () => { if (!noAr) throw new Error('s3 indisponível'); };
  // 1ª tentativa (na hora do pedido) falha
  await apagarObjetoComLapide({ key: 'u1/rosto.jpg', tombstoneId: id, deleteMedia, settle: lap.settle });
  // varredura com o S3 ainda fora: segue pendente
  let r = await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle });
  assert.deepEqual([r.vistos, r.apagados, r.falhas], [1, 0, 1]);
  // S3 volta: a próxima varredura fecha
  noAr = true;
  r = await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle });
  assert.deepEqual([r.vistos, r.apagados, r.falhas], [1, 1, 0]);
  assert.equal(lap.abertas().length, 0, 'nenhum objeto pode ficar sem dono no bucket');
  // nada mais a varrer
  assert.equal((await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle })).vistos, 0);
});

test('mídia sem key (modo disco) não deixa lápide aberta', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira(null);
  const r = await apagarObjetoComLapide({
    key: null, tombstoneId: id,
    deleteMedia: async () => { throw new Error('não devia ser chamado'); },
    settle: lap.settle,
  });
  assert.equal(r.pendente, false);
  assert.equal(lap.linhas.get(id).status, 'done');
});

test('falha ao fechar a lápide deixa o caso pro varredor (delete é idempotente)', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/doc.pdf');
  const r = await apagarObjetoComLapide({
    key: 'u1/doc.pdf', tombstoneId: id,
    deleteMedia: async () => {},
    settle: async () => { throw new Error('banco caiu'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.pendente, true);
  assert.equal(lap.linhas.get(id).status, 'pending');
});

test('uma falha não impede as outras lápides de serem apagadas', async () => {
  const lap = criarLapidario();
  lap.enfileira('u1/a.jpg'); lap.enfileira('u1/ruim.jpg'); lap.enfileira('u1/c.jpg');
  const r = await varrerLapides({
    claim: lap.claim,
    deleteMedia: async (k) => { if (k === 'u1/ruim.jpg') throw new Error('s3 403'); },
    settle: lap.settle,
  });
  assert.deepEqual([r.vistos, r.apagados, r.falhas], [3, 2, 1]);
  assert.deepEqual(lap.abertas().map(l => l.s3_key), ['u1/ruim.jpg']);
});
