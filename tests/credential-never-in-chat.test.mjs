// A revoked credential is NEVER requested in the chat.
// Bug: upon detecting a revoked Notion/Splitwise token, the tool itself told the
// assistant to ask for the new key pasted into the conversation — the secret ended up recorded in the
// message history. The guidance has to be the Vault / OAuth screen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const fontes = ['web/connectors-vault.mjs', 'web/server.mjs'];
// "cole/colar/manda a chave ... aqui no chat" in an instruction to the user.
const PROIBE_NO_CHAT = /(nunca|não)\s+(peça|pedir|solicite)\s+(pra|para)\s+(col(ar|e)|mand(ar|e)|envi(ar|e))[^.\n]{0,80}(chave|token|api key)[^.\n]{0,80}no chat/i;
const PEDE_NO_CHAT = /(col(ar|e|ando)|mand(ar|e|a)|envi(ar|e))[^.\n]{0,80}(chave|token|api key)[^.\n]{0,80}(aqui no chat|no chat)/i;

for (const f of fontes) {
  test(`${f} does not instruct asking for a credential in the chat`, () => {
    const linhas = readFileSync(f, 'utf8').split('\n');
    const ruins = linhas
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => PEDE_NO_CHAT.test(l))
      // "se ele colar a chave no chat por conta própria" is the tolerated case
      .filter(([, l]) => !/por conta própria/i.test(l))
      // the prohibition ("NUNCA peça pra colar o token no chat") is also tolerated
      .filter(([, l]) => !PROIBE_NO_CHAT.test(l));
    assert.deepEqual(ruins, [], `lines asking for a secret in the chat: ${JSON.stringify(ruins)}`);
  });
}

test('invalid credential message points to the Vault', () => {
  const src = readFileSync('web/connectors-vault.mjs', 'utf8');
  for (const nome of ['NOTION_BAD', 'SW_BAD', 'ASAAS_BAD']) {
    // Text that cites the brand became a function (read at time of use): `const X = () => [`.
    const i = Math.max(src.indexOf(`const ${nome} = [`), src.indexOf(`const ${nome} = () => [`));
    assert.ok(i > 0, `${nome} not found`);
    const bloco = src.slice(i, src.indexOf('].join(', i));
    assert.match(bloco, /Cofre de credenciais/i, `${nome} does not point to the Vault`);
  }
});
