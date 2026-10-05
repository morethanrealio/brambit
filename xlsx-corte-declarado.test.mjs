import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDocument } from './web/docgen.mjs';

// O gerador de xlsx tem três tetos (abas, linhas por aba, colunas). Até
// 18/09/2026 os três cortavam em SILÊNCIO: o arquivo chegava ao usuário
// parecendo completo e o assistente anunciava "planilha pronta". Estes testes
// travam a regra "quem corta, avisa" na única saída que o modelo enxerga.

const planilha = (conteudo) => generateDocument({ format: 'xlsx', content: conteudo, title: 'Teste' });

test('planilha dentro dos limites não ganha aviso', async () => {
  const { buffer, aviso } = await planilha('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(buffer.length > 0);
  assert.equal(aviso, null);
});

test('abas acima do teto são contadas no aviso', async () => {
  const md = Array.from({ length: 25 }, (_, i) => `# Aba ${i + 1}\n\n| x |\n|---|\n| ${i} |`).join('\n\n');
  const { buffer, aviso } = await planilha(md);
  assert.ok(buffer.length > 0, 'o arquivo ainda é gerado, só que declarado incompleto');
  assert.match(aviso, /5 aba\(s\)/);
  assert.match(aviso, /INCOMPLETA/);
});

test('colunas acima do teto são contadas no aviso', async () => {
  const cabec = `| ${Array.from({ length: 205 }, (_, i) => `c${i}`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(205)}`;
  const { aviso } = await planilha(`${cabec}\n${sep}\n${cabec}`);
  assert.match(aviso, /5 coluna\(s\)/);
});

test('linhas acima do teto são contadas no aviso', async () => {
  const linhas = Array.from({ length: 20003 }, (_, i) => `| ${i} |`).join('\n');
  const { aviso } = await planilha(`| n |\n|---|\n${linhas}`);
  // 20003 linhas de corpo + 1 de cabeçalho = 20004 contra o teto de 20000
  assert.match(aviso, /4 linha\(s\)/);
});

test('formato não-planilha não inventa aviso', async () => {
  const { aviso } = await generateDocument({ format: 'md', content: '# oi', title: 'x' });
  assert.ok(!aviso);
});
