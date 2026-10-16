import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CORE_LOCALES_DIR, createI18n, localeLayers, matchLanguage, parseAcceptLanguage, readCatalogDir, resolveLanguage} from '../web/i18n.mjs';
import {checkCatalogs} from '../test-support/i18n-guard.mjs';
import {conferirPlugin} from '../web/plugins.mjs';

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

test('core catalogs pass the guard', () => {
  assert.deepEqual(checkCatalogs([CORE_LOCALES_DIR]).errors, []);
});

test('guard: extra key and placeholder drift fail; missing key and extra plural form do not', () => {
  const dir = dirWith({
    'en.json': {a: {hello: 'Hi {name}', items_one: '{count} item', items_other: '{count} items', bye: 'Bye'}},
    'pl.json': {a: {hello: 'Cześć {imie}', items_few: '{count} elementy', extra: 'x'}},
  });
  const {errors, missing} = checkCatalogs([dir]);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /a\.hello uses \{imie\}/);
  assert.match(errors.join('\n'), /a\.extra is not in en/);
  assert.match(missing.join('\n'), /a\.bye/);
});

test('fallback pt-BR -> pt -> en -> key, and unknown languages get English', () => {
  const dir = dirWith({
    'en.json': {s: {one: 'one', two: 'two', three: 'three'}},
    'pt.json': {s: {two: 'dois'}},
    'pt-BR.json': {s: {one: 'um'}},
  });
  const {t, languages} = createI18n({layers: [dir]});
  assert.deepEqual(languages, ['en', 'pt', 'pt-BR']);
  assert.deepEqual(['one', 'two', 'three', 'four'].map((k) => t(`s.${k}`, 'pt-br')), ['um', 'dois', 'three', 's.four']);
  assert.equal(t('s.one', 'xx'), 'one');
  assert.equal(t('s.one', 'not a tag!'), 'one');
});

test('plural forms follow the language rules, not count === 1', () => {
  const dir = dirWith({
    'en.json': {files_one: '{count} file', files_other: '{count} files'},
    'ru.json': {files_one: '{count} файл', files_few: '{count} файла', files_many: '{count} файлов', files_other: '{count} файла'},
  });
  const {t} = createI18n({layers: [dir]});
  assert.deepEqual([1, 2, 5, 21].map((count) => t('files', 'ru', {count})), ['1 файл', '2 файла', '5 файлов', '21 файл']);
  assert.deepEqual([1, 2].map((count) => t('files', 'en', {count})), ['1 file', '2 files']);
});

test('variables are plain text and are not re-read as placeholders', () => {
  const dir = dirWith({'en.json': {greet: 'Hi {name}'}});
  const {t} = createI18n({layers: [dir]});
  assert.equal(t('greet', 'en', {name: '<b>{x}</b> $t(greet)'}), 'Hi <b>{x}</b> $t(greet)');
});

test('layers: plugin over instance overlay over core; each layer may be partial', () => {
  const core = dirWith({'en.json': {k: {a: 'core a', b: 'core b', c: 'core c'}}});
  const overlay = dirWith({'en.json': {k: {b: 'overlay b', c: 'overlay c'}}});
  const plugin = dirWith({'en.json': {k: {c: 'plugin c'}}, 'de.json': {k: {a: 'plugin de a'}}});
  const layers = localeLayers({coreDir: core, overlayDir: overlay, plugins: [{nome: 'p', locales: [plugin]}]});
  assert.deepEqual(layers, [core, overlay, plugin]);
  const {t, languages} = createI18n({layers});
  assert.deepEqual(['a', 'b', 'c'].map((k) => t(`k.${k}`, 'en')), ['core a', 'overlay b', 'plugin c']);
  assert.equal(t('k.b', 'de'), 'overlay b');
  assert.deepEqual(languages, ['de', 'en']);
});

test('a broken catalog fails at load', () => {
  assert.throws(() => readCatalogDir(dirWith({'pt-br.json': {}})), /canonical form/);
  assert.throws(() => readCatalogDir(dirWith({'en.json': '{'})), /invalid JSON/);
  assert.throws(() => createI18n({layers: [dirWith({'en.json': {a: [1]}})]}), /a must be text or an object/);
  assert.deepEqual(readCatalogDir(path.join(os.tmpdir(), 'no-such-i18n-dir')), {});
});

test('language resolution: saved, channel, Accept-Language, instance default', () => {
  const supported = ['en', 'es', 'pt-BR'];
  assert.deepEqual(parseAcceptLanguage('fr;q=0.5, pt-PT, es;q=0.8, de;q=0'), ['pt-PT', 'es', 'fr']);
  assert.equal(matchLanguage('pt-PT', supported), 'pt-BR');
  assert.equal(matchLanguage('es-AR', supported), 'es');
  assert.equal(matchLanguage('fr', supported), null);
  assert.equal(resolveLanguage({saved: 'es', channel: 'pt-BR', acceptLanguage: 'en', supported}), 'es');
  assert.equal(resolveLanguage({saved: 'fr', channel: 'pt-BR', supported}), 'pt-BR');
  assert.equal(resolveLanguage({acceptLanguage: 'fr, pt;q=0.9', supported}), 'pt-BR');
  assert.equal(resolveLanguage({acceptLanguage: 'fr', instanceDefault: 'pt-BR', supported}), 'pt-BR');
  assert.equal(resolveLanguage({supported}), 'en');
});

test('plugin locales field takes absolute folders only', () => {
  assert.doesNotThrow(() => conferirPlugin({nome: 'p', locales: [path.resolve('x')]}));
  assert.throws(() => conferirPlugin({nome: 'p', locales: ['x']}), /locales/);
});
