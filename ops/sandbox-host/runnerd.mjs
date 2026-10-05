// ── runnerd: HTTP fino na frente do runner de sandbox ──
// Roda NO host dedicado de sandbox (não no dev.mara). O backend (dev.mara) chama
// estes endpoints por HTTP, na rede privada da VPC, autenticado por um token
// compartilhado (Bearer). Sem token = 401. Bind no IP PRIVADO (nunca público).
//
// Endpoints (todos POST, corpo JSON):
//   /shell  {userId, command, timeout?, cwd?}  -> {exitCode, stdout, stderr, timedOut}
//   /write  {userId, path, content}            -> {ok, path, error?}
//   /read   {userId, path}                     -> {ok, path, content?, error?}
//   /readfile {userId, path}                    -> streama os bytes crus (application/octet-stream); 404/413/400 em erro
//   /stop   {userId}                           -> {ok}
//   /health (GET)                              -> {ok:true}
//
// Segurança: o isolamento de verdade está nas flags do docker (runner.mjs) e no
// firewall do host (rede do sandbox bloqueada da rede interna + metadata).
// runnerd só orquestra; nunca recebe/expõe credencial nenhuma.

import http from 'node:http';
import { shellRun, writeFile, readFile, stopSandbox, statFile, spawnCat } from './runner.mjs';

const PORT = Number(process.env.RUNNERD_PORT || 9000);
const HOST = process.env.RUNNERD_HOST || '0.0.0.0';
const TOKEN = process.env.RUNNER_TOKEN || '';
const MAX_BODY = 2 * 1024 * 1024; // 2MB (writeFile pode mandar arquivo)
const MAX_FILE = Number(process.env.RUNNER_MAX_FILE || 25 * 1024 * 1024); // teto do /readfile

if (!TOKEN) { console.error('RUNNER_TOKEN ausente; recusando subir.'); process.exit(1); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_BODY) { reject(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });

    const raw = await readBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'json invalido' }); }
    const { userId } = body;
    if (!userId || typeof userId !== 'string') return send(res, 400, { error: 'userId obrigatorio' });

    if (req.url === '/shell') {
      const { command, timeout, cwd } = body;
      if (typeof command !== 'string') return send(res, 400, { error: 'command obrigatorio' });
      return send(res, 200, await shellRun(userId, command, { timeout, cwd }));
    }
    if (req.url === '/write') {
      const { path, content } = body;
      if (typeof path !== 'string' || typeof content !== 'string') return send(res, 400, { error: 'path/content obrigatorios' });
      return send(res, 200, await writeFile(userId, path, content));
    }
    if (req.url === '/read') {
      const { path } = body;
      if (typeof path !== 'string') return send(res, 400, { error: 'path obrigatorio' });
      return send(res, 200, await readFile(userId, path));
    }
    if (req.url === '/readfile') {
      const { path: fp } = body;
      if (typeof fp !== 'string') return send(res, 400, { error: 'path obrigatorio' });
      const st = await statFile(userId, fp);
      if (!st.ok) return send(res, st.error === 'arquivo não encontrado' ? 404 : 400, { error: st.error });
      if (st.size > MAX_FILE) return send(res, 413, { error: `arquivo grande demais (${st.size} bytes, max ${MAX_FILE})` });
      const child = spawnCat(st.name, st.norm);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(st.size) });
      let sent = 0, aborted = false;
      const abort = () => { if (aborted) return; aborted = true; try { child.kill('SIGKILL'); } catch { /* já morto */ } try { res.destroy(); } catch { /* já fechado */ } };
      child.stdout.on('data', (d) => {
        sent += d.length;
        if (sent > MAX_FILE) return abort(); // guarda extra: arquivo cresceu entre stat e cat
        res.write(d);
      });
      child.stderr.on('data', () => { /* descarta ruído do docker exec */ });
      child.on('close', () => { if (!aborted) { try { res.end(); } catch { /* já fechado */ } } });
      child.on('error', abort);
      req.on('close', () => { if (!res.writableEnded) abort(); }); // cliente desistiu: mata o cat
      return;
    }
    if (req.url === '/stop') return send(res, 200, await stopSandbox(userId));

    return send(res, 404, { error: 'rota' });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => console.log(`runnerd ouvindo em ${HOST}:${PORT}`));
