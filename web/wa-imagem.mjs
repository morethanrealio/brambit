// Imagem por link de fora (saídas do atendimento público) pronta pro WhatsApp.
// A Cloud API só aceita JPEG e PNG, e muita loja serve WebP mesmo com URL .jpg
// (o CDN decide pelo cabeçalho Accept de quem pede). Se a Meta busca o link
// sozinha, a recusa chega DEPOIS do HTTP 200, no webhook de status (131053), e
// a mensagem some. Aqui a gente baixa, converte o que não for JPEG/PNG e sobe
// os bytes pra Meta: o envio passa a usar o media id e qualquer problema de
// imagem acontece na nossa mão, antes do envio.
// Falhou o preparo: devolve o link como veio (melhor tentar do que não mandar).
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fetchFixado } from './net-pin.mjs';

const MAX_BAIXAR = 10 * 1024 * 1024;
const MAX_WA = 5 * 1024 * 1024;     // teto de imagem da Cloud API
const LADO_MAX = 1600;
const VALIDADE_MS = 24 * 60 * 60 * 1000; // media id da Meta vale 30 dias
const CACHE_MAX = 1000;

export function tipoDaImagem(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// JPEG/PNG até 5 MB passam como estão; o resto (WebP, GIF, AVIF, grande demais)
// vira JPEG com no máximo 1600 px no lado maior.
export async function paraJpegOuPng(buf) {
  const tipo = tipoDaImagem(buf);
  if (tipo && buf.length <= MAX_WA) return { buffer: buf, mime: tipo };
  const img = await loadImage(buf);
  const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * escala)), h = Math.max(1, Math.round(img.height * escala));
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); // JPEG não tem transparência
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

// subir(buffer, mime) devolve o media id (uploadMedia do whatsapp.mjs).
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
    console.warn(`[whatsapp] imagem vai por link, preparo falhou: ${e?.message ?? e}`);
    return { link: url };
  }
}
