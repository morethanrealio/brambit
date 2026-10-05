import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmed } from './web/confirm.mjs';

// Frustração 25/09 (dois casos): o recibo de publicar app
// privado só trazia "publicado" + link; usuário e senha ficavam no retorno da
// tool e o modelo, que só repete a referência do recibo, nunca os entregava.
const pub = { name: 'publicar_sistema', args: { nome_do_sistema: 'whoop' } };

test('publicar privado: recibo traz usuário e senha', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://mir0.brambs.com.br/whoop/', credenciais: { usuario: 'whoop', senha: 'Xy12abCD' } });
  assert.match(t, /publicado/);
  assert.match(t, /https:\/\/mir0\.brambs\.com\.br\/whoop\//);
  assert.match(t, /Usuário: whoop\nSenha: Xy12abCD/);
});

test('republicar (sem credencial nova) e app público não mostram login', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://x/whoop/', acesso: 'público (qualquer pessoa com o link abre)' });
  assert.doesNotMatch(t, /Senha|privado/);
});

test('portão falhou: avisa que o link está aberto, sem senha', () => {
  const t = renderConfirmed(pub, { ok: true, url: 'https://x/whoop/', aviso_acesso: 'FOI publicado mas não trancou' });
  assert.match(t, /ainda não conseguiu trancar/);
  assert.doesNotMatch(t, /Senha/);
});

test('registro de acesso falhou: entrega login e pede pra guardar', () => {
  const pubT = renderConfirmed(pub, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' }, aviso_registro_acesso: 'x' });
  assert.match(pubT, /Senha: b\n[^\n]*\nGuarde este login agora/);
  const rep = renderConfirmed({ name: 'replicar_sistema', args: {} }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' }, aviso_acesso: 'registro não confirmou' });
  assert.match(rep, /Senha: b\n[^\n]*\nGuarde este login agora/);
  assert.doesNotMatch(rep, /trancar/);
});

test('idioma do dono: en e es', () => {
  assert.match(renderConfirmed({ ...pub, language: 'en' }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' } }), /User: a\nPassword: b/);
  assert.match(renderConfirmed({ ...pub, language: 'es' }, { ok: true, url: 'u', credenciais: { usuario: 'a', senha: 'b' } }), /Usuario: a\nContraseña: b/);
});

test('outra tool com campo credenciais não imprime nada', () => {
  const t = renderConfirmed({ name: 'apagar_sistema', args: { nome_do_sistema: 'z' } }, { ok: true, credenciais: { usuario: 'a', senha: 'b' } });
  assert.doesNotMatch(t, /Senha/);
});
