// The Cloud API refuses WebP (131053, after HTTP 200): whatever is not JPEG/PNG
// becomes JPEG before uploading to Meta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { paraJpegOuPng, tipoDaImagem } from './web/wa-imagem.mjs';

test('WebP vira JPEG; JPEG passa como está', async () => {
  const c = createCanvas(40, 20); c.getContext('2d').fillRect(0, 0, 10, 10);
  const webp = await c.encode('webp');
  assert.equal(tipoDaImagem(webp), null);
  const r = await paraJpegOuPng(webp);
  assert.equal(r.mime, 'image/jpeg'); assert.equal(tipoDaImagem(r.buffer), 'image/jpeg');
  const jpeg = await c.encode('jpeg');
  assert.equal((await paraJpegOuPng(jpeg)).buffer, jpeg);
});
