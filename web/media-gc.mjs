// ── Bucket garbage collection (deletion tombstones) ──
// Deleting a user's file is two steps that don't fit in the same transaction:
// (1) remove the database reference, (2) remove the object from S3. Step 2 is network and
// can fail. The old design did step 1 and swallowed step 2's failure, so the object
// (photo, document, biometric face) stayed in the bucket forever and WITHOUT a record,
// impossible to re-enqueue.
//
// Now step 1 writes a TOMBSTONE (media_deletions table) in the same transaction.
// The tombstone is the object's memory between the two steps: it's only closed when the
// bucket confirms the delete, and while it's open the sweeper keeps retrying.
//
// This module is just the logic, with no database or S3 inside: the dependencies come in by
// parameter (deleteMedia/settle/claim). That's what makes the behavior testable.

// Tries to delete the object and close the tombstone. NEVER throws: a bucket failure becomes
// { ok:false, pendente:true } and the tombstone stays open for the sweeper.
export async function apagarObjetoComLapide({ key, tombstoneId, deleteMedia, settle, onErro }) {
  // Without a key there's no object in the bucket (disk mode or media with no file): the tombstone,
  // if it exists, is already born fulfilled.
  if (!key) {
    if (tombstoneId) await settle?.(tombstoneId, 'done');
    return { ok: true, pendente: false };
  }
  try {
    await deleteMedia(key);
  } catch (e) {
    onErro?.(e, key);
    return { ok: false, pendente: true, erro: e?.message ?? String(e) };
  }
  // Only closes AFTER the bucket confirms. If closing fails, the tombstone stays
  // open and the sweeper repeats the delete, which is idempotent (404 counts as ok).
  try {
    if (tombstoneId) await settle?.(tombstoneId, 'done');
  } catch (e) {
    onErro?.(e, key);
    return { ok: true, pendente: true, erro: e?.message ?? String(e) };
  }
  return { ok: true, pendente: false };
}

// Account destruction: deletes ALL of the bucket owner's media, with a tombstone.
// The order is the point: the tombstone for all keys is written BEFORE the first delete,
// because right after comes the account's DELETE, which takes down by CASCADE exactly the
// rows (media_assets/user_likeness) that knew these keys. Without that record,
// a bucket failure would leave the photo, voice and biometric FACE of a
// DELETED account in the bucket forever with no one to retry.
// A bucket failure never throws: whatever doesn't go out now stays pending for the sweeper.
// Failing to WRITE the tombstone, though, does: destroying the account without a record of the keys is
// exactly what the tombstone exists to prevent, so the next round retries.
export async function purgarMidiaDaConta({ keys = [], registrarLapides, deleteMedia, settle, onErro }) {
  const uteis = [...new Set((keys || []).filter(Boolean))];
  if (!uteis.length) return { total: 0, apagados: 0, pendentes: 0 };
  const lapides = await registrarLapides(uteis);
  let apagados = 0, pendentes = 0;
  for (const l of lapides) {
    const r = await apagarObjetoComLapide({ key: l.s3_key, tombstoneId: l.id, deleteMedia, settle, onErro });
    if (r.ok && !r.pendente) apagados++; else pendentes++;
  }
  return { total: uteis.length, apagados, pendentes };
}

// Sweeps open tombstones and retries. One's failure doesn't stop the others.
export async function varrerLapides({ claim, deleteMedia, settle, onErro, limite = 50 }) {
  const pendentes = await claim(limite);
  let apagados = 0, falhas = 0;
  for (const t of pendentes) {
    const r = await apagarObjetoComLapide({ key: t.s3_key, tombstoneId: t.id, deleteMedia, settle, onErro });
    if (r.ok && !r.pendente) apagados++; else falhas++;
  }
  return { vistos: pendentes.length, apagados, falhas };
}
