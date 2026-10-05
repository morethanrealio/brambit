// editar_arquivo tem que gravar a troca LITERAL (achado #20).
//
// O bug: `content.replace(busca, troca)` com troca STRING faz o motor de regex
// interpretar os padrões de substituição ($$, $&, $`, $'), então um trecho de
// Makefile/shell/PHP com "$$" era gravado como "$" e a tool ainda respondia
// "Editado". Aqui o transporte é fingido (nenhum SSH/HTTP real): um mini
// sistema de arquivos em memória devolve o `cat` e captura o que foi gravado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DEVEXEC_URL = 'http://runner.invalido';
process.env.DEVEXEC_TOKEN = 'token-de-teste';

const { codingTools } = await import('./web/coding.mjs');

const fonte = fs.readFileSync(new URL('./web/coding.mjs', import.meta.url), 'utf8');

// ── transporte fingido ──────────────────────────────────────────────────────
// Entende só os dois comandos que editar_arquivo emite: o `cat` e a gravação
// por base64. Qualquer outro comando é erro explícito (o teste não pode passar
// por acidente).
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
  assert.ok(t, 'editar_arquivo precisa existir no modo projeto');
  return t;
}

async function editar({ antes, busca, troca }) {
  const gravados = montarRunner({ '/work/a.txt': antes });
  const out = JSON.parse(await editarArquivo().run({ caminho: '/work/a.txt', busca, troca }));
  return { out, gravado: gravados['/work/a.txt'] };
}

// ── comportamento ───────────────────────────────────────────────────────────

test('$$ de Makefile/shell chega inteiro no arquivo', async () => {
  const troca = 'echo $$PID && make FOO=$$(BAR)';
  const { out, gravado } = await editar({ antes: 'linha 1\nALVO\nlinha 3\n', busca: 'ALVO', troca });
  assert.equal(out.ok, true);
  assert.equal(gravado, `linha 1\n${troca}\nlinha 3\n`);
  assert.ok(gravado.includes('$$PID'), 'o $$ não pode virar $');
});

test('$& não repete o trecho buscado', async () => {
  const { gravado } = await editar({ antes: 'a SENHA b\n', busca: 'SENHA', troca: 'preco: R$& taxa' });
  assert.equal(gravado, 'a preco: R$& taxa b\n');
  assert.ok(!gravado.includes('R$SENHA'), '$& não pode ser expandido para a busca');
});

test("$` e $' não trazem o resto do arquivo pra dentro da troca", async () => {
  const antes = 'antes\nALVO\ndepois\n';
  const { gravado } = await editar({ antes, busca: 'ALVO', troca: "x=$` y=$' z=$1" });
  assert.equal(gravado, "antes\nx=$` y=$' z=$1\ndepois\n");
  assert.ok(!gravado.includes('antes\nx=antes'), '$` não pode virar o prefixo do arquivo');
});

test('a busca também é literal: caracteres de regex não viram metacaractere', async () => {
  const { out, gravado } = await editar({ antes: 'const re = a.b(c)+d;\n', busca: 'a.b(c)+d', troca: 'ok' });
  assert.equal(out.ok, true);
  assert.equal(gravado, 'const re = ok;\n');
});

test('trecho ausente ou repetido continua recusado, sem gravar nada', async () => {
  const ausente = await editar({ antes: 'nada aqui\n', busca: 'ALVO', troca: 'x' });
  assert.equal(ausente.out.ok, false);
  assert.match(ausente.out.error, /Não achei o trecho/);
  assert.equal(ausente.gravado, undefined);

  const repetido = await editar({ antes: 'ALVO e ALVO\n', busca: 'ALVO', troca: 'x' });
  assert.equal(repetido.out.ok, false);
  assert.match(repetido.out.error, /2x/);
  assert.equal(repetido.gravado, undefined);
});

test('a contagem de linhas do retorno bate com o que foi gravado', async () => {
  const { out, gravado } = await editar({ antes: 'a\nALVO\nb\n', busca: 'ALVO', troca: 'x\ny\nz' });
  assert.match(out.saida, /\+2 linhas/);
  assert.equal(gravado.split('\n').length, 6);
});

// ── fonte ───────────────────────────────────────────────────────────────────

test('o fonte não volta a usar replace com string de substituição', () => {
  assert.ok(!/\.replace\(busca, troca\)/.test(fonte), 'replace(busca, troca) reintroduzido');
  assert.match(fonte, /content\.split\(busca\)\.join\(troca\)/);
});
