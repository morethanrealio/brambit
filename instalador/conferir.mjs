#!/usr/bin/env node
// Prova de ponta a ponta do instalador, do jeito que a pessoa usa (o CI roda em
// Windows, macOS e Linux): primeira vez com a página de configuração, conta do
// dono, cadastro fechado pros outros, chave fora do disco em texto; ligando de
// novo, o dono entra; uma segunda cópia só aponta pra que já está ligada; o dono
// vê "Este computador" nas Configurações e troca a IA por ali; `brambit parar` desliga. A "IA" é um servidor falso em 127.0.0.1: nada sai da máquina.
//
// Uso: node instalador/conferir.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, pararPostgres, postgresBin } from '../dev/local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = mkdtempSync(path.join(os.tmpdir(), 'brambit-conferir-'));
const CHAVE = 'chave-de-teste-que-nao-pode-ir-pro-disco';
const DONO = { nome: 'Dona do Brambit', email: 'dona@example.com', senha: 'senha-bem-comprida-1' };
const log = (m) => console.log(`[conferir] ${m}`);
const falha = (m) => { throw new Error(m); };

// IA falsa: só a lista de modelos, que é o que o teste da chave consulta.
const ia = http.createServer((req, res) => {
  const ok = req.url === '/v1/models' && req.headers.authorization === `Bearer ${CHAVE}`;
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { data: [{ id: 'modelo-de-teste' }] } : { error: 'chave' }));
});
await new Promise((r) => ia.listen(0, '127.0.0.1', r));
const enderecoIa = `http://127.0.0.1:${ia.address().port}/v1`;
const porta = await freePort();

// Liga o instalador e espera a linha do log que interessa.
function ligar(espera, comando = []) {
  const filho = spawn(process.execPath, [path.join(root, 'instalador', 'brambit.mjs'), ...comando, '--sem-navegador'], {
    env: { ...process.env, BRAMBIT_DADOS: dados, BRAMBIT_PORTA: String(porta) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const achou = new Promise((resolve, reject) => {
    let saida = '';
    filho.stdout.on('data', (b) => {
      process.stdout.write(b);
      saida += b;
      const m = saida.match(espera);
      if (m) resolve(m);
    });
    filho.on('exit', (code) => reject(new Error(`o instalador parou (código ${code})`)));
    setTimeout(() => reject(new Error(`não apareceu ${espera} em 5 min`)), 300_000).unref();
  });
  return { filho, achou };
}

// No Windows o kill não derruba o servidor filho: taskkill derruba a árvore.
function desligar(filho) {
  if (filho.exitCode !== null) return Promise.resolve();
  const saiu = new Promise((r) => filho.once('exit', r));
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(filho.pid)], { stdio: 'ignore' }); } catch {} }
  else filho.kill('SIGTERM');
  return saiu;
}

const base = `http://127.0.0.1:${porta}`;
const post = (url, corpo, origin = base, cookie = '') => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(corpo) });
const cookieDe = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
// Roda um comando do lançador até o fim: {codigo, saida}.
function rodar(comando) {
  const { filho, achou } = ligar(/$^/, comando);
  achou.catch(() => {});
  let saida = '';
  filho.stdout.on('data', (b) => { saida += b; });
  return new Promise((r) => filho.on('exit', (codigo) => r({ codigo, saida })));
}
async function esperarServidor() {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  falha('o servidor não ligou depois da configuração');
}

let atual;
try {
  // 1) Primeira vez: a página de configuração.
  atual = ligar(/configure o Brambit no navegador: (http:\S+)#codigo=(\S+)/);
  const [, url, codigo] = await atual.achou;
  const pagina = await fetch(url);
  const csp = pagina.headers.get('content-security-policy') || '';
  if (pagina.status !== 200 || !/script-src 'nonce-[^']+'/.test(csp)) falha(`página de configuração: ${pagina.status} ${csp}`);
  if ((await pagina.text()).includes('__CSP_NONCE__')) falha('a página saiu sem o nonce trocado');
  const pedido = { codigo, nome: DONO.nome, email: DONO.email, provedor: 'outro', endereco: enderecoIa, modelo: 'modelo-de-teste', chave: CHAVE };
  if ((await post('/instalar', { ...pedido, codigo: 'errado' })).status !== 403) falha('código errado passou');
  if ((await post('/instalar', pedido, 'http://evil.example')).status !== 403) falha('outra origem passou');
  const recusada = await post('/instalar', { ...pedido, chave: 'outra' });
  if ((await recusada.json()).erro !== 'chave_recusada') falha('chave errada não foi recusada');
  const instalar = await post('/instalar', pedido);
  if (instalar.status !== 200) falha(`configuração: ${instalar.status} ${await instalar.text()}`);
  log('configuração aceita');

  // 2) O servidor de verdade liga no mesmo endereço; o dono cria a conta.
  await esperarServidor();
  const cadastro = await post('/api/signup', { name: DONO.nome, email: DONO.email, password: DONO.senha });
  if (cadastro.status !== 200) falha(`cadastro do dono: ${cadastro.status} ${await cadastro.text()}`);
  const cookies = cadastro.headers.getSetCookie();
  if (!cookies.length || cookies.some((c) => /;\s*Secure/i.test(c))) falha(`cookie do mesmo computador devia vir sem Secure: ${cookies}`);
  const outro = await post('/api/signup', { name: 'Outra Pessoa', email: 'outra@example.com', password: DONO.senha });
  if (outro.status !== 403) falha(`cadastro de outra pessoa devia ser recusado, veio ${outro.status}`);
  if (readFileSync(path.join(dados, 'instalacao.json'), 'utf8').includes(CHAVE)) falha('a chave da IA está em texto no disco');
  log('conta do dono criada, cadastro fechado pros outros, chave cifrada');

  // 3) Liga de novo: sem configuração, direto no servidor; o dono entra.
  await desligar(atual.filho);
  pararPostgres(postgresBin(), path.join(dados, 'banco'));
  atual = ligar(/pronto: http/);
  await atual.achou;
  const entrar = await post('/api/login', { email: DONO.email, password: DONO.senha });
  if (entrar.status !== 200) falha(`login do dono depois de religar: ${entrar.status} ${await entrar.text()}`);
  const sessao = cookieDe(entrar);
  log('religou e o dono entrou');

  // 4) Abrir de novo com ele ligado só aponta pra cópia que já está rodando.
  const segunda = await rodar([]);
  if (segunda.codigo !== 0 || !/já está ligado/.test(segunda.saida)) falha(`segunda cópia: código ${segunda.codigo}, ${segunda.saida}`);
  const st = await rodar(['status']);
  if (st.codigo !== 0 || !st.saida.includes(`ligado: ${base}`)) falha(`status: código ${st.codigo}, ${st.saida}`);
  log('segunda cópia não liga outra; status diz ligado');

  // 5) "Este computador" nas Configurações: só o dono vê.
  if ((await fetch(`${base}/api/instalacao`)).status !== 404) falha('/api/instalacao sem sessão devia ser 404');
  const info = await fetch(`${base}/api/instalacao`, { headers: { cookie: sessao } });
  const j = await info.json().catch(() => ({}));
  if (info.status !== 200 || j.ia?.modelo !== 'modelo-de-teste' || j.dados !== dados) falha(`/api/instalacao do dono: ${info.status} ${JSON.stringify(j)}`);
  const semSessao = await post('/api/instalacao/trocar-ia', {}, base);
  if (semSessao.ok || 'codigo' in (await semSessao.json().catch(() => ({})))) falha(`trocar a IA sem sessão passou: ${semSessao.status}`);

  // 6) Trocar a IA: o servidor dá lugar à página de configuração e volta com a escolha nova.
  const pedidoTroca = await post('/api/instalacao/trocar-ia', {}, base, sessao);
  const { codigo: codigoTroca } = await pedidoTroca.json().catch(() => ({}));
  if (pedidoTroca.status !== 200 || !codigoTroca) falha(`trocar a IA: ${pedidoTroca.status}`);
  let naConfiguracao = false;
  for (let i = 0; i < 120 && !naConfiguracao; i++) {
    try { naConfiguracao = (await fetch(`${base}/?ia`)).headers.get('x-brambit-configuracao') === '1'; } catch {}
    if (!naConfiguracao) await new Promise((r) => setTimeout(r, 500));
  }
  if (!naConfiguracao) falha('a página de trocar a IA não abriu');
  const atualIa = await (await fetch(`${base}/atual`)).json();
  if (atualIa.modelo !== 'modelo-de-teste' || 'chave' in atualIa) falha(`/atual: ${JSON.stringify(atualIa)}`);
  const trocou = await post('/instalar', { codigo: codigoTroca, provedor: 'outro', endereco: enderecoIa, modelo: 'modelo-de-teste', chave: CHAVE });
  if (trocou.status !== 200) falha(`trocar a IA: ${trocou.status} ${await trocou.text()}`);
  await esperarServidor();
  const cfg = JSON.parse(readFileSync(path.join(dados, 'instalacao.json'), 'utf8'));
  if (cfg.dono.email !== DONO.email || !cfg.trocadoEm) falha('trocar a IA mexeu no dono ou não gravou');
  if ((await fetch(`${base}/api/instalacao`, { headers: { cookie: sessao } })).status !== 200) falha('a sessão do dono não sobreviveu à troca da IA');
  log('trocou a IA e o dono continua dentro');

  // 7) brambit parar desliga tudo.
  const parou = await rodar(['parar']);
  if (!/desligado/.test(parou.saida)) falha(`parar: ${parou.saida}`);
  if (atual.filho.exitCode === null) await Promise.race([new Promise((r) => atual.filho.once('exit', r)), new Promise((_, rej) => setTimeout(() => rej(new Error('o Brambit não desligou')), 10_000))]);
  if (existsSync(path.join(dados, 'ligado.json'))) falha('ligado.json ficou pra trás');
  log('brambit parar desligou: tudo certo');
} catch (e) {
  process.exitCode = 1;
  console.error(`[conferir] FALHOU: ${e.message}`);
  try { console.error(readFileSync(path.join(dados, 'banco', 'postgres.log'), 'utf8').slice(-4000)); } catch {}
} finally {
  if (atual) await desligar(atual.filho);
  pararPostgres(postgresBin(), path.join(dados, 'banco'));
  ia.close();
  if (process.exitCode) log(`dados mantidos pra olhar: ${dados}`);
  else rmSync(dados, { recursive: true, force: true, maxRetries: 5 });
}
process.exit();
