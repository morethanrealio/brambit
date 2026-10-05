// Regressão do achado #26: o prazo do download do vídeo cobria só os cabeçalhos.
// Aqui a rede é falsa (nada de socket de verdade), mas ela respeita o AbortSignal
// igual ao fetch real, que é exatamente o detalhe que o bug ignorava.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCorpoComTeto } from './web/baixar-corpo.mjs';

process.env.COMFY_URL = 'http://worker.invalido';
process.env.COMFY_TOKEN = 'token-de-teste';
const { fetchRenderVideo, MAX_VIDEO_BYTES } = await import('./web/videogen.mjs');

const cabecalhos = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

// Corpo que entrega um pedaço e depois fica pendurado até o signal abortar, que é
// o que um worker lento (ou um socket meio-morto) faz na vida real.
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

// Relógio de guarda: se o download travar de novo, o teste ACUSA em vez de pendurar
// a suíte inteira. O timer é unref pra não segurar o processo.
async function comVigia(promessa, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promessa.then(() => 'baixou', (e) => `erro: ${e.message}`),
      new Promise((resolve) => { timer = setTimeout(() => resolve('TRAVOU'), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('#26 corpo que não termina estoura o prazo em vez de pendurar pra sempre', async () => {
  const restaurar = fingirFetch(async (_url, init) => ({
    ok: true, status: 200,
    headers: cabecalhos({ 'content-type': 'video/mp4' }),
    body: corpoQueTrava(init.signal),
    arrayBuffer: () => new Promise(() => {}),
  }));
  try {
    const desfecho = await comVigia(fetchRenderVideo('job-lento', { timeoutMs: 120 }));
    assert.notEqual(desfecho, 'TRAVOU', 'o download ficou pendurado: o prazo não cobriu o corpo');
    assert.match(desfecho, /timeout/);
  } finally { restaurar(); }
});

test('#26 download normal continua devolvendo buffer e content-type', async () => {
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

test('#26 corpo maior que o teto é cortado', async () => {
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

test('teto de bytes tem valor de produção generoso pra um vídeo de 15s', () => {
  assert.equal(MAX_VIDEO_BYTES, 256 * 1024 * 1024);
});

test('lerCorpoComTeto junta os pedaços na ordem', async () => {
  const res = { headers: cabecalhos({}), body: (async function* () { yield Buffer.from('um'); yield Buffer.from('dois'); })() };
  assert.equal((await lerCorpoComTeto(res, 100)).toString(), 'umdois');
});

test('lerCorpoComTeto recusa antes de baixar quando o content-length já estoura', async () => {
  let leu = false;
  const res = {
    headers: cabecalhos({ 'content-length': '999' }),
    body: (async function* () { leu = true; yield Buffer.alloc(999); })(),
  };
  await assert.rejects(lerCorpoComTeto(res, 10, 'baixa'), /anunciado de 999/);
  assert.equal(leu, false, 'não deveria ter começado a baixar');
});

test('lerCorpoComTeto para no meio do stream quando passa do teto', async () => {
  let pedacos = 0;
  const res = {
    headers: cabecalhos({}),
    body: (async function* () { for (let i = 0; i < 50; i++) { pedacos++; yield Buffer.alloc(10); } })(),
  };
  await assert.rejects(lerCorpoComTeto(res, 25, 'baixa'), /passou do teto/);
  assert.ok(pedacos < 10, `parou tarde demais: leu ${pedacos} pedaços`);
});

test('lerCorpoComTeto cai no arrayBuffer quando a resposta não tem stream, e ainda aplica o teto', async () => {
  const semStream = (n) => ({ headers: cabecalhos({}), arrayBuffer: async () => Buffer.alloc(n) });
  assert.equal((await lerCorpoComTeto(semStream(5), 100)).length, 5);
  await assert.rejects(lerCorpoComTeto(semStream(500), 100, 'baixa'), /passa do teto/);
});

test('lerCorpoComTeto recusa teto inválido', async () => {
  const res = { headers: cabecalhos({}), body: (async function* () { yield Buffer.from('x'); })() };
  await assert.rejects(lerCorpoComTeto(res, 0, 'baixa'), /teto de bytes inválido/);
  await assert.rejects(lerCorpoComTeto(res, NaN, 'baixa'), /teto de bytes inválido/);
});

test('o corpo é lido DENTRO do withTimeout no videogen (guarda de fonte)', async () => {
  const fonte = await import('node:fs').then((fs) => fs.readFileSync('web/videogen.mjs', 'utf8'));
  // O jeito antigo: pegar a resposta do withTimeout e só então ler o arquivo.
  assert.ok(!/\}\), 120_000, 'fetchRenderVideo'\);/.test(fonte), 'fetchRenderVideo voltou a ler o corpo fora do prazo');
  assert.ok(!/Buffer\.from\(await res\.arrayBuffer\(\)\)/.test(fonte), 'leitura do mp4 fora do withTimeout');
  assert.match(fonte, /await lerCorpoComTeto\(res, maxBytes, 'fetchRenderVideo'\)/);
  // createRender/getRender sofriam do mesmo mal com o JSON.
  assert.match(fonte, /return res\.json\(\);\n  \}, 20_000, 'getRender'\)/);
  assert.match(fonte, /return res\.json\(\);\n  \}, 30_000, 'createRender'\)/);
});
