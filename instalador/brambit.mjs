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
// Uso: node instalador/brambit.mjs [--sem-navegador]
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const log = (m) => console.log(`[brambit] ${m}`);

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

// Página de configuração. Só abre com o código de uso único que vai no endereço
// (depois do #, então não aparece em log nem em histórico de servidor); confere
// o Host (outro site apontando um domínio pro 127.0.0.1 não entra) e a Origin.
// Resolve com a configuração quando a chave da IA foi testada e salva; aoOuvir
// roda quando a porta já atende (antes disso o navegador abriria numa página de erro).
function servirConfiguracao(porta, codigo, aoOuvir) {
  const pagina = readFileSync(path.join(root, 'instalador', 'configurar.html'), 'utf8');
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
      const json = (status, corpo) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(corpo)); };
      if (!hosts.has(String(req.headers.host || ''))) return json(403, { erro: 'host' });
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(pagina.split('__CSP_NONCE__').join(nonce));
      }
      if (req.method !== 'POST' || req.url !== '/instalar') return json(404, { erro: 'nao_existe' });
      if (req.headers.origin !== `http://${req.headers.host}`) return json(403, { erro: 'origem' });
      let corpo = '';
      for await (const parte of req) { corpo += parte; if (corpo.length > 16384) return json(413, { erro: 'grande' }); }
      let p;
      try { p = JSON.parse(corpo); } catch { return json(400, { erro: 'corpo' }); }
      if (tentativas >= 10) return json(403, { erro: 'codigo_esgotado' });
      if (!mesmoTexto(p.codigo, codigo)) { tentativas++; return json(403, { erro: 'codigo' }); }
      const nome = String(p.nome || '').trim().slice(0, 120), email = String(p.email || '').trim().toLowerCase();
      if (!nome || !emailValido(email)) return json(400, { erro: 'dono' });
      const e = escolha(p);
      if (e.erro) return json(400, { erro: e.erro });
      const teste = await testarChave(e);
      if (!teste.ok) return json(400, { erro: teste.erro, status: teste.status });
      const cfg = {
        versao: 1, porta, dono: { nome, email },
        ia: { provedor: e.provedor, endereco: e.endereco, modelo: e.modelo },
        chave: e.chave ? cofre.encryptSecret(e.chave) : null,
        criadoEm: new Date().toISOString(),
      };
      writeFileSync(arquivoConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      res.on('finish', () => { server.close(() => resolve(cfg)); server.closeIdleConnections(); });
      json(200, { ok: true });
    });
    server.once('error', reject);
    server.listen(porta, '127.0.0.1', aoOuvir);
  });
}

async function main() {
  const semNavegador = process.argv.includes('--sem-navegador');
  mkdirSync(dados, { recursive: true, mode: 0o700 });
  await cofre.initVault();
  const { stop, conn } = await startPostgres(postgresBin(), path.join(dados, 'banco'));
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  let cfg = lerConfig();
  const porta = cfg?.porta || Number(process.env.BRAMBIT_PORTA) || await portaLivre(8080);
  const base = `http://127.0.0.1:${porta}`;
  const env = {
    ...process.env, ...dbEnvOf(conn),
    HOST: '127.0.0.1', PORT: String(porta), PUBLIC_BASE_URL: base,
    APP_TASK_STORE_DIR: path.join(dados, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(dados, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(dados, 'credit-calls'),
  };
  const banco = prepararBanco(conn, env);
  banco.catch(() => {}); // o erro aparece no await lá embaixo
  const primeiraVez = !cfg;
  if (primeiraVez) {
    const codigo = randomBytes(18).toString('base64url');
    const url = `${base}/#codigo=${codigo}`;
    const pronto = servirConfiguracao(porta, codigo, () => {
      log(`configure o Brambit no navegador: ${url}`);
      if (!semNavegador) abrirNavegador(url);
    });
    cfg = await pronto;
    log('configuração salva');
  }
  await banco;

  const ia = cfg.ia, varChave = PROVEDORES[ia.provedor].chave;
  writeFileSync(path.join(dados, 'modelos.yaml'), modelosYaml({ ...ia, chave: Boolean(cfg.chave) }));
  Object.assign(env, {
    ADMIN_EMAIL: cfg.dono.email, BRAMBIT_CADASTRO: 'fechado',
    MODELOS_ARQUIVO: path.join(dados, 'modelos.yaml'),
    ...(cfg.chave ? { [varChave]: cofre.decryptSecret(cfg.chave) } : {}),
  });
  const server = spawn(process.execPath, ['server.mjs'], { cwd: path.join(root, 'web'), env, stdio: 'inherit' });
  process.on('exit', () => server.kill());
  server.on('exit', (code) => process.exit(code ?? 0));
  await waitReady(base, server);
  log(`pronto: ${base}  (pra desligar, feche esta janela ou aperte Ctrl+C)`);
  // Na primeira vez a página de configuração já está aberta e cria a conta do dono.
  if (!primeiraVez && !semNavegador) abrirNavegador(base);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[brambit] ${e.message}`); process.exit(1); });
