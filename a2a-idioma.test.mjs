// Conversa entre assistentes: cada lado fala no idioma do PRÓPRIO dono. Em
// pt-BR o corpo do prompt não muda um byte (o JSON segue pedindo "em pt-BR");
// a diretriz de idioma entra no fim, igual aos outros sub-agentes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { systemA, systemB } from './web/agent2agent.mjs';
import { comIdioma } from './web/locale.mjs';

const baseA = { ownerAName: 'Ana', agentA: { name: 'Mara' }, ownerBName: 'Bruno', objetivo: 'marcar um café', ownerAProfileText: '' };
const baseB = { ownerBName: 'Bruno', agentB: { name: 'Kim' }, ownerAName: 'Ana', ownerBPublicText: '' };

test('pt-BR: corpo dos prompts de A e B igual com e sem idioma', () => {
  for (const language of [undefined, null, 'pt-BR']) {
    const a = systemA({ ...baseA, language });
    const b = systemB({ ...baseB, language });
    assert.equal(a, systemA(baseA));
    assert.equal(b, systemB(baseB));
    assert.match(a, /"mensagem":"<your short message in pt-BR>"/);
    assert.match(b, /short question in pt-BR>"/);
  }
});

test('en/es: o JSON pede o idioma do dono e a diretriz entra no fim', () => {
  for (const language of ['en', 'es']) {
    const a = comIdioma(systemA({ ...baseA, language }), language);
    const b = comIdioma(systemB({ ...baseB, language }), language);
    assert.match(a, new RegExp(`your short message in ${language}>`));
    assert.match(b, new RegExp(`short question in ${language}>`));
    assert.ok(a.startsWith(systemA({ ...baseA, language })) && a.length > systemA({ ...baseA, language }).length);
    assert.ok(b.length > systemB({ ...baseB, language }).length);
  }
});
