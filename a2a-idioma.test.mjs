// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Conversation between assistants: each side speaks in its OWN owner's language. In
// pt-BR the body of the prompt doesn't change a single byte (the JSON still asks for "in pt-BR");
// the language directive goes at the end, same as the other sub-agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { systemA, systemB } from './web/agent2agent.mjs';
import { comIdioma } from './web/locale.mjs';

const baseA = { ownerAName: 'Ana', agentA: { name: 'Mara' }, ownerBName: 'Bruno', objetivo: 'marcar um café', ownerAProfileText: '' };
const baseB = { ownerBName: 'Bruno', agentB: { name: 'Kim' }, ownerAName: 'Ana', ownerBPublicText: '' };

test('pt-BR: A and B prompt bodies identical with and without language', () => {
  for (const language of [undefined, null, 'pt-BR']) {
    const a = systemA({ ...baseA, language });
    const b = systemB({ ...baseB, language });
    assert.equal(a, systemA(baseA));
    assert.equal(b, systemB(baseB));
    assert.match(a, /"mensagem":"<your short message in pt-BR>"/);
    assert.match(b, /short question in pt-BR>"/);
  }
});

test("en/es: the JSON asks for the owner's language and the directive goes at the end", () => {
  for (const language of ['en', 'es']) {
    const a = comIdioma(systemA({ ...baseA, language }), language);
    const b = comIdioma(systemB({ ...baseB, language }), language);
    assert.match(a, new RegExp(`your short message in ${language}>`));
    assert.match(b, new RegExp(`short question in ${language}>`));
    assert.ok(a.startsWith(systemA({ ...baseA, language })) && a.length > systemA({ ...baseA, language }).length);
    assert.ok(b.length > systemB({ ...baseB, language }).length);
  }
});
