#!/usr/bin/env node
// Brambit no seu computador, pra quem não é técnico: liga o banco, sobe o
// servidor e abre o navegador. Na primeira vez abre a página de configuração
// (quem é o dono, qual IA usar e a chave dela) e a conta do dono é criada ali.
// Depois disso o cadastro fica fechado: os outros entram com o convite do dono.
//
// Os dados ficam fora da pasta do programa (atualizar não apaga nada), em
// BRAMBIT_DADOS ou, sem ela, na pasta .brambit do usuário. Tudo escuta só em
// 127.0.0.1: nada fica aberto pra rede.
//
// Fica uma cópia só ligada por pasta de dados. Enquanto ela roda, o
// ligado.json da pasta diz onde falar com ela (porta de controle em 127.0.0.1
// e um token que só quem lê a pasta tem): é por ali que `brambit` de novo só
// abre o navegador, `brambit parar` desliga e `brambit status` pergunta. O
// servidor pede "desligar" e "trocar a IA" (botões nas Configurações, plugin
// instalador/plugin) pelo canal de mensagens que este processo abre ao ligá-lo.
//
// Uso: node instalador/brambit.mjs [abrir | parar | status] [--sem-navegador]
// status sai com 0 se está ligado e 3 se não está (como o systemctl).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbEnvOf, freePort, postgresBin, prepararBanco, startPostgres, waitReady } from '../dev/local.mjs';
import { escolha, modelosYaml, PROVEDORES, testarChave } from './provedores.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = path.resolve(process.env.BRAMBIT_DADOS || path.join(os.homedir(), '.brambit'));
const arquivoConfig = path.join(dados, 'instalacao.json');
const arquivoLigado = path.join(dados, 'ligado.json');
const versao = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const log = (m) => console.log(`[brambit] ${m}`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// A chave da IA fica cifrada no instalacao.json pelo mesmo cofre do servidor.
process.env.BRAMBS_LOCAL = '1';
process.env.VAULT_KEY_FILE = path.join(dados, 'vault.key');
const cofre = await import('../web/vault.mjs');

const lerConfig = () => (existsSync(arquivoConfig) ? JSON.parse(readFileSync(arquivoConfig, 'utf8')) : null);

// 8080 se estiver livre; senão qualquer uma. Fica gravada: o endereço não muda.
const portaLivre = (preferida) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => freePort().then(resolve));
  s.listen(preferida, '127.0.0.1', () => s.close(() => resolve(preferida)));
});

export function abrirNavegador(url) {
  const [cmd, args, extra] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin' ? ['open', [url], {}] : ['xdg-open', [url], {}];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, ...extra }).on('error', () => {}).unref(); } catch {}
}

const mesmoTexto = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const processoVivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Página de configuração. Só abre com o código de uso único que vai no endereço
// (depois do #, então não aparece em log nem em histórico de servidor); confere
// o Host (outro site apontando um domínio pro 127.0.0.1 não entra) e a Origin.
// Resolve com a configuração quando a chave da IA foi testada e salva; aoOuvir
// roda quando a porta já atende (antes disso o navegador abriria numa página de erro).
// Com `atual` é a troca da IA (botão nas Configurações): o dono e a porta ficam,
// e "Cancelar" volta com a configuração de antes.
function servirConfiguracao(porta, codigo, aoOuvir, atual = null) {
  const pagina = readFileSync(path.join(root, 'instalador', 'configurar.html'), 'utf8').replace('__MODO__', atual ? 'trocar' : 'primeira');
  const hosts = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);
  let tentativas = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const nonce = randomBytes(16).toString('base64');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      // O app, enquanto espera o servidor dar lugar a esta página, procura por isto.
      res.setHeader('x-brambit-configuracao', '1');
      const json = (status, corpo) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(corpo)); };
      if (!hosts.has(String(req.headers.host || ''))) return json(403, { erro: 'host' });
      const caminho = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && caminho === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(pagina.split('__CSP_NONCE__').join(nonce));
      }
      // A IA de agora, pra página já vir com ela marcada. Nada secreto: a chave não vai.
      if (req.method === 'GET' && caminho === '/atual' && atual) return json(200, atual.ia);
      if (req.method !== 'POST' || !['/instalar', '/cancelar'].includes(caminho) || (caminho === '/cancelar' && !atual)) return json(404, { erro: 'nao_existe' });
      if (req.headers.origin !== `http://${req.headers.host}`) return json(403, { erro: 'origem' });
      let corpo = '';
      for await (const parte of req) { corpo += parte; if (corpo.length > 16384) return json(413, { erro: 'grande' }); }
      let p;
      try { p = JSON.parse(corpo); } catch { return json(400, { erro: 'corpo' }); }
      if (tentativas >= 10) return json(403, { erro: 'codigo_esgotado' });
      if (!mesmoTexto(p.codigo, codigo)) { tentativas++; return json(403, { erro: 'codigo' }); }
      const fechar = (cfg) => { res.on('finish', () => { server.close(() => resolve(cfg)); server.closeIdleConnections(); }); json(200, { ok: true }); };
      if (caminho === '/cancelar') return fechar(atual);
      const nome = atual ? atual.dono.nome : String(p.nome || '').trim().slice(0, 120);
      const email = atual ? atual.dono.email : String(p.email || '').trim().toLowerCase();
      if (!nome || !emailValido(email)) return json(400, { erro: 'dono' });
      const e = escolha(p);
      if (e.erro) return json(400, { erro: e.erro });
      const teste = await testarChave(e);
      if (!teste.ok) return json(400, { erro: teste.erro, status: teste.status });
      const cfg = {
        versao: 1, porta, dono: { nome, email },
        ia: { provedor: e.provedor, endereco: e.endereco, modelo: e.modelo },
        chave: e.chave ? cofre.encryptSecret(e.chave) : null,
        criadoEm: atual?.criadoEm || new Date().toISOString(),
        ...(atual ? { trocadoEm: new Date().toISOString() } : {}),
      };
      writeFileSync(arquivoConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      fechar(cfg);
    });
    server.once('error', reject);
    server.listen(porta, '127.0.0.1', aoOuvir);
  });
}

// A cópia ligada desta pasta de dados, se tiver: {fase, url, desde, ligado}.
async function instancia() {
  let ligado;
  try { ligado = JSON.parse(readFileSync(arquivoLigado, 'utf8')); } catch { return null; }
  try {
    const r = await fetch(`http://127.0.0.1:${ligado.porta}/estado`, { headers: { authorization: `Bearer ${ligado.token}` }, signal: AbortSignal.timeout(3000) });
    if (r.ok) return { ...(await r.json()), ligado };
  } catch {}
  // Sobrou de uma cópia que caiu sem limpar (janela fechada no X, computador desligado).
  if (!processoVivo(ligado.pid)) { try { unlinkSync(arquivoLigado); } catch {} }
  return null;
}

async function status() {
  const viva = await instancia(), cfg = lerConfig();
  log(!viva ? 'desligado'
    : viva.fase === 'ligado' ? `ligado: ${new URL(viva.url).origin}`
      : viva.fase === 'configuracao' ? 'ligado, com a página de configuração aberta' : 'ligando');
  log(`dados: ${dados}`);
  log(cfg ? `IA: ${cfg.ia.provedor} · ${cfg.ia.modelo}` : 'ainda não configurado: abra o Brambit pra configurar');
  process.exitCode = viva ? 0 : 3;
}

async function parar() {
  const viva = await instancia();
  if (!viva) return log('o Brambit não está ligado');
  const { porta, token, pid } = viva.ligado;
  await fetch(`http://127.0.0.1:${porta}/parar`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (let i = 0; i < 120; i++) {
    if (!processoVivo(pid)) return log('desligado');
    await espera(500);
  }
  log('pedi pra desligar, mas ele ainda não parou');
  process.exitCode = 1;
}

async function abrir(semNavegador) {
  mkdirSync(dados, { recursive: true, mode: 0o700 });
  const viva = await instancia();
  if (viva) {
    if (viva.fase === 'ligando') return log('o Brambit já está ligando; o endereço aparece na janela dele');
    log('o Brambit já está ligado');
    if (!semNavegador) abrirNavegador(viva.url);
    return;
  }
  await cofre.initVault();
  let cfg = lerConfig();
  const porta = cfg?.porta || Number(process.env.BRAMBIT_PORTA) || await portaLivre(8080);
  const base = `http://127.0.0.1:${porta}`;
  const desde = new Date().toISOString();
  let fase = 'ligando', url = base, servidor = null, desligando = false, trocando = false;

  // Controle: só 127.0.0.1, Host conferido e o token do ligado.json.
  const token = randomBytes(24).toString('base64url');
  const controle = http.createServer((req, res) => {
    const autorizado = req.headers.host === `127.0.0.1:${controle.address().port}` && mesmoTexto(req.headers.authorization || '', `Bearer ${token}`);
    if (!autorizado) { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/estado') return res.end(JSON.stringify({ fase, url, desde }));
    if (req.method === 'POST' && req.url === '/parar') { res.end('{"ok":true}'); return desligar(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => controle.listen(0, '127.0.0.1', r));
  writeFileSync(arquivoLigado, JSON.stringify({ pid: process.pid, porta: controle.address().port, token }), { mode: 0o600 });
  process.on('exit', () => {
    try { if (JSON.parse(readFileSync(arquivoLigado, 'utf8')).pid === process.pid) unlinkSync(arquivoLigado); } catch {}
  });

  const { stop, conn } = await startPostgres(postgresBin(), path.join(dados, 'banco'));
  process.on('exit', stop);
  process.on('exit', () => { if (servidor?.exitCode === null) servidor.kill(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (desligando ? process.exit(1) : desligar()));

  const env = {
    ...process.env, ...dbEnvOf(conn),
    HOST: '127.0.0.1', PORT: String(porta), PUBLIC_BASE_URL: base,
    APP_TASK_STORE_DIR: path.join(dados, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(dados, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(dados, 'credit-calls'),
  };

  function ligarServidor() {
    const ia = cfg.ia, varChave = PROVEDORES[ia.provedor].chave;
    writeFileSync(path.join(dados, 'modelos.yaml'), modelosYaml({ ...ia, chave: Boolean(cfg.chave) }));
    const s = spawn(process.execPath, ['server.mjs'], {
      cwd: path.join(root, 'web'), stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...env, ADMIN_EMAIL: cfg.dono.email, BRAMBIT_CADASTRO: 'fechado',
        MODELOS_ARQUIVO: path.join(dados, 'modelos.yaml'),
        BRAMBIT_PLUGINS: path.join(root, 'instalador', 'plugin', 'ativos.mjs'),
        BRAMBIT_INSTALACAO: JSON.stringify({ versao, endereco: base, dados, ia: { provedor: ia.provedor, modelo: ia.modelo }, desde }),
        ...(cfg.chave ? { [varChave]: cofre.decryptSecret(cfg.chave) } : {}),
      },
    });
    s.on('message', (m) => {
      if (s !== servidor) return;
      if (m?.acao === 'desligar') desligar();
      else if (m?.acao === 'trocar-ia' && typeof m.codigo === 'string' && m.codigo.length >= 20) trocarIa(m.codigo);
    });
    // Servidor que cai sozinho derruba o lançador (a janela mostra o erro).
    s.on('exit', (code) => { if (s === servidor && !desligando) process.exit(code ?? 1); });
    servidor = s;
    return waitReady(base, s).then(() => { fase = 'ligado'; url = base; });
  }

  // Unix: SIGTERM, e o servidor espera os turnos em andamento (teto de 60 s). Windows
  // não tem sinal: taskkill derruba o servidor e o que ele tiver ligado.
  async function pararServidor() {
    const s = servidor;
    servidor = null;
    if (!s || s.exitCode !== null || s.signalCode) return;
    const saiu = new Promise((r) => s.once('exit', r));
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(s.pid)], { stdio: 'ignore' }); } catch {} }
    else s.kill('SIGTERM');
    if (await Promise.race([saiu.then(() => true), espera(70000).then(() => false)])) return;
    s.kill('SIGKILL');
    await saiu;
  }

  async function desligar() {
    if (desligando) return;
    desligando = true;
    log('desligando...');
    await pararServidor();
    controle.close();
    process.exit(0);
  }

  async function trocarIa(codigo) {
    if (trocando || desligando) return;
    trocando = true;
    log('trocando a IA: o assistente fica parado até você concluir no navegador');
    await pararServidor();
    fase = 'configuracao';
    url = `${base}/?ia#codigo=${codigo}`;
    try { cfg = await servirConfiguracao(porta, codigo, null, cfg); }
    catch (e) { log(`a página de configuração não abriu (${e.message}); religando com a IA de antes`); }
    fase = 'ligando';
    url = base;
    try { await ligarServidor(); } catch (e) { log(e.message); return desligar(); }
    trocando = false;
    log(`pronto de novo: ${base}`);
  }

  const banco = prepararBanco(conn, env);
  banco.catch(() => {}); // o erro aparece no await lá embaixo
  const primeiraVez = !cfg;
  if (primeiraVez) {
    const codigo = randomBytes(18).toString('base64url');
    fase = 'configuracao';
    url = `${base}/#codigo=${codigo}`;
    const pronto = servirConfiguracao(porta, codigo, () => {
      log(`configure o Brambit no navegador: ${url}`);
      if (!semNavegador) abrirNavegador(url);
    });
    cfg = await pronto;
    fase = 'ligando';
    url = base;
    log('configuração salva');
  }
  await banco;
  await ligarServidor();
  log(`pronto: ${base}  (pra desligar, feche esta janela, aperte Ctrl+C ou rode "brambit parar")`);
  // Na primeira vez a página de configuração já está aberta e cria a conta do dono.
  if (!primeiraVez && !semNavegador) abrirNavegador(base);
}

async function main() {
  const args = process.argv.slice(2);
  const comando = args.find((a) => !a.startsWith('--')) || 'abrir';
  if (comando === 'status') return status();
  if (comando === 'parar') return parar();
  if (comando === 'abrir') return abrir(args.includes('--sem-navegador'));
  console.error('uso: brambit [abrir | parar | status] [--sem-navegador]');
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[brambit] ${e.message}`); process.exit(1); });
