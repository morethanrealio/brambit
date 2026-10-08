// Image from an outside link (public-facing support outputs) made ready for WhatsApp.
// The Cloud API only accepts JPEG and PNG, and many stores serve WebP even with a .jpg URL
// (the CDN decides based on the requester's Accept header). If Meta fetches the link
// on its own, the rejection arrives AFTER the HTTP 200, in the status webhook (131053), and
// the message disappears. Here we download, convert whatever isn't JPEG/PNG, and upload
// the bytes to Meta: sending then uses the media id and any image
// problem happens on our side, before sending.
// Preparation failed: returns the link as it came (better to try than not to send).
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fetchFixado } from './net-pin.mjs';

const MAX_BAIXAR = 10 * 1024 * 1024;
const MAX_WA = 5 * 1024 * 1024;     // image cap for the Cloud API
const LADO_MAX = 1600;
const VALIDADE_MS = 24 * 60 * 60 * 1000; // Meta media id is valid for 30 days
const CACHE_MAX = 1000;

export function tipoDaImagem(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// JPEG/PNG up to 5 MB pass through as is; the rest (WebP, GIF, AVIF, too big)
// becomes JPEG with at most 1600 px on the longer side.
export async function paraJpegOuPng(buf) {
  const tipo = tipoDaImagem(buf);
  if (tipo && buf.length <= MAX_WA) return { buffer: buf, mime: tipo };
  const img = await loadImage(buf);
  const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * escala)), h = Math.max(1, Math.round(img.height * escala));
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); // JPEG has no transparency
  c.drawImage(img, 0, 0, w, h);
  return { buffer: await canvas.encode('jpeg', 85), mime: 'image/jpeg' };
}

async function baixar(url, saltos = 2) {
  const r = await fetchFixado(url, { timeoutMs: 10000, maxBytes: MAX_BAIXAR, headers: { accept: 'image/jpeg,image/png;q=0.9,*/*;q=0.5' } });
  if (r.status >= 300 && r.status < 400 && r.headers.get('location') && saltos > 0) {
    const prox = new URL(r.headers.get('location'), url);
    if (prox.protocol !== 'https:') throw new Error('redirect fora de https');
    return baixar(prox.href, saltos - 1);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const cache = new Map(); // url -> {em, id: Promise<string>}

// subir(buffer, mime) returns the media id (uploadMedia from whatsapp.mjs).
export async function imagemParaWa(url, subir) {
  const agora = Date.now();
  let c = cache.get(url);
  if (!c || agora - c.em > VALIDADE_MS) {
    c = { em: agora, id: baixar(url).then(paraJpegOuPng).then(({ buffer, mime }) => subir(buffer, mime)) };
    cache.set(url, c);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  try { return { id: await c.id }; }
  catch (e) {
    if (cache.get(url) === c) cache.delete(url);
    console.warn(`[whatsapp] image will go via link, prep failed: ${e?.message ?? e}`);
    return { link: url };
  }
}
