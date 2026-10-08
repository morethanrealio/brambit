import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDocument } from '../web/docgen.mjs';

// The xlsx generator has three caps (sheets, rows per sheet, columns). Until
// 2026-09-18 all three cut SILENTLY: the file arrived to the user
// looking complete and the assistant announced "planilha pronta". These tests
// lock down the "whoever cuts, warns" rule in the one output the model sees.

const planilha = (conteudo) => generateDocument({ format: 'xlsx', content: conteudo, title: 'Teste' });

test('spreadsheet within limits gets no notice', async () => {
  const { buffer, aviso } = await planilha('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(buffer.length > 0);
  assert.equal(aviso, null);
});

test('sheets over the cap are counted in the notice', async () => {
  const md = Array.from({ length: 25 }, (_, i) => `# Aba ${i + 1}\n\n| x |\n|---|\n| ${i} |`).join('\n\n');
  const { buffer, aviso } = await planilha(md);
  assert.ok(buffer.length > 0, 'the file is still generated, just declared incomplete');
  assert.match(aviso, /5 aba\(s\)/);
  assert.match(aviso, /INCOMPLETA/);
});

test('columns over the cap are counted in the notice', async () => {
  const cabec = `| ${Array.from({ length: 205 }, (_, i) => `c${i}`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(205)}`;
  const { aviso } = await planilha(`${cabec}\n${sep}\n${cabec}`);
  assert.match(aviso, /5 coluna\(s\)/);
});

test('rows over the cap are counted in the notice', async () => {
  const linhas = Array.from({ length: 20003 }, (_, i) => `| ${i} |`).join('\n');
  const { aviso } = await planilha(`| n |\n|---|\n${linhas}`);
  // 20003 body rows + 1 header row = 20004 against the cap of 20000
  assert.match(aviso, /4 linha\(s\)/);
});

test('non-spreadsheet format does not invent a notice', async () => {
  const { aviso } = await generateDocument({ format: 'md', content: '# oi', title: 'x' });
  assert.ok(!aviso);
});
