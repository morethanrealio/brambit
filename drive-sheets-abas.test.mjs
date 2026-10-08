// drive_read with a native Google Sheets spreadsheet: has to read ALL tabs
// (export .xlsx), not just the first one (export CSV). 2026-09-30 case.
// Since 2026-10-01 the whole spreadsheet goes to the analysis environment (pandas) and the
// drive_read result never carries the cells, only the structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleTools } from './web/connectors.mjs';
import { workbookFixture } from './test-support/xlsx-fixture.mjs';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
const duasAbas = () => workbookFixture(`<row r="1">${cell('A1', 'Banco')}${cell('B1', 'Total')}</row>`, {
  sheets: '<sheet name="Resumo" sheetId="1" r:id="rId1"/><sheet name="Semana 39" sheetId="2" r:id="rId2"/>',
  rels: `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/>`,
  extra: { 'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData><row r="1">${cell('A1', 'Fornecedor')}${cell('B1', 'Status')}</row><row r="2">${cell('A2', 'Energia')}${cell('B2', 'aguardando')}</row></sheetData></worksheet>` },
});

function comFetch(respostas, fn) {
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url); chamadas.push(url);
    const r = respostas(url);
    const bytes = () => r.bytes || Buffer.from(r.text ?? '');
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json, text: async () => r.text ?? '', arrayBuffer: async () => { const b = bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
  };
  return fn(chamadas).finally(() => { globalThis.fetch = original; });
}
const driveRead = (onSheetLoad) => googleTools({ token: async () => 't', caps: { drive: { read: true } }, onSheetLoad }).find((t) => t.name === 'drive_read');
const metaSheets = { json: { id: 'abc', name: 'Contas_a_Pagar', mimeType: 'application/vnd.google-apps.spreadsheet' } };
const registra = (carregadas) => async (buf, nome, mime) => { carregadas.push({ nome, mime, buf: Buffer.from(buf) }); return { ok: true, note: 'carregada' }; };

test('Google Sheets é exportado como .xlsx e o arquivo inteiro vai pro ambiente de análise, sem células no resultado', async () => {
  const carregadas = [];
  await comFetch((url) => url.includes('/export?') ? { bytes: duasAbas() } : metaSheets, async (chamadas) => {
    const out = JSON.parse(await driveRead(registra(carregadas)).run({ id: 'abc' }));
    const exp = chamadas.find((u) => u.includes('/export?'));
    assert.match(exp, /mimeType=application%2Fvnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
    assert.ok(!chamadas.some((u) => u.includes('text%2Fcsv') || u.includes('text/csv')));
    assert.equal(out.analise, 'carregada');
    assert.equal(out.text, undefined);
    assert.ok(!JSON.stringify(out).includes('Energia'), 'célula não chega ao modelo');
    assert.equal(carregadas.length, 1);
    assert.equal(carregadas[0].nome, 'Contas_a_Pagar.xlsx');
    assert.ok(carregadas[0].buf.equals(duasAbas()), 'pandas recebe os bytes do export, com as duas abas');
  });
});

test('planilha grande demais pro export cai no CSV, vai pro pandas e avisa que só veio a primeira aba', async () => {
  const carregadas = [];
  await comFetch((url) => {
    if (url.includes('text%2Fcsv') || url.includes('text/csv')) return { text: 'Banco,Total\nBB,10' };
    if (url.includes('/export?')) return { status: 403, text: '{"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}' };
    return metaSheets;
  }, async () => {
    const out = JSON.parse(await driveRead(registra(carregadas)).run({ id: 'abc' }));
    assert.equal(out.text, undefined);
    assert.ok(!JSON.stringify(out).includes('BB,10'));
    assert.match(out.note, /PRIMEIRA ABA/);
    assert.equal(carregadas[0].nome, 'Contas_a_Pagar.csv');
    assert.equal(carregadas[0].buf.toString(), 'Banco,Total\nBB,10');
  });
});

test('sem ambiente de análise a planilha não é lida como texto: o resultado diz que não conseguiu', async () => {
  await comFetch((url) => url.includes('/export?') ? { bytes: duasAbas() } : metaSheets, async () => {
    const out = JSON.parse(await driveRead(null).run({ id: 'abc' }));
    assert.equal(out.text, undefined);
    assert.ok(!JSON.stringify(out).includes('Energia'));
    assert.match(out.analise, /indisponível/);
  });
});

test('outro erro do export não vira leitura parcial silenciosa', async () => {
  await comFetch((url) => url.includes('/export?') ? { status: 404, text: 'not found' } : metaSheets, async (chamadas) => {
    await assert.rejects(driveRead(null).run({ id: 'abc' }), /404/);
    assert.ok(!chamadas.some((u) => u.includes('text%2Fcsv') || u.includes('text/csv')));
  });
});

test('Excel e CSV no Drive baixam os bytes originais e vão pro pandas', async () => {
  for (const [nome, mimeType] of [['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['contas.csv', 'text/csv']]) {
    const carregadas = [];
    await comFetch((url) => url.includes('alt=media') ? { bytes: duasAbas() } : { json: { id: 'x', name: nome, mimeType } }, async (chamadas) => {
      const out = JSON.parse(await driveRead(registra(carregadas)).run({ id: 'x' }));
      assert.equal(out.analise, 'carregada');
      assert.equal(out.text, undefined);
      assert.ok(!chamadas.some((u) => u.includes('/export?')));
      assert.deepEqual(carregadas.map((c) => [c.nome, c.mime]), [[nome, mimeType]]);
    });
  }
});
