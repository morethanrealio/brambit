// Single spreadsheet rule (2026-10-01): no matter where it comes from (chat attachment,
// ler_arquivo, Drive, Gmail, OneDrive, link opened with abrir_link), the spreadsheet is
// loaded into pandas in the analysis environment and the model receives only the structure
// (sheets, columns, row count), never the cells. If the environment fails,
// the result says it could not read it; there is no fallback to text.
// Real network blocked. The only process that runs is the probe's local python
// (PLANILHA_PY or /tmp/pdvenv/bin/python), skipped if pandas is not present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const denied = () => { throw Error('EXTERNAL IO FORBIDDEN'); };
net.Socket.prototype.connect = denied; tls.connect = denied; globalThis.fetch = denied;
// assertPublicUrl of abrir_link resolves the host: every host becomes a fixed public IP.
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

// Fake sandbox: the test decides what gravar/rodar returns (globalThis.__sb).
const fakeSandbox = `const S=()=>globalThis.__sb;
export const sandboxEnabled=()=>S().enabled;
export const sandboxWriteBytes=(...a)=>S().write(...a);
export const sandboxShell=(...a)=>S().shell(...a);`;
// Network for abrir_link: each fetchFixado falls into globalThis.__net(url, opts).
const fakeNetPin = 'export const fetchFixado=(...a)=>globalThis.__net(...a);';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox.mjs' && context.parentURL?.endsWith('/web/planilha.mjs')) return { url: 'data:text/javascript,' + encodeURIComponent(fakeSandbox), shortCircuit: true };
  if (specifier === './net-pin.mjs' && context.parentURL?.endsWith('/web/websearch.mjs')) return { url: 'data:text/javascript,' + encodeURIComponent(fakeNetPin), shortCircuit: true };
  return next(specifier, context);
} });
process.env.SANDBOX_URL = 'http://sandbox.invalid';
process.env.SANDBOX_TOKEN = 'MOCK_ONLY';

const { tipoPlanilha, loadSpreadsheetIntoSandbox, analisePlanilhaConector, getLoadedSheets } = await import('./web/planilha.mjs');
const { googleTools } = await import('./web/connectors.mjs');
const { microsoftTools } = await import('./web/connectors-ext.mjs');
const { openLinkTool, exportGoogleSheets } = await import('./web/websearch.mjs');
const { sandboxTools } = await import('./web/sandbox.mjs');
const { workbookFixture } = await import('./test-support/xlsx-fixture.mjs');

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
const duasAbas = () => workbookFixture(`<row r="1">${cell('A1', 'Banco')}${cell('B1', 'Total')}</row><row r="2">${cell('A2', 'Itaú')}${cell('B2', '1500')}</row>`, {
  sheets: '<sheet name="Resumo" sheetId="1" r:id="rId1"/><sheet name="Semana 39" sheetId="2" r:id="rId2"/>',
  rels: `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/>`,
  extra: { 'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData><row r="1">${cell('A1', 'Fornecedor')}${cell('B1', 'Status')}</row><row r="2">${cell('A2', 'Energia')}${cell('B2', 'aguardando')}</row><row r="3">${cell('A3', 'Água')}${cell('B3', 'pago')}</row></sheetData></worksheet>` },
});
const CELULAS = ['Itaú', '1500', 'Energia', 'aguardando', 'pago'];
const semCelulas = (txt) => { for (const c of CELULAS) assert.ok(!String(txt).includes(c), `célula "${c}" vazou: ${txt}`); };

// Fake sandbox that answers the probe with a ready-made structure.
const sondaOk = (abas) => ({ enabled: true, gravados: [], comandos: [],
  async write(userId, path, buf) { this.gravados.push({ userId, path, buf }); return { ok: true }; },
  async shell(userId, cmd) { this.comandos.push(cmd); return { exitCode: 0, stdout: JSON.stringify({ ok: true, abas }) + '\n', stderr: '' }; } });
const ABAS = [{ nome: 'Resumo', linhas: 1, colunas: 2, nomes: ['Banco', 'Total'] }, { nome: 'Semana 39', linhas: 2, colunas: 2, nomes: ['Fornecedor', 'Status'] }];

test('tipoPlanilha: a extensão manda, o mime decide quando não há extensão', () => {
  assert.equal(tipoPlanilha('a.xlsx'), 'excel');
  assert.equal(tipoPlanilha('a.XLSM'), 'excel');
  assert.equal(tipoPlanilha('a.xls'), 'excel');
  assert.equal(tipoPlanilha('contas.csv', 'application/vnd.ms-excel'), 'csv', 'CSV do Windows com mime de Excel continua CSV');
  assert.equal(tipoPlanilha('a.tsv'), 'tsv');
  assert.equal(tipoPlanilha('export', 'text/csv; charset=utf-8'), 'csv');
  assert.equal(tipoPlanilha('', 'text/tab-separated-values'), 'tsv');
  assert.equal(tipoPlanilha('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'excel');
  assert.equal(tipoPlanilha('x', 'application/vnd.google-apps.spreadsheet'), 'excel');
  for (const [n, m] of [['a.pdf', 'application/pdf'], ['a.txt', 'text/plain'], ['a.docx', ''], ['', ''], ['pagina', 'text/html']]) assert.equal(tipoPlanilha(n, m), null, `${n} ${m}`);
});

test('carregar planilha: grava no sandbox, registra e a nota traz só a estrutura', async () => {
  const sb = globalThis.__sb = sondaOk(ABAS);
  const lr = await loadSpreadsheetIntoSandbox('u-estrutura', duasAbas(), 'Contas a Pagar.xlsx');
  assert.equal(lr.ok, true);
  assert.equal(sb.gravados[0].path, '/workspace/planilhas/Contas_a_Pagar.xlsx');
  assert.ok(sb.gravados[0].buf.equals(duasAbas()), 'bytes originais, inteiros');
  assert.match(sb.comandos[0], /^python3 - '\/workspace\/planilhas\/Contas_a_Pagar\.xlsx' excel <<'SONDA_PY'/);
  assert.equal(lr.sheets, 2); assert.equal(lr.rows, 3);
  assert.match(lr.note, /aba "Resumo": 1 linha\(s\) de dados, 2 coluna\(s\): "Banco", "Total"/);
  assert.match(lr.note, /aba "Semana 39": 2 linha\(s\)/);
  assert.match(lr.note, /analisar_planilha/);
  semCelulas(lr.note);
  assert.deepEqual(getLoadedSheets('u-estrutura').map((e) => [e.filename, e.sheets, e.rows]), [['Contas_a_Pagar.xlsx', 2, 3]]);
});

test('CSV sem extensão ganha .csv no nome e a sonda abre como CSV', async () => {
  const sb = globalThis.__sb = sondaOk([{ nome: '(csv)', linhas: 1, colunas: 2, nomes: ['a', 'b'] }]);
  const lr = await loadSpreadsheetIntoSandbox('u-csv', Buffer.from('a;b\n1;2'), 'export', { mime: 'text/csv' });
  assert.equal(lr.filename, 'export.csv');
  assert.match(sb.comandos[0], /export\.csv' csv <</);
});

test('qualquer falha do ambiente vira nota de "não consegui ler", nunca texto da planilha', async () => {
  const casos = {
    'desligado': { enabled: false },
    'gravação falha': { enabled: true, write: async () => ({ ok: false, error: 'disco cheio' }) },
    'gravação lança': { enabled: true, write: async () => { throw Error('ECONNREFUSED'); } },
    'shell lança': { enabled: true, write: async () => ({ ok: true }), shell: async () => { throw Error('socket hang up'); } },
    'tempo limite': { enabled: true, write: async () => ({ ok: true }), shell: async () => ({ timedOut: true, stdout: '' }) },
    'saída inválida': { enabled: true, write: async () => ({ ok: true }), shell: async () => ({ stdout: 'Traceback...', stderr: 'ModuleNotFoundError: pandas' }) },
    'pandas não abre': { enabled: true, write: async () => ({ ok: true }), shell: async () => ({ stdout: '{"ok": false, "erro": "BadZipFile: File is not a zip file"}' }) },
  };
  for (const [caso, sb] of Object.entries(casos)) {
    globalThis.__sb = sb;
    const lr = await loadSpreadsheetIntoSandbox('u-falha', duasAbas(), 'contas.xlsx');
    assert.equal(lr.ok, false, caso);
    assert.match(lr.note, /não pôde ser aberta no ambiente de análise/, caso);
    assert.match(lr.note, /NÃO está disponível por nenhum outro caminho/, caso);
    semCelulas(lr.note);
  }
  assert.equal(getLoadedSheets('u-falha').filter((e) => e.sheets != null).length, 0, 'falha não registra planilha como lida');
});

test('conector sem ambiente de análise, ou com ele quebrando, devolve a nota de falha', async () => {
  assert.match(await analisePlanilhaConector(null, duasAbas(), 'a.xlsx'), /ambiente de análise indisponível/);
  assert.match(await analisePlanilhaConector(async () => { throw Error('boom'); }, duasAbas(), 'a.xlsx'), /não pôde ser aberta.*boom/);
  assert.match(await analisePlanilhaConector(async () => ({ ok: false, error: 'x' }), duasAbas(), 'a.xlsx'), /não pôde ser aberta no ambiente de análise \(x\)/);
});

// ── The real probe, with local pandas ──
const PY = process.env.PLANILHA_PY || '/tmp/pdvenv/bin/python';
const temPandas = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pandas, openpyxl'], { stdio: 'ignore' }).status === 0;
function sandboxLocal() {
  const raiz = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'planilha-'));
  const local = (p) => nodePath.join(raiz, p.replace(/^\/workspace\//, ''));
  return { enabled: true,
    async write(_u, path, buf) { fs.mkdirSync(nodePath.dirname(local(path)), { recursive: true }); fs.writeFileSync(local(path), buf); return { ok: true }; },
    async shell(_u, cmd) {
      const m = /^python3 - '([^']+)' (\w+) <<'SONDA_PY'\n([\s\S]*)\nSONDA_PY$/.exec(cmd);
      assert.ok(m, 'comando da sonda no formato esperado');
      const r = spawnSync(PY, ['-', local(m[1]), m[2]], { input: m[3], encoding: 'utf8', timeout: 60_000 });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    } };
}

test('sonda real: Excel de duas abas abre todas as abas e nenhuma célula sai', { skip: !temPandas && 'sem pandas local' }, async () => {
  globalThis.__sb = sandboxLocal();
  const lr = await loadSpreadsheetIntoSandbox('u-real', duasAbas(), 'contas.xlsx');
  assert.equal(lr.ok, true, lr.error);
  assert.deepEqual(lr.abas, ABAS);
  semCelulas(lr.note);
});

test('sonda real: CSV com ponto e vírgula em latin-1 (export do Excel BR) abre certo', { skip: !temPandas && 'sem pandas local' }, async () => {
  globalThis.__sb = sandboxLocal();
  const csv = Buffer.from('Fornecedor;Situação;Valor\nEnergia;aguardando;150,00\nÁgua;pago;80,00\n', 'latin1');
  const lr = await loadSpreadsheetIntoSandbox('u-real', csv, 'contas.csv');
  assert.equal(lr.ok, true, lr.error);
  assert.deepEqual(lr.abas, [{ nome: '(csv)', linhas: 2, colunas: 3, nomes: ['Fornecedor', 'Situação', 'Valor'] }]);
  semCelulas(lr.note);
});

test('sonda real: arquivo que não é planilha falha com nota, sem texto', { skip: !temPandas && 'sem pandas local' }, async () => {
  globalThis.__sb = sandboxLocal();
  const lr = await loadSpreadsheetIntoSandbox('u-real', Buffer.from('<html>login</html>'), 'falsa.xlsx');
  assert.equal(lr.ok, false);
  assert.match(lr.note, /não pôde ser aberta/);
  assert.ok(!lr.note.includes('login'));
});

// ── Connectors: the result never carries cells ──
const resposta = (r) => ({ ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.json, text: async () => r.text ?? '', arrayBuffer: async () => { const b = r.bytes || Buffer.from(r.text ?? ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
async function comFetch(rotas, fn) {
  const chamadas = [];
  globalThis.fetch = async (url) => { url = String(url); chamadas.push(url); return resposta(rotas(url)); };
  try { return await fn(chamadas); } finally { globalThis.fetch = denied; }
}
const registra = (lista) => async (buf, nome, mime) => { lista.push({ buf: Buffer.from(buf), nome, mime }); return { ok: true, note: 'ESTRUTURA' }; };

test('Gmail: anexo .xlsx e .csv vão pro pandas; o resultado não tem texto', async () => {
  for (const [filename, mimeType] of [['contas.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['contas.csv', 'text/csv']]) {
    const carregadas = [];
    const tool = googleTools({ token: async () => 't', caps: { gmail: { read: true } }, onSheetLoad: registra(carregadas) }).find((t) => t.name === 'gmail_read_attachment');
    await comFetch((url) => url.includes('/attachments/')
      ? { json: { data: duasAbas().toString('base64url') } }
      : { json: { id: 'm1', payload: { parts: [{ filename, mimeType, body: { attachmentId: 'a1', size: 10 } }] } } }, async () => {
      const out = JSON.parse(await tool.run({ id: 'm1', attachmentId: 'a1' }));
      assert.equal(out.analise, 'ESTRUTURA');
      assert.equal(out.text, undefined);
      assert.deepEqual(carregadas.map((c) => [c.nome, c.mime]), [[filename, mimeType]]);
      assert.ok(carregadas[0].buf.equals(duasAbas()));
    });
  }
});

test('OneDrive: Excel e CSV vão pro pandas; sem ambiente, a nota diz que não leu', async () => {
  for (const [name, mimeType] of [['contas.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['contas.csv', 'text/csv']]) {
    for (const comAmbiente of [true, false]) {
      const carregadas = [];
      const tool = microsoftTools({ token: async () => 't', onSheetLoad: comAmbiente ? registra(carregadas) : null }).find((t) => t.name === 'onedrive_read');
      await comFetch((url) => url.endsWith('/content') ? { bytes: duasAbas() } : { json: { id: 'i1', name, size: 100, file: { mimeType } } }, async () => {
        const out = JSON.parse(await tool.run({ id: 'i1' }));
        assert.equal(out.text, undefined);
        semCelulas(JSON.stringify(out));
        if (comAmbiente) { assert.equal(out.analise, 'ESTRUTURA'); assert.equal(carregadas[0].nome, name); }
        else assert.match(out.analise, /ambiente de análise indisponível/);
      });
    }
  }
});

// ── abrir_link ──
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function comRede(rotas, fn) {
  const chamadas = [];
  globalThis.__net = async (url) => {
    chamadas.push(String(url));
    const r = rotas(String(url));
    return new Response(r.body ?? null, { status: r.status || 200, headers: r.headers || {} });
  };
  // Any call to Tavily (page text) is a test failure.
  globalThis.fetch = async (url) => { throw Error(`fetch inesperado (texto da página): ${url}`); };
  return fn(chamadas).finally(() => { globalThis.fetch = denied; delete globalThis.__net; });
}

test('exportGoogleSheets reconhece o link de edição e o publicado na web', () => {
  assert.deepEqual(exportGoogleSheets(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=0#gid=0`), { id: SHEET_ID, publicado: false, url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx` });
  assert.deepEqual(exportGoogleSheets('https://docs.google.com/spreadsheets/d/e/2PACX-abc_123/pubhtml'), { id: '2PACX-abc_123', publicado: true, url: 'https://docs.google.com/spreadsheets/d/e/2PACX-abc_123/pub?output=xlsx' });
  assert.equal(exportGoogleSheets('https://docs.google.com/document/d/abc/edit'), null);
  assert.equal(exportGoogleSheets('https://evil.example/spreadsheets/d/abc'), null);
});

test('abrir_link com Google Sheets público baixa o xlsx inteiro pro pandas', async () => {
  const carregadas = [];
  await comRede((url) => url.includes('/export?format=xlsx')
    ? { body: duasAbas(), headers: { 'content-type': XLSX_CT, 'content-disposition': `attachment; filename="Contas.xlsx"; filename*=UTF-8''Contas%20Set.xlsx` } }
    : { status: 500 }, async (chamadas) => {
    const out = await openLinkTool({ onSheetLoad: registra(carregadas) }).run({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` });
    assert.equal(out, 'ESTRUTURA');
    assert.deepEqual(chamadas, [`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`]);
    assert.equal(carregadas[0].nome, 'Contas Set.xlsx');
    assert.equal(carregadas[0].mime, XLSX_CT);
    assert.ok(carregadas[0].buf.equals(duasAbas()));
  });
});

test('abrir_link com Google Sheets privado avisa que não leu e não cai no texto da página', async () => {
  await comRede((url) => url.includes('/export?format=xlsx')
    ? { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?continue=x' } }
    : { body: '<html>Fazer login</html>', headers: { 'content-type': 'text/html; charset=utf-8' } }, async (chamadas) => {
    const out = await openLinkTool({ onSheetLoad: registra([]) }).run({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` });
    assert.match(out, /não está aberta ao público.*NÃO li nada/);
    assert.ok(out.includes(SHEET_ID), 'aponta o id pra abrir pelo Drive conectado');
    assert.ok(!out.includes('Fazer login'));
    assert.equal(chamadas.length, 2, 'só o export e o redirect de login');
  });
});

test('abrir_link com Google Sheets quando a rede falha: erro, sem texto da página', async () => {
  globalThis.__net = async () => { throw Error('ETIMEDOUT'); };
  globalThis.fetch = async (url) => { throw Error(`fetch inesperado: ${url}`); };
  try {
    const out = await openLinkTool({ onSheetLoad: registra([]) }).run({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` });
    assert.match(out, /^ERRO: não consegui baixar a planilha do Google Sheets \(ETIMEDOUT\)/);
  } finally { globalThis.fetch = denied; delete globalThis.__net; }
});

test('abrir_link com link direto pra .csv/.xlsx vai pro pandas pelo nome do arquivo', async () => {
  for (const [path, ct, esperado] of [['/dados/contas.csv', 'text/plain', 'contas.csv'], ['/baixar?id=9', XLSX_CT, 'baixar'], ['/relatorio.xlsx', 'application/octet-stream', 'relatorio.xlsx']]) {
    const carregadas = [];
    await comRede(() => ({ body: duasAbas(), headers: { 'content-type': ct } }), async () => {
      const out = await openLinkTool({ onSheetLoad: registra(carregadas) }).run({ url: `https://exemplo.com.br${path}` });
      assert.equal(out, 'ESTRUTURA', path);
      assert.equal(carregadas[0].nome, esperado);
    });
  }
});

test('abrir_link com planilha que dá 404, ou sem ambiente de análise, não lê nada', async () => {
  await comRede(() => ({ status: 404, body: 'not found', headers: { 'content-type': 'text/plain' } }), async () => {
    const out = await openLinkTool({ onSheetLoad: registra([]) }).run({ url: 'https://exemplo.com.br/contas.csv' });
    assert.match(out, /^ERRO: não consegui baixar a planilha desse link \(HTTP 404\)/);
  });
  await comRede(() => ({ body: duasAbas(), headers: { 'content-type': XLSX_CT } }), async () => {
    const out = await openLinkTool({}).run({ url: 'https://exemplo.com.br/contas.xlsx' });
    assert.match(out, /Este link é uma PLANILHA/);
    const sheets = await openLinkTool({}).run({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` });
    assert.match(sheets, /Este link é uma PLANILHA/);
  });
});

test('sandbox_read_file não entrega planilha como texto; outros arquivos seguem normais', async () => {
  const tool = sandboxTools('u1').find((t) => t.name === 'sandbox_read_file');
  for (const p of ['/workspace/planilhas/contas.csv', '/workspace/a.XLSX', '/workspace/b.tsv', '/workspace/c.xls']) {
    assert.match(await tool.run({ path: p }), /é uma planilha e não é lido como texto/, p);
  }
  const lidos = [];
  globalThis.fetch = async (url, opts) => { lidos.push(JSON.parse(opts.body).path); return { ok: true, json: async () => ({ ok: true, content: 'olá' }) }; };
  try { assert.equal(await tool.run({ path: '/workspace/notas.txt' }), 'olá'); } finally { globalThis.fetch = denied; }
  assert.deepEqual(lidos, ['/workspace/notas.txt']);
});

test('anexo do chat: docKind manda xlsx, xls, csv e tsv pro caminho da planilha', () => {
  const src = fs.readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
  const pega = (ini, fim) => src.slice(src.indexOf(ini), src.indexOf(fim, src.indexOf(ini)));
  const code = [pega('const TEXT_DOC_RE', '\n'), pega('const TEXT_MIME_RE', '\n'), pega('function docKind', 'function normalizeFiles')].join('\n');
  const docKind = vm.runInNewContext(`${code};docKind`, { tipoPlanilha });
  for (const [n, m] of [['a.xlsx', ''], ['a.xls', 'application/vnd.ms-excel'], ['contas.csv', 'application/vnd.ms-excel'], ['contas.csv', 'text/csv'], ['b.tsv', ''], ['sem-nome', 'text/csv']]) assert.equal(docKind(n, m), 'planilha', `${n} ${m}`);
  assert.equal(docKind('a.pdf', 'application/pdf'), 'pdf');
  assert.equal(docKind('a.txt', 'text/plain'), 'text');
  // The attachment block uses the loading note, never spreadsheet text.
  const bloco = pega("if (kind === 'planilha')", 'continue;');
  assert.match(bloco, /loadSpreadsheetIntoSandbox\(userId, f\.buffer, name, \{ tipo \}\)/);
  assert.match(bloco, /\$\{lr\.note\}/);
  assert.doesNotMatch(bloco, /xlsxToText|toString\(/);
});
