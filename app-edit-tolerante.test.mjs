// ── Edição de app sem exigir byte a byte ──────────────────────────────────────
// Item 3 das frustrações de 16/09: o editor de app exigia que o trecho_antigo
// casasse EXATAMENTE, e o construtor entrava em loop de reler/tentar/ser
// recusado. A medição em produção (12 recusas reais do caso âncora) mostrou que
// TODAS as 12 eram diferença de espaço/quebra de linha, com semelhança entre
// 93,9% e 96,7%. As três peças verificadas aqui:
//   1. resolverAncora (web/app-anchor.mjs): ancora por semelhança ≥90%, com
//      margem sobre o segundo lugar e corpo mínimo. Prova de segurança: trecho
//      de OUTRO arquivo e trecho ambíguo continuam recusados.
//   2. pioraSintaxe (web/app-syntax.mjs): a gravação só passa se o arquivo
//      compilar. Nunca bloqueia o que já estava quebrado antes.
//   3. Freio anti-loop (web/app-task-runner.mjs): a releitura que vem logo
//      depois de uma edição RECUSADA não conta como teimosia (teto de 3).
// Tudo offline: nenhum SSH, nenhum banco, nenhum app de usuário.
import { dominioDosApps, urlDoApp } from './web/appshost.mjs';
import { linkDaPagina, marca } from './web/marca.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { filePage } from './core-proto/file-page.mjs';
import { validateDraft, validationPage, draftRevision } from './web/app-draft-validation.mjs';
import { searchAppCode } from './web/app-code-search.mjs';
import { rejectedEdit } from './web/coding-effects.mjs';
import { resolverAncora, LIMIAR_PADRAO, CORPO_MINIMO } from './web/app-anchor.mjs';
import { pioraSintaxe, checarSintaxe } from './web/app-syntax.mjs';
import { ToolRegistry } from './core-proto/core.mjs';
import { runAppTask } from './web/app-task-runner.mjs';

const b64 = s => Buffer.from(s).toString('base64');
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

const SERVIDOR = `const express = require('express');
const app = express();

app.get('/api/plantas', async (req, res) => {
  const linhas = await db.all('SELECT * FROM plantas ORDER BY nome');
  res.json({ ok: true, plantas: linhas });
});

app.post('/api/rega', async (req, res) => {
  const { planta_id, quando } = req.body || {};
  if (!planta_id) return res.status(400).json({ erro: 'planta_id obrigatório' });
  await db.run('INSERT INTO regas (planta_id, quando) VALUES (?, ?)', planta_id, quando);
  res.json({ ok: true });
});

module.exports = app;
`;

// ── 1. Âncora por semelhança ────────────────────────────────────────────────
test('âncora resolve a diferença de espaço/quebra de linha que causava a recusa', () => {
  // O jeito como o modelo erra na vida real: indentação a mais, espaço depois
  // da vírgula, aspas trocadas, uma linha em branco que sumiu.
  const variacoes = [
    "app.post('/api/rega', async (req, res) => {\n    const { planta_id, quando } = req.body || {};",
    "app.post('/api/rega', async (req,res) => {\n  const { planta_id, quando } = req.body || {};",
    "app.post('/api/rega', async (req, res) => {\n  const {planta_id, quando} = req.body || {};",
  ];
  for (const trecho of variacoes) {
    const r = resolverAncora(SERVIDOR, trecho);
    assert.equal(r.ok, true, `deveria ancorar: ${JSON.stringify(trecho)}`);
    assert.ok(r.similaridade >= LIMIAR_PADRAO);
    assert.ok(r.trecho_no_arquivo.includes("app.post('/api/rega'"));
    // A âncora cobre linhas inteiras, então a troca não corta o arquivo no meio.
    assert.equal(SERVIDOR[r.inicio - 1], '\n');
    assert.ok(r.fim === SERVIDOR.length || SERVIDOR[r.fim] === '\n');
  }
});

test('trecho idêntico ancora com similaridade 1', () => {
  const trecho = "  const linhas = await db.all('SELECT * FROM plantas ORDER BY nome');";
  const r = resolverAncora(SERVIDOR, trecho);
  assert.equal(r.ok, true);
  assert.equal(r.similaridade, 1);
  assert.equal(SERVIDOR.slice(r.inicio, r.fim), trecho);
});

test('âncora NÃO aceita trecho de outro arquivo nem trecho ambíguo nem trecho curto demais', () => {
  // Segurança 1: código que não é deste arquivo.
  const outro = "function desenharCarta(ctx, carta) {\n  ctx.fillStyle = '#fff';\n  ctx.fillRect(carta.x, carta.y, 60, 90);\n}";
  assert.equal(resolverAncora(SERVIDOR, outro).ok, false);
  // Segurança 2: o mesmo bloco duas vezes no arquivo = não dá pra adivinhar.
  const repetido = SERVIDOR + '\n' + SERVIDOR;
  const r = resolverAncora(repetido, "app.get('/api/plantas', async (req, res) => {");
  assert.equal(r.ok, false);
  assert.ok(['ambiguo', 'sem_candidato'].includes(r.motivo));
  // Segurança 3: corpo mínimo, senão "}" ancoraria em qualquer lugar.
  assert.equal(resolverAncora(SERVIDOR, '}').motivo, 'corpo_insuficiente');
  assert.equal(resolverAncora(SERVIDOR, '  });').motivo, 'corpo_insuficiente');
  assert.ok(CORPO_MINIMO >= 12);
  // Entradas degeneradas não explodem.
  assert.equal(resolverAncora(SERVIDOR, '').ok, false);
  assert.equal(resolverAncora(null, 'x').ok, false);
});

test('mudança de verdade no código (não só espaço) fica abaixo do limiar', () => {
  // 90% tolera espaço; não tolera trocar a lógica. Aqui o "trecho_antigo" cita
  // uma tabela/coluna que não existe no arquivo: tem que recusar.
  const inventado = "  const linhas = await db.all('SELECT id, apelido FROM jardim WHERE ativo = 1 ORDER BY criado_em DESC');";
  const r = resolverAncora(SERVIDOR, inventado);
  assert.equal(r.ok, false);
  assert.ok(r.melhor_similaridade === undefined || r.melhor_similaridade < LIMIAR_PADRAO);
});

// ── 2. Portão de sintaxe ────────────────────────────────────────────────────
test('portão de sintaxe: bloqueia só quando a edição QUEBRA um arquivo íntegro', async () => {
  const quebrado = SERVIDOR.replace('res.json({ ok: true });', 'res.json({ ok: true );');
  const piora = await pioraSintaxe('server.js', SERVIDOR, quebrado);
  assert.ok(piora, 'edição que quebra tem que ser barrada');
  assert.match(piora.erro, /SyntaxError|Error/);
  assert.ok(!piora.erro.includes('/tmp/'), 'o erro não pode vazar caminho temporário');
  // Já estava quebrado antes: a edição pode ser justamente o conserto.
  assert.equal(await pioraSintaxe('server.js', quebrado, quebrado.replace('40', '41')), null);
  assert.equal(await pioraSintaxe('server.js', quebrado, SERVIDOR), null);
  // Edição boa passa.
  assert.equal(await pioraSintaxe('server.js', SERVIDOR, SERVIDOR + '\n// nota\n'), null);
});

test('portão de sintaxe entende CommonJS, ESM e JSON, e pula o que não sabe parsear', async () => {
  assert.equal((await checarSintaxe('server.js', "const a = require('x');\nmodule.exports = { a };")).estado, 'ok');
  assert.equal((await checarSintaxe('public/app.js', "import x from 'y';\nexport const a = 1;")).estado, 'ok');
  assert.equal((await checarSintaxe('a.json', '{"a":1}')).estado, 'ok');
  assert.equal((await checarSintaxe('a.json', '{"a":}')).estado, 'erro');
  // HTML/CSS não têm parser aqui: não inventa veredito.
  assert.equal((await checarSintaxe('index.html', '<div>')).estado, 'pulado');
  assert.equal((await checarSintaxe('estilo.css', 'body {')).estado, 'pulado');
  assert.equal(await pioraSintaxe('index.html', '<div>', '<div'), null);
});

// ── 3. As duas peças costuradas na tool real (hosting.mjs) ──────────────────
// Carrega o hosting de verdade com os imports trocados por dublês: nenhum SSH,
// nenhum banco. Só putAppDraftFile é observado, pra provar o que foi gravado.
function hostFixture(arquivos) {
  const conteudo = { ...arquivos };
  let gravacoes = 0, externo = 0;
  const src = fs.readFileSync('web/hosting.mjs', 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export \{[^\n]+\};?\n/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const ctx = vm.createContext({ Buffer, console, process: { env: {} }, Date, Map, Set, URL, zlib,
    createHash: crypto.createHash, randomBytes: () => Buffer.alloc(12),
    filePage, validateDraft, validationPage, draftRevision, searchAppCode, rejectedEdit, resolverAncora, pioraSintaxe,
    countLines: s => s.split('\n').length, lintAppB64: () => { throw Error('publicação não faz parte deste teste'); },
    dominioDosApps, urlDoApp, linkDaPagina, marca, hostingEnabled: () => true, ctl: async () => { externo++; throw Error('SSH proibido'); },
    getAppRow: async (u, s) => (u === 'u1' && s === 'demo' ? { system: s, agent_id: 'agent' } : null),
    getAppDraft: async () => ({ ...conteudo }), getAppSnapshot: async () => null,
    resolveConnectedUser: async () => ({ ok: false }), isAppCollaborator: async () => false,
    listSharedAppsForCollaborator: async () => [], listAppDraftSystems: async () => [],
    listAppsForUser: async () => [{ system: 'demo', agent_id: 'agent' }], listAgents: async () => [],
    ensureUserSubdomain: async () => { externo++; throw Error('alocação proibida'); },
    putAppDraftFile: async (_u, _s, p, c) => { gravacoes++; conteudo[p] = c; } });
  vm.runInContext(src + "\nresolveLabel=async()=>({label:'fixture',name:'Fixture'});globalThis.actual=hostingTools('u1','agent');", ctx);
  const tool = n => ctx.actual.find(t => t.name === n);
  return { conteudo, tool, texto: p => Buffer.from(conteudo[p], 'base64').toString('utf8'),
    get gravacoes() { return gravacoes; }, get externo() { return externo; } };
}

test('editar_arquivo_do_app grava mesmo com espaço fora do lugar, e avisa que ancorou', async () => {
  const f = hostFixture({ 'server.js': b64(SERVIDOR) });
  const r = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: "  if (!planta_id) return res.status(400).json({ erro: 'planta_id obrigatório' });",
    trecho_novo: "  if (!planta_id) return res.status(400).json({ erro: 'informe a planta' });" });
  assert.equal(r.ok, true);
  assert.equal(f.gravacoes, 1);
  assert.ok(f.texto('server.js').includes('informe a planta'));
  assert.equal(f.texto('server.js').includes('planta_id obrigatório'), false);
  assert.equal(f.externo, 0);

  // Mesmo trecho, agora com indentação errada e espaço a mais: tem que gravar
  // e declarar no recibo que a âncora foi aproximada (o modelo precisa saber).
  const g = hostFixture({ 'server.js': b64(SERVIDOR) });
  const r2 = await g.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: "    if (!planta_id)  return res.status(400).json({ erro: 'planta_id obrigatório' });",
    trecho_novo: "  if (!planta_id) return res.status(400).json({ erro: 'informe a planta' });" });
  assert.equal(r2.ok, true);
  assert.equal(g.gravacoes, 1);
  assert.equal(r2.ancora_aproximada.length, 1);
  assert.ok(r2.ancora_aproximada[0].similaridade >= LIMIAR_PADRAO);
  assert.ok(g.texto('server.js').includes('informe a planta'));
  assert.equal(g.texto('server.js').includes('planta_id obrigatório'), false);
});

test('editar_arquivo_do_app não grava arquivo que passaria a ter erro de sintaxe', async () => {
  const f = hostFixture({ 'server.js': b64(SERVIDOR) });
  const r = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: '  res.json({ ok: true, plantas: linhas });',
    trecho_novo: '  res.json({ ok: true, plantas: linhas );' });
  assert.equal(r.ok, false);
  assert.equal(f.gravacoes, 0);
  assert.match(r.error, /sintaxe/i);
  assert.ok(r.erro_de_sintaxe);
  assert.deepEqual(r.effect, { version: 1, state: 'not_applied', operation: 'file_edit' });
});

test('arquivo que já estava quebrado pode ser consertado (o portão nunca trava o conserto)', async () => {
  const quebrado = SERVIDOR.replace('res.json({ ok: true });', 'res.json({ ok: true );');
  const f = hostFixture({ 'server.js': b64(quebrado) });
  const r = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: '  res.json({ ok: true );', trecho_novo: '  res.json({ ok: true });' });
  assert.equal(r.ok, true);
  assert.equal(f.gravacoes, 1);
  assert.equal((await checarSintaxe('server.js', f.texto('server.js'))).estado, 'ok');
});

test('as recusas que continuam valendo: trecho inexistente e trecho ambíguo', async () => {
  const f = hostFixture({ 'server.js': b64(SERVIDOR) });
  const inexistente = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: "app.delete('/api/usuario/:id', autenticado, async (req, res) => {", trecho_novo: '// nada' });
  assert.equal(inexistente.ok, false);
  assert.match(inexistente.error, /não encontrado/);
  const ambiguo = hostFixture({ 'server.js': b64(SERVIDOR + '\n' + SERVIDOR) });
  const r = await ambiguo.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: "app.get('/api/plantas', async (req, res) => {", trecho_novo: "app.get('/api/plantas2', async (req, res) => {" });
  assert.equal(r.ok, false);
  assert.equal(f.gravacoes, 0);
  assert.equal(ambiguo.gravacoes, 0);
});

// ── 4. Freio anti-loop: releitura pós-recusa não é teimosia ─────────────────
const HTML = '<html>\n<div id="alpha">A</div>\n<div id="beta">B</div>\n<div id="gamma">C</div>\n</html>';
function runnerFixture() {
  const arquivos = { 'public/index.html': b64(HTML) };
  let recusas = 0, gravacoes = 0;
  let record = { id: crypto.randomUUID(), targetIdentity: 'owner:demo', mode: 'edicao',
    objective: 'Corrigir o HTML e validar, sem publicar.', status: 'paused', history: [], calls: 0, tokens: 0,
    elapsed: 0, journal: [], evidence: [], report: [], signatures: [], progress: [], pending: null, reviewFiles: null,
    readCoverage: [{ arquivo: 'public/index.html', hash: hash(HTML), intervalos: [[0, HTML.length]], total_chars: HTML.length }] };
  const scope = JSON.stringify(['session', 'demo', '']);
  const store = { withTask: async (k, fn) => fn({ id: hash(k), record: structuredClone(record), save: async r => { record = structuredClone(r); } }) };
  const tools = new ToolRegistry();
  tools.add({ name: 'listar_arquivos_do_app', parameters: {}, run: async () => ({ ok: true, alvo_validacao: 'owner:demo', revisao: draftRevision(arquivos), arquivos: [{ caminho: 'public/index.html', hash: hash(HTML) }] }) });
  tools.add({ name: 'buscar_codigo_do_app', parameters: {}, run: async args => searchAppCode(arquivos, args) });
  tools.add({ name: 'editar_arquivo_do_app', parameters: {}, run: async () => { recusas++; return rejectedEdit('trecho_antigo não encontrado. Nada foi gravado.'); } });
  tools.add({ name: 'escrever_arquivo_do_app', parameters: {}, run: async () => { gravacoes++; return { ok: true, arquivo: 'public/index.html', hash: hash(HTML), alvo_validacao: 'owner:demo', revisao: draftRevision(arquivos) }; } });
  tools.add({ name: 'validar_rascunho_do_app', parameters: {}, run: async () => ({ ...validateDraft(arquivos), alvo_validacao: 'owner:demo' }) });
  return { read: () => store.withTask(scope, async ({ record: r }) => r), get recusas() { return recusas; }, get gravacoes() { return gravacoes; },
    run: provider => runAppTask({ store, scope, mode: 'edicao', objetivo: 'Continue', userRequest: 'Continue', system: 'synthetic', tools, provider }) };
}
const chamada = (name, args, id) => ({ id, name, args });
const lote = (...toolCalls) => ({ stop: 'tool', toolCalls, usage: { in: 3, out: 2 } });
const busca = (texto, id) => chamada('buscar_codigo_do_app', { caminho: 'public/index.html', texto }, id);
// Cada tentativa manda um trecho_antigo diferente: é assim que o modelo erra na
// vida real (chuta outro recorte depois da recusa), e repetir a MESMA chamada
// idêntica já é barrado por outro freio (identical_call), que não é o daqui.
const edicao = id => chamada('editar_arquivo_do_app', { caminho: 'public/index.html', trecho_antigo: `<div id="${id}">`, trecho_novo: '<div>' }, id);
const fim = { stop: 'end', text: 'Pronto.', usage: { in: 3, out: 2 } };
const roteiro = passos => { let n = 0; return { get calls() { return n; }, complete: async () => passos[n++] || fim }; };

test('sem recusa no meio, três releituras sem progresso seguem interrompendo o lote', async () => {
  const f = runnerFixture();
  const out = await f.run(roteiro([lote(busca('alpha', 'a'), busca('id="alpha"', 'b'), busca('alpha">', 'c'), busca('"alpha"', 'd'))]));
  assert.equal(out.app_build.motivo, 'read_coverage_loop');
  assert.equal((await f.read()).editReadState.consecutive, 3);
});

test('a releitura logo depois de uma edição recusada não conta como loop', async () => {
  const f = runnerFixture();
  const out = await f.run(roteiro([lote(
    edicao('alpha'), busca('alpha', 'a'),
    edicao('beta'), busca('id="alpha"', 'b'),
    edicao('gamma'), busca('alpha">', 'c'),
  ), fim]));
  assert.equal(f.recusas, 3);
  assert.notEqual(out.app_build.motivo, 'read_coverage_loop');
  const saved = await f.read();
  assert.equal(saved.editReadState.consecutive, 0, 'nenhuma das releituras pode ter avançado o freio');
  // A primeira busca trouxe trecho novo (progresso de verdade), então nem
  // precisou de perdão; as duas seguintes repetiram o mesmo pedaço e foram
  // perdoadas por virem logo depois de uma recusa.
  assert.equal(saved.editReadState.pardons, 2);
});

test('o perdão tem teto: depois de três, o freio volta a valer', async () => {
  const f = runnerFixture();
  const busca_repetida = ['alpha', 'id="alpha"', 'alpha">', '"alpha"', 'div id="alpha', 'alpha">A', '="alpha"', 'alpha">A<'];
  const passos = busca_repetida.flatMap((texto, i) => [edicao(`e${i}`), busca(texto, `r${i}`)]);
  const out = await f.run(roteiro([lote(...passos)]));
  assert.equal(out.app_build.motivo, 'read_coverage_loop');
  const saved = await f.read();
  assert.equal(saved.editReadState.pardons, 3, 'o perdão para no teto');
  assert.ok(saved.editReadState.consecutive >= 3, 'depois do teto as releituras voltam a contar');
  assert.equal(f.gravacoes, 0);
});
