// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmed } from '../web/confirm.mjs';

// 2026-09-25 frustration (two cases): the receipt for publishing a private
// app only showed "published" + link; the username and password stayed in the
// tool's return value and the model, which only repeats the receipt reference, never delivered them.
const pub = { name: 'publicar_sistema', args: { nome_do_sistema: 'whoop' } };

test('publish private: receipt carries username and password', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://mir0.brambs.com.br/whoop/', credenciais: { usuario: 'whoop', senha: 'Xy12abCD' } });
  assert.match(t, /publicado/);
  assert.match(t, /https:\/\/mir0\.brambs\.com\.br\/whoop\//);
  assert.match(t, /Usuário: whoop\nSenha: Xy12abCD/);
});

test('republish (no new credential) and public app do not show login', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://x/whoop/', acesso: 'público (qualquer pessoa com o link abre)' });
  assert.doesNotMatch(t, /Senha|privado/);
});

test('gate failed: warns the link is open, without a password', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://x/whoop/', aviso_acesso: 'FOI publicado mas não trancou' });
  assert.match(t, /ainda não conseguiu trancar/);
  assert.doesNotMatch(t, /Senha/);
});

test('access logging failed: delivers login and asks to save it', () => {
  const pubT = renderConfirmed(pub, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' }, aviso_registro_acesso: 'x' });
  assert.match(pubT, /Senha: b\n[^\n]*\nGuarde este login agora/);
  const rep = renderConfirmed({ name: 'replicar_sistema', args: {} }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' }, aviso_acesso: 'registro não confirmou' });
  assert.match(rep, /Senha: b\n[^\n]*\nGuarde este login agora/);
  assert.doesNotMatch(rep, /trancar/);
});

test("owner's language: en and es", () => {
  assert.match(renderConfirmed({ ...pub, language: 'en' }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' } }), /User: a\nPassword: b/);
  assert.match(renderConfirmed({ ...pub, language: 'es' }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' } }), /Usuario: a\nContraseña: b/);
});

test('another tool with a credentials field prints nothing', () => {
  const t = renderConfirmed({ name: 'apagar_sistema', args: { nome_do_sistema: 'z' } }, { ok: true, credenciais: { usuario: 'a', senha: 'b' } });
  assert.doesNotMatch(t, /Senha/);
});
