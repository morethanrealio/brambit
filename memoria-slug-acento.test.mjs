// Página de memória com acento/espaço no nome não pode ser sobrescrita (achado #18).
// Causa: existiam DUAS regras de nome. O banco troca acento e espaço por hífen
// ("pessoa joão" -> "pessoa-joao"); o wiki.mjs APAGAVA esses caracteres
// ("pessoajoo"). Com nomes diferentes, a leitura pegava página vazia e a
// gravação substituía a página real, perdendo as linhas antigas em silêncio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aplicarOps } from './web/wiki.mjs';
import { normWikiSlug } from './web/db.mjs';

const ANTIGA = '- João é o contador do escritório';

test('nome do banco e nome do wiki são o mesmo', () => {
  assert.equal(normWikiSlug('pessoa-joão'), 'pessoa-joao');
  assert.equal(normWikiSlug('pessoa joão'), 'pessoa-joao');
  assert.equal(normWikiSlug('Preferências'), 'preferencias');
});

test('add numa página com acento preserva as linhas que já existiam', () => {
  const r = aplicarOps(
    [{ op: 'add', pagina: 'pessoa-joão', texto: 'João fecha o mês toda primeira sexta' }],
    { 'pessoa-joao': ANTIGA },
  );
  assert.deepEqual(Object.keys(r.paginas), ['pessoa-joao']);
  assert.ok(r.paginas['pessoa-joao'].includes(ANTIGA), 'a linha antiga sumiu');
  assert.ok(r.paginas['pessoa-joao'].includes('primeira sexta'));
});

test('espaço no nome cai na mesma página, não numa cópia', () => {
  const r = aplicarOps(
    [{ op: 'add', pagina: 'pessoa joão', texto: 'João mora em Santos desde 2019' }],
    { 'pessoa-joao': ANTIGA },
  );
  assert.deepEqual(Object.keys(r.paginas), ['pessoa-joao']);
  assert.ok(r.paginas['pessoa-joao'].includes(ANTIGA));
});

test('página de área com acento: corrigir acha a âncora na página certa', () => {
  const r = aplicarOps(
    [{ op: 'fix', pagina: 'Preferências', ancora: 'café coado', texto: 'prefere café expresso' }],
    { preferencias: '- prefere café coado de manhã' },
  );
  assert.deepEqual(r.feitas, ['fix(preferencias)']);
  assert.equal(r.paginas.preferencias, '- prefere café expresso');
});

test('remover numa página com acento não zera o resto', () => {
  const r = aplicarOps(
    [{ op: 'remove', pagina: 'pessoa-joão', ancora: 'contador do escritório' }],
    { 'pessoa-joao': `${ANTIGA}\n- João joga tênis aos sábados` },
  );
  assert.equal(r.paginas['pessoa-joao'], '- João joga tênis aos sábados');
});

test('nenhum caminho do wiki usa a regra de nome antiga', () => {
  const src = fs.readFileSync(new URL('./web/wiki.mjs', import.meta.url), 'utf8');
  assert.ok(!/replace\(\/\[\^a-z0-9-\]\/g/.test(src),
    'ainda existe um lugar apagando acento/espaço em vez de normalizar');
});
