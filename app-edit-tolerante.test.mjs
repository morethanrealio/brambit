// ── App editing without requiring a byte-for-byte match ──────────────────────────────────────
// Item 3 of the 2026-09-16 frustrations: the app editor required trecho_antigo
// to match EXACTLY, and the builder would loop re-reading/retrying/getting
// refused. Measurement in production (12 real refusals from the anchor case) showed that
// ALL 12 were a space/line-break difference, with similarity between
// 93.9% and 96.7%. The three pieces verified here:
//   1. resolverAncora (web/app-anchor.mjs): anchors by similarity ≥90%, with
//      a margin over second place and a minimum body size. Safety proof: an excerpt
//      from ANOTHER file and an ambiguous excerpt are still refused.
//   2. pioraSintaxe (web/app-syntax.mjs): the write only goes through if the file
//      compiles. Never blocks what was already broken before.
//   3. Anti-loop guard (web/app-task-runner.mjs): the re-read that comes right
//      after a REFUSED edit doesn't count as stubbornness (cap of 3).
// All offline: no SSH, no database, no user app.
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

// ── 1. Similarity-based anchor ────────────────────────────────────────────────
test('anchor resolves the space/line-break difference that caused the refusal', () => {
  // The way the model gets it wrong in real life: extra indentation, a space after
  // the comma, swapped quotes, a blank line that disappeared.
  const variacoes = [
    "app.post('/api/rega', async (req, res) => {\n    const { planta_id, quando } = req.body || {};",
    "app.post('/api/rega', async (req,res) => {\n  const { planta_id, quando } = req.body || {};",
    "app.post('/api/rega', async (req, res) => {\n  const {planta_id, quando} = req.body || {};",
  ];
  for (const trecho of variacoes) {
    const r = resolverAncora(SERVIDOR, trecho);
    assert.equal(r.ok, true, `should anchor: ${JSON.stringify(trecho)}`);
    assert.ok(r.similaridade >= LIMIAR_PADRAO);
    assert.ok(r.trecho_no_arquivo.includes("app.post('/api/rega'"));
    // The anchor covers whole lines, so the swap doesn't cut the file in the middle.
    assert.equal(SERVIDOR[r.inicio - 1], '\n');
    assert.ok(r.fim === SERVIDOR.length || SERVIDOR[r.fim] === '\n');
  }
});

test('identical excerpt anchors with similarity 1', () => {
  const trecho = "  const linhas = await db.all('SELECT * FROM plantas ORDER BY nome');";
  const r = resolverAncora(SERVIDOR, trecho);
  assert.equal(r.ok, true);
  assert.equal(r.similaridade, 1);
  assert.equal(SERVIDOR.slice(r.inicio, r.fim), trecho);
});

test('anchor does NOT accept an excerpt from another file, an ambiguous excerpt, or a too-short one', () => {
  // Safety 1: code that isn't from this file.
  const outro = "function desenharCarta(ctx, carta) {\n  ctx.fillStyle = '#fff';\n  ctx.fillRect(carta.x, carta.y, 60, 90);\n}";
  assert.equal(resolverAncora(SERVIDOR, outro).ok, false);
  // Safety 2: the same block twice in the file = can't guess.
  const repetido = SERVIDOR + '\n' + SERVIDOR;
  const r = resolverAncora(repetido, "app.get('/api/plantas', async (req, res) => {");
  assert.equal(r.ok, false);
  assert.ok(['ambiguo', 'sem_candidato'].includes(r.motivo));
  // Safety 3: minimum body size, otherwise "}" would anchor anywhere.
  assert.equal(resolverAncora(SERVIDOR, '}').motivo, 'corpo_insuficiente');
  assert.equal(resolverAncora(SERVIDOR, '  });').motivo, 'corpo_insuficiente');
  assert.ok(CORPO_MINIMO >= 12);
  // Degenerate inputs don't blow up.
  assert.equal(resolverAncora(SERVIDOR, '').ok, false);
  assert.equal(resolverAncora(null, 'x').ok, false);
});

test('a real code change (not just whitespace) falls below the threshold', () => {
  // 90% tolerates whitespace; it doesn't tolerate swapping the logic. Here the "trecho_antigo" cites
  // a table/column that doesn't exist in the file: it has to be refused.
  const inventado = "  const linhas = await db.all('SELECT id, apelido FROM jardim WHERE ativo = 1 ORDER BY criado_em DESC');";
  const r = resolverAncora(SERVIDOR, inventado);
  assert.equal(r.ok, false);
  assert.ok(r.melhor_similaridade === undefined || r.melhor_similaridade < LIMIAR_PADRAO);
});

// ── 2. Syntax gate ────────────────────────────────────────────────────
test('syntax gate: only blocks when the edit BREAKS an otherwise intact file', async () => {
  const quebrado = SERVIDOR.replace('res.json({ ok: true });', 'res.json({ ok: true );');
  const piora = await pioraSintaxe('server.js', SERVIDOR, quebrado);
  assert.ok(piora, 'an edit that breaks the file has to be blocked');
  assert.match(piora.erro, /SyntaxError|Error/);
  assert.ok(!piora.erro.includes('/tmp/'), 'the error must not leak a temp path');
  // Was already broken before: the edit may be exactly the fix.
  assert.equal(await pioraSintaxe('server.js', quebrado, quebrado.replace('40', '41')), null);
  assert.equal(await pioraSintaxe('server.js', quebrado, SERVIDOR), null);
  // A good edit goes through.
  assert.equal(await pioraSintaxe('server.js', SERVIDOR, SERVIDOR + '\n// nota\n'), null);
});

test('syntax gate understands CommonJS, ESM and JSON, and skips what it cannot parse', async () => {
  assert.equal((await checarSintaxe('server.js', "const a = require('x');\nmodule.exports = { a };")).estado, 'ok');
  assert.equal((await checarSintaxe('public/app.js', "import x from 'y';\nexport const a = 1;")).estado, 'ok');
  assert.equal((await checarSintaxe('a.json', '{"a":1}')).estado, 'ok');
  assert.equal((await checarSintaxe('a.json', '{"a":}')).estado, 'erro');
  // HTML/CSS have no parser here: doesn't make up a verdict.
  assert.equal((await checarSintaxe('index.html', '<div>')).estado, 'pulado');
  assert.equal((await checarSintaxe('estilo.css', 'body {')).estado, 'pulado');
  assert.equal(await pioraSintaxe('index.html', '<div>', '<div'), null);
});

// ── 3. Both pieces stitched together in the real tool (hosting.mjs) ──────────────────
// Loads the real hosting with the imports swapped for stand-ins: no SSH,
// no database. Only putAppDraftFile is observed, to prove what was written.
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

test('editar_arquivo_do_app writes even with whitespace out of place, and reports that it anchored', async () => {
  const f = hostFixture({ 'server.js': b64(SERVIDOR) });
  const r = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: "  if (!planta_id) return res.status(400).json({ erro: 'planta_id obrigatório' });",
    trecho_novo: "  if (!planta_id) return res.status(400).json({ erro: 'informe a planta' });" });
  assert.equal(r.ok, true);
  assert.equal(f.gravacoes, 1);
  assert.ok(f.texto('server.js').includes('informe a planta'));
  assert.equal(f.texto('server.js').includes('planta_id obrigatório'), false);
  assert.equal(f.externo, 0);

  // Same excerpt, now with wrong indentation and an extra space: it has to save
  // and state in the receipt that the anchor was approximate (the model needs to know).
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

test('editar_arquivo_do_app does not write a file that would end up with a syntax error', async () => {
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

test('a file that was already broken can be fixed (the gate never blocks the fix)', async () => {
  const quebrado = SERVIDOR.replace('res.json({ ok: true });', 'res.json({ ok: true );');
  const f = hostFixture({ 'server.js': b64(quebrado) });
  const r = await f.tool('editar_arquivo_do_app').run({ nome_do_sistema: 'demo', caminho: 'server.js',
    trecho_antigo: '  res.json({ ok: true );', trecho_novo: '  res.json({ ok: true });' });
  assert.equal(r.ok, true);
  assert.equal(f.gravacoes, 1);
  assert.equal((await checarSintaxe('server.js', f.texto('server.js'))).estado, 'ok');
});

test('the refusals that still hold: nonexistent excerpt and ambiguous excerpt', async () => {
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

// ── 4. Anti-loop guard: re-read after a refusal isn't stubbornness ─────────────────
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
// Each attempt sends a different trecho_antigo: that's how the model gets it wrong in
// real life (guesses another excerpt after the refusal), and repeating the SAME
// identical call is already blocked by another guard (identical_call), which isn't this one.
const edicao = id => chamada('editar_arquivo_do_app', { caminho: 'public/index.html', trecho_antigo: `<div id="${id}">`, trecho_novo: '<div>' }, id);
const fim = { stop: 'end', text: 'Pronto.', usage: { in: 3, out: 2 } };
const roteiro = passos => { let n = 0; return { get calls() { return n; }, complete: async () => passos[n++] || fim }; };

test('with no refusal in between, three re-reads with no progress still interrupt the batch', async () => {
  const f = runnerFixture();
  const out = await f.run(roteiro([lote(busca('alpha', 'a'), busca('id="alpha"', 'b'), busca('alpha">', 'c'), busca('"alpha"', 'd'))]));
  assert.equal(out.app_build.motivo, 'read_coverage_loop');
  assert.equal((await f.read()).editReadState.consecutive, 3);
});

test('the re-read right after a refused edit does not count as a loop', async () => {
  const f = runnerFixture();
  const out = await f.run(roteiro([lote(
    edicao('alpha'), busca('alpha', 'a'),
    edicao('beta'), busca('id="alpha"', 'b'),
    edicao('gamma'), busca('alpha">', 'c'),
  ), fim]));
  assert.equal(f.recusas, 3);
  assert.notEqual(out.app_build.motivo, 'read_coverage_loop');
  const saved = await f.read();
  assert.equal(saved.editReadState.consecutive, 0, 'none of the re-reads may have advanced the brake');
  // The first search brought a new excerpt (real progress), so it didn't even
  // need forgiveness; the next two repeated the same chunk and were
  // forgiven for coming right after a refusal.
  assert.equal(saved.editReadState.pardons, 2);
});

test('forgiveness has a cap: after three, the brake kicks back in', async () => {
  const f = runnerFixture();
  const busca_repetida = ['alpha', 'id="alpha"', 'alpha">', '"alpha"', 'div id="alpha', 'alpha">A', '="alpha"', 'alpha">A<'];
  const passos = busca_repetida.flatMap((texto, i) => [edicao(`e${i}`), busca(texto, `r${i}`)]);
  const out = await f.run(roteiro([lote(...passos)]));
  assert.equal(out.app_build.motivo, 'read_coverage_loop');
  const saved = await f.read();
  assert.equal(saved.editReadState.pardons, 3, 'forgiveness stops at the cap');
  assert.ok(saved.editReadState.consecutive >= 3, 'after the cap, re-reads count again');
  assert.equal(f.gravacoes, 0);
});
