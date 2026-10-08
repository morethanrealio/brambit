// An empty cell/row in the .xlsx must not swallow the next one (finding #19).
// An .xlsx is a ZIP of XMLs; here we build the ZIP by hand (entries "stored",
// without compression) to test the reader offline, without a binary file in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

const { xlsxToText, xlsxCells } = await import('./web/xlsxread.mjs');

// ---- minimal ZIP (only what readZipEntries/readEntry need) ----
function zip(arquivos) {
  const locais = [];
  const central = [];
  let off = 0;
  for (const [nome, texto] of Object.entries(arquivos)) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const dados = Buffer.from(texto, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(dados) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); // method 0 = stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(dados.length, 22);
    lh.writeUInt16LE(nomeBuf.length, 26); lh.writeUInt16LE(0, 28);
    locais.push(lh, nomeBuf, dados);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dados.length, 20); ch.writeUInt32LE(dados.length, 24);
    ch.writeUInt16LE(nomeBuf.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nomeBuf);
    off += 30 + nomeBuf.length + dados.length;
  }
  const corpo = Buffer.concat(locais);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(arquivos).length, 8);
  eocd.writeUInt16LE(Object.keys(arquivos).length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(corpo.length, 16);
  return Buffer.concat([corpo, dir, eocd]);
}

const WB = '<workbook xmlns:r="r"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';

function planilha(sheetData, shared = '<si><t>alfa</t></si>') {
  return zip({
    'xl/workbook.xml': WB,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': `<sst>${shared}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetData}</sheetData></worksheet>`,
  });
}

test('an empty self-closing cell doesn\'t swallow the next cell', () => {
  const buf = planilha('<row r="1"><c r="A1"/><c r="B1"><v>5</v></c><c r="C1"><v>7</v></c></row>');
  const { text } = xlsxToText(buf);
  assert.equal(text, '# Dados\n,5,7');
});

test('an entire self-closing row doesn\'t swallow the next row', () => {
  const buf = planilha('<row r="1"/><row r="2"><c r="A2" t="s"><v>0</v></c></row>');
  const { text, rows } = xlsxToText(buf);
  assert.equal(rows, 2);
  assert.equal(text, '# Dados\n\nalfa');
});

test('cell checker: the empty one comes back empty and the next one comes back with the right value', () => {
  const buf = planilha('<row r="1"><c r="A1"/><c r="B1"><v>5</v></c></row>');
  const [a1, b1] = xlsxCells(buf, ['Dados!A1', 'Dados!B1']);
  assert.equal(a1.exists, true);
  assert.equal(a1.value, '');
  assert.equal(b1.value, '5');
});

test('cell checker: the next cell\'s formula isn\'t assigned to the empty one', () => {
  const buf = planilha('<row r="1"><c r="A1" s="2"/><c r="B1"><f>SOMA(C1:D1)</f><v>9</v></c></row>');
  const [a1, b1] = xlsxCells(buf, ['A1', 'B1']);
  assert.equal(a1.formula, '');
  assert.equal(a1.value, '');
  assert.equal(b1.formula, 'SOMA(C1:D1)');
  assert.equal(b1.value, '9');
});

test('an empty shared string doesn\'t misalign the string table', () => {
  // empty <si/> at position 0: if it swallowed the next one, index 1 would come out wrong.
  const buf = planilha('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
    '<si/><si><t>beta</t></si>');
  assert.equal(xlsxToText(buf).text, '# Dados\n,beta');
});

test('an empty <t/> inside inlineStr doesn\'t swallow the next text', () => {
  const buf = planilha('<row r="1"><c r="A1" t="inlineStr"><is><t/></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>gama</t></is></c></row>');
  assert.equal(xlsxToText(buf).text, '# Dados\n,gama');
});

test('a normal spreadsheet (no empty cell) keeps reading the same way', () => {
  const buf = planilha('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2</v></c></row>'
    + '<row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row>');
  assert.equal(xlsxToText(buf).text, '# Dados\nalfa,2\n3,4');
});

test('source: every body search has the self-closing form as the first alternative', () => {
  // Guards against regression: if someone rewrites one of these regexes without the
  // '/>' alternative in front, the defect comes back silently.
  const src = fs.readFileSync(new URL('./web/xlsxread.mjs', import.meta.url), 'utf8');
  for (const linha of src.split('\n')) {
    if (/^\s*\/\//.test(linha)) continue; // comment is not code
    if (!/= \/</.test(linha) && !/new RegExp\(/.test(linha)) continue;
    for (const tag of ['row', 'c', 'si', 't']) {
      const corpo = linha.indexOf('</' + tag + '>');
      if (corpo < 0) continue;
      const antes = linha.slice(0, corpo);
      assert.ok(/\/>\|/.test(antes) || /\\\/>\|/.test(antes),
        `<${tag}> matches the body without trying the self-closing form first: ${linha.trim()}`);
    }
  }
});
