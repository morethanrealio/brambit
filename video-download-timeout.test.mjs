// Regression from finding #26: the video download deadline only covered the headers.
// Here the network is fake (no real socket), but it respects AbortSignal
// just like the real fetch, which is exactly the detail the bug ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCorpoComTeto } from './web/baixar-corpo.mjs';

process.env.COMFY_URL = 'http://worker.invalido';
process.env.COMFY_TOKEN = 'token-de-teste';
const { fetchRenderVideo, MAX_VIDEO_BYTES } = await import('./web/videogen.mjs');

const cabecalhos = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

// Body that delivers one chunk and then hangs until the signal aborts, which is
// what a slow worker (or a half-dead socket) does in real life.
function corpoQueTrava(signal) {
  return (async function* () {
    yield Buffer.from('mp4-comecou');
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  })();
}

function fingirFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

// Guard clock: if the download hangs again, the test FLAGS it instead of hanging
// the entire suite. The timer is unref'd so it doesn't hold the process.
async function comVigia(promessa, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promessa.then(() => 'baixou', (e) => `erro: ${e.message}`),
      new Promise((resolve) => { timer = setTimeout(() => resolve('TRAVOU'), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('#26 a body that never ends blows the deadline instead of hanging forever', async () => {
  const restaurar = fingirFetch(async (_url, init) => ({
    ok: true, status: 200,
    headers: cabecalhos({ 'content-type': 'video/mp4' }),
    body: corpoQueTrava(init.signal),
    arrayBuffer: () => new Promise(() => {}),
  }));
  try {
    const desfecho = await comVigia(fetchRenderVideo('job-lento', { timeoutMs: 120 }));
    assert.notEqual(desfecho, 'TRAVOU', 'the download hung: the deadline did not cover the body');
    assert.match(desfecho, /timeout/);
  } finally { restaurar(); }
});

test('#26 a normal download still returns the buffer and content-type', async () => {
  const restaurar = fingirFetch(async () => ({
    ok: true, status: 200,
    headers: cabecalhos({ 'content-type': 'video/mp4', 'content-length': '6' }),
    body: (async function* () { yield Buffer.from('abc'); yield Buffer.from('def'); })(),
  }));
  try {
    const { buffer, contentType } = await fetchRenderVideo('job-ok', { timeoutMs: 2000 });
    assert.equal(buffer.toString(), 'abcdef');
    assert.equal(contentType, 'video/mp4');
  } finally { restaurar(); }
});

test('#26 a body bigger than the cap is cut off', async () => {
  const restaurar = fingirFetch(async () => ({
    ok: true, status: 200,
    headers: cabecalhos({ 'content-type': 'video/mp4' }),
    body: (async function* () { for (let i = 0; i < 100; i++) yield Buffer.alloc(1024); })(),
  }));
  try {
    await assert.rejects(
      fetchRenderVideo('job-gordo', { timeoutMs: 2000, maxBytes: 2048 }),
      /passou do teto/,
    );
  } finally { restaurar(); }
});

test('byte cap has a production value generous for a 15s video', () => {
  assert.equal(MAX_VIDEO_BYTES, 256 * 1024 * 1024);
});

test('lerCorpoComTeto joins the chunks in order', async () => {
  const res = { headers: cabecalhos({}), body: (async function* () { yield Buffer.from('um'); yield Buffer.from('dois'); })() };
  assert.equal((await lerCorpoComTeto(res, 100)).toString(), 'umdois');
});

test('lerCorpoComTeto refuses before downloading when content-length already exceeds the cap', async () => {
  let leu = false;
  const res = {
    headers: cabecalhos({ 'content-length': '999' }),
    body: (async function* () { leu = true; yield Buffer.alloc(999); })(),
  };
  await assert.rejects(lerCorpoComTeto(res, 10, 'baixa'), /anunciado de 999/);
  assert.equal(leu, false, 'should not have started downloading');
});

test('lerCorpoComTeto stops mid-stream when it passes the cap', async () => {
  let pedacos = 0;
  const res = {
    headers: cabecalhos({}),
    body: (async function* () { for (let i = 0; i < 50; i++) { pedacos++; yield Buffer.alloc(10); } })(),
  };
  await assert.rejects(lerCorpoComTeto(res, 25, 'baixa'), /passou do teto/);
  assert.ok(pedacos < 10, `stopped too late: read ${pedacos} chunks`);
});

test('lerCorpoComTeto falls back to arrayBuffer when the response has no stream, and still applies the cap', async () => {
  const semStream = (n) => ({ headers: cabecalhos({}), arrayBuffer: async () => Buffer.alloc(n) });
  assert.equal((await lerCorpoComTeto(semStream(5), 100)).length, 5);
  await assert.rejects(lerCorpoComTeto(semStream(500), 100, 'baixa'), /passa do teto/);
});

test('lerCorpoComTeto refuses an invalid cap', async () => {
  const res = { headers: cabecalhos({}), body: (async function* () { yield Buffer.from('x'); })() };
  await assert.rejects(lerCorpoComTeto(res, 0, 'baixa'), /teto de bytes inválido/);
  await assert.rejects(lerCorpoComTeto(res, NaN, 'baixa'), /teto de bytes inválido/);
});

test('the body is read INSIDE withTimeout in videogen (source guard)', async () => {
  const fonte = await import('node:fs').then((fs) => fs.readFileSync('web/videogen.mjs', 'utf8'));
  // The old way: get the response from withTimeout and only then read the file.
  assert.ok(!/\}\), 120_000, 'fetchRenderVideo'\);/.test(fonte), 'fetchRenderVideo went back to reading the body outside the deadline');
  assert.ok(!/Buffer\.from\(await res\.arrayBuffer\(\)\)/.test(fonte), 'mp4 read outside withTimeout');
  assert.match(fonte, /await lerCorpoComTeto\(res, maxBytes, 'fetchRenderVideo'\)/);
  // createRender/getRender suffered from the same problem with the JSON.
  assert.match(fonte, /return res\.json\(\);\n  \}, 20_000, 'getRender'\)/);
  assert.match(fonte, /return res\.json\(\);\n  \}, 30_000, 'createRender'\)/);
});
