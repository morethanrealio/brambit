// PLATFORM-INDEPENDENT document generation.
//
// Takes simple markdown (or simple HTML) and produces the binary of a .docx,
// .pdf, .md or .txt, WITHOUT Google Drive or any external lib (only node:zlib
// for the .docx zip deflate). The caller stores the file in the user's own
// bucket (media_assets); here we only return { buffer, mime, ext }.
//
// Philosophy: reading a PDF and producing a .doc must NOT depend on Google.
// The layout needn't be a pixel copy of the original: we extract the content
// and rebuild an approximate structure, and are honest about it.

import zlib from 'node:zlib';
import { fetchFixado } from './net-pin.mjs';
import { xlsxToText } from './xlsxread.mjs';
import dns from 'node:dns/promises';
import net from 'node:net';

// ── util ──────────────────────────────────────────────────────────────────
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Decodifica as entidades HTML mais comuns (o modelo às vezes manda &amp; etc.).
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } });
}

// Se o conteúdo veio como HTML, normaliza pra pseudo-markdown (blocos viram
// linhas; negrito/heading/lista viram marcação leve; o resto das tags some).
function htmlToMd(html) {
  let s = String(html || '');
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*h1[^>]*>([\s\S]*?)<\s*\/\s*h1\s*>/gi, (_, t) => `\n# ${t.trim()}\n`);
  s = s.replace(/<\s*h2[^>]*>([\s\S]*?)<\s*\/\s*h2\s*>/gi, (_, t) => `\n## ${t.trim()}\n`);
  s = s.replace(/<\s*h[3-6][^>]*>([\s\S]*?)<\s*\/\s*h[3-6]\s*>/gi, (_, t) => `\n### ${t.trim()}\n`);
  s = s.replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_, t) => `\n- ${t.trim()}`);
  s = s.replace(/<\s*(strong|b)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_, __, t) => `**${t.trim()}**`);
  s = s.replace(/<\s*(em|i)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_, __, t) => `_${t.trim()}_`);
  // <img> vira markdown de imagem pra sobreviver até o gerador de PDF/DOCX
  // (antes a tag era descartada junto com o resto → imagem sumia no doc).
  s = s.replace(/<\s*img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const alt = (tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    return /^https?:\/\//i.test(src) ? `\n![${alt}](${src})\n` : '';
  });
  s = s.replace(/<\s*\/\s*(p|div|ul|ol|tr|table|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ''); // tira o resto das tags
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function looksLikeHtml(s) {
  return /<\s*(html|body|p|div|h[1-6]|ul|ol|li|br|table|span|strong|b|em)\b[^>]*>/i.test(String(s || ''));
}

// Normaliza o conteúdo de entrada pra markdown simples, venha ele como markdown
// ou como HTML.
function toMarkdown(content) {
  const s = String(content == null ? '' : content);
  return looksLikeHtml(s) ? htmlToMd(s) : s;
}

// Divide uma linha em "runs" alternando normal/negrito a partir de **...**.
function splitBold(line) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), bold: false });
  return parts.length ? parts : [{ text: line, bold: false }];
}

// Modelo de bloco comum ao docx e ao pdf: cada linha de markdown vira um bloco
// { type: 'h1'|'h2'|'h3'|'li'|'p'|'blank', runs: [{text,bold}] }.
function parseBlocks(md) {
  const out = [];
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  for (let raw of lines) {
    // Asterisco solto pode ser DADO (Pix copia-e-cola, senha, token, conta).
    // Não apagar caracteres da linha inteira para simular itálico: além de
    // corromper esses valores, a regex antiga quebrava **negrito** e * listas.
    // Itálico simples não é renderizado; preservamos seus marcadores literais.
    // Negrito e marcadores de lista são tratados nas etapas específicas abaixo.
    const line = raw;
    if (!line.trim()) { out.push({ type: 'blank', runs: [] }); continue; }
    let m;
    if ((m = line.match(/^#\s+(.*)$/))) { out.push({ type: 'h1', runs: [{ text: m[1].trim(), bold: true }] }); continue; }
    if ((m = line.match(/^##\s+(.*)$/))) { out.push({ type: 'h2', runs: [{ text: m[1].trim(), bold: true }] }); continue; }
    if ((m = line.match(/^#{3,}\s+(.*)$/))) { out.push({ type: 'h3', runs: [{ text: m[1].trim(), bold: true }] }); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { out.push({ type: 'li', runs: splitBold(m[1].trim()) }); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { out.push({ type: 'li', runs: splitBold(m[1].trim()) }); continue; }
    out.push({ type: 'p', runs: splitBold(line.trim()) });
  }
  return out;
}

// ── ZIP mínimo (pro .docx) ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);   // método: deflate
    lh.writeUInt16LE(0, 10);  // hora
    lh.writeUInt16LE(0x21, 12); // data (1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(local);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── .docx (WordprocessingML mínimo, válido no Word/Google Docs/LibreOffice) ──
function runXml(text, { bold = false, sz = 22 } = {}) {
  const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  return `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(xmlSafe(text))}</w:t></w:r>`;
}
function paraXml(block) {
  const sizeByType = { h1: 34, h2: 28, h3: 24, p: 22, li: 22 };
  const sz = sizeByType[block.type] || 22;
  const spacing = (block.type === 'h1' || block.type === 'h2' || block.type === 'h3')
    ? '<w:spacing w:before="240" w:after="120"/>' : '<w:spacing w:after="120"/>';
  if (block.type === 'blank') return '<w:p/>';
  let runs;
  if (block.type === 'li') {
    // Bullet como texto ("•  ") pra não precisar de numbering.xml.
    runs = runXml('•  ', { sz }) + block.runs.map((r) => runXml(r.text, { bold: r.bold, sz })).join('');
  } else {
    const forceBold = block.type.startsWith('h');
    runs = block.runs.map((r) => runXml(r.text, { bold: forceBold || r.bold, sz })).join('');
  }
  const ind = block.type === 'li' ? '<w:ind w:left="360"/>' : '';
  return `<w:p><w:pPr>${spacing}${ind}</w:pPr>${runs}</w:p>`;
}
// Parágrafo com uma imagem embutida (inline drawing). cx/cy em EMU.
function docxDrawingPara(rec) {
  const { cx, cy, rid, id } = rec;
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="Imagem ${id}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Imagem ${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function buildDocx(md, images) {
  const blocks = parseBlocks(md);
  const media = [];               // { name, data }
  const rels = [];                // { id, target }
  const byUrl = new Map();        // url → { rid, id, cx, cy }
  const CONTENT_EMU = 5486400;    // ~6 pol de largura útil (A4, margens 1417)
  function ensureImage(url, img) {
    if (byUrl.has(url)) return byUrl.get(url);
    const ext = img.info.kind === 'jpeg' ? 'jpg' : 'png';
    const n = media.length + 1;
    const rid = `rId${n}`;
    media.push({ name: `word/media/image${n}.${ext}`, data: img.buf });
    rels.push({ id: rid, target: `media/image${n}.${ext}` });
    let cx = (img.info.width || 1) * 9525;   // px → EMU (96 dpi)
    let cy = (img.info.height || 1) * 9525;
    if (cx > CONTENT_EMU) { const s = CONTENT_EMU / cx; cx = Math.round(cx * s); cy = Math.round(cy * s); }
    const rec = { rid, id: n, cx, cy };
    byUrl.set(url, rec);
    return rec;
  }
  const parts = [];
  for (const b of blocks) {
    const flat = b.runs.map((r) => r.text).join('');
    const im = flat.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
    if (im) {
      const alt = im[1].trim();
      const url = im[2];
      const img = images && images.get(url);
      const rec = img ? ensureImage(url, img) : null;
      if (rec) {
        parts.push(docxDrawingPara(rec));
        if (alt) parts.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runXml(alt, { sz: 18 })}</w:p>`);
      } else {
        parts.push(paraXml({ type: 'p', runs: [{ text: `[imagem indisponível: ${alt || url}]`, bold: false }] }));
      }
      continue;
    }
    parts.push(paraXml(b));
  }
  const body = parts.join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
    + ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
    + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
    + ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr></w:body></w:document>`;
  const imgExts = [...new Set(media.map((m) => m.name.split('.').pop().toLowerCase()))];
  const imgDefaults = imgExts.map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + imgDefaults
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `</Types>`;
  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`;
  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: pkgRels },
    { name: 'word/document.xml', data: documentXml },
  ];
  if (media.length) {
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('')
      + `</Relationships>`;
    files.push({ name: 'word/_rels/document.xml.rels', data: docRels });
    for (const m of media) files.push({ name: m.name, data: m.data });
  }
  return zipStore(files);
}

// ── .xlsx (planilha DE VERDADE, no mesmo ZIP zero-dep do .docx) ─────────────
// Um .xlsx também é um ZIP de XMLs, então reusa o zipStore acima: nenhuma
// dependência nova. O conteúdo chega como markdown e cada TABELA de markdown
// vira uma aba (cabeçalho em negrito e congelado; heading vira o nome da aba).
// O ponto central: número, dinheiro, porcentagem e data são gravados como
// VALOR, não como texto — planilha em que não dá pra somar nem ordenar não
// resolve o problema de ninguém.
const XLSX_MAX_ROWS = 20000;   // teto por aba
const XLSX_MAX_COLS = 200;

// 0 → "A", 26 → "AA".
function colName(i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Tira os caracteres de controle que o XML 1.0 não aceita. Vêm de PDF/OCR sujo e
// quebrariam o arquivo INTEIRO na hora de abrir.
function xmlSafe(s) {
  return String(s == null ? '' : s).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '');
}

// Limpa a marcação de uma célula de tabela markdown (negrito, código, link).
function cellText(v) {
  return String(v == null ? '' : v)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// "12/03/2026" ou "2026-03-12" → serial do Excel (dias desde 1899-12-30).
// dd/mm é o padrão pt-BR; se o mês passar de 12 (formato americano) devolve null
// e a célula fica como TEXTO, que é honesto — melhor que inverter a data calado.
function parseDateCell(s) {
  let y, mo, d, m;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2999) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // 31/02
  return Math.round((ts - Date.UTC(1899, 11, 30)) / 86400000);
}

// "R$ 1.234,56" → 1234.56 (moeda) · "1.234" → 1234 · "12%" → 0.12 · "(50)" → -50.
// NÃO converte o que é identificador disfarçado de número: zero à esquerda
// (00336, senha/agência) e sequência longa de dígitos (CPF, conta, cartão)
// continuam texto, senão a planilha destrói o dado.
function parseNumberCell(input) {
  let s = String(input).trim();
  let kind = 'number';
  let neg = false;
  if (/^\(.+\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/(R\$|US\$|\$|€|£)/i.test(s)) { kind = 'currency'; s = s.replace(/(R\$|US\$|\$|€|£)/gi, '').trim(); }
  let pct = false;
  if (/%$/.test(s)) { pct = true; s = s.slice(0, -1).trim(); }
  if (/^[-–—]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (/^0\d/.test(s)) return null;                       // 00336 é identificador
  const digits = s.replace(/\D/g, '');
  if (!digits.length || digits.length > 15) return null;
  // Sequência longa de dígitos SEM separador nenhum é identificador, não valor:
  // CPF (11), CNPJ (14), cartão (16), telefone, conta. Virar número apagaria o
  // dado. Com separador (1.234.567,89) é dinheiro de verdade e passa.
  if (!/[.,]/.test(s) && digits.length >= 10) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s, decPart = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // Os dois separadores presentes: o ÚLTIMO é o decimal (vale pra 1.234,56 e 1,234.56).
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    const parts = s.split(dec);
    if (parts.length > 2) return null;
    intPart = parts[0].split(thou).join('');
    decPart = parts[1];
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) {
      intPart = parts.join('');                          // 1.234.567 = milhar
    } else if (parts.length === 2) {
      // Um separador só: no pt-BR o ponto separa milhar (1.234) e a vírgula é
      // decimal (1,5). Ponto com 3 casas depois tratamos como milhar.
      if (sep === '.' && parts[1].length === 3 && parts[0].length <= 3) intPart = parts.join('');
      else { intPart = parts[0]; decPart = parts[1]; }
    } else return null;
  }
  if (!/^\d+$/.test(intPart) || (decPart && !/^\d+$/.test(decPart))) return null;
  let num = parseFloat(intPart + (decPart ? '.' + decPart : ''));
  if (!Number.isFinite(num)) return null;
  if (pct) { num /= 100; kind = 'percent'; }
  if (neg) num = -num;
  return { kind, value: num };
}

// Decide o tipo da célula. Ordem importa: data antes de número.
function xlsxCell(raw) {
  const s = cellText(raw);
  if (!s) return { kind: 'blank', text: '' };
  const d = parseDateCell(s);
  if (d != null) return { kind: 'date', value: d, text: s };
  const n = parseNumberCell(s);
  if (n) return { ...n, text: s };
  return { kind: 'text', value: s, text: s };
}

function isTableLine(l) { return /^\s*\|.*\|\s*$/.test(l); }
function isSepLine(l) { return /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/.test(l); }

// "| a | b |" → ["a","b"], respeitando \| escapado.
function splitTableRow(l) {
  const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out.map(cellText);
}

// Markdown → abas. Heading nomeia/abre uma aba; tabela vira linhas; linha solta
// (um total, uma observação) entra na coluna A pra não sumir com informação.
function parseSheets(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const sheets = [];
  let cur = null;
  let pendingName = '';
  const open = () => {
    if (!cur) { cur = { name: pendingName, rows: [] }; pendingName = ''; sheets.push(cur); }
    return cur;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) {
      const name = cellText(h[1]);
      if (cur && cur.rows.length) cur = null;
      if (cur) cur.name = cur.name || name;
      else pendingName = name;
      continue;
    }
    if (isTableLine(line)) {
      const sh = open();
      while (i < lines.length && isTableLine(lines[i])) {
        const bl = lines[i];
        i++;
        if (isSepLine(bl)) { if (sh.rows.length) sh.rows[sh.rows.length - 1].header = true; continue; }
        sh.rows.push({ cells: splitTableRow(bl), header: false });
      }
      i--;
      continue;
    }
    const txt = cellText(line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''));
    if (txt) open().rows.push({ cells: [txt], header: false });
  }
  return sheets.filter((s) => s.rows.length);
}

// Excel recusa nome de aba vazio, com mais de 31 chars ou com []:*?/\ — e recusa
// o arquivo inteiro se dois nomes repetirem.
function sheetNameFor(raw, idx, used) {
  let n = String(raw || '').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (!n) n = idx === 0 ? 'Planilha' : `Planilha ${idx + 1}`;
  const base = n;
  let k = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
  used.add(n.toLowerCase());
  return n;
}

function xlsxStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="3">`
    + `<numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>`
    + `<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>`
    + `<numFmt numFmtId="166" formatCode="0.00%"/>`
    + `</numFmts>`
    + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
    + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`
    + `<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="5">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    + `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    + `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    + `</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;
}

const XLSX_STYLE = { number: 0, text: 0, header: 1, currency: 2, date: 3, percent: 4 };

function xlsxSheetXml(rows) {
  const widths = [];
  const body = [];
  let maxCols = 1;
  // Numa coluna de dinheiro raramente TODA célula traz o "R$" ("R$ 432,17" numa
  // linha, "(58,90)" na outra). Se pelo menos uma célula da coluna é moeda, a
  // coluna inteira ganha formato de moeda — senão a planilha sai com aparência
  // remendada e a soma some do rodapé do Excel.
  const moneyCol = [];
  for (const row of rows) {
    if (row.header) continue;
    for (let c = 0; c < row.cells.length; c++) {
      if (xlsxCell(row.cells[c]).kind === 'currency') moneyCol[c] = true;
    }
  }
  rows.forEach((row, r) => {
    const cells = [];
    const n = Math.min(row.cells.length, XLSX_MAX_COLS);
    for (let c = 0; c < n; c++) {
      const ref = `${colName(c)}${r + 1}`;
      const v = xlsxCell(row.cells[c]);
      const len = (v.text || '').length;
      if (!(widths[c] >= len)) widths[c] = len;
      if (row.header) {
        if (v.kind === 'blank') { cells.push(`<c r="${ref}" s="1"/>`); continue; }
        cells.push(`<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(xmlSafe(v.text))}</t></is></c>`);
        continue;
      }
      if (v.kind === 'blank') continue;
      if (v.kind === 'text') {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(xmlSafe(v.value))}</t></is></c>`);
        continue;
      }
      const s = (v.kind === 'number' && moneyCol[c]) ? XLSX_STYLE.currency : (XLSX_STYLE[v.kind] || 0);
      cells.push(`<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v.value}</v></c>`);
    }
    if (n > maxCols) maxCols = n;
    body.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const cols = widths.map((w, i) => {
    const width = Math.min(60, Math.max(9, (w || 0) + 2));
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  const frozen = rows.length && rows[0].header
    ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
    : '';
  const dim = `A1:${colName(Math.max(0, maxCols - 1))}${Math.max(1, rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="${dim}"/>`
    + `<sheetViews><sheetView workbookViewId="0">${frozen}</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData>${body.join('')}</sheetData>`
    + `</worksheet>`;
}

// Teto de abas do arquivo. Como os de linha e coluna, ele existe pra não gerar
// um xlsx absurdo; o problema era estourar em SILÊNCIO, entregando um arquivo
// que parece completo e não é. Agora o que ficou de fora volta como aviso.
const XLSX_MAX_SHEETS = 20;

function buildXlsx(md, title = '') {
  let sheets = parseSheets(md);
  if (!sheets.length) sheets = [{ name: '', rows: [{ cells: [String(title || 'Sem conteúdo')], header: false }] }];
  const used = new Set();
  const abasOmitidas = Math.max(0, sheets.length - XLSX_MAX_SHEETS);
  let linhasOmitidas = 0;
  let colunasOmitidas = 0;
  sheets = sheets.slice(0, XLSX_MAX_SHEETS).map((s, i) => {
    linhasOmitidas += Math.max(0, s.rows.length - XLSX_MAX_ROWS);
    const rows = s.rows.slice(0, XLSX_MAX_ROWS);
    for (const row of rows) {
      colunasOmitidas = Math.max(colunasOmitidas, row.cells.length - XLSX_MAX_COLS);
    }
    return { name: sheetNameFor(s.name || (i === 0 ? title : ''), i, used), rows };
  });
  colunasOmitidas = Math.max(0, colunasOmitidas);
  const faltou = [];
  if (abasOmitidas) faltou.push(`${abasOmitidas} aba(s) além do limite de ${XLSX_MAX_SHEETS}`);
  if (linhasOmitidas) faltou.push(`${linhasOmitidas} linha(s) além do limite de ${XLSX_MAX_ROWS} por aba`);
  if (colunasOmitidas) faltou.push(`${colunasOmitidas} coluna(s) além do limite de ${XLSX_MAX_COLS}`);
  const aviso = faltou.length
    ? `A planilha saiu INCOMPLETA: ficaram de fora ${faltou.join('; ')}. Avise o usuário disso e ofereça quebrar o conteúdo em mais de um arquivo.`
    : null;
  const files = [];
  const overrides = [];
  const wbRels = [];
  sheets.forEach((s, i) => {
    const n = i + 1;
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: xlsxSheetXml(s.rows) });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
  });
  wbRels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
    + sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + `</sheets></workbook>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + overrides.join('')
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `</Types>`;
  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`;
  const buffer = zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: pkgRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: xlsxStyles() },
    ...files,
  ]);
  return { buffer, aviso };
}

// CSV existe só pra quando o usuário PEDE csv com todas as letras. Separador ";"
// e BOM porque é assim que o Excel em pt-BR abre nas colunas certas (com vírgula
// ele joga a linha inteira numa coluna só).
function buildCsv(md) {
  const sheets = parseSheets(md);
  const esc = (v) => (/[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const parts = sheets.map((s) => {
    const head = s.name ? `${esc(s.name)}\n` : '';
    return head + s.rows.map((r) => r.cells.map((c) => esc(cellText(c))).join(';')).join('\n');
  });
  return Buffer.from('﻿' + parts.join('\n\n'), 'utf8');
}

// ── .pdf (texto simples, uma ou mais páginas — layout aproximado, honesto) ──
function pdfEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
// As fontes do PDF são declaradas com /WinAnsiEncoding, mas o content stream é
// serializado em latin1: sem esta tabela, `Buffer.from('•','latin1')` trunca o
// ponto de código (8226 % 256 = 34) e o bullet vira aspas. Os caracteres abaixo
// existem no WinAnsi entre 0x80 e 0x9F, faixa que o latin1 não cobre.
const WIN_ANSI = new Map(Object.entries({
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85, '\u2020': 0x86,
  '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95,
  '\u2013': 0x96, '\u2014': 0x97, '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
}));
// Converte para uma string de bytes WinAnsi (cada char vira o byte final).
// O que não existe na tabela de 8 bits vira '?', em vez de um byte aleatório.
function winAnsi(s) {
  let out = '';
  for (const ch of String(s)) {
    const mapped = WIN_ANSI.get(ch);
    if (mapped !== undefined) { out += String.fromCharCode(mapped); continue; }
    const code = ch.codePointAt(0);
    out += code <= 0xFF ? ch : '?';
  }
  return out;
}

// Quebra um texto em linhas que cabem em `max` caracteres (aprox., fonte fixa
// de largura média). Retorna array de strings.
function wrap(text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function buildPdf(md, title, images) {
  const blocks = parseBlocks(md);
  const PAGE_H = 842, PAGE_W = 595, TOP = 792, LEFT = 56, LEADING = 15, BOTTOM = 56;
  const CONTENT_W = PAGE_W - 2 * LEFT;

  // XObjects únicos (por url) que de fato entram no PDF.
  const xobjs = [];            // [{ id, dict, stream, width, height }]
  const xobjByUrl = new Map();
  function ensureXobj(url, img) {
    if (xobjByUrl.has(url)) return xobjByUrl.get(url);
    const xo = pdfImageXObject(img);
    if (!xo) { xobjByUrl.set(url, null); return null; }
    xo.id = xobjs.length + 1;
    xobjs.push(xo);
    xobjByUrl.set(url, xo);
    return xo;
  }

  // Fluxo de itens: texto | imagem | espaço.
  const items = [];
  if (title) { items.push({ type: 'text', text: title, size: 18, bold: true }); items.push({ type: 'gap', h: 12 }); }
  for (const b of blocks) {
    const flat = b.runs.map((r) => r.text).join('');
    const im = flat.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
    if (im) {
      const alt = im[1].trim();
      const url = im[2];
      const img = images && images.get(url);
      const xo = img ? ensureXobj(url, img) : null;
      if (xo) {
        let dw = xo.width, dh = xo.height;
        let scale = CONTENT_W / dw;                       // encaixa na largura útil
        const maxH = TOP - BOTTOM - 4;
        if (dh * scale > maxH) scale = maxH / dh;          // não estoura a página
        items.push({ type: 'image', xo, w: dw * scale, h: dh * scale });
        if (alt) items.push({ type: 'text', text: alt, size: 9, bold: false });
      } else {
        items.push({ type: 'text', text: `[imagem indisponível: ${alt || url}]`, size: 11, bold: false });
      }
      continue;
    }
    if (b.type === 'blank') { items.push({ type: 'gap', h: 8 }); continue; }
    if (b.type === 'h1') { items.push({ type: 'text', text: flat, size: 18, bold: true }); continue; }
    if (b.type === 'h2') { items.push({ type: 'text', text: flat, size: 15, bold: true }); continue; }
    if (b.type === 'h3') { items.push({ type: 'text', text: flat, size: 13, bold: true }); continue; }
    if (b.type === 'li') { for (const l of wrap('•  ' + flat, 92)) items.push({ type: 'text', text: l, size: 11, bold: false }); continue; }
    for (const l of wrap(flat, 95)) items.push({ type: 'text', text: l, size: 11, bold: false });
  }

  // Pagina posicionando y do topo pra baixo.
  const pages = [];
  let cur = [];
  let y = TOP;
  const flush = () => { pages.push(cur); cur = []; y = TOP; };
  for (const it of items) {
    if (it.type === 'gap') { y -= it.h; if (y < BOTTOM) flush(); continue; }
    if (it.type === 'image') {
      if (y - (it.h + 8) < BOTTOM && cur.length) flush();
      cur.push({ ...it, y });
      y -= (it.h + 8);
      continue;
    }
    const lh = it.size >= 15 ? LEADING + 6 : LEADING;
    if (y - lh < BOTTOM) flush();
    cur.push({ ...it, y });
    y -= lh;
  }
  pages.push(cur);
  if (!pages.length || (pages.length === 1 && !pages[0].length)) { pages.length = 0; pages.push([{ type: 'text', text: '', size: 11, bold: false, y: TOP }]); }

  // Content stream por página + imagens usadas em cada uma.
  const contents = pages.map((list) => {
    let s = '';
    const used = new Set();
    for (const it of list) {
      if (it.type === 'image') {
        used.add(it.xo.id);
        const yy = it.y - it.h;
        s += `q ${it.w.toFixed(2)} 0 0 ${it.h.toFixed(2)} ${LEFT} ${yy.toFixed(2)} cm /Im${it.xo.id} Do Q\n`;
      } else {
        const font = it.bold ? '/F2' : '/F1';
        const bytes = pdfEscape(winAnsi(it.text));
        s += `BT ${font} ${it.size} Tf ${LEFT} ${it.y} Td (${bytes}) Tj ET\n`;
      }
    }
    return { s, used: [...used] };
  });

  // Monta os objetos PDF.
  const objs = [];
  const nPages = pages.length;
  const pageObjStart = 3;
  const fontF1Obj = pageObjStart + nPages;
  const fontF2Obj = fontF1Obj + 1;
  const contentStart = fontF2Obj + 1;
  const imageObjStart = contentStart + nPages;   // 1 objeto por XObject único

  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const kids = [];
  for (let i = 0; i < nPages; i++) kids.push(`${pageObjStart + i} 0 R`);
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nPages} >>`;
  for (let i = 0; i < nPages; i++) {
    const usedImgs = contents[i].used;
    const xobjRes = usedImgs.length
      ? ` /XObject << ${usedImgs.map((id) => `/Im${id} ${imageObjStart + (id - 1)} 0 R`).join(' ')} >>`
      : '';
    objs[pageObjStart + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 ${fontF1Obj} 0 R /F2 ${fontF2Obj} 0 R >>${xobjRes} >> `
      + `/Contents ${contentStart + i} 0 R >>`;
  }
  objs[fontF1Obj] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[fontF2Obj] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  for (let i = 0; i < nPages; i++) {
    const sbuf = Buffer.from(contents[i].s, 'latin1');
    objs[contentStart + i] = { stream: sbuf, dict: `<< /Length ${sbuf.length} >>` };
  }
  for (let i = 0; i < xobjs.length; i++) {
    objs[imageObjStart + i] = { stream: xobjs[i].stream, dict: xobjs[i].dict };
  }

  // Serializa com xref.
  let pdf = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const offsets = [];
  const total = imageObjStart + xobjs.length;
  for (let i = 1; i < total; i++) {
    offsets[i] = pdf.length;
    let objStr;
    const o = objs[i];
    if (o && typeof o === 'object' && o.stream) {
      objStr = `${i} 0 obj\n${o.dict}\nstream\n`;
      pdf = Buffer.concat([pdf, Buffer.from(objStr, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      objStr = `${i} 0 obj\n${o}\nendobj\n`;
      pdf = Buffer.concat([pdf, Buffer.from(objStr, 'latin1')]);
    }
  }
  const xrefStart = pdf.length;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  pdf = Buffer.concat([pdf, Buffer.from(xref, 'latin1')]);
  return pdf;
}

// ── Imagens embutidas (self-contained) ──────────────────────────────────────
// Baixa imagens referenciadas por <img src="http(s)://..."> e as embute como
// data: URI, pra o documento carregar sozinho (não depende de o link externo
// continuar vivo — foi o problema do caso de 19/08: colar imagem de referência
// numa apresentação e ela quebrar depois). SEM lib externa (fetch nativo).
//
// Guarda de SSRF (roda no servidor): só http/https, resolve o host e bloqueia
// IP privado/loopback/link-local/metadata, segue redirect manualmente checando
// cada salto, teto de tamanho por imagem e no total, timeout por requisição.
const MAX_IMG_BYTES = 8 * 1024 * 1024;      // 8 MB por imagem
const MAX_IMG_TOTAL = 24 * 1024 * 1024;     // 24 MB somando todas
const MAX_IMG_COUNT = 40;                    // no máximo 40 imagens por doc
const IMG_TIMEOUT_MS = 8000;

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;              // link-local / metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;  // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const lo = String(ip || '').toLowerCase();
  if (lo === '::1' || lo === '::') return true;
  if (lo.startsWith('fe80')) return true;                       // link-local
  if (lo.startsWith('fc') || lo.startsWith('fd')) return true;  // ULA
  if (lo.startsWith('::ffff:')) return ipIsPrivate(lo.slice(7));// IPv4 mapeado
  return false;
}

async function hostIsPublic(hostname) {
  if (net.isIP(hostname)) return !ipIsPrivate(hostname);
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); } catch { return false; }
  return addrs.length > 0 && addrs.every((a) => !ipIsPrivate(a.address));
}

// Baixa uma imagem e devolve { mime, buf } ou null se falhar/for barrada.
// Endurecido contra hotlink protection: manda user-agent de browser + Referer da
// própria origem da imagem (foi o que quebrava as imagens do caso de 19/08 — hosts
// tipo ND Mais/Wikimedia devolvem 403 pra bot sem UA de browser e sem Referer).
// A guarda de SSRF (hostIsPublic por salto) continua valendo em cada redirect.
async function fetchImageBytes(startUrl, budget) {
  let url = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!(await hostIsPublic(u.hostname))) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
    let r;
    try {
      // fetchFixado resolve o host UMA vez e amarra a conexão nos IPs validados.
      // Com o fetch nativo o DNS era resolvido de novo na hora de conectar, então
      // um domínio com TTL curto passava no hostIsPublic e conectava no metadata
      // da cloud (DNS rebinding). hostIsPublic acima fica como filtro barato.
      r = await fetchFixado(url, {
        signal: ctrl.signal,
        timeoutMs: IMG_TIMEOUT_MS,
        maxBytes: MAX_IMG_BYTES,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
          referer: u.origin + '/',
        },
      });
    } catch { clearTimeout(t); return null; }
    clearTimeout(t);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return null;
      try { url = new URL(loc, url).toString(); } catch { return null; }
      continue;
    }
    if (!r.ok) return null;
    let buf;
    try { buf = Buffer.from(await r.arrayBuffer()); } catch { return null; }
    if (!buf.length || buf.length > MAX_IMG_BYTES) return null;
    // Aceita se o content-type é imagem OU se os magic bytes batem (alguns hosts
    // servem imagem como application/octet-stream).
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const info = imageInfo(buf);
    let mime = ct.startsWith('image/') ? ct : (info ? (info.kind === 'jpeg' ? 'image/jpeg' : 'image/png') : null);
    if (!mime) return null;
    if (budget && budget.used + buf.length > MAX_IMG_TOTAL) return null;
    if (budget) budget.used += buf.length;
    return { mime, buf };
  }
  return null;
}

// Wrapper: devolve "data:<mime>;base64,..." (usado no HTML self-contained).
async function fetchImageAsDataUri(startUrl, budget) {
  const g = await fetchImageBytes(startUrl, budget);
  return g ? `data:${g.mime};base64,${g.buf.toString('base64')}` : null;
}

// ── Decodificação de imagem (dimensões + PNG→RGB), sem lib externa ────────────
// Lê largura/altura (e metadados) de PNG e JPEG a partir dos bytes crus.
function imageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: assinatura 89 50 4E 47 0D 0A 1A 0A, IHDR começa no byte 8.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      kind: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bitDepth: buf[24],
      colorType: buf[25],
      interlace: buf[28],
    };
  }
  // JPEG: começa em FF D8; procura um marker SOF (dimensões + nº de componentes).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      let marker = buf[p + 1];
      while (marker === 0xff && p + 1 < buf.length) { p++; marker = buf[p + 1]; }
      // markers sem payload
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (p + 4 > buf.length) break;
      const len = buf.readUInt16BE(p + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        if (p + 9 > buf.length) break;
        return {
          kind: 'jpeg',
          height: buf.readUInt16BE(p + 5),
          width: buf.readUInt16BE(p + 7),
          components: buf[p + 9],
        };
      }
      p += 2 + len;
    }
    return null;
  }
  return null;
}

// Reduz por vizinho-mais-próximo se a maior dimensão passa de `maxDim` (mantém o
// PDF enxuto quando a origem manda imagem gigante). Devolve { rgb, w, h }.
function downscaleRgb(rgb, w, h, maxDim) {
  if (Math.max(w, h) <= maxDim) return { rgb, w, h };
  const scale = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 3;
      const di = (y * nw + x) * 3;
      out[di] = rgb[si]; out[di + 1] = rgb[si + 1]; out[di + 2] = rgb[si + 2];
    }
  }
  return { rgb: out, w: nw, h: nh };
}

// Decodifica um PNG (não-entrelaçado) para RGB 8-bit, compondo alpha sobre branco.
// Cobre color types 0/2/3/4/6, bit depths 8/16 (não-palette) e 1/2/4/8 (palette).
// Retorna { width, height, rgb } ou null (entrelaçado/exótico → cai no fallback).
function pngToRgb(buf) {
  const info = imageInfo(buf);
  if (!info || info.kind !== 'png' || info.interlace !== 0) return null;
  const { width, height, bitDepth, colorType } = info;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3
    : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null;
  if (colorType === 3) { if (![1, 2, 4, 8].includes(bitDepth)) return null; }
  else if (![8, 16].includes(bitDepth)) return null;
  // Coleta chunks
  let p = 8;
  const idat = [];
  let palette = null, trns = null;
  try {
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      const data = buf.subarray(p + 8, p + 8 + len);
      if (type === 'IDAT') idat.push(data);
      else if (type === 'PLTE') palette = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IEND') break;
      p += 12 + len;
    }
  } catch { return null; }
  if (!idat.length) return null;
  if (colorType === 3 && !palette) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const rowBytes = Math.ceil(channels * bitDepth * width / 8);
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
  if (raw.length < (rowBytes + 1) * height) return null;
  // Desfiltra (Paeth/Sub/Up/Average) linha a linha.
  const un = Buffer.alloc(rowBytes * height);
  let pos = 0;
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const cur = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[pos + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      cur[i] = v & 0xff;
    }
    cur.copy(un, y * rowBytes);
    prev = cur;
    pos += rowBytes;
  }
  // Expande para RGB compondo alpha sobre branco (255).
  const rgb = Buffer.alloc(width * height * 3);
  let oi = 0;
  const comp = (val, a) => Math.round(val * a / 255 + 255 * (255 - a) / 255);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    if (colorType === 3) {
      let bitPos = 0;
      for (let x = 0; x < width; x++) {
        let idx;
        if (bitDepth === 8) idx = un[rowOff + x];
        else {
          const bytePos = rowOff + (bitPos >> 3);
          const shift = 8 - bitDepth - (bitPos & 7);
          idx = (un[bytePos] >> shift) & ((1 << bitDepth) - 1);
          bitPos += bitDepth;
        }
        const pr = palette[idx * 3] ?? 0, pg = palette[idx * 3 + 1] ?? 0, pb = palette[idx * 3 + 2] ?? 0;
        const a = (trns && idx < trns.length) ? trns[idx] : 255;
        rgb[oi++] = comp(pr, a); rgb[oi++] = comp(pg, a); rgb[oi++] = comp(pb, a);
      }
    } else {
      const bps = bitDepth === 16 ? 2 : 1;
      for (let x = 0; x < width; x++) {
        const base = rowOff + x * channels * bps;
        const rd = (ci) => un[base + ci * bps]; // byte alto (serve p/ 8 e 16 bit)
        let r, g, b, a = 255;
        if (colorType === 0) { r = g = b = rd(0); }
        else if (colorType === 4) { r = g = b = rd(0); a = rd(1); }
        else if (colorType === 2) { r = rd(0); g = rd(1); b = rd(2); }
        else { r = rd(0); g = rd(1); b = rd(2); a = rd(3); }
        rgb[oi++] = comp(r, a); rgb[oi++] = comp(g, a); rgb[oi++] = comp(b, a);
      }
    }
  }
  return { width, height, rgb };
}

// Monta um XObject de imagem de PDF a partir de { info, buf }. JPEG entra direto
// via DCTDecode; PNG é decodificado p/ RGB e re-comprimido com FlateDecode.
// Retorna { dict, stream, width, height } ou null (formato não suportado).
const MAX_PDF_IMG_DIM = 1600;
function pdfImageXObject(img) {
  const { info, buf } = img;
  if (info.kind === 'jpeg') {
    if (info.components !== 1 && info.components !== 3) return null; // CMYK/exótico → fallback
    const cs = info.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    const dict = `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} `
      + `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${buf.length} >>`;
    return { dict, stream: buf, width: info.width, height: info.height };
  }
  if (info.kind === 'png') {
    const dec = pngToRgb(buf);
    if (!dec) return null;
    const ds = downscaleRgb(dec.rgb, dec.width, dec.height, MAX_PDF_IMG_DIM);
    const comp = zlib.deflateSync(ds.rgb);
    const dict = `<< /Type /XObject /Subtype /Image /Width ${ds.w} /Height ${ds.h} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${comp.length} >>`;
    return { dict, stream: comp, width: ds.w, height: ds.h };
  }
  return null;
}

// Baixa e prepara todas as imagens referenciadas por ![alt](url) no markdown.
// Devolve Map(url → { buf, mime, info }); respeita os tetos globais (SSRF/tamanho).
async function collectImages(md) {
  const re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  const urls = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(md || '')))) {
    if (!seen.has(m[1])) { seen.add(m[1]); urls.push(m[1]); }
    if (urls.length >= MAX_IMG_COUNT) break;
  }
  const out = new Map();
  if (!urls.length) return out;
  const budget = { used: 0 };
  for (const u of urls) {
    const got = await fetchImageBytes(u, budget).catch(() => null);
    if (!got) continue;
    const info = imageInfo(got.buf);
    if (!info) continue;
    out.set(u, { buf: got.buf, mime: got.mime, info });
  }
  return out;
}

// Acha <img src="http(s)://..."> no HTML e troca o src por data: URI embutido.
// Deduplica por URL, respeita os tetos e, se não conseguir baixar, MANTÉM o
// link externo original (degradação suave, não some com a imagem).
async function inlineRemoteImages(html) {
  const src = String(html || '');
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  const urls = [];
  const seen = new Set();
  let m;
  while ((m = imgRe.exec(src))) {
    const u = m[1];
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
    if (urls.length >= MAX_IMG_COUNT) break;
  }
  if (!urls.length) return src;
  const budget = { used: 0 };
  const map = new Map();
  // sequencial: o teto total (budget.used) precisa ser respeitado de forma determinística
  for (const u of urls) {
    const data = await fetchImageAsDataUri(u, budget).catch(() => null);
    if (data) map.set(u, data);
  }
  if (!map.size) return src;
  return src.replace(imgRe, (full, u) => {
    const data = map.get(u);
    return data ? full.replace(u, () => data) : full;
  });
}

// ── API pública ─────────────────────────────────────────────────────────────
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export const SUPPORTED_FORMATS = Object.keys(MIME);

// Gera { buffer, mime, ext } para o formato pedido a partir de `content`
// (+ `aviso` no xlsx quando parte do conteúdo não coube e foi descartada)
// (markdown simples ou HTML simples). `title` é opcional (vira cabeçalho no PDF).
export async function generateDocument({ format, content, title = '' } = {}) {
  const fmt = String(format || 'docx').toLowerCase().replace(/^\.+/, '');
  const md = toMarkdown(content);
  if (fmt === 'xlsx' || fmt === 'xls' || fmt === 'planilha' || fmt === 'excel') {
    const x = buildXlsx(md, title);
    return { buffer: x.buffer, mime: MIME.xlsx, ext: 'xlsx', aviso: x.aviso };
  }
  if (fmt === 'csv') return { buffer: buildCsv(md), mime: MIME.csv, ext: 'csv' };
  if (fmt === 'docx' || fmt === 'pdf') {
    // Baixa e embute as imagens referenciadas (self-contained, não quebra quando o
    // link externo cair). Se algum download falhar, o gerador cai num rótulo de
    // "imagem indisponível" no lugar — nunca some silenciosamente.
    let images = new Map();
    try { images = await collectImages(md); } catch {}
    if (fmt === 'docx') return { buffer: buildDocx(md, images), mime: MIME.docx, ext: 'docx' };
    return { buffer: buildPdf(md, title, images), mime: MIME.pdf, ext: 'pdf' };
  }
  if (fmt === 'md' || fmt === 'markdown') return { buffer: Buffer.from(md, 'utf8'), mime: MIME.md, ext: 'md' };
  if (fmt === 'html' || fmt === 'htm') {
    const raw = String(content || '');
    let html = looksLikeHtml(raw) ? raw : mdToHtml(md, title);
    // Embute imagens externas como data: URI → HTML self-contained (não quebra
    // quando o link de origem cair). Se o download falhar, mantém o link externo.
    try { html = await inlineRemoteImages(html); } catch {}
    return { buffer: Buffer.from(html, 'utf8'), mime: MIME.html, ext: 'html' };
  }
  // txt e qualquer outro caem em texto puro.
  return { buffer: Buffer.from(md, 'utf8'), mime: MIME.txt, ext: 'txt' };
}

// Decodifica as entidades XML/HTML básicas (o &amp; por último pra não desfazer
// entidades já decodificadas por engano).
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return _; } })
    .replace(/&amp;/g, '&');
}

// Extrai texto legível de um documento que ESTE módulo gerou (ou de texto simples).
// docx: nossos zips são STORED (zipStore, sem compressão), então o word/document.xml
// aparece cru no buffer — pegamos os runs <w:t> e quebramos linha por <w:p>. Para
// md/txt/csv/json/xml é só decodificar UTF-8; no html tiramos as tags. PDF NÃO passa
// por aqui (quem chama usa pdf-parse). Retorna string (vazia se não achar texto).
export function extractDocumentText({ buffer, mime = '', ext = '' } = {}) {
  if (!buffer || !buffer.length) return '';
  const e = String(ext || '').toLowerCase().replace(/^\.+/, '');
  const m = String(mime || '').toLowerCase();
  // Planilha: reusa o leitor zero-dep. Fecha o ciclo "gerei um .xlsx → o usuário
  // pede pra mudar uma linha → eu releio o arquivo" sem pedir reenvio.
  if (e === 'xlsx' || m.includes('spreadsheetml')) {
    try { return xlsxToText(buffer).text; } catch { return ''; }
  }
  if (e === 'docx' || m.includes('wordprocessingml')) {
    // O docx é um zip (entradas deflate, método 8). Percorre os local file headers
    // até achar word/document.xml e infla — sem depender de lib de zip externa.
    let xml = '';
    try {
      let p = 0;
      while (p + 30 <= buffer.length && buffer.readUInt32LE(p) === 0x04034b50) {
        const method = buffer.readUInt16LE(p + 8);
        const compSize = buffer.readUInt32LE(p + 18);
        const nameLen = buffer.readUInt16LE(p + 26);
        const extraLen = buffer.readUInt16LE(p + 28);
        const name = buffer.toString('utf8', p + 30, p + 30 + nameLen);
        const dataStart = p + 30 + nameLen + extraLen;
        const comp = buffer.subarray(dataStart, dataStart + compSize);
        if (name === 'word/document.xml') {
          xml = (method === 8 ? zlib.inflateRawSync(comp) : comp).toString('utf8');
          break;
        }
        p = dataStart + compSize;
      }
    } catch { xml = ''; }
    if (!xml) return '';
    const paras = xml.split(/<w:p[ >]/).slice(1);
    const lines = paras.map((para) => {
      const runs = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((mm) => mm[1]);
      return decodeXmlEntities(runs.join(''));
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  let text = buffer.toString('utf8');
  if (e === 'html' || e === 'htm' || m.includes('html')) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n');
    text = decodeXmlEntities(text);
  }
  return text.trim();
}

// HTML simples (quando o pedido é .html mas o conteúdo veio em markdown).
function mdToHtml(md, title) {
  const blocks = parseBlocks(md);
  const esc = (t) => escapeXml(t);
  const inline = (runs) => runs.map((r) => (r.bold ? `<strong>${esc(r.text)}</strong>` : esc(r.text))).join('');
  let body = '';
  let inList = false;
  for (const b of blocks) {
    if (b.type === 'li') { if (!inList) { body += '<ul>'; inList = true; } body += `<li>${inline(b.runs)}</li>`; continue; }
    if (inList) { body += '</ul>'; inList = false; }
    if (b.type === 'blank') continue;
    if (b.type === 'h1') body += `<h1>${inline(b.runs)}</h1>`;
    else if (b.type === 'h2') body += `<h2>${inline(b.runs)}</h2>`;
    else if (b.type === 'h3') body += `<h3>${inline(b.runs)}</h3>`;
    else {
      const txt = b.runs.map((r) => r.text).join('');
      const im = txt.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
      if (im) {
        const cap = im[1].trim();
        body += `<figure><img src="${esc(im[2])}" alt="${esc(cap)}">`
          + (cap ? `<figcaption>${esc(cap)}</figcaption>` : '')
          + `</figure>`;
      } else body += `<p>${inline(b.runs)}</p>`;
    }
  }
  if (inList) body += '</ul>';
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">`
    + `<title>${esc(title || 'Documento')}</title>`
    + `<style>body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5;color:#222}`
    + `img{max-width:100%;height:auto;display:block}figure{margin:16px 0}figcaption{font-size:.85em;color:#666;margin-top:4px}</style>`
    + `</head><body>${body}</body></html>`;
}
