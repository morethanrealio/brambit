// Teste offline da EDIÇÃO de planilha por código (web/planilha-edit.mjs).
// Sem banco, sem S3, sem sandbox: todas as dependências entram por `deps`, e a
// planilha é um buffer fake. Roda com: node planilha-edit.test.mjs
//
// O que este teste protege (o incidente de 09/09/2026): planilha grande sendo
// reescrita a partir de uma chamada truncada perdia linhas e gravava o marcador
// de corte como dado. Os casos abaixo cobrem os mecanismos que impedem isso —
// guarda do marcador, atomicidade (falha não gera asset), versão anterior
// preservada com nome de histórico, e serialização de edições encavaladas.

const {
  editSpreadsheet, pickSheetAsset, versionedCaption, hasCutMarker,
  describeDelta, detectarProblema, declarouRemocao, withKeyLock, isSheetAsset,
  pecasPerdidas, pedeClarificacao, parseEvidencia, conferirEvidencia,
} = await import('./web/planilha-edit.mjs');

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── 1) Marcador de corte ──
t('marcador de corte detectado', hasCutMarker('linha a\n…[cortado: 74123 chars]…\nlinha b'));
t('marcador com espaco tambem', hasCutMarker('x …[cortado:74123 chars]… y'));
t('texto normal nao acusa', !hasCutMarker('| Autor | Ano |\n| Bae | 2019 |'));
t('nao-string nao quebra', !hasCutMarker(null) && !hasCutMarker(12));

// ── 2) Escolha do asset: o mais RECENTE é a versão válida ──
const assets = [
  { id: 9, caption: 'Matriz de artigos.xlsx', mime: XLSX_MIME, s3_key: 'u/9', created_at: '2026-09-09T18:30:00Z' },
  { id: 8, caption: 'foto.jpg', mime: 'image/jpeg', s3_key: 'u/8', created_at: '2026-09-09T18:00:00Z' },
  { id: 7, caption: 'Matriz de artigos.xlsx', mime: XLSX_MIME, s3_key: 'u/7', created_at: '2026-09-09T17:00:00Z' },
];
t('pega a planilha mais recente', pickSheetAsset(assets).asset.id === 9);
t('pula anexo que nao e planilha', pickSheetAsset([assets[1], assets[2]]).asset.id === 7);
t('id explicito respeitado', pickSheetAsset(assets, { id: 7 }).asset.id === 7);
t('id inexistente da erro', !!pickSheetAsset(assets, { id: 99 }).error);
t('id de nao-planilha da erro', !!pickSheetAsset(assets, { id: 8 }).error);
t('biblioteca sem planilha da erro', !!pickSheetAsset([assets[1]]).error);
t('lista vazia da erro', !!pickSheetAsset([]).error && !!pickSheetAsset(null).error);
t('detecta planilha por extensao sem mime', isSheetAsset({ caption: 'x.xlsx' }));
t('nao confunde docx com planilha', !isSheetAsset({ caption: 'x.docx', mime: 'application/msword' }));

// ── 3) Nome da versão arquivada ──
t('versao arquivada usa aaaammddhhmmss',
  versionedCaption('Matriz de artigos.xlsx', '2026-09-09T17:04:05Z') === 'Matriz de artigos_20260909170405.xlsx');
t('preserva extensao xlsm',
  versionedCaption('a.xlsm', '2026-01-02T03:04:05Z') === 'a_20260102030405.xlsm');
t('sem extensao ainda funciona',
  versionedCaption('planilha', '2026-01-02T03:04:05Z') === 'planilha_20260102030405');
t('data invalida cai pro id',
  versionedCaption('a.xlsx', 'nao-e-data', { id: 7 }) === 'a_v7.xlsx');
t('nome canonico nunca vira o arquivado',
  versionedCaption('a.xlsx', '2026-01-02T03:04:05Z') !== 'a.xlsx');

// ── 4) Delta e detecção de falha SILENCIOSA (xlsx válido, conteúdo perdido) ──
t('delta descreve crescimento', describeDelta({ rows: 62, sheets: 2 }, { rows: 66, sheets: 2 }).includes('62 → 66 (+4)'));
t('delta sem mudanca de contagem', describeDelta({ rows: 62, sheets: 1 }, { rows: 62, sheets: 1 }).includes('sem mudança'));
const prob = (b, a, resumo = '', identical = false) =>
  detectarProblema({ before: { rows: b }, after: { rows: a, text: resumo === 'TEXTO' ? 'x' : (resumo || '') }, resumo, identical });
t('encolhimento grande e problema', !!prob(62, 21));
t('encolhimento pequeno passa', !prob(62, 60));
t('planilha minuscula nao dispara', !prob(6, 2));
t('marcador como dado e problema',
  !!detectarProblema({ before: { rows: 62 }, after: { rows: 62, text: 'ART-07,…[cortado: 400 chars]…' }, resumo: '' }));
t('arquivo identico e problema', !!detectarProblema({ before: { rows: 62 }, after: { rows: 62, text: '' }, resumo: '', identical: true }));
t('resultado bom nao gera problema', !detectarProblema({ before: { rows: 62 }, after: { rows: 66, text: 'ok' }, resumo: 'acrescentei 4' }));
t('remocao declarada e aceita',
  !detectarProblema({ before: { rows: 62 }, after: { rows: 12, text: 'ok' }, resumo: 'removi as canceladas. REMOCAO_INTENCIONAL' }));
t('declaracao com acento tambem vale', declarouRemocao('feito: REMOÇÃO_INTENCIONAL'));
t('declaracao nao aceita marcador de corte',
  !!detectarProblema({ before: { rows: 62 }, after: { rows: 12, text: '…[cortado: 9 chars]…' }, resumo: 'REMOCAO_INTENCIONAL' }));
t('problema traz instrucao de correcao', typeof prob(62, 21).instrucao === 'string' && prob(62, 21).instrucao.length > 20);

// ── 5) Fila por chave (edições encavaladas não se sobrepõem) ──
{
  const ordem = [];
  const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = withKeyLock('k1', async () => { ordem.push('a-in'); await dorme(30); ordem.push('a-out'); });
  const b = withKeyLock('k1', async () => { ordem.push('b-in'); await dorme(1); ordem.push('b-out'); });
  await Promise.all([a, b]);
  t('segunda edicao espera a primeira TERMINAR',
    ordem.join(',') === 'a-in,a-out,b-in,b-out');

  // Falha na primeira não pode travar a fila pra sempre.
  const p1 = withKeyLock('k2', async () => { throw new Error('boom'); }).catch(() => 'erro');
  const p2 = withKeyLock('k2', async () => 'segunda rodou');
  t('falha na fila nao trava a proxima', (await p1) === 'erro' && (await p2) === 'segunda rodou');

  // Chaves diferentes (usuários diferentes) rodam em paralelo.
  const marcas = [];
  await Promise.all([
    withKeyLock('u1', async () => { marcas.push('u1-in'); await dorme(20); marcas.push('u1-out'); }),
    withKeyLock('u2', async () => { marcas.push('u2-in'); await dorme(1); marcas.push('u2-out'); }),
  ]);
  t('usuarios diferentes nao se bloqueiam', marcas.indexOf('u2-out') < marcas.indexOf('u1-out'));
}

// ── Harness de fakes pro orquestrador ──
// A "planilha" é só um buffer com um JSON dentro: { rows, sheets, cells }. O
// "sub-agente" muta esse JSON. Isso testa a orquestração (seleção, atomicidade,
// versionamento, encadeamento) sem xlsx nem sandbox de verdade.
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
  t('edicao ok', r.ok === true);
  t('gravou UM asset novo', state.saved.length === 1);
  t('asset novo mantem o nome canonico', state.saved[0].caption === 'Matriz.xlsx');
  t('versao anterior foi renomeada pro historico',
    state.renamed.length === 1 && state.renamed[0][1] === 'Matriz_20260909170000.xlsx');
  t('bytes antigos NAO foram sobrescritos',
    JSON.parse(state.files['u/1'].toString()).rows === 62);
  t('bytes novos tem a mudanca',
    JSON.parse(state.files['u/2'].toString()).rows === 66);
  t('delta contado dos bytes', r.delta.includes('62 → 66 (+4)'));
  t('uma tentativa so', r.tentativas === 1);
  t('sem leitor de células, entrega com ressalva de conferência indisponível', r.avisos.some((a) => a.includes('conferência das células não está disponível')));
  t('resumo do sub-agente volta', r.resumo.includes('4 linhas'));
}

// ── 7) Atomicidade: falha em qualquer etapa NÃO gera asset e NÃO renomeia ──
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
  t(`atomico: ${nome}`, r.ok === false && !!r.error && state.saved.length === 0 && state.renamed.length === 0);
}

// Arquivo idêntico byte a byte = ninguém mexeu: não cria versão nova.
{
  let chamadas = 0;
  const { state, deps } = mkFake({ runEditor: async () => { chamadas++; return 'não achei o que mudar'; } });
  const r = await editSpreadsheet({ userId: 'user-noop', objetivo: 'muda algo', deps });
  t('no-op nao gera versao nova', r.ok === false && state.saved.length === 0 && state.renamed.length === 0);
  t('no-op foi tentado de novo antes de desistir', chamadas === 2);
}

// ── 7b) Falha SILENCIOSA (xlsx válido, conteúdo perdido) é REFEITA a partir dos
// bytes originais. Não se entrega arquivo ruim nem se manda o usuário caçar
// "versão anterior": ou a mudança sai certa, ou nada muda.
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
  t('refazendo, a edicao passa', r.ok === true && r.tentativas === 2);
  t('so UM asset gravado (o certo)',
    state.saved.length === 1 && JSON.parse(state.files['u/2'].toString()).rows === 66);
  t('2a tentativa recebeu o diagnostico do erro',
    objetivos.length === 2 && /ATENÇÃO/.test(objetivos[1]) && /21 linhas/.test(objetivos[1]));
  t('aviso conta que precisou refazer', r.avisos.some((a) => a.includes('2 tentativas')));
}

// Esgotou as tentativas: nada gravado, arquivo do usuário intacto e com o mesmo nome.
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
  t('desiste sem gravar nada', r.ok === false && state.saved.length === 0 && state.renamed.length === 0);
  t('tentou duas vezes e parou', chamadas === 2 && r.tentativas === 2);
  t('cada tentativa partiu dos bytes originais', vistos.length === 2 && vistos.every((v) => v === 62));
  t('erro proibe oferecer versao anterior', /não ofereça "versão anterior"/.test(r.error));
  t('biblioteca segue com o canonico intacto',
    state.lib.length === 1 && state.lib[0].caption === 'Matriz.xlsx'
    && JSON.parse(state.files['u/1'].toString()).rows === 62);
}

// Remoção que a instrução PEDIA: o sub-agente declara e passa de primeira.
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
  t('remocao declarada passa de primeira',
    r.ok === true && r.tentativas === 1 && state.saved.length === 1);
  t('aviso pede confirmacao ao usuario', r.avisos.some((a) => a.includes('de propósito')));
}

// Falha ao renomear a versão antiga não invalida a edição (o asset novo já existe).
{
  const { state, deps } = mkFake({ renameAsset: async () => { throw new Error('db off'); } });
  const r = await editSpreadsheet({ userId: 'user-ren', objetivo: 'muda', deps });
  t('renomeacao falha mas edicao vale', r.ok === true && state.saved.length === 1 && r.arquivada === null);
}

// ── 8) Objetivo vazio ──
{
  const { deps } = mkFake();
  const r = await editSpreadsheet({ userId: 'user-v', objetivo: '   ', deps });
  t('objetivo vazio rejeitado', r.ok === false);
}

// ── 9) Edições ENCAVALADAS do mesmo usuário: a segunda parte do resultado da
// primeira (nada de lost update). É o caso do turno que chega no meio do turno.
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
  t('as duas edicoes passaram', r1.ok === true && r2.ok === true);
  t('a segunda partiu da primeira (62→66→70)',
    r1.after.rows === 66 && r2.before.rows === 66 && r2.after.rows === 70);
  t('duas versoes novas, nome canonico nas duas',
    state.saved.length === 2 && state.saved.every((s) => s.caption === 'Matriz.xlsx'));
  t('historico com nomes distintos',
    state.renamed.length === 2 && state.renamed[0][1] !== state.renamed[1][1]);
  const canonicos = state.lib.filter((a) => a.caption === 'Matriz.xlsx');
  t('so UMA linha fica com o nome canonico', canonicos.length === 1 && canonicos[0].id === 3);
}

// ── 10) Peças internas do arquivo: conteúdo perdido é ERRO, metadado é aviso ──
// A classificação foi MEDIDA (round-trip do openpyxl em planilha real): salvar
// pelo openpyxl descarta customXml/, docMetadata/ e sharedStrings.xml sempre —
// se isso fosse erro, planilha vinda do Excel seria ineditável. Já perder
// xl/drawings/ ou xl/media/ é gráfico/imagem que desapareceu (acontece de
// verdade quando falta Pillow) e tem que reprovar.
{
  const before = {
    parts: ['xl/workbook.xml', 'xl/charts/chart1.xml', 'xl/media/image1.png',
            'customXml/item1.xml', 'docMetadata/LabelInfo.xml', 'xl/sharedStrings.xml'],
  };
  const soAcessorio = { parts: ['xl/workbook.xml', 'xl/charts/chart1.xml', 'xl/media/image1.png'] };
  const p1 = pecasPerdidas(before, soAcessorio);
  t('metadado do Office nao conta como conteudo', p1.conteudo.length === 0 && p1.acessorias.length === 3);
  const semImagem = { parts: ['xl/workbook.xml', 'customXml/item1.xml', 'docMetadata/LabelInfo.xml', 'xl/sharedStrings.xml'] };
  const p2 = pecasPerdidas(before, semImagem);
  t('grafico e imagem perdidos contam como conteudo',
    p2.conteudo.length === 2 && p2.conteudo.some((n) => n.includes('media')) && p2.conteudo.some((n) => n.includes('chart')));
  t('sem lista de pecas a checagem nao opina',
    pecasPerdidas({ rows: 10 }, { rows: 10 }).conteudo.length === 0);

  const prob = detectarProblema({
    before: { rows: 10, sheets: 1, ...before },
    after: { rows: 10, sheets: 1, ...semImagem },
    resumo: 'mudei a celula B2',
  });
  t('perda de conteudo vira problema (refaz)', !!prob && /peça\(s\) interna\(s\)/.test(prob.motivo));
  t('instrucao do retry cita Pillow', !!prob && /Pillow/.test(prob.instrucao));
  t('perda so de metadado NAO vira problema',
    detectarProblema({
      before: { rows: 10, sheets: 1, ...before },
      after: { rows: 10, sheets: 1, ...soAcessorio },
      resumo: 'mudei a celula B2',
    }) === null);
}

// ── 10b) data_only=True achatando fórmula em valor ──
{
  const base = { rows: 40, sheets: 2, parts: ['xl/workbook.xml'] };
  const prob = detectarProblema({
    before: { ...base, formulas: 30 },
    after: { ...base, formulas: 3 },
    resumo: 'atualizei a coluna de status',
  });
  t('formula achatada vira problema', !!prob && /fórmulas/.test(prob.motivo));
  t('instrucao do retry cita data_only', !!prob && /data_only/.test(prob.instrucao));
  t('queda pequena de formula nao reprova',
    detectarProblema({ before: { ...base, formulas: 30 }, after: { ...base, formulas: 28 }, resumo: 'ok' }) === null);
  t('planilha sem formula nao dispara o check',
    detectarProblema({ before: { ...base, formulas: 2 }, after: { ...base, formulas: 0 }, resumo: 'ok' }) === null);
  t('remocao declarada libera a queda de formula',
    detectarProblema({ before: { ...base, formulas: 30 }, after: { ...base, formulas: 1 }, resumo: 'apaguei a aba de cálculo. REMOCAO_INTENCIONAL' }) === null);
}

// ── 11) Canal de clarificação ──
{
  t('sentinela detectada', pedeClarificacao('PRECISO_DE_CLARIFICACAO: qual das duas abas de 2026?') === 'qual das duas abas de 2026?');
  t('sentinela sem acento/underscore tambem', !!pedeClarificacao('preciso de clarificação: qual coluna?'));
  t('resumo normal nao vira pergunta', pedeClarificacao('acrescentei 4 linhas na aba Artigos') === null);
  t('pergunta vazia ainda avisa', !!pedeClarificacao('PRECISO_DE_CLARIFICACAO:'));
}

// ── 12) Evidência de célula: parse e conferência ──
{
  const ev = parseEvidencia([
    'acrescentei 2 linhas na aba Fontes.',
    'EVIDENCIA: Fontes!A63=Bae et al.; Fontes!B63=2019',
    '- EVIDENCIA: Resumo!D2==SOMA(B2:B10)',
    'EVIDENCIA: lixo sem igual',
  ].join('\n'));
  t('parse pega multiplas evidencias', ev.length === 3);
  t('parse separa ref e valor', ev[0].ref === 'Fontes!A63' && ev[0].esperado === 'Bae et al.');
  t('parse aceita formula', ev[2].ref === 'Resumo!D2' && ev[2].esperado === '=SOMA(B2:B10)');
  t('resumo sem evidencia devolve vazio', parseEvidencia('mudei umas coisas').length === 0);
  t('teto de 20 evidencias', parseEvidencia(
    'EVIDENCIA: ' + Array.from({ length: 30 }, (_, i) => `A${i + 1}=${i}`).join('; ')).length === 20);

  const c = (ref, over) => ({ ref, exists: true, value: '', formula: null, ...over });
  const bom = conferirEvidencia(
    [{ ref: 'A1', esperado: '1234,50' }, { ref: 'A2', esperado: 'Bae et al.' }],
    [c('A1', { value: 1234.5 }), c('A2', { value: 'Bae et al. (2019)' })],
  );
  t('numero pt-BR confere com float', bom.erros.length === 0 && bom.conferidas === 2);
  const pct = conferirEvidencia([{ ref: 'B1', esperado: '15%' }], [c('B1', { value: 0.15 })]);
  t('percentual confere com a fracao', pct.erros.length === 0);
  const ruim = conferirEvidencia([{ ref: 'A1', esperado: '999' }], [c('A1', { value: 12 })]);
  t('valor diferente eh erro', ruim.erros.length === 1);
  const vazia = conferirEvidencia([{ ref: 'A9', esperado: 'x' }], [c('A9', { exists: false })]);
  t('celula vazia no arquivo salvo eh erro', vazia.erros.length === 1 && /VAZIA/.test(vazia.erros[0]));
  const semAba = conferirEvidencia([{ ref: 'Nova!A1', esperado: 'x' }], [{ ref: 'Nova!A1', noSheet: true }]);
  t('aba inexistente eh erro', semAba.erros.length === 1);
  const form = conferirEvidencia(
    [{ ref: 'D2', esperado: '=SOMA(B2:B10)' }],
    [c('D2', { value: '', formula: 'SOMA(B2:B10)' })],
  );
  t('formula confere por texto', form.erros.length === 0);
  const naoVer = conferirEvidencia([{ ref: 'D3', esperado: '42' }], [c('D3', { value: '', formula: 'B3*C3' })]);
  t('valor de formula nao recalculada vai pra nao-verificavel',
    naoVer.erros.length === 0 && naoVer.naoVerificaveis.length === 1);
  const data = conferirEvidencia([{ ref: 'E1', esperado: '01/03/2026' }], [c('E1', { value: '46082' })]);
  t('data vs serial do Excel nao eh erro', data.erros.length === 0 && data.naoVerificaveis.length === 1);
}

// ── 13) Evidência ponta a ponta: erro de célula refaz; falta de evidência
// entrega com ressalva (não queimar token do usuário e não entregar nada).
{
  // Harness com peças/fórmulas/células: a "planilha" é JSON { rows, sheets, cells }.
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

  // (a) evidência bate: passa numa tentativa e o aviso diz que conferiu.
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
    t('evidencia correta passa de primeira', r.ok === true && r.tentativas === 1);
    t('relatou quantas celulas conferiu', r.evidencia?.conferidas === 1 && r.avisos.some((a) => /Conferido por código/.test(a)));
    t('gravou um asset', state.saved.length === 1);
  }

  // (b) evidência mentirosa: refaz do original e desiste sem gravar.
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
    t('evidencia que nao confere reprova', r.ok === false && r.tentativas === 2);
    t('nada gravado quando a evidencia nunca confere', state.saved.length === 0 && state.renamed.length === 0);
    t('erro explica que a celula nao bate', /não conferem no arquivo salvo/.test(r.error));
    t('erro segue proibindo oferecer versao anterior', /não ofereça "versão anterior"/.test(r.error));
  }

  // (c) sem evidência: pede na 2ª tentativa e, se não vier, grava com ressalva.
  {
    let vistas = 0;
    const { state, deps } = mkRico({
      runEditor: async ({ path, objetivo }) => {
        vistas++;
        if (vistas === 2) t('2a tentativa pede evidencia explicitamente', /EVIDENCIA/.test(objetivo));
        const j = JSON.parse(state.sandbox[path].toString('utf8'));
        j.rows += 1;
        state.sandbox[path] = Buffer.from(JSON.stringify(j));
        return 'mudei o que foi pedido';
      },
    });
    const r = await editSpreadsheet({ userId: 'ev-none', objetivo: 'muda algo', deps });
    t('sem evidencia ainda entrega', r.ok === true && r.tentativas === 2);
    t('entrega com ressalva de nao-conferido', r.avisos.some((a) => /não.*conferir célula a célula/i.test(a)));
    t('gravou mesmo sem prova', state.saved.length === 1 && state.saved[0].caption === 'Real.xlsx');
  }

  // (d) clarificação: não grava, não repete tentativa, devolve a pergunta.
  {
    let chamadas = 0;
    const { state, deps } = mkRico({
      runEditor: async () => { chamadas++; return 'PRECISO_DE_CLARIFICACAO: tem duas abas 2026, qual delas?'; },
    });
    const r = await editSpreadsheet({ userId: 'ev-amb', objetivo: 'atualize a aba de 2026', deps });
    t('clarificacao nao grava nada', r.ok === false && state.saved.length === 0);
    t('clarificacao nao gasta a 2a tentativa', chamadas === 1);
    t('pergunta volta pro agente principal', /qual delas/.test(r.clarificacao || ''));
  }
}

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
