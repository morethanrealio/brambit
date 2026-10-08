// Regression of block G: a file deleted by the user has to disappear from the BUCKET,
// not just from the database. Before, the S3 failure was swallowed and the object stayed there
// forever, with no record to retry (findings #36 and #37).
import test from 'node:test';
import assert from 'node:assert/strict';
import { apagarObjetoComLapide, varrerLapides } from './web/media-gc.mjs';

// In-memory tombstones, in the same format as the media_deletions table.
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

test('S3 down: the tombstone stays open instead of the file becoming orphaned', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/foto.jpg');
  const r = await apagarObjetoComLapide({
    key: 'u1/foto.jpg', tombstoneId: id,
    deleteMedia: async () => { throw new Error('s3 delete 500'); },
    settle: lap.settle,
  });
  assert.equal(r.ok, false);
  assert.equal(r.pendente, true);
  assert.equal(lap.linhas.get(id).status, 'pending', 'a tombstone cannot close without the bucket confirming');
  assert.equal(lap.abertas().length, 1);
});

test('bucket confirms: the tombstone closes', async () => {
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

test('the sweeper actually deletes once S3 comes back', async () => {
  const lap = criarLapidario();
  const id = lap.enfileira('u1/rosto.jpg');
  let noAr = false;
  const deleteMedia = async () => { if (!noAr) throw new Error('s3 indisponível'); };
  // 1st attempt (at request time) fails
  await apagarObjetoComLapide({ key: 'u1/rosto.jpg', tombstoneId: id, deleteMedia, settle: lap.settle });
  // sweep with S3 still down: stays pending
  let r = await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle });
  assert.deepEqual([r.vistos, r.apagados, r.falhas], [1, 0, 1]);
  // S3 comes back: the next sweep closes it
  noAr = true;
  r = await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle });
  assert.deepEqual([r.vistos, r.apagados, r.falhas], [1, 1, 0]);
  assert.equal(lap.abertas().length, 0, 'no object can be left ownerless in the bucket');
  // nada mais a varrer
  assert.equal((await varrerLapides({ claim: lap.claim, deleteMedia, settle: lap.settle })).vistos, 0);
});

test('media with no key (disk mode) doesn\'t leave a tombstone open', async () => {
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

test('failing to close the tombstone leaves the case for the sweeper (delete is idempotent)', async () => {
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

test('one failure doesn\'t stop the other tombstones from being deleted', async () => {
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
