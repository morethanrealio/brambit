import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPage } from './web/page-i18n.mjs';

const i18n = (texts) => ({ t: (key, language, vars = {}) => (texts[key] ?? key).replace(/\{(\w+)\}/g, (m, v) => vars[v] ?? m), keys: () => [], has: () => true });

test('child tags are placed by number and catalog text cannot add markup', () => {
  const page = '<p data-i18n="k">Click <a href="/x" class="b">here</a> and run <code>ls</code>.</p>';
  const texts = { k: 'Rode <1/> e <0>clique</0> <script>alert(1)</script> & pronto' };
  assert.equal(fillPage(page, 'pt-BR', { i18n: i18n(texts) }),
    '<p data-i18n="k">Rode <code>ls</code> e <a href="/x" class="b">clique</a> &lt;script&gt;alert(1)&lt;/script&gt; &amp; pronto</p>');
});

test('a number with no child tag keeps the source text and reports it', () => {
  const page = '<p data-i18n="k">Click <b>OK</b></p>';
  const problems = [];
  assert.equal(fillPage(page, 'pt-BR', { i18n: i18n({ k: 'Clique <1>OK</1>' }), onProblem: (p) => problems.push(p) }), page);
  assert.equal(problems.length, 1);
});

test('attributes, nested marks, texts script and <html lang>', () => {
  const page = '<html lang="en"><p data-i18n="k">Hi <img alt="logo" data-i18n-alt="alt"></p><script type="application/json" data-i18n-texts="area"></script></html>';
  const texts = { k: 'Oi <0/>', alt: 'marca "{brand}"' };
  const out = fillPage(page, 'pt-BR', { i18n: { ...i18n(texts), keys: () => ['area.x'] }, vars: { brand: 'B</script>' } });
  assert.equal(out, '<html lang="pt-BR"><p data-i18n="k">Oi <img alt="marca &quot;B&lt;/script&gt;&quot;" data-i18n-alt="alt"></p><script type="application/json" data-i18n-texts="area">{"x":"area.x"}</script></html>');
});
