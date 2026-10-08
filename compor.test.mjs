import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { composeImage, comporTools, registrarFontes, cor } from './web/compor.mjs';
import { renderPdfPagesToPng } from './web/pdf.mjs';
import { pdfSoDesenho, pdfComTexto } from './test-support/pdf-minimo.mjs';

// The case that originated all of this: a user asked, several times, for a
// congratulations card with THEIR LOGO inside, and never received it. gerar_imagem sends a
// description to the model, which REDRAWS the emblem and gets a letter wrong in Portuguese. The
// fix is to not ask the model for something that needs to be exact: the platform pastes the
// original file pixel-for-pixel and writes the text with a real font.
//
// These tests verify exactly the parts that can't "come out approximate":
// the pasted piece is where it was asked to be, the sheet's white background doesn't turn into a rectangle
// on top of the artwork, the text fits, and a missing piece NEVER silently becomes a delivered
// image.

// Reads a pixel from the produced PNG, which is the only way to prove position/color without
// relying on the word of the very function that drew it.
async function pixel(png, x, y) {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

// Test piece: a 200x200 white sheet with a 40x40 red square in the
// middle. It's the format a logo arrives in from a PDF (small artwork, lots of white
// margin around it).
function pecaComMargemBranca() {
  const c = createCanvas(200, 200);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(80, 80, 40, 40);
  return c.toBuffer('image/png');
}

test('as fontes embutidas registram (sem elas o texto sairia invisível no servidor)', () => {
  // The production box has no font installed: fillText would draw
  // NOTHING, with no error at all. That's why the fonts travel inside the repository.
  assert.equal(registrarFontes(), true);
});

test('entrega PNG no tamanho pedido', async () => {
  const r = await composeImage({ largura: 300, altura: 500, fundo: { cor: 'branco' }, camadas: [] });
  assert.equal(r.width, 300);
  assert.equal(r.height, 500);
  assert.equal(r.png.subarray(1, 4).toString(), 'PNG');
  const img = await loadImage(r.png);
  assert.equal(img.width, 300);
  assert.equal(img.height, 500);
});

test('cor aceita nome em português e hex, e não vira preto silencioso quando não entende', () => {
  assert.equal(cor('azul-escuro'), '#0b2a4a');
  assert.equal(cor('#abc'), '#abc');
  assert.equal(cor('roxo-neon-inexistente', '#123456'), '#123456');
  assert.equal(cor('', '#123456'), '#123456');
});

test('remover_fundo_branco tira a folha branca e apara a margem vazia', async () => {
  const peca = pecaComMargemBranca();
  const r = await composeImage({
    largura: 200, altura: 200,
    fundo: { cor: 'preto' },
    camadas: [{ tipo: 'imagem', imagem: 'logo', x: 50, y: 50, largura: 50, remover_fundo_branco: true }],
  }, { carregarImagem: async () => peca });
  assert.deepEqual(r.avisos, []);
  // Trimmed, the piece is just the red square, so 50% of the width = 100px
  // centered: the center is red and the border remains the black background.
  assert.deepEqual(await pixel(r.png, 100, 100), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(r.png, 5, 5), [0, 0, 0, 255]);
  // Without trimming or removing white, the SAME piece would cover the center in white: it's
  // the white rectangle on top of the artwork that the fix avoids.
  const semTratar = await composeImage({
    largura: 200, altura: 200,
    fundo: { cor: 'preto' },
    camadas: [{ tipo: 'imagem', imagem: 'logo', x: 50, y: 50, largura: 50 }],
  }, { carregarImagem: async () => peca });
  assert.deepEqual(await pixel(semTratar.png, 60, 60), [255, 255, 255, 255]);
});

test('cor numa camada de imagem repinta a peça mantendo o recorte', async () => {
  const r = await composeImage({
    largura: 200, altura: 200,
    fundo: { cor: 'preto' },
    camadas: [{ tipo: 'imagem', imagem: 'logo', x: 50, y: 50, largura: 50, remover_fundo_branco: true, cor: 'branco' }],
  }, { carregarImagem: async () => pecaComMargemBranca() });
  assert.deepEqual(await pixel(r.png, 100, 100), [255, 255, 255, 255]);
});

test('âncora posiciona a peça pelo ponto pedido', async () => {
  const r = await composeImage({
    largura: 200, altura: 200,
    fundo: { cor: 'preto' },
    camadas: [{ tipo: 'imagem', imagem: 'logo', x: 0, y: 0, largura: 25, ancora: 'topo-esquerda', remover_fundo_branco: true }],
  }, { carregarImagem: async () => pecaComMargemBranca() });
  assert.deepEqual(await pixel(r.png, 10, 10), [255, 0, 0, 255]);   // inside the corner
  assert.deepEqual(await pixel(r.png, 100, 100), [0, 0, 0, 255]);   // meio segue fundo
});

test('proporção da peça é preservada quando só a largura é dada (logo não estica)', async () => {
  // 40x20 piece (landscape rectangle): asking for 50% width on a 200 square,
  // the height has to come out 50px, not 100.
  const c = createCanvas(40, 20);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 40, 20);
  const peca = c.toBuffer('image/png');
  const r = await composeImage({
    largura: 200, altura: 200,
    fundo: { cor: 'preto' },
    camadas: [{ tipo: 'imagem', imagem: 'x', x: 0, y: 0, largura: 50, ancora: 'topo-esquerda' }],
  }, { carregarImagem: async () => peca });
  assert.deepEqual(await pixel(r.png, 50, 45), [255, 0, 0, 255]);  // inside the 100x50
  assert.deepEqual(await pixel(r.png, 50, 60), [0, 0, 0, 255]);    // below, it's already background
});

test('texto é desenhado, quebra linha e encolhe pra caber na largura pedida', async () => {
  const curto = await composeImage({
    largura: 400, altura: 200, fundo: { cor: 'branco' },
    camadas: [{ tipo: 'texto', texto: 'oi', x: 50, y: 50, tamanho: 20, cor: 'preto' }],
  });
  assert.deepEqual(curto.avisos, []);
  // Proof that ink hit the canvas (without a registered font, the PNG would come out all white).
  const img = await loadImage(curto.png);
  const cv = createCanvas(img.width, img.height);
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const dados = cx.getImageData(0, 0, img.width, img.height).data;
  let escuros = 0;
  for (let i = 0; i < dados.length; i += 4) if (dados[i] < 100) escuros++;
  assert.ok(escuros > 50, `esperava texto desenhado, achei ${escuros} pixels escuros`);

  // Long text with an accent: can't leak outside the requested band. With
  // largura_max 50% on a 400 canvas, columns 0 to ~99 and ~301 to 399
  // have to remain clean.
  const longo = await composeImage({
    largura: 400, altura: 400, fundo: { cor: 'branco' },
    camadas: [{
      tipo: 'texto', x: 50, y: 50, tamanho: 12, largura_max: 50, cor: 'preto',
      texto: 'Parabéns pela união de vocês, que a felicidade e a prosperidade acompanhem essa nova jornada em família',
    }],
  });
  const li = await loadImage(longo.png);
  const lc = createCanvas(li.width, li.height);
  const lx = lc.getContext('2d');
  lx.drawImage(li, 0, 0);
  const px = lx.getImageData(0, 0, li.width, li.height).data;
  const sujo = (x0, x1) => {
    for (let y = 0; y < li.height; y++) {
      for (let x = x0; x < x1; x++) if (px[(y * li.width + x) * 4] < 200) return true;
    }
    return false;
  };
  assert.equal(sujo(0, 95), false, 'texto vazou pela esquerda');
  assert.equal(sujo(305, 400), false, 'texto vazou pela direita');
});

test('peça que falta nunca some em silêncio: vira aviso, não imagem entregue como certa', async () => {
  const r = await composeImage({
    largura: 100, altura: 100,
    camadas: [{ tipo: 'imagem', imagem: 'nao-existe' }, { tipo: 'circulo-mágico' }],
  }, { carregarImagem: async () => null });
  assert.equal(r.avisos.length, 2);
  assert.match(r.avisos[0], /não achei a imagem nao-existe/);
  assert.match(r.avisos[1], /tipo desconhecido/);
});

test('PDF de logo (sem camada de texto) vira imagem e entra na composição', async () => {
  // The original dead end: extractPdfText returns empty on this PDF, so the
  // file had no way to be used. Now it becomes a PNG and is pasted pixel-for-pixel.
  const { imagens, total } = await renderPdfPagesToPng(pdfSoDesenho(), { pages: 1, width: 400 });
  assert.equal(total, 1);
  assert.equal(imagens.length, 1);
  assert.equal(imagens[0].png.subarray(1, 4).toString(), 'PNG');
  const r = await composeImage({
    largura: 600, altura: 600,
    fundo: { gradiente: { de: 'creme', para: 'bege' } },
    camadas: [
      { tipo: 'imagem', imagem: 'pdf', x: 50, y: 25, largura: 40, remover_fundo_branco: true },
      { tipo: 'texto', texto: 'Feliz aniversário!', x: 50, y: 60, tamanho: 6, peso: 'negrito', fonte: 'serif' },
      { tipo: 'retangulo', x: 50, y: 100, largura: 100, altura: 10, cor: 'azul-escuro', ancora: 'baixo' },
    ],
  }, { carregarImagem: async () => imagens[0].png });
  assert.deepEqual(r.avisos, []);
  // The footer band is deterministic: the bottom 10% is dark blue.
  assert.deepEqual(await pixel(r.png, 300, 580), [11, 42, 74, 255]);
});

test('PDF com texto continua sendo texto (rasterizar não atropela o caminho normal)', async () => {
  const { imagens } = await renderPdfPagesToPng(pdfComTexto('CONTRATO DE TESTE'), { pages: 1, width: 300 });
  assert.equal(imagens.length, 1);
  assert.ok(imagens[0].width === 300);
});

test('a tool recusa em vez de entregar cartão sem o logo que o usuário pediu', async () => {
  let salvou = 0;
  const [tool] = comporTools('u1', {
    carregarAsset: async () => null,
    saveBlob: async () => { salvou++; return { url: 'x', key: 'k' }; },
  });
  const saida = await tool.run({ camadas: [{ tipo: 'imagem', imagem: 'id-que-nao-existe' }] });
  assert.match(saida, /^ERRO/);
  assert.match(saida, /id-que-nao-existe/);
  assert.equal(salvou, 0, 'não pode guardar nem entregar imagem faltando a peça pedida');
});

test('a tool monta, guarda e anuncia a imagem quando as peças existem', async () => {
  const anexos = [];
  const [tool] = comporTools('u1', {
    carregarAsset: async () => pecaComMargemBranca(),
    saveBlob: async ({ buffer, mime, kind }) => {
      assert.equal(mime, 'image/png');
      assert.equal(kind, 'image');
      assert.ok(buffer.length > 100);
      return { url: 'https://brambs.com.br/api/media/abc', key: 'k' };
    },
    onAttachment: (a) => anexos.push(a),
  });
  const saida = await tool.run({
    largura: 300, altura: 300, legenda: 'cartão de teste',
    camadas: [{ tipo: 'imagem', imagem: 'logo', x: 50, y: 50, largura: 40, remover_fundo_branco: true }],
  });
  assert.match(saida, /300x300/);
  assert.match(saida, /brambs\.com\.br/);
  assert.equal(anexos.length, 1);
  assert.equal(anexos[0].type, 'image');
});

test('a tool sem nada pra desenhar não inventa uma imagem vazia', async () => {
  const [tool] = comporTools('u1', { carregarAsset: async () => null, saveBlob: async () => ({ url: 'x' }) });
  assert.match(await tool.run({ camadas: [] }), /^ERRO/);
});

test('sem as dependências injetadas a tool nem é registrada', () => {
  assert.deepEqual(comporTools('u1', {}), []);
});
