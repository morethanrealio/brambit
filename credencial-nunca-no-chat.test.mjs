// Credencial revogada NUNCA é pedida no chat.
// Bug: ao detectar token revogado de Notion/Splitwise, a própria tool mandava o
// assistente pedir a chave nova colada na conversa — o segredo ficava gravado no
// histórico de mensagens. A orientação tem que ser a tela do Cofre / OAuth.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const fontes = ['web/connectors-vault.mjs', 'web/server.mjs'];
// "cole/colar/manda a chave ... aqui no chat" em uma instrução ao usuário.
const PROIBE_NO_CHAT = /(nunca|não)\s+(peça|pedir|solicite)\s+(pra|para)\s+(col(ar|e)|mand(ar|e)|envi(ar|e))[^.\n]{0,80}(chave|token|api key)[^.\n]{0,80}no chat/i;
const PEDE_NO_CHAT = /(col(ar|e|ando)|mand(ar|e|a)|envi(ar|e))[^.\n]{0,80}(chave|token|api key)[^.\n]{0,80}(aqui no chat|no chat)/i;

for (const f of fontes) {
  test(`${f} não instrui a pedir credencial no chat`, () => {
    const linhas = readFileSync(f, 'utf8').split('\n');
    const ruins = linhas
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => PEDE_NO_CHAT.test(l))
      // "se ele colar a chave no chat por conta própria" é o caso tolerado
      .filter(([, l]) => !/por conta própria/i.test(l))
      // a proibição ("NUNCA peça pra colar o token no chat") também é tolerada
      .filter(([, l]) => !PROIBE_NO_CHAT.test(l));
    assert.deepEqual(ruins, [], `linhas pedindo segredo no chat: ${JSON.stringify(ruins)}`);
  });
}

test('mensagem de credencial inválida aponta pro Cofre', () => {
  const src = readFileSync('web/connectors-vault.mjs', 'utf8');
  for (const nome of ['NOTION_BAD', 'SW_BAD', 'ASAAS_BAD']) {
    // Texto que cita a marca virou função (lido na hora do uso): `const X = () => [`.
    const i = Math.max(src.indexOf(`const ${nome} = [`), src.indexOf(`const ${nome} = () => [`));
    assert.ok(i > 0, `${nome} não encontrada`);
    const bloco = src.slice(i, src.indexOf('].join(', i));
    assert.match(bloco, /Cofre de credenciais/i, `${nome} não manda pro Cofre`);
  }
});
