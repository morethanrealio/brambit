// ── Composição determinística de imagem ────────────────────────────────────
// Por que isto existe: `gerar_imagem` manda uma DESCRIÇÃO pro modelo e recebe
// um desenho novo. Quando o pedido é "põe o MEU logo no cartão", isso não tem
// conserto por prompt: o modelo redesenha o emblema (fica parecido, não é o
// logo) e erra letra dentro da arte ("CONSÓRCCIO", "PARABÊÑS"). O caso do
// Um caso de set/2026 foi exatamente esse: várias tentativas, nenhuma com
// o logo dele de verdade.
//
// A saída é separar as duas coisas. O modelo faz o que ele faz bem (pintar um
// FUNDO, sem texto e sem marca) e a plataforma faz o que precisa ser exato:
// cola o arquivo original em pixel e escreve o texto com fonte de verdade.
// Nada aqui é probabilístico; o assistente só decide POSIÇÃO e TAMANHO.
//
// Coordenadas são sempre em PORCENTAGEM da tela (0-100), nunca em pixel: assim
// o mesmo layout serve pra 1080x1080 do WhatsApp e pra 1080x1920 de story, e o
// modelo não precisa fazer conta de pixel (onde ele erra).
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts');
const FAMILIAS = { sans: 'Brambs Sans', serif: 'Brambs Serif' };
const ARQUIVOS_FONTE = [
  ['Poppins-Regular.ttf', FAMILIAS.sans],
  ['Poppins-Bold.ttf', FAMILIAS.sans],
  ['PTSerif-Regular.ttf', FAMILIAS.serif],
  ['PTSerif-Bold.ttf', FAMILIAS.serif],
];

// O servidor de produção NÃO tem nenhuma fonte instalada (/usr/share/fonts nem
// existe lá). Sem registrar uma fonte própria, fillText desenha NADA e a
// composição sairia muda, sem erro nenhum. Por isso as fontes viajam dentro do
// repositório e o registro é conferido: se falhar, a composição avisa em vez de
// entregar um cartão sem texto.
let fontesRegistradas = null;
export function registrarFontes() {
  if (fontesRegistradas !== null) return fontesRegistradas;
  try {
    for (const [arquivo, familia] of ARQUIVOS_FONTE) GlobalFonts.registerFromPath(path.join(FONT_DIR, arquivo), familia);
    const fams = new Set(GlobalFonts.families.map((f) => f.family));
    fontesRegistradas = fams.has(FAMILIAS.sans) && fams.has(FAMILIAS.serif);
  } catch (e) {
    console.error('[compor] registro de fontes:', e?.message ?? e);
    fontesRegistradas = false;
  }
  if (!fontesRegistradas) console.error('[compor] fontes não registraram; texto sairia vazio');
  return fontesRegistradas;
}

// Nomes de cor em português porque é assim que o modelo escreve. Hex e rgb()
// continuam passando direto; o que não for reconhecido cai no padrão em vez de
// virar preto silencioso.
const CORES = {
  branco: '#ffffff', preto: '#000000', cinza: '#8a8a8a', 'cinza-claro': '#d9d9d9', 'cinza-escuro': '#3a3a3a',
  vermelho: '#c0392b', vinho: '#7d2230', rosa: '#e0629a', laranja: '#ef7a1a', amarelo: '#f2c200',
  dourado: '#c9a227', verde: '#1e8e4e', 'verde-escuro': '#14532d', azul: '#1f5fbf', 'azul-escuro': '#0b2a4a',
  'azul-claro': '#6fb1e8', roxo: '#6b3fa0', marrom: '#6b4a2f', bege: '#efe3d0', creme: '#faf3e6',
  transparente: 'rgba(0,0,0,0)',
};
export function cor(valor, padrao = '#000000') {
  const s = String(valor ?? '').trim().toLowerCase();
  if (!s) return padrao;
  if (CORES[s]) return CORES[s];
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/.test(s)) return s;
  return padrao;
}

const num = (v, padrao) => (Number.isFinite(Number(v)) ? Number(v) : padrao);
const ANCORAS = {
  centro: [0.5, 0.5], topo: [0.5, 0], baixo: [0.5, 1], esquerda: [0, 0.5], direita: [1, 0.5],
  'topo-esquerda': [0, 0], 'topo-direita': [1, 0], 'baixo-esquerda': [0, 1], 'baixo-direita': [1, 1],
};
const ancora = (v) => ANCORAS[String(v || '').trim().toLowerCase()] || ANCORAS.centro;

// Branco -> transparente. Uma logo que veio de PDF chega desenhada sobre a
// folha BRANCA da página; sem isto, colar a logo põe um retângulo branco em
// cima da arte.
function tirarBranco(ctx, w, h, limiar) {
  const d = ctx.getImageData(0, 0, w, h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i] >= limiar && p[i + 1] >= limiar && p[i + 2] >= limiar) p[i + 3] = 0;
  }
  ctx.putImageData(d, 0, 0);
}

// Corta a margem vazia em volta do desenho. Página de PDF é quase toda folha em
// branco com a marca pequena no meio: sem aparar, "logo com 60% da largura"
// entregaria 60% de folha em branco e uma marca minúscula.
function aparar(canvas) {
  const w = canvas.width, h = canvas.height;
  const p = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (p[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return canvas; // tudo transparente: não há o que aparar
  const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
  if (lw === w && lh === h) return canvas;
  const saida = createCanvas(lw, lh);
  saida.getContext('2d').drawImage(canvas, x0, y0, lw, lh, 0, 0, lw, lh);
  return saida;
}

// Repinta o desenho inteiro numa cor só, preservando o recorte (alpha). É o que
// deixa uma logo azul-escura utilizável sobre fundo escuro, sem redesenhar.
function repintar(canvas, corChapada) {
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = corChapada;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

// Teto de trabalho por peça. Uma foto de 8000px entraria em memória inteira e
// ainda seria varrida pixel a pixel por tirarBranco/aparar, e no fim ela é
// desenhada em no máximo alguns milhares de pixels. Reduzir na entrada é o que
// mantém o custo previsível sem mudar o resultado visível.
const LADO_MAX_PECA = 2400;
async function prepararImagem(buffer, camada) {
  const img = await loadImage(buffer);
  const escala = Math.min(1, LADO_MAX_PECA / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * escala));
  const h = Math.max(1, Math.round(img.height * escala));
  let c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const semBranco = camada.remover_fundo_branco === true;
  if (semBranco) tirarBranco(c.getContext('2d'), c.width, c.height, Math.max(1, Math.min(num(camada.limiar_branco, 235), 254)));
  // aparar segue o fundo removido por padrão: é o caso do logo vindo de PDF.
  if (camada.aparar === true || (camada.aparar !== false && semBranco)) c = aparar(c);
  const chapada = camada.cor ? cor(camada.cor, null) : null;
  if (chapada) repintar(c, chapada);
  return c;
}

function quebrar(ctx, texto, maxLargura) {
  const linhas = [];
  for (const paragrafo of String(texto).split('\n')) {
    const palavras = paragrafo.trim().split(/\s+/).filter(Boolean);
    if (!palavras.length) { linhas.push(''); continue; }
    let linha = palavras[0];
    for (let i = 1; i < palavras.length; i++) {
      const teste = `${linha} ${palavras[i]}`;
      if (ctx.measureText(teste).width <= maxLargura) linha = teste;
      else { linhas.push(linha); linha = palavras[i]; }
    }
    linhas.push(linha);
  }
  return linhas;
}

function desenharTexto(ctx, camada, W, H) {
  const texto = String(camada.texto ?? '').trim();
  if (!texto) return;
  const familia = FAMILIAS[String(camada.fonte || 'sans').toLowerCase()] || FAMILIAS.sans;
  const peso = /negrito|bold|forte/i.test(String(camada.peso || '')) ? '700' : '400';
  const maxLargura = W * Math.max(5, Math.min(num(camada.largura_max, 90), 100)) / 100;
  const entrelinha = Math.max(0.9, Math.min(num(camada.entrelinha, 1.2), 3));
  let tamanho = Math.max(8, Math.round(H * Math.max(0.5, Math.min(num(camada.tamanho, 5), 40)) / 100));
  let linhas = [];
  // Encolhe até caber. Texto que vaza pra fora da arte é o jeito mais fácil de
  // estragar o cartão, e quem escreve o texto (o modelo) não sabe medir pixel.
  for (;;) {
    ctx.font = `${peso} ${tamanho}px "${familia}"`;
    linhas = quebrar(ctx, texto, maxLargura);
    const maior = linhas.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    if (maior <= maxLargura || tamanho <= 8) break;
    tamanho = Math.max(8, Math.round(tamanho * 0.94));
  }
  const alturaLinha = tamanho * entrelinha;
  const alturaBloco = alturaLinha * linhas.length;
  const [, ay] = ancora(camada.ancora);
  const topo = H * num(camada.y, 50) / 100 - ay * alturaBloco;
  const alinhamento = String(camada.alinhamento || 'centro').toLowerCase();
  ctx.textAlign = alinhamento === 'esquerda' ? 'left' : alinhamento === 'direita' ? 'right' : 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cor(camada.cor, '#000000');
  const x = W * num(camada.x, 50) / 100;
  ctx.save();
  if (camada.sombra === true) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = Math.round(tamanho * 0.28);
    ctx.shadowOffsetY = Math.round(tamanho * 0.06);
  }
  if (camada.opacidade != null) ctx.globalAlpha = Math.max(0, Math.min(num(camada.opacidade, 100), 100)) / 100;
  linhas.forEach((linha, i) => ctx.fillText(linha, x, topo + (i + 0.5) * alturaLinha));
  ctx.restore();
}

function caixaArredondada(ctx, x, y, w, h, r) {
  const raio = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + raio, y);
  ctx.arcTo(x + w, y, x + w, y + h, raio);
  ctx.arcTo(x + w, y + h, x, y + h, raio);
  ctx.arcTo(x, y + h, x, y, raio);
  ctx.arcTo(x, y, x + w, y, raio);
  ctx.closePath();
}

function desenharRetangulo(ctx, camada, W, H) {
  const w = W * Math.max(0, num(camada.largura, 100)) / 100;
  const h = H * Math.max(0, num(camada.altura, 20)) / 100;
  const [ax, ay] = ancora(camada.ancora);
  const x = W * num(camada.x, 50) / 100 - ax * w;
  const y = H * num(camada.y, 50) / 100 - ay * h;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(num(camada.opacidade, 100), 100)) / 100;
  ctx.fillStyle = cor(camada.cor, '#000000');
  caixaArredondada(ctx, x, y, w, h, H * num(camada.raio, 0) / 100);
  ctx.fill();
  ctx.restore();
}

// Preenche a tela inteira sem distorcer: escala pelo lado que falta e corta o
// excesso (o "cover" do CSS). Esticar a arte do fundo é o erro clássico.
function cobrir(ctx, img, W, H) {
  const escala = Math.max(W / img.width, H / img.height);
  const w = img.width * escala, h = img.height * escala;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function pintarFundo(ctx, fundo, W, H, imagemFundo) {
  ctx.fillStyle = cor(fundo?.cor, '#ffffff');
  ctx.fillRect(0, 0, W, H);
  const g = fundo?.gradiente;
  if (g && (g.de || g.para)) {
    const dir = String(g.direcao || 'vertical').toLowerCase();
    const grad = dir === 'horizontal' ? ctx.createLinearGradient(0, 0, W, 0)
      : dir === 'diagonal' ? ctx.createLinearGradient(0, 0, W, H)
        : ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, cor(g.de, '#ffffff'));
    grad.addColorStop(1, cor(g.para, '#000000'));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
  if (imagemFundo) cobrir(ctx, imagemFundo, W, H);
}

/**
 * Monta a imagem final. `carregarImagem(ref)` devolve o Buffer da peça (logo,
 * foto, fundo) ou null; quem chama é que sabe resolver a referência (id da
 * biblioteca do dono), então aqui não há I/O de storage nem dependência de
 * banco, e o teste roda com buffers na mão.
 * Devolve { png, width, height, avisos }: `avisos` diz o que NÃO entrou, pra o
 * assistente poder contar a verdade em vez de afirmar que colou o logo.
 */
export async function composeImage(spec = {}, { carregarImagem = async () => null } = {}) {
  const W = Math.max(64, Math.min(Math.round(num(spec.largura, 1080)), 4096));
  const H = Math.max(64, Math.min(Math.round(num(spec.altura, 1080)), 4096));
  const avisos = [];
  if (!registrarFontes() && (spec.camadas || []).some((c) => c?.tipo === 'texto')) {
    avisos.push('as fontes da plataforma não carregaram, o texto pode não ter sido desenhado');
  }
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  let imagemFundo = null;
  if (spec.fundo?.imagem != null) {
    const buf = await carregarImagem(spec.fundo.imagem);
    if (buf) {
      try { imagemFundo = await loadImage(buf); }
      catch (e) { avisos.push(`não consegui abrir a imagem de fundo (${e?.message ?? e})`); }
    } else avisos.push(`não achei a imagem de fundo (${spec.fundo.imagem})`);
  }
  pintarFundo(ctx, spec.fundo, W, H, imagemFundo);

  // Teto de camadas: um layout de verdade tem punhado delas; uma lista enorme
  // só queimaria tempo e memória. Corta em silêncio não, avisa.
  const todas = Array.isArray(spec.camadas) ? spec.camadas : [];
  const camadas = todas.slice(0, 40);
  if (todas.length > camadas.length) avisos.push(`só as 40 primeiras camadas foram desenhadas (vieram ${todas.length})`);
  for (const camada of camadas) {
    if (!camada || typeof camada !== 'object') continue;
    const tipo = String(camada.tipo || '').toLowerCase();
    try {
      if (tipo === 'texto') { desenharTexto(ctx, camada, W, H); continue; }
      if (tipo === 'retangulo') { desenharRetangulo(ctx, camada, W, H); continue; }
      if (tipo !== 'imagem') { avisos.push(`camada de tipo desconhecido ignorada ("${camada.tipo}")`); continue; }
      const buf = await carregarImagem(camada.imagem);
      if (!buf) { avisos.push(`não achei a imagem ${camada.imagem}, essa camada ficou de fora`); continue; }
      const peca = await prepararImagem(buf, camada);
      const larguraAlvo = camada.largura != null || camada.altura == null
        ? W * Math.max(1, Math.min(num(camada.largura, 40), 200)) / 100
        : null;
      const alturaAlvo = camada.altura != null ? H * Math.max(1, Math.min(num(camada.altura, 40), 200)) / 100 : null;
      // Sem os dois lados, mantém a proporção original da peça (esticar um logo
      // é tão errado quanto redesenhá-lo).
      const w = larguraAlvo ?? alturaAlvo * (peca.width / peca.height);
      const h = alturaAlvo ?? larguraAlvo * (peca.height / peca.width);
      const [ax, ay] = ancora(camada.ancora);
      const x = W * num(camada.x, 50) / 100 - ax * w;
      const y = H * num(camada.y, 50) / 100 - ay * h;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(num(camada.opacidade, 100), 100)) / 100;
      if (camada.formato === 'circulo') {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.drawImage(peca, x, y, w, h);
      ctx.restore();
    } catch (e) {
      avisos.push(`uma camada (${tipo || 'sem tipo'}) falhou: ${e?.message ?? e}`);
    }
  }
  return { png: canvas.toBuffer('image/png'), width: W, height: H, avisos };
}

const CAMADA_SCHEMA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['imagem', 'texto', 'retangulo'], description: 'imagem = paste a file from the library (logo, photo); texto = write text; retangulo = background band/strip.' },
    imagem: { type: 'string', description: 'Only for tipo=imagem: the file id in the library (comes from the 🖼️ [foto id=...] marker, from listar_midia or from gerar_imagem\'s result).' },
    texto: { type: 'string', description: 'Only for tipo=texto. Use \\n for line breaks. Write it already accented and proofread: it comes out exactly like that.' },
    x: { type: 'number', description: 'Horizontal position in % of the width (0 left, 50 middle, 100 right). Default 50.' },
    y: { type: 'number', description: 'Vertical position in % of the height (0 top, 100 bottom). Default 50.' },
    ancora: { type: 'string', enum: Object.keys(ANCORAS), description: 'Which point of the piece sits at (x,y). Default centro.' },
    largura: { type: 'number', description: 'Width in % of the canvas width. For imagem without altura, the aspect ratio is kept. Default 40.' },
    altura: { type: 'number', description: 'Height in % of the canvas height.' },
    tamanho: { type: 'number', description: 'Only for tipo=texto: font size in % of the canvas height (title ~7, body ~4, footer ~2.8). Shrinks automatically if it does not fit.' },
    cor: { type: 'string', description: 'Color as a pt-BR name (branco, dourado, azul-escuro) or hex. For tipo=imagem, repaints the whole piece in that color keeping the cutout (useful to turn a dark logo white over a dark background).' },
    fonte: { type: 'string', enum: ['sans', 'serif'], description: 'Only for tipo=texto. sans = modern; serif = classic (invitation, wedding).' },
    peso: { type: 'string', enum: ['normal', 'negrito'], description: 'Only for tipo=texto.' },
    alinhamento: { type: 'string', enum: ['esquerda', 'centro', 'direita'], description: 'Only for tipo=texto. Default centro.' },
    largura_max: { type: 'number', description: 'Only for tipo=texto: maximum line width in % of the canvas before wrapping. Default 90.' },
    entrelinha: { type: 'number', description: 'Only for tipo=texto: line spacing (1.2 default).' },
    sombra: { type: 'boolean', description: 'Only for tipo=texto: light shadow, for light text over a photo.' },
    remover_fundo_branco: { type: 'boolean', description: 'Only for tipo=imagem: makes white transparent and trims the empty margin. Use ALWAYS when the piece is a logo that came from a PDF (the white page sheet becomes a white rectangle over the artwork).' },
    formato: { type: 'string', enum: ['normal', 'circulo'], description: 'Only for tipo=imagem: circulo crops the photo into a circle.' },
    opacidade: { type: 'number', description: 'From 0 to 100. Default 100.' },
    raio: { type: 'number', description: 'Only for tipo=retangulo: rounded corner in % of the canvas height.' },
  },
  required: ['tipo'],
};

/**
 * Tool do tool-loop. Mantida ao lado das de mídia porque é a outra metade do
 * `gerar_imagem`: uma inventa a arte, esta monta o resultado exato.
 * carregarAsset(id) -> Buffer|null é injetado pelo servidor (resolve o id na
 * biblioteca DO DONO, então uma pessoa não alcança arquivo de outra).
 */
export function comporTools(userId, { carregarAsset, saveBlob, onAttachment = () => {} } = {}) {
  if (typeof carregarAsset !== 'function' || typeof saveBlob !== 'function') return [];
  return [{
    name: 'compor_imagem',
    description: 'Builds a final image by PASTING exact pieces: the user\'s REAL logo/photo (library file, pixel-exact, not redrawn) and text written with a real font. Use ALWAYS when the image must contain the person\'s brand or correct words (greeting card, post, invitation, story, banner with logo). Do NOT use gerar_imagem for this: it REDRAWS the logo (comes out similar, it is not the logo) and gets letters wrong inside the artwork. Recommended flow: 1) gerar_imagem creates only the BACKGROUND/artwork, with no text and no logo; 2) compor_imagem pastes the logo on top (with remover_fundo_branco when it came from a PDF) and writes the text. The image is delivered to the user on its own. If the logo is in a PDF, it already arrives converted to an image in the library: use the id.',
    parameters: {
      type: 'object',
      properties: {
        largura: { type: 'number', description: 'Final width in pixels. Default 1080 (WhatsApp/Instagram square). Story/reels: 1080 x 1920.' },
        altura: { type: 'number', description: 'Final height in pixels. Default 1080.' },
        fundo: {
          type: 'object',
          description: 'Image background. Can be a color, a gradient or an image (the gerar_imagem artwork, or a user photo).',
          properties: {
            cor: { type: 'string', description: 'Solid color (pt-BR name or hex).' },
            imagem: { type: 'string', description: 'id of the library file to use as background; fills the whole canvas without distortion.' },
            gradiente: {
              type: 'object',
              properties: {
                de: { type: 'string' }, para: { type: 'string' },
                direcao: { type: 'string', enum: ['vertical', 'horizontal', 'diagonal'] },
              },
            },
          },
        },
        camadas: { type: 'array', description: 'The pieces, drawn in the order they appear (the last one ends up on top).', items: CAMADA_SCHEMA },
        legenda: { type: 'string', description: 'Short name to save in the library (e.g. "cartão de aniversário Acme Invest").' },
      },
      required: ['camadas'],
    },
    async run(spec = {}) {
      const camadas = Array.isArray(spec.camadas) ? spec.camadas : [];
      if (!camadas.length && spec.fundo?.imagem == null) return 'ERRO: preciso de pelo menos uma camada (imagem, texto ou retangulo) ou de uma imagem de fundo.';
      const faltando = [];
      let resultado;
      try {
        resultado = await composeImage(spec, {
          carregarImagem: async (id) => {
            try {
              const buf = await carregarAsset(id);
              if (!buf) faltando.push(id);
              return buf;
            } catch (e) {
              console.error('[compor] carregar asset:', e?.message ?? e);
              faltando.push(id);
              return null;
            }
          },
        });
      } catch (e) {
        console.error('[compor] composição:', e?.message ?? e);
        return `ERRO: não consegui montar a imagem (${e?.message ?? e}). Avise o usuário e não diga que a imagem ficou pronta.`;
      }
      if (faltando.length) {
        return `ERRO: não achei na biblioteca o(s) arquivo(s) de id ${[...new Set(faltando)].join(', ')}. Confira o id com listar_midia e chame de novo. NÃO entregue a imagem sem a peça que o usuário pediu.`;
      }
      const legenda = String(spec.legenda || '').trim().slice(0, 160) || 'imagem composta';
      let url, key;
      try {
        ({ url, key } = await saveBlob({ buffer: resultado.png, ext: 'png', mime: 'image/png', kind: 'image', source: 'generated', caption: legenda }));
      } catch (e) {
        console.error('[compor] saveBlob:', e?.message ?? e);
        return `ERRO: montei a imagem mas não consegui guardá-la (${e?.message ?? e}). Avise o usuário.`;
      }
      onAttachment({ type: 'image', url, mime: 'image/png', key });
      console.log(`[compor] user=${userId} ${resultado.width}x${resultado.height} camadas=${camadas.length} bytes=${resultado.png.length}`);
      const nota = resultado.avisos.length ? ` ATENÇÃO, conte isto ao usuário: ${resultado.avisos.join('; ')}.` : '';
      return `Imagem ${resultado.width}x${resultado.height} montada e já enviada ao usuário (URL: ${url}).${nota} Responda em uma frase curta; se ele pedir ajuste (mover, aumentar, trocar cor), chame compor_imagem de novo com os valores corrigidos.`;
    },
  }];
}
