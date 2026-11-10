// Offline test of spreadsheet EDITING by code (web/sheet-edit.mjs).
// No DB, no S3, no sandbox: all dependencies come in via `deps`, and the
// spreadsheet is a fake buffer. Run with: node tests/sheet-edit.test.mjs
//
// What this test protects (the 2026-09-09 incident): a large spreadsheet being
// rewritten from a truncated call lost rows and wrote the cut marker
// as data. The cases below cover the mechanisms that prevent this —
// marker guard, atomicity (failure generates no asset), previous version
// preserved under a history name, and serialization of overlapping edits.

const {
  editSpreadsheet, pickSheetAsset, baseFamily, versionedCaption, hasCutMarker,
  describeDelta, detectarProblema, declarouRemocao, withKeyLock, isSheetAsset,
  pecasPerdidas, pedeClarificacao, parseEvidencia, conferirEvidencia,
} = await import('../web/sheet-edit.mjs');
const { registerLoadedSheet, getLoadedSheets, withSheetThread, analyzeKeepingCopies } = await import('../web/sheet.mjs');

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── 1) Cut marker ──
t('cut marker detected', hasCutMarker('linha a\n…[cortado: 74123 chars]…\nlinha b'));
t('marker with space too', hasCutMarker('x …[cortado:74123 chars]… y'));
t('normal text does not trigger', !hasCutMarker('| Autor | Ano |\n| Bae | 2019 |'));
t('non-string does not break', !hasCutMarker(null) && !hasCutMarker(12));

// ── 2) Asset selection: the most RECENT one is the valid version ──
const assets = [
  { id: 9, caption: 'Matriz de artigos.xlsx', mime: XLSX_MIME, s3_key: 'u/9', created_at: '2026-09-09T18:30:00Z' },
  { id: 8, caption: 'foto.jpg', mime: 'image/jpeg', s3_key: 'u/8', created_at: '2026-09-09T18:00:00Z' },
  { id: 7, caption: 'Matriz de artigos.xlsx', mime: XLSX_MIME, s3_key: 'u/7', created_at: '2026-09-09T17:00:00Z' },
];
t('picks the most recent spreadsheet', pickSheetAsset(assets).asset.id === 9);
t('skips attachment that is not a spreadsheet', pickSheetAsset([assets[1], assets[2]]).asset.id === 7);
// id 7 and id 9 are the same spreadsheet (same caption); the id of the older one
// resolves to the current version (id 9), never editing an archived copy.
t('id of an older same-name version resolves to the current one', pickSheetAsset(assets, { id: 7 }).asset.id === 9);
t('nonexistent id errors', !!pickSheetAsset(assets, { id: 99 }).error);
t('non-spreadsheet id errors', !!pickSheetAsset(assets, { id: 8 }).error);
t('library without spreadsheet errors', !!pickSheetAsset([assets[1]]).error);
t('empty list errors', !!pickSheetAsset([]).error && !!pickSheetAsset(null).error);
t('detects spreadsheet by extension without mime', isSheetAsset({ caption: 'x.xlsx' }));
{
  // A file sent from outside is a spreadsheet of its own: its id edits it, not a
  // newer upload or generated file that happens to have the same name.
  const up = [
    { id: 31, caption: 'fatura.xlsx', mime: XLSX_MIME, source: 'upload', s3_key: 'u/31', created_at: '2026-10-05T10:00:00Z' },
    { id: 30, caption: 'fatura.xlsx', mime: XLSX_MIME, source: 'upload', s3_key: 'u/30', created_at: '2026-03-05T10:00:00Z' },
  ];
  t('id of an older upload with the same name edits that upload', pickSheetAsset(up, { id: 30 }).asset.id === 30);
}
t('does not confuse docx with spreadsheet', !isSheetAsset({ caption: 'x.docx', mime: 'application/msword' }));

// ── 2b) Version family: an id must resolve to the CURRENT version, not an archived copy ──
// The library has no version-group column; versions are told apart only by the caption
// (an archived one is `base_yyyymmddhhmmss.ext`). baseFamily groups them.
t('family strips the version stamp', baseFamily('Fontes_20260909170405.xlsx') === 'fontes.xlsx');
t('family strips a doubly-stamped name', baseFamily('Fontes_20260909170405_20261101120000.xlsx') === 'fontes.xlsx');
t('family strips the dateless _v fallback', baseFamily('a_v0b1c2d3e-0000-4000-8000-123456789abc.xlsx') === 'a.xlsx');
t('family strips the _vantiga fallback', baseFamily('a_vantiga.xlsx') === 'a.xlsx');
t('family keeps a user _v2 suffix', baseFamily('Orcamento_v2.xlsx') === 'orcamento_v2.xlsx' && baseFamily('Orcamento_v3.xlsx') !== baseFamily('Orcamento_v2.xlsx'));
t('family keeps a non-stamp suffix', baseFamily('Report_final.xlsx') === 'report_final.xlsx');
t('canonical caption is its own family', baseFamily('Fontes.xlsx') === 'fontes.xlsx');
{
  // Canonical "Fontes.xlsx" (newest) plus its archived version and an unrelated sheet.
  const lib = [
    { id: 20, caption: 'Fontes.xlsx', mime: XLSX_MIME, s3_key: 'u/20', created_at: '2026-10-02T10:00:00Z' },
    { id: 19, caption: 'Vendas.xlsx', mime: XLSX_MIME, s3_key: 'u/19', created_at: '2026-10-01T10:00:00Z' },
    { id: 18, caption: 'Fontes_20260909170405.xlsx', mime: XLSX_MIME, s3_key: 'u/18', created_at: '2026-09-09T17:04:05Z' },
  ];
  t('id of an archived version resolves to the current one', pickSheetAsset(lib, { id: 18 }).asset.id === 20);
  t('id of a distinct spreadsheet stays in its own family', pickSheetAsset(lib, { id: 19 }).asset.id === 19);
  t('id of the current version resolves to itself', pickSheetAsset(lib, { id: 20 }).asset.id === 20);
}

// ── 3) Archived version name ──
t('archived version uses yyyymmddhhmmss',
  versionedCaption('Matriz de artigos.xlsx', '2026-09-09T17:04:05Z') === 'Matriz de artigos_20260909170405.xlsx');
t('preserves xlsm extension',
  versionedCaption('a.xlsm', '2026-01-02T03:04:05Z') === 'a_20260102030405.xlsm');
t('works even without extension',
  versionedCaption('planilha', '2026-01-02T03:04:05Z') === 'planilha_20260102030405');
t('invalid date falls back to id',
  versionedCaption('a.xlsx', 'nao-e-data', { id: 7 }) === 'a_v7.xlsx');
t('canonical name never becomes the archived one',
  versionedCaption('a.xlsx', '2026-01-02T03:04:05Z') !== 'a.xlsx');

// ── 4) Delta and SILENT failure detection (valid xlsx, lost content) ──
t('delta describes growth', describeDelta({ rows: 62, sheets: 2 }, { rows: 66, sheets: 2 }).includes('62 → 66 (+4)'));
t('delta without count change', describeDelta({ rows: 62, sheets: 1 }, { rows: 62, sheets: 1 }).includes('sem mudança'));
const prob = (b, a, resumo = '', identical = false) =>
  detectarProblema({ before: { rows: b }, after: { rows: a, text: resumo === 'TEXTO' ? 'x' : (resumo || '') }, resumo, identical });
t('large shrink is a problem', !!prob(62, 21));
t('small shrink passes', !prob(62, 60));
t('tiny spreadsheet does not trigger', !prob(6, 2));
t('marker as data is a problem',
  !!detectarProblema({ before: { rows: 62 }, after: { rows: 62, text: 'ART-07,…[cortado: 400 chars]…' }, resumo: '' }));
t('identical file is a problem', !!detectarProblema({ before: { rows: 62 }, after: { rows: 62, text: '' }, resumo: '', identical: true }));
t('good result does not create a problem', !detectarProblema({ before: { rows: 62 }, after: { rows: 66, text: 'ok' }, resumo: 'acrescentei 4' }));
t('declared removal is accepted',
  !detectarProblema({ before: { rows: 62 }, after: { rows: 12, text: 'ok' }, resumo: 'removi as canceladas. REMOCAO_INTENCIONAL' }));
t('declaration with accent also counts', declarouRemocao('feito: REMOÇÃO_INTENCIONAL'));
t('declaration does not accept cut marker',
  !!detectarProblema({ before: { rows: 62 }, after: { rows: 12, text: '…[cortado: 9 chars]…' }, resumo: 'REMOCAO_INTENCIONAL' }));
t('problem carries a correction instruction', typeof prob(62, 21).instrucao === 'string' && prob(62, 21).instrucao.length > 20);

// ── 5) Queue per key (overlapping edits do not overlap) ──
{
  const ordem = [];
  const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = withKeyLock('k1', async () => { ordem.push('a-in'); await dorme(30); ordem.push('a-out'); });
  const b = withKeyLock('k1', async () => { ordem.push('b-in'); await dorme(1); ordem.push('b-out'); });
  await Promise.all([a, b]);
  t('second edit waits for the first to FINISH',
    ordem.join(',') === 'a-in,a-out,b-in,b-out');

  // Failure in the first one must not lock the queue forever.
  const p1 = withKeyLock('k2', async () => { throw new Error('boom'); }).catch(() => 'erro');
  const p2 = withKeyLock('k2', async () => 'segunda rodou');
  t('failure in the queue does not block the next one', (await p1) === 'erro' && (await p2) === 'segunda rodou');

  // Different keys (different users) run in parallel.
  const marcas = [];
  await Promise.all([
    withKeyLock('u1', async () => { marcas.push('u1-in'); await dorme(20); marcas.push('u1-out'); }),
    withKeyLock('u2', async () => { marcas.push('u2-in'); await dorme(1); marcas.push('u2-out'); }),
  ]);
  t('different users do not block each other', marcas.indexOf('u2-out') < marcas.indexOf('u1-out'));
}

// ── Fakes harness for the orchestrator ──
// The "spreadsheet" is just a buffer with a JSON inside: { rows, sheets, cells }. The
// "sub-agent" mutates this JSON. This tests the orchestration (selection, atomicity,
// versioning, chaining) without real xlsx or sandbox.
function mkFake(over = {}) {
  const state = {
    lib: [{ id: 1, caption: 'Matriz.xlsx', mime: XLSX_MIME, s3_key: 'u/1', created_at: '2026-09-09T17:00:00Z' }],
    files: { 'u/1': Buffer.from(JSON.stringify({ rows: 62, sheets: 2 })) },
    sandbox: {},
    saved: [],      // assets criados
    renamed: [],    // [id, novoCaption]
    nextId: 2,
  };
  const deps = {
    listAssets: async () => state.lib.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    getAsset: async (_u, id) => state.lib.find((a) => String(a.id) === String(id)) || null,
    fetchBytes: async (key) => {
      if (!state.files[key]) throw new Error('sem bytes');
      return { buffer: state.files[key], contentType: XLSX_MIME };
    },
    loadIntoSandbox: async (_u, buf, name) => {
      const path = `/workspace/planilhas/${name}`;
      state.sandbox[path] = Buffer.from(buf);
      return { ok: true, path, filename: name };
    },
    readBytes: async (_u, path) => (state.sandbox[path]
      ? { ok: true, buffer: state.sandbox[path] }
      : { ok: false, error: 'arquivo não encontrado' }),
    inspect: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('{')) throw new Error('xlsx: nenhuma planilha encontrada');
      const j = JSON.parse(s);
      return { rows: j.rows, sheets: j.sheets, text: j.text || '' };
    },
    runEditor: async ({ path }) => {
      const j = JSON.parse(state.sandbox[path].toString('utf8'));
      j.rows += 4;
      state.sandbox[path] = Buffer.from(JSON.stringify(j));
      return 'acrescentei 4 linhas na aba Artigos';
    },
    saveAsset: async ({ buffer, caption, mime }) => {
      const id = state.nextId++;
      const key = `u/${id}`;
      state.files[key] = Buffer.from(buffer);
      state.lib.push({ id, caption, mime, s3_key: key, created_at: `2026-09-09T18:0${id}:00Z` });
      state.saved.push({ id, caption });
      return { url: `https://x/${key}`, key, assetId: id };
    },
    renameAsset: async (_u, id, caption) => {
      const a = state.lib.find((x) => String(x.id) === String(id));
      if (a) a.caption = caption;
      state.renamed.push([id, caption]);
      return true;
    },
    ...over,
  };
  return { state, deps };
}

// ── 6) Caminho felizinho ──
{
  const { state, deps } = mkFake();
  const r = await editSpreadsheet({ userId: 'user-a', objetivo: 'acrescente 4 linhas', deps });
  t('edit ok', r.ok === true);
  t('saved ONE new asset', state.saved.length === 1);
  t('new asset keeps the canonical name', state.saved[0].caption === 'Matriz.xlsx');
  t('previous version was renamed into history',
    state.renamed.length === 1 && state.renamed[0][1] === 'Matriz_20260909170000.xlsx');
  t('old bytes were NOT overwritten',
    JSON.parse(state.files['u/1'].toString()).rows === 62);
  t('new bytes have the change',
    JSON.parse(state.files['u/2'].toString()).rows === 66);
  t('delta counted from the bytes', r.delta.includes('62 → 66 (+4)'));
  t('just one attempt', r.tentativas === 1);
  t('without a cell reader, delivers with a caveat about unavailable verification', r.avisos.some((a) => a.includes('conferência das células não está disponível')));
  t('sub-agent summary comes back', r.resumo.includes('4 linhas'));
}

// ── 6b) Editing by the id of an ARCHIVED version edits the CURRENT one (no data loss) ──
{
  const { state, deps } = mkFake();
  // Make id 1 an older archived version and add the current canonical (id 5, newer).
  state.lib = [
    { id: 5, caption: 'Matriz.xlsx', mime: XLSX_MIME, s3_key: 'u/5', created_at: '2026-10-02T10:00:00Z' },
    { id: 1, caption: 'Matriz_20260909170000.xlsx', mime: XLSX_MIME, s3_key: 'u/1', created_at: '2026-09-09T17:00:00Z' },
  ];
  state.files['u/5'] = Buffer.from(JSON.stringify({ rows: 80, sheets: 2 })); // current has more content
  state.files['u/1'] = Buffer.from(JSON.stringify({ rows: 50, sheets: 2 })); // stale archived copy
  const r = await editSpreadsheet({ userId: 'user-a', objetivo: 'acrescente 4 linhas', id: '1', deps });
  t('edit by archived id succeeds', r.ok === true);
  t('edited the CURRENT version, not the archived one', r.before.rows === 80 && r.after.rows === 84);
  t('the archived bytes were left untouched', JSON.parse(state.files['u/1'].toString()).rows === 50);
  t('a single new asset was saved with the canonical name', state.saved.length === 1 && state.saved[0].caption === 'Matriz.xlsx');
}

// ── 7) Atomicity: failure at any step does NOT generate an asset and does NOT rename ──
for (const [nome, over] of [
  ['sub-agente estourou', { runEditor: async () => { throw new Error('openpyxl faltando'); } }],
  ['nao releu do sandbox', { readBytes: async () => ({ ok: false, error: 'arquivo não encontrado' }) }],
  ['arquivo voltou vazio', { readBytes: async () => ({ ok: true, buffer: Buffer.alloc(0) }) }],
  ['arquivo voltou corrompido', { runEditor: async () => 'ok' , readBytes: async () => ({ ok: true, buffer: Buffer.from('zip quebrado') }) }],
  ['bytes da biblioteca ilegiveis', { fetchBytes: async () => { throw new Error('403'); } }],
  ['sandbox recusou o load', { loadIntoSandbox: async () => ({ ok: false, error: 'sandbox desligado' }) }],
]) {
  const { state, deps } = mkFake(over);
  const r = await editSpreadsheet({ userId: `user-${nome}`, objetivo: 'muda algo', deps });
  t(`atomic: ${nome}`, r.ok === false && !!r.error && state.saved.length === 0 && state.renamed.length === 0);
}

// A rejected edit puts the original back in the sandbox, where the copy stays
// registered for analysis; a saved one leaves the copy named after the new version.
{
  const { state, deps } = mkFake({ runEditor: async ({ path }) => {
    const j = JSON.parse(state.sandbox[path].toString('utf8'));
    j.rows = 10;
    state.sandbox[path] = Buffer.from(JSON.stringify(j));
    return 'reescrevi a aba';
  } });
  const r = await editSpreadsheet({ userId: 'user-restore', objetivo: 'muda algo', deps });
  t('rejected edit is not saved', r.ok === false && state.saved.length === 0);
  t('rejected edit leaves the original bytes in the sandbox',
    JSON.parse(state.sandbox['/workspace/planilhas/Matriz.xlsx'].toString()).rows === 62);
}
{
  const { deps } = mkFake();
  const load = deps.loadIntoSandbox;
  let loads = 0;
  deps.loadIntoSandbox = async (u, buf, name, opts) => {
    loads++;
    const r = await load(u, buf, name);
    registerLoadedSheet(u, { path: r.path, filename: name, assetId: opts?.assetId });
    return r;
  };
  const r = await editSpreadsheet({ userId: 'user-reregister', objetivo: 'acrescente 4 linhas', deps });
  const [copy] = getLoadedSheets('user-reregister');
  t('saved edit leaves the sandbox copy named after the new version', r.ok === true && copy?.assetId === 2);
  t('saved edit does not write the sandbox again', loads === r.tentativas);
}

// Byte-for-byte identical file = nobody touched it: no new version is created.
{
  let chamadas = 0;
  const { state, deps } = mkFake({ runEditor: async () => { chamadas++; return 'não achei o que mudar'; } });
  const r = await editSpreadsheet({ userId: 'user-noop', objetivo: 'muda algo', deps });
  t('no-op does not create a new version', r.ok === false && state.saved.length === 0 && state.renamed.length === 0);
  t('no-op was retried before giving up', chamadas === 2);
}

// ── 7b) SILENT failure (valid xlsx, lost content) is REDONE from the
// original bytes. No bad file is delivered, and the user is not sent hunting for a
// "previous version": either the change comes out right, or nothing changes.
{
  const { state, deps } = mkFake();
  const base = deps.runEditor;
  const objetivos = [];
  const flaky = {
    ...deps,
    runEditor: async (a) => {
      objetivos.push(a.objetivo);
      if (a.tentativa === 1) {
        // recriou a planilha do zero: 62 → 21 linhas (o incidente real)
        state.sandbox[a.path] = Buffer.from(JSON.stringify({ rows: 21, sheets: 1 }));
        return 'reconstruí a planilha';
      }
      return base(a);
    },
  };
  const r = await editSpreadsheet({ userId: 'user-retry', objetivo: 'acrescente 4 linhas', deps: flaky });
  t('retrying, the edit passes', r.ok === true && r.tentativas === 2);
  t('only ONE asset saved (the right one)',
    state.saved.length === 1 && JSON.parse(state.files['u/2'].toString()).rows === 66);
  t('2nd attempt received the error diagnosis',
    objetivos.length === 2 && /ATENÇÃO/.test(objetivos[1]) && /21 linhas/.test(objetivos[1]));
  t('notice says it had to redo', r.avisos.some((a) => a.includes('2 tentativas')));
}

// Ran out of attempts: nothing saved, user's file intact and with the same name.
{
  const { state, deps } = mkFake();
  let chamadas = 0; const vistos = [];
  const ruim = {
    ...deps,
    runEditor: async ({ path }) => {
      chamadas++;
      vistos.push(JSON.parse(state.sandbox[path].toString('utf8')).rows);
      state.sandbox[path] = Buffer.from(JSON.stringify({ rows: 10, sheets: 1 }));
      return 'recriei a planilha';
    },
  };
  const r = await editSpreadsheet({ userId: 'user-ruim', objetivo: 'acrescente 4 linhas', deps: ruim });
  t('gives up without saving anything', r.ok === false && state.saved.length === 0 && state.renamed.length === 0);
  t('tried twice and stopped', chamadas === 2 && r.tentativas === 2);
  t('each attempt started from the original bytes', vistos.length === 2 && vistos.every((v) => v === 62));
  t('error forbids offering a previous version', /não ofereça "versão anterior"/.test(r.error));
  t('library still has the canonical file intact',
    state.lib.length === 1 && state.lib[0].caption === 'Matriz.xlsx'
    && JSON.parse(state.files['u/1'].toString()).rows === 62);
}

// Removal that the instruction ASKED for: the sub-agent declares it and passes on the first try.
{
  const { state, deps } = mkFake();
  const rem = {
    ...deps,
    runEditor: async ({ path }) => {
      state.sandbox[path] = Buffer.from(JSON.stringify({ rows: 12, sheets: 2 }));
      return 'apaguei as 50 linhas canceladas. REMOCAO_INTENCIONAL';
    },
  };
  const r = await editSpreadsheet({ userId: 'user-rem', objetivo: 'apague as linhas canceladas', deps: rem });
  t('declared removal passes on the first try',
    r.ok === true && r.tentativas === 1 && state.saved.length === 1);
  t('notice asks the user for confirmation', r.avisos.some((a) => a.includes('de propósito')));
}

// Failure to rename the old version does not invalidate the edit (the new asset already exists).
{
  const { state, deps } = mkFake({ renameAsset: async () => { throw new Error('db off'); } });
  const r = await editSpreadsheet({ userId: 'user-ren', objetivo: 'muda', deps });
  t('rename fails but the edit still counts', r.ok === true && state.saved.length === 1 && r.arquivada === null);
}

// ── 8) Objetivo vazio ──
{
  const { deps } = mkFake();
  const r = await editSpreadsheet({ userId: 'user-v', objetivo: '   ', deps });
  t('empty objective rejected', r.ok === false);
}

// ── 9) OVERLAPPING edits from the same user: the second one starts from the result of
// the first (no lost update). This is the case of a turn arriving mid-turn.
{
  const { state, deps } = mkFake();
  const lento = {
    ...deps,
    runEditor: async (a) => { await new Promise((r) => setTimeout(r, 25)); return deps.runEditor(a); },
  };
  const [r1, r2] = await Promise.all([
    editSpreadsheet({ userId: 'user-race', objetivo: 'acrescente 4 linhas', deps: lento }),
    editSpreadsheet({ userId: 'user-race', objetivo: 'acrescente outras 4', deps: lento }),
  ]);
  t('both edits passed', r1.ok === true && r2.ok === true);
  t('the second started from the first (62→66→70)',
    r1.after.rows === 66 && r2.before.rows === 66 && r2.after.rows === 70);
  t('two new versions, canonical name on both',
    state.saved.length === 2 && state.saved.every((s) => s.caption === 'Matriz.xlsx'));
  t('history with distinct names',
    state.renamed.length === 2 && state.renamed[0][1] !== state.renamed[1][1]);
  const canonicos = state.lib.filter((a) => a.caption === 'Matriz.xlsx');
  t('only ONE row keeps the canonical name', canonicos.length === 1 && canonicos[0].id === 3);
}

// ── 10) Internal file parts: lost content is an ERROR, metadata is a notice ──
// The classification was MEASURED (openpyxl round-trip on a real spreadsheet): saving
// via openpyxl always discards customXml/, docMetadata/ and sharedStrings.xml —
// if that were an error, a spreadsheet coming from Excel would be uneditable. But losing
// xl/drawings/ or xl/media/ is a chart/image that disappeared (this really
// happens when Pillow is missing) and must fail the check.
{
  const before = {
    parts: ['xl/workbook.xml', 'xl/charts/chart1.xml', 'xl/media/image1.png',
            'customXml/item1.xml', 'docMetadata/LabelInfo.xml', 'xl/sharedStrings.xml'],
  };
  const soAcessorio = { parts: ['xl/workbook.xml', 'xl/charts/chart1.xml', 'xl/media/image1.png'] };
  const p1 = pecasPerdidas(before, soAcessorio);
  t('Office metadata does not count as content', p1.conteudo.length === 0 && p1.acessorias.length === 3);
  const semImagem = { parts: ['xl/workbook.xml', 'customXml/item1.xml', 'docMetadata/LabelInfo.xml', 'xl/sharedStrings.xml'] };
  const p2 = pecasPerdidas(before, semImagem);
  t('lost chart and image count as content',
    p2.conteudo.length === 2 && p2.conteudo.some((n) => n.includes('media')) && p2.conteudo.some((n) => n.includes('chart')));
  t('without a parts list the check stays silent',
    pecasPerdidas({ rows: 10 }, { rows: 10 }).conteudo.length === 0);

  const prob = detectarProblema({
    before: { rows: 10, sheets: 1, ...before },
    after: { rows: 10, sheets: 1, ...semImagem },
    resumo: 'mudei a celula B2',
  });
  t('content loss becomes a problem (redo)', !!prob && /peça\(s\) interna\(s\)/.test(prob.motivo));
  t('retry instruction mentions Pillow', !!prob && /Pillow/.test(prob.instrucao));
  t('metadata-only loss does NOT become a problem',
    detectarProblema({
      before: { rows: 10, sheets: 1, ...before },
      after: { rows: 10, sheets: 1, ...soAcessorio },
      resumo: 'mudei a celula B2',
    }) === null);
}

// ── 10b) data_only=True flattening formula into value ──
{
  const base = { rows: 40, sheets: 2, parts: ['xl/workbook.xml'] };
  const prob = detectarProblema({
    before: { ...base, formulas: 30 },
    after: { ...base, formulas: 3 },
    resumo: 'atualizei a coluna de status',
  });
  t('flattened formula becomes a problem', !!prob && /fórmulas/.test(prob.motivo));
  t('retry instruction mentions data_only', !!prob && /data_only/.test(prob.instrucao));
  t('small formula drop does not fail',
    detectarProblema({ before: { ...base, formulas: 30 }, after: { ...base, formulas: 28 }, resumo: 'ok' }) === null);
  t('spreadsheet without formulas does not trigger the check',
    detectarProblema({ before: { ...base, formulas: 2 }, after: { ...base, formulas: 0 }, resumo: 'ok' }) === null);
  t('declared removal allows the formula drop',
    detectarProblema({ before: { ...base, formulas: 30 }, after: { ...base, formulas: 1 }, resumo: 'apaguei a aba de cálculo. REMOCAO_INTENCIONAL' }) === null);
}

// ── 11) Clarification channel ──
{
  t('sentinel detected', pedeClarificacao('PRECISO_DE_CLARIFICACAO: qual das duas abas de 2026?') === 'qual das duas abas de 2026?');
  t('sentinel without accent/underscore too', !!pedeClarificacao('preciso de clarificação: qual coluna?'));
  t('normal summary does not become a question', pedeClarificacao('acrescentei 4 linhas na aba Artigos') === null);
  t('empty question still warns', !!pedeClarificacao('PRECISO_DE_CLARIFICACAO:'));
}

// ── 12) Cell evidence: parsing and verification ──
{
  const ev = parseEvidencia([
    'acrescentei 2 linhas na aba Fontes.',
    'EVIDENCIA: Fontes!A63=Bae et al.; Fontes!B63=2019',
    '- EVIDENCIA: Resumo!D2==SOMA(B2:B10)',
    'EVIDENCIA: lixo sem igual',
  ].join('\n'));
  t('parse picks up multiple evidence items', ev.length === 3);
  t('parse separates ref and value', ev[0].ref === 'Fontes!A63' && ev[0].esperado === 'Bae et al.');
  t('parse accepts formula', ev[2].ref === 'Resumo!D2' && ev[2].esperado === '=SOMA(B2:B10)');
  t('summary without evidence returns empty', parseEvidencia('mudei umas coisas').length === 0);
  t('cap of 20 evidence items', parseEvidencia(
    'EVIDENCIA: ' + Array.from({ length: 30 }, (_, i) => `A${i + 1}=${i}`).join('; ')).length === 20);

  const c = (ref, over) => ({ ref, exists: true, value: '', formula: null, ...over });
  const bom = conferirEvidencia(
    [{ ref: 'A1', esperado: '1234,50' }, { ref: 'A2', esperado: 'Bae et al.' }],
    [c('A1', { value: 1234.5 }), c('A2', { value: 'Bae et al. (2019)' })],
  );
  t('pt-BR number matches float', bom.erros.length === 0 && bom.conferidas === 2);
  const pct = conferirEvidencia([{ ref: 'B1', esperado: '15%' }], [c('B1', { value: 0.15 })]);
  t('percentage matches the fraction', pct.erros.length === 0);
  const ruim = conferirEvidencia([{ ref: 'A1', esperado: '999' }], [c('A1', { value: 12 })]);
  t('different value is an error', ruim.erros.length === 1);
  const vazia = conferirEvidencia([{ ref: 'A9', esperado: 'x' }], [c('A9', { exists: false })]);
  t('empty cell in the saved file is an error', vazia.erros.length === 1 && /VAZIA/.test(vazia.erros[0]));
  const semAba = conferirEvidencia([{ ref: 'Nova!A1', esperado: 'x' }], [{ ref: 'Nova!A1', noSheet: true }]);
  t('nonexistent sheet is an error', semAba.erros.length === 1);
  const form = conferirEvidencia(
    [{ ref: 'D2', esperado: '=SOMA(B2:B10)' }],
    [c('D2', { value: '', formula: 'SOMA(B2:B10)' })],
  );
  t('formula matches by text', form.erros.length === 0);
  const naoVer = conferirEvidencia([{ ref: 'D3', esperado: '42' }], [c('D3', { value: '', formula: 'B3*C3' })]);
  t('unrecalculated formula value goes to not-verifiable',
    naoVer.erros.length === 0 && naoVer.naoVerificaveis.length === 1);
  const data = conferirEvidencia([{ ref: 'E1', esperado: '01/03/2026' }], [c('E1', { value: '46082' })]);
  t('date vs Excel serial is not an error', data.erros.length === 0 && data.naoVerificaveis.length === 1);
  // Date-formatted cell (reader sends `date`): pt and en spellings are checked, a wrong date is an error.
  const fmt = conferirEvidencia(
    [{ ref: 'E2', esperado: '09/10/2026' }, { ref: 'E3', esperado: '10/09/2026' }, { ref: 'E4', esperado: '08/10/2026' }],
    [c('E2', { value: '46304', date: '2026-10-09' }), c('E3', { value: '46304', date: '2026-10-09' }), c('E4', { value: '46304', date: '2026-10-09' })],
  );
  t('date-formatted cell is verified by date', fmt.conferidas === 2 && fmt.erros.length === 1 && fmt.naoVerificaveis.length === 0);
}

// ── 13) End-to-end evidence: cell error redoes; lack of evidence
// delivers with a caveat (not burning the user's tokens and not delivering nothing).
{
  // Harness with parts/formulas/cells: the "spreadsheet" is JSON { rows, sheets, cells }.
  const mkRico = (over = {}) => {
    const state = {
      lib: [{ id: 1, caption: 'Real.xlsx', mime: XLSX_MIME, s3_key: 'u/1', created_at: '2026-09-09T17:00:00Z' }],
      files: { 'u/1': Buffer.from(JSON.stringify({ rows: 62, sheets: 2, cells: {} })) },
      sandbox: {}, saved: [], renamed: [], nextId: 2,
    };
    const deps = {
      listAssets: async () => state.lib.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      getAsset: async (_u, id) => state.lib.find((a) => String(a.id) === String(id)) || null,
      fetchBytes: async (key) => ({ buffer: state.files[key], contentType: XLSX_MIME }),
      loadIntoSandbox: async (_u, buf, name) => {
        const path = `/workspace/planilhas/${name}`;
        state.sandbox[path] = Buffer.from(buf);
        return { ok: true, path, filename: name };
      },
      readBytes: async (_u, p) => (state.sandbox[p] ? { ok: true, buffer: state.sandbox[p] } : { ok: false, error: 'nao achei' }),
      inspect: (buf) => {
        const j = JSON.parse(buf.toString('utf8'));
        return { rows: j.rows, sheets: j.sheets, text: '', parts: ['xl/workbook.xml'], formulas: 0 };
      },
      readCells: (buf, refs) => {
        const j = JSON.parse(buf.toString('utf8'));
        return refs.map((ref) => (Object.prototype.hasOwnProperty.call(j.cells, ref)
          ? { ref, exists: true, value: j.cells[ref], formula: null }
          : { ref, exists: false, value: '', formula: null }));
      },
      saveAsset: async ({ buffer, caption, mime }) => {
        const id = state.nextId++;
        state.files[`u/${id}`] = Buffer.from(buffer);
        state.lib.push({ id, caption, mime, s3_key: `u/${id}`, created_at: `2026-09-09T18:0${id}:00Z` });
        state.saved.push({ id, caption });
        return { url: `https://x/u/${id}`, key: `u/${id}`, assetId: id };
      },
      renameAsset: async (_u, id, caption) => { state.renamed.push([id, caption]); return true; },
      ...over,
    };
    return { state, deps };
  };

  // (a) evidence matches: passes on one attempt and the notice says it verified.
  {
    const { state, deps } = mkRico({
      runEditor: async ({ path }) => {
        const j = JSON.parse(state.sandbox[path].toString('utf8'));
        j.rows += 1; j.cells['Fontes!A63'] = 'Bae et al.';
        state.sandbox[path] = Buffer.from(JSON.stringify(j));
        return 'acrescentei 1 linha\nEVIDENCIA: Fontes!A63=Bae et al.';
      },
    });
    const r = await editSpreadsheet({ userId: 'ev-ok', objetivo: 'acrescente Bae et al.', deps });
    t('correct evidence passes on the first try', r.ok === true && r.tentativas === 1);
    t('reported how many cells it verified', r.evidencia?.conferidas === 1 && r.avisos.some((a) => /Conferido por código/.test(a)));
    t('saved an asset', state.saved.length === 1);
  }

  // (b) lying evidence: redoes from the original and gives up without saving.
  {
    const { state, deps } = mkRico({
      runEditor: async ({ path }) => {
        const j = JSON.parse(state.sandbox[path].toString('utf8'));
        j.rows += 1; j.cells['Fontes!A63'] = 'outra coisa';
        state.sandbox[path] = Buffer.from(JSON.stringify(j));
        return 'acrescentei 1 linha\nEVIDENCIA: Fontes!A63=Bae et al.';
      },
    });
    const r = await editSpreadsheet({ userId: 'ev-bad', objetivo: 'acrescente Bae et al.', deps });
    t('evidence that does not match fails', r.ok === false && r.tentativas === 2);
    t('nothing saved when evidence never matches', state.saved.length === 0 && state.renamed.length === 0);
    t('error explains the cell does not match', /não conferem no arquivo salvo/.test(r.error));
    t('error still forbids offering a previous version', /não ofereça "versão anterior"/.test(r.error));
  }

  // (c) no evidence: asks on the 2nd attempt and, if it doesn't come, saves with a caveat.
  {
    let vistas = 0;
    const { state, deps } = mkRico({
      runEditor: async ({ path, objetivo }) => {
        vistas++;
        if (vistas === 2) t('2nd attempt explicitly asks for evidence', /EVIDENCIA/.test(objetivo));
        const j = JSON.parse(state.sandbox[path].toString('utf8'));
        j.rows += 1;
        state.sandbox[path] = Buffer.from(JSON.stringify(j));
        return 'mudei o que foi pedido';
      },
    });
    const r = await editSpreadsheet({ userId: 'ev-none', objetivo: 'muda algo', deps });
    t('without evidence it still delivers', r.ok === true && r.tentativas === 2);
    t('delivers with a not-verified caveat', r.avisos.some((a) => /não.*conferir célula a célula/i.test(a)));
    t('saved even without proof', state.saved.length === 1 && state.saved[0].caption === 'Real.xlsx');
  }

  // (d) clarification: does not save, does not retry, returns the question.
  {
    let chamadas = 0;
    const { state, deps } = mkRico({
      runEditor: async () => { chamadas++; return 'PRECISO_DE_CLARIFICACAO: tem duas abas 2026, qual delas?'; },
    });
    const r = await editSpreadsheet({ userId: 'ev-amb', objetivo: 'atualize a aba de 2026', deps });
    t('clarification saves nothing', r.ok === false && state.saved.length === 0);
    t('clarification does not spend the 2nd attempt', chamadas === 1);
    t('question goes back to the main agent', /qual delas/.test(r.clarificacao || ''));
  }
}

// ── beforeEdit: a spreadsheet linked to Google Sheets is edited from what came from there ──
{
  const { state, deps } = mkFake();
  state.files['u/7'] = Buffer.from(JSON.stringify({ rows: 70, sheets: 2 }));
  const pulled = { id: 7, caption: 'Matriz.xlsx', mime: XLSX_MIME, s3_key: 'u/7', created_at: '2026-09-09T17:30:00Z' };
  let seen = null;
  deps.beforeEdit = async (a) => { seen = a.id; return { asset: pulled, note: 'came from Google Sheets\n' }; };
  const r = await editSpreadsheet({ userId: 'user-sync', objetivo: 'acrescente 4 linhas', deps });
  t('beforeEdit gets the picked spreadsheet', seen === 1);
  t('the edit starts from the version beforeEdit returned', r.ok && r.before.rows === 70 && r.after.rows === 74);
  t('that version is the one archived', state.renamed.length === 1 && state.renamed[0][0] === 7);
  t('the sync note goes to the model', r.avisos[0] === 'came from Google Sheets');
}

// ── afterEdit: the saved version is handed over to go back to Google Sheets ──
{
  const { deps } = mkFake();
  let sent = null;
  deps.afterEdit = async (a) => { sent = a; return { note: 'sent to Google Sheets\n' }; };
  const r = await editSpreadsheet({ userId: 'user-push', objetivo: 'acrescente 4 linhas', deps });
  t('afterEdit gets the new version', sent && sent.id === r.asset.id && sent.s3_key === r.asset.key && sent.caption === 'Matriz.xlsx');
  t('its note goes to the model', r.avisos.includes('sent to Google Sheets'));
  deps.afterEdit = async () => { throw new Error('quota'); };
  const r2 = await editSpreadsheet({ userId: 'user-push', objetivo: 'acrescente 4 linhas', deps });
  t('a failing afterEdit does not undo the edit', r2.ok && r2.avisos.some((a) => a.includes('quota')));
}

// The editor has the whole sandbox: another loaded copy it writes (2026-10-28: the
// rows meant for one spreadsheet went into another) is put back, saved edit or not.
for (const [caso, mexeNoAlvo] of [['saved', true], ['rejected', false]]) {
  const userId = `user-other-${caso}`;
  const outro = '/workspace/planilhas/To-Do.xlsx';
  const { state, deps } = mkFake({ runEditor: async ({ path }) => {
    if (mexeNoAlvo) {
      const j = JSON.parse(state.sandbox[path].toString('utf8'));
      j.rows += 4;
      state.sandbox[path] = Buffer.from(JSON.stringify(j));
    }
    state.sandbox[outro] = Buffer.from(JSON.stringify({ rows: 9, sheets: 1 }));
    return 'acrescentei 4 linhas';
  } });
  const writes = [];
  deps.writeBytes = async (_u, path, buf) => { writes.push(path); state.sandbox[path] = Buffer.from(buf); return { ok: true }; };
  state.sandbox[outro] = Buffer.from(JSON.stringify({ rows: 5, sheets: 1 }));
  withSheetThread('t1', () => registerLoadedSheet(userId, { path: outro, filename: 'To-Do.xlsx', assetId: 99 }));
  const r = await editSpreadsheet({ userId, objetivo: 'acrescente 4 linhas', deps });
  t(`${caso} edit: the other loaded copy is put back`, JSON.parse(state.sandbox[outro].toString()).rows === 5 && writes.length === 1);
  t(`${caso} edit: the model hears it was undone`, mexeNoAlvo ? r.ok && r.avisos.some((a) => a.includes('"To-Do.xlsx"')) : !r.ok && r.error.includes('"To-Do.xlsx"'));
  t(`${caso} edit: the copy keeps the conversation it was loaded in`, getLoadedSheets(userId).find((e) => e.path === outro)?.threadId === 't1');
}

// An analysis only reads: whatever loaded copy the analyst wrote, the analyzed one
// included, is put back, and the model hears it.
{
  const userId = 'user-analysis';
  const box = { '/workspace/planilhas/Gastos.xlsx': Buffer.from('gastos'), '/workspace/planilhas/To-Do.xlsx': Buffer.from('todo') };
  const io = { readBytes: async (_u, p) => (box[p] ? { ok: true, buffer: box[p] } : { ok: false }), writeBytes: async (_u, p, b) => { box[p] = Buffer.from(b); return { ok: true }; } };
  for (const p of Object.keys(box)) registerLoadedSheet(userId, { path: p, filename: p.split('/').pop() });
  const text = await analyzeKeepingCopies(userId, io, async () => { box['/workspace/planilhas/Gastos.xlsx'] = Buffer.from('x'); box['/workspace/planilhas/To-Do.xlsx'] = Buffer.from('y'); return 'total 10'; });
  t('analysis: every loaded copy the analyst changed is put back', box['/workspace/planilhas/Gastos.xlsx'].toString() === 'gastos' && box['/workspace/planilhas/To-Do.xlsx'].toString() === 'todo');
  t('analysis: the model hears it, the answer stays', text.startsWith('total 10') && text.includes('"Gastos.xlsx"') && text.includes('"To-Do.xlsx"'));
  t('analysis that changes nothing: answer as it was', await analyzeKeepingCopies(userId, io, async () => 'total 10') === 'total 10');
}

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
