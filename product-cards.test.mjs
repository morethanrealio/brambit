import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductCards, productOfferKey } from './web/product-cards.mjs';

function setup(overrides = {}) {
  const attachments = [], emitted = [];
  const cards = createProductCards({ attachments, onAttachment: card => emitted.push(card),
    imageServed: async url => !url.includes('dead'), productImageFromPage: async () => null,
    cacheProductImage: async url => `/cached/${url.split('/').at(-1)}`, ...overrides });
  return { cards, attachments, emitted };
}
const offer = (id, image = `https://img.example/${id}.jpg`) => ({ nome: `Produto ${id}`, link: `https://shop.example/product/${id}`, imagem: image, detalhe: 'R$ 25' });

test('bad image followed by tool retry produces one card, not a duplicate', async () => {
  const s = setup();
  const out = await s.cards.tool.run({ produtos: [offer('a'), offer('b', 'https://img.example/dead')] });
  assert.match(out, /2 produto/); assert.match(out, /sem foto/);
  const repaired = await s.cards.tool.run({ produtos: [{ nome: 'Produto b', link: offer('b').link }] });
  assert.match(repaired, /já estão/);
  assert.equal(s.attachments.length, 2); assert.equal(s.emitted.length, 2);
  assert.equal(s.attachments[1].image, undefined);
});

test('media exceptions and fallback failure still deliver entire ordered batch', async () => {
  const s = setup({ imageServed: async () => { throw Error('timeout'); }, productImageFromPage: async () => { throw Error('blocked'); } });
  await s.cards.tool.run({ produtos: [offer('a'), offer('b'), offer('c')] });
  assert.deepEqual(s.emitted.map(c => c.title), ['Produto a', 'Produto b', 'Produto c']);
  assert.ok(s.emitted.every(c => !c.image));
});

test('concurrent explicit selections and retries share same per-turn identity', async () => {
  const s = setup();
  await Promise.all([s.cards.tool.run({ produtos: [offer('a'), offer('a')] }), s.cards.tool.run({ produtos: [offer('a'), offer('b')] })]);
  assert.deepEqual(s.emitted.map(c => c.title), ['Produto a', 'Produto b']);
  const nextTurn = setup(); await nextTurn.cards.tool.run({ produtos: [offer('a')] }); assert.equal(nextTurn.emitted.length, 1);
});

test('offer identity ignores tracking but preserves seller and variant', async () => {
  assert.equal(productOfferKey('https://s.example/p?variant=1&utm_source=x#top'), productOfferKey('https://s.example/p?variant=1'));
  assert.notEqual(productOfferKey('https://s.example/p?variant=1'), productOfferKey('https://s.example/p?variant=2'));
  assert.notEqual(productOfferKey('https://s.example/p?seller=1'), productOfferKey('https://s.example/p?seller=2'));
  assert.equal(productOfferKey('javascript:alert(1)'), null);
  const s = setup(); await s.cards.render([{ nome: 'bad', link: 'javascript:alert(1)' }, offer('a')]);
  assert.equal(s.emitted.length, 1);
});

test('source image fallback resolves before batch emission', async () => {
  const resolved = [];
  const s = setup({ imageServed: async url => !url.endsWith('dead'),
    productImageFromPage: async link => { resolved.push(link); return 'https://img.example/fallback.jpg'; },
    onAttachment: () => { assert.equal(resolved.length, 2); } });
  await s.cards.render([offer('a', 'https://img.example/dead'), offer('b', 'https://img.example/dead')]);
  assert.ok(s.attachments.every(c => c.image === '/cached/fallback.jpg'));
});
