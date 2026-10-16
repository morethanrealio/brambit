// editar_arquivo has to write the LITERAL replacement (finding #20).
//
// The bug: `content.replace(busca, troca)` with a STRING replacement makes the regex engine
// interpret the substitution patterns ($$, $&, $`, $'), so a snippet of
// Makefile/shell/PHP with "$$" was written as "$" and the tool still replied
// "Editado". Here the transport is faked (no real SSH/HTTP): a mini
// in-memory file system returns the `cat` and captures what was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DEVEXEC_URL = 'http://runner.invalido';
process.env.DEVEXEC_TOKEN = 'token-de-teste';

const { codingTools } = await import('../web/coding.mjs');

const fonte = fs.readFileSync(new URL('../web/coding.mjs', import.meta.url), 'utf8');

// ── fake transport ──────────────────────────────────────────────────────
// Understands only the two commands that editar_arquivo emits: the `cat` and the
// base64 write. Any other command is an explicit error (the test cannot pass
// by accident).
function montarRunner(arquivos) {
  const gravados = {};
  globalThis.fetch = async (_url, opts) => {
    const { cmd } = JSON.parse(opts.body);
    let m = /^cat '(.+)'$/.exec(cmd);
    if (m) {
      const conteudo = arquivos[m[1]];
      if (conteudo == null) return resposta({ ok: false, exit: 1, stderr: 'No such file' });
      return resposta({ ok: true, exit: 0, saida: conteudo });
    }
    m = /^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '(.+)\.brambs\.tmp' && mv -f '.+' '(.+)' && echo OK$/.exec(cmd);
    if (m) {
      gravados[m[3]] = Buffer.from(m[1], 'base64').toString('utf8');
      return resposta({ ok: true, exit: 0, saida: 'OK' });
    }
    throw new Error(`comando inesperado: ${cmd}`);
  };
  return gravados;
}
const resposta = (corpo) => ({ status: 200, text: async () => JSON.stringify(corpo) });

function editarArquivo() {
  const tools = codingTools('u1', { project: { ownerUserId: 'u1', nome: 'proj' } });
  const t = tools.find((x) => x.name === 'editar_arquivo');
  assert.ok(t, 'editar_arquivo must exist in project mode');
  return t;
}

async function editar({ antes, busca, troca }) {
  const gravados = montarRunner({ '/work/a.txt': antes });
  const out = JSON.parse(await editarArquivo().run({ caminho: '/work/a.txt', busca, troca }));
  return { out, gravado: gravados['/work/a.txt'] };
}

// ── comportamento ───────────────────────────────────────────────────────────

test('$$ from Makefile/shell arrives intact in the file', async () => {
  const troca = 'echo $$PID && make FOO=$$(BAR)';
  const { out, gravado } = await editar({ antes: 'linha 1\nALVO\nlinha 3\n', busca: 'ALVO', troca });
  assert.equal(out.ok, true);
  assert.equal(gravado, `linha 1\n${troca}\nlinha 3\n`);
  assert.ok(gravado.includes('$$PID'), 'the $$ must not turn into $');
});

test('$& does not repeat the searched snippet', async () => {
  const { gravado } = await editar({ antes: 'a SENHA b\n', busca: 'SENHA', troca: 'preco: R$& taxa' });
  assert.equal(gravado, 'a preco: R$& taxa b\n');
  assert.ok(!gravado.includes('R$SENHA'), '$& must not expand to the search term');
});

test("$` and $' do not bring the rest of the file into the replacement", async () => {
  const antes = 'antes\nALVO\ndepois\n';
  const { gravado } = await editar({ antes, busca: 'ALVO', troca: "x=$` y=$' z=$1" });
  assert.equal(gravado, "antes\nx=$` y=$' z=$1\ndepois\n");
  assert.ok(!gravado.includes('antes\nx=antes'), '$` must not turn into the file prefix');
});

test('the search is also literal: regex characters do not become metacharacters', async () => {
  const { out, gravado } = await editar({ antes: 'const re = a.b(c)+d;\n', busca: 'a.b(c)+d', troca: 'ok' });
  assert.equal(out.ok, true);
  assert.equal(gravado, 'const re = ok;\n');
});

test('missing or repeated snippet keeps being refused, without writing anything', async () => {
  const ausente = await editar({ antes: 'nada aqui\n', busca: 'ALVO', troca: 'x' });
  assert.equal(ausente.out.ok, false);
  assert.match(ausente.out.error, /Não achei o trecho/);
  assert.equal(ausente.gravado, undefined);

  const repetido = await editar({ antes: 'ALVO e ALVO\n', busca: 'ALVO', troca: 'x' });
  assert.equal(repetido.out.ok, false);
  assert.match(repetido.out.error, /2x/);
  assert.equal(repetido.gravado, undefined);
});

test('the line count in the return matches what was written', async () => {
  const { out, gravado } = await editar({ antes: 'a\nALVO\nb\n', busca: 'ALVO', troca: 'x\ny\nz' });
  assert.match(out.saida, /\+2 linhas/);
  assert.equal(gravado.split('\n').length, 6);
});

// ── fonte ───────────────────────────────────────────────────────────────────

test('the source does not go back to using replace with a substitution string', () => {
  assert.ok(!/\.replace\(busca, troca\)/.test(fonte), 'replace(busca, troca) reintroduced');
  assert.match(fonte, /content\.split\(busca\)\.join\(troca\)/);
});
