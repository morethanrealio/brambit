// A memory page with an accent/space in the name must not be overwritten (finding #18).
// Cause: there were TWO naming rules. The database swaps accent and space for a hyphen
// ("pessoa joão" -> "pessoa-joao"); wiki.mjs DELETED those characters
// ("pessoajoo"). With different names, the read got an empty page and the
// write replaced the real page, silently losing the old lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aplicarOps } from '../web/wiki.mjs';
import { normWikiSlug } from '../web/db.mjs';

const ANTIGA = '- João é o contador do escritório';

test('database name and wiki name are the same', () => {
  assert.equal(normWikiSlug('pessoa-joão'), 'pessoa-joao');
  assert.equal(normWikiSlug('pessoa joão'), 'pessoa-joao');
  assert.equal(normWikiSlug('Preferências'), 'preferencias');
});

test('add on an accented page preserves the lines that already existed', () => {
  const r = aplicarOps(
    [{ op: 'add', pagina: 'pessoa-joão', texto: 'João fecha o mês toda primeira sexta' }],
    { 'pessoa-joao': ANTIGA },
  );
  assert.deepEqual(Object.keys(r.paginas), ['pessoa-joao']);
  assert.ok(r.paginas['pessoa-joao'].includes(ANTIGA), 'the old line disappeared');
  assert.ok(r.paginas['pessoa-joao'].includes('primeira sexta'));
});

test('a space in the name lands on the same page, not on a copy', () => {
  const r = aplicarOps(
    [{ op: 'add', pagina: 'pessoa joão', texto: 'João mora em Santos desde 2019' }],
    { 'pessoa-joao': ANTIGA },
  );
  assert.deepEqual(Object.keys(r.paginas), ['pessoa-joao']);
  assert.ok(r.paginas['pessoa-joao'].includes(ANTIGA));
});

test('accented area page: fix finds the anchor on the right page', () => {
  const r = aplicarOps(
    [{ op: 'fix', pagina: 'Preferências', ancora: 'café coado', texto: 'prefere café expresso' }],
    { preferencias: '- prefere café coado de manhã' },
  );
  assert.deepEqual(r.feitas, ['fix(preferencias)']);
  assert.equal(r.paginas.preferencias, '- prefere café expresso');
});

test('remove on an accented page does not wipe out the rest', () => {
  const r = aplicarOps(
    [{ op: 'remove', pagina: 'pessoa-joão', ancora: 'contador do escritório' }],
    { 'pessoa-joao': `${ANTIGA}\n- João joga tênis aos sábados` },
  );
  assert.equal(r.paginas['pessoa-joao'], '- João joga tênis aos sábados');
});

test('no wiki path uses the old naming rule', () => {
  const src = fs.readFileSync(new URL('../web/wiki.mjs', import.meta.url), 'utf8');
  assert.ok(!/replace\(\/\[\^a-z0-9-\]\/g/.test(src),
    'there is still a place stripping accent/space instead of normalizing');
});
