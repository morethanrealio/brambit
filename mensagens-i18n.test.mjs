// Testes do i18n das MENSAGENS do servidor. Como no site, o que se prova aqui
// não é qualidade de tradução: é que a resposta em português sai exatamente
// igual à de hoje, e que nada além de `error` e `message` é tocado.
//
// A diferença de mecanismo em relação ao site importa e está testada: lá o
// catálogo é SUBSTITUÍDO dentro do fonte da página; aqui é uma BUSCA no mapa
// com a string já pronta na mão. Por isso nenhum teste aqui se preocupa com
// aspa ou crase na tradução, e sim com chave que não existe mais no código.
//
// rodar: node mensagens-i18n.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiMensagens, traduzMensagem, traduzResposta, idiomaDaRequisicao, FONTES_MENSAGENS } from './web/mensagens-i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, 'web');

let ok = 0, falhas = 0;
const t = (nome, fn) => {
  try { fn(); ok++; }
  catch (e) { falhas++; console.error(`FALHOU: ${nome}\n  ${e.message}`); }
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || 'diferente'}\n  esperado: ${JSON.stringify(b)?.slice(0, 300)}\n  obtido:   ${JSON.stringify(a)?.slice(0, 300)}`);
};

const fonte = FONTES_MENSAGENS.map((f) => fs.readFileSync(path.join(WEB, f), 'utf8')).join('\n');
const mensagens = extraiMensagens(fonte);
const catalogos = {};
for (const idioma of ['en', 'es']) {
  catalogos[idioma] = JSON.parse(fs.readFileSync(path.join(WEB, 'textos-servidor', `${idioma}.json`), 'utf8'));
}

// ── 1. pt-BR não muda um byte ───────────────────────────────────────────────
// Este é O teste. Vale sobre as 362 mensagens reais, não sobre exemplo
// inventado: se uma delas passasse a sair diferente, os 99 usuários de hoje
// veriam a mudança.
t('pt-BR devolve a MESMA string em toda mensagem real', () => {
  for (const m of mensagens) {
    for (const idioma of ['pt-BR', 'pt', 'pt-PT', undefined, null, '']) {
      const saida = traduzMensagem(m, idioma, catalogos);
      if (saida !== m) throw new Error(`${JSON.stringify(idioma)} mexeu em ${JSON.stringify(m)} -> ${JSON.stringify(saida)}`);
    }
  }
});

t('pt-BR devolve o MESMO objeto, pela mesma referência', () => {
  const obj = { ok: false, error: 'Faça login.', message: 'Faça login.', saldo: 12 };
  for (const idioma of ['pt-BR', undefined, null]) {
    if (traduzResposta(obj, idioma, catalogos) !== obj) throw new Error(`copiou o objeto em ${JSON.stringify(idioma)}`);
  }
});

t('idioma desconhecido não traduz e não copia', () => {
  const obj = { error: 'Faça login.' };
  eq(traduzResposta(obj, 'de', catalogos), obj, 'alemão não tem catálogo, tinha que sair o mesmo objeto');
  eq(traduzMensagem('Faça login.', 'de', catalogos), 'Faça login.', 'alemão não tem catálogo');
});

// ── 2. só `error` e `message`, nada além ────────────────────────────────────
t('traduz error e message e não encosta no resto', () => {
  const pt = mensagens.find((m) => catalogos.en[m]);
  if (!pt) throw new Error('catálogo en vazio: o resto do teste não valeria nada');
  const obj = { ok: false, error: pt, id: 'abc', queued: true, credits: 10 };
  const saida = traduzResposta(obj, 'en', catalogos);
  eq(saida.error, catalogos.en[pt], 'error tinha que estar traduzido');
  for (const campo of ['ok', 'id', 'queued', 'credits']) eq(saida[campo], obj[campo], `${campo} foi alterado`);
  eq(Object.keys(saida).join(','), Object.keys(obj).join(','), 'mudou o conjunto ou a ordem das chaves');
  eq(obj.error, pt, 'o objeto ORIGINAL foi mutado');
});

t('campo que não é string passa intacto', () => {
  const obj = { error: { code: 42 }, message: 7 };
  eq(traduzResposta(obj, 'en', catalogos), obj, 'objeto sem string traduzível tinha que sair pela mesma referência');
});

t('não é objeto: devolve como veio', () => {
  for (const v of [null, undefined, 'texto', 42, true]) eq(traduzResposta(v, 'en', catalogos), v, `mexeu em ${JSON.stringify(v)}`);
});

// ── 3. código de máquina nunca vira frase traduzida ─────────────────────────
// Traduzir `locked` ou `bad_request` não deixaria a tela feia: deixaria o
// cliente comparando contra um valor que mudou de idioma.
t('código de máquina fica fora da extração', () => {
  const CODIGO = /^[a-z][a-z0-9_]*$/;
  const vazados = mensagens.filter((m) => CODIGO.test(m));
  if (vazados.length) throw new Error(`extraiu código de máquina: ${JSON.stringify(vazados)}`);
});

t('código de máquina não está no catálogo, nem por engano', () => {
  for (const idioma of ['en', 'es']) {
    for (const codigo of ['locked', 'no_agent', 'bad_request', 'unauthorized', 'rate_limited']) {
      if (catalogos[idioma][codigo] !== undefined) throw new Error(`${idioma} traduz ${codigo}`);
      eq(traduzMensagem(codigo, idioma, catalogos), codigo, `${idioma} mexeu em ${codigo}`);
    }
  }
});

// ── 4. o catálogo bate com o código de hoje ─────────────────────────────────
// Chave que não existe mais no server.mjs é peso morto e esconde erro de
// digitação; este teste é o que avisa quando alguém reescreve uma mensagem.
t('toda chave do catálogo existe na extração do server.mjs', () => {
  const validas = new Set(mensagens);
  for (const idioma of ['en', 'es']) {
    const orfas = Object.keys(catalogos[idioma]).filter((k) => !validas.has(k));
    if (orfas.length) throw new Error(`${idioma} tem ${orfas.length} chave(s) órfã(s): ${JSON.stringify(orfas.slice(0, 5))}`);
  }
});

t('nenhuma tradução traz barra invertida ou interpolação', () => {
  for (const idioma of ['en', 'es']) {
    for (const [pt, tr] of Object.entries(catalogos[idioma])) {
      if (typeof tr !== 'string' || !tr.trim()) throw new Error(`${idioma}: tradução vazia em ${JSON.stringify(pt)}`);
      if (tr.includes('\\')) throw new Error(`${idioma}: barra invertida em ${JSON.stringify(pt)}`);
      if (tr.includes('${')) throw new Error(`${idioma}: interpolação em ${JSON.stringify(pt)}`);
    }
  }
});

t('extração não pega template nem literal com escape', () => {
  for (const m of mensagens) {
    if (m.includes('${')) throw new Error(`template virou chave: ${JSON.stringify(m)}`);
    if (m.includes('\\')) throw new Error(`literal com escape virou chave: ${JSON.stringify(m)}`);
  }
});

// ── 5. ponto de emissão, não conteúdo ───────────────────────────────────────
// O que decide se um literal vai pra tela é por onde ele sai. `return { error }`
// é resultado de tool, vai pro modelo, e traduzir ali mexeria no texto que guia
// a decisão dele.
t('só literal emitido por fail()/send() entra', () => {
  const amostra = `
    fail(res, 401, 'Entra na conta primeiro.');
    send(res, 400, { error: 'Escolhe um arquivo.' });
    send(res, 200, { ok: true, message: 'Tudo certo por aqui.' });
    return { error: 'Isto aqui é resposta de tool.' };
    const rotulo = 'Isto aqui é texto solto.';
    fail(res, 403, 'locked');
  `;
  const achados = extraiMensagens(amostra);
  eq(achados.join(' | '), 'Entra na conta primeiro. | Escolhe um arquivo. | Tudo certo por aqui.', 'conjunto errado');
});

// ── 6. idioma da requisição ─────────────────────────────────────────────────
// A ordem existe por um motivo: o `X-Idioma` da SPA não é palpite do navegador,
// é o eco da preferência SALVA com que o servidor montou aquela página. Então
// o erro chega no mesmo idioma da tela que o provocou.
const doHeader = (req) => ({ language: req.headers['accept-language'] === 'es-AR' ? 'es' : 'pt-BR' });

t('X-Idioma válido ganha do Accept-Language', () => {
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'en', 'accept-language': 'es-AR' } }, doHeader), 'en');
});

t('X-Idioma inválido cai no Accept-Language', () => {
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'klingon', 'accept-language': 'es-AR' } }, doHeader), 'es');
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'EN', 'accept-language': 'es-AR' } }, doHeader), 'es', 'a checagem é sensível a caixa, de propósito');
});

t('sem header nenhum, português', () => {
  eq(idiomaDaRequisicao({ headers: {} }, doHeader), 'pt-BR');
  eq(idiomaDaRequisicao({}, doHeader), 'pt-BR');
});

t('doHeader que explode não derruba a requisição', () => {
  eq(idiomaDaRequisicao({ headers: {} }, () => { throw new Error('boom'); }), 'pt-BR');
});

// ── 7. a SPA de fato devolve o idioma da página ─────────────────────────────
// Sem isto o resto vira teoria: se o `api()` parar de mandar o header, todo
// erro do app volta pro português e nenhum outro teste reclama.
t('index.html manda X-Idioma com o lang do <html>', () => {
  const spa = fs.readFileSync(path.join(WEB, 'public', 'index.html'), 'utf8');
  if (!/X-Idioma/.test(spa)) throw new Error('o api() da SPA não manda mais X-Idioma');
  if (!/document\.documentElement\.lang/.test(spa)) throw new Error('X-Idioma não vem mais do lang do <html>');
});

// ── 8. cobertura, como aviso e não como falha ───────────────────────────────
for (const idioma of ['en', 'es']) {
  const n = mensagens.filter((m) => catalogos[idioma][m]).length;
  console.log(`${idioma}: ${n}/${mensagens.length} mensagens traduzidas`);
}

console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
