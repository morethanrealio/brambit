// ── Syntax check before writing an app file (a real parser) ──
// Measured on the bench of 2026-09-19: of the 12 real edits refused for
// "snippet not found", resolving the anchor makes all 12 match, but only 7 of
// the NEW texts the model sent generate a file that compiles. Writing the
// other 5 would trade a useless refusal for a broken app. Here the host runs
// the result through a parser and returns the compiler's error, which is
// actionable information.
//
// Golden rule: NEVER block an edit that does not make the file worse. If the
// file was ALREADY broken before (the model might be exactly fixing it), or if
// the parser is not available, the write goes through. The parser only
// parses: it does not execute the code, does not import a module, does not
// resolve a dependency.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JS = /\.(js|mjs|cjs)$/i;
const PY = /\.py$/i;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

export function sintaxeChecavel(rel) { return JS.test(rel) || PY.test(rel) || /\.json$/i.test(rel); }

function rodar(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => resolve({ err, saida: `${stderr || ''}${stdout || ''}` }));
  });
}

// First useful line of the parser's error, with no temp path or stack.
function limparErro(saida, arquivoTmp, rel) {
  const linhas = String(saida || '').split('\n')
    .filter((l) => !/^\s+at\s/.test(l) && !/^Node\.js v/.test(l) && !/ExperimentalWarning|Warning:/.test(l) && l.trim());
  const msg = linhas.find((l) => /SyntaxError|Error:/.test(l)) || linhas[0] || 'erro de sintaxe';
  const ctx = linhas.filter((l) => l !== msg).slice(0, 3).join('\n');
  return `${msg}\n${ctx}`.split(arquivoTmp).join(rel).replace(/\s+$/, '').slice(0, 800);
}

/**
 * Returns { estado: 'ok' | 'erro' | 'pulado', erro? }. 'pulado' = couldn't
 * check (extension with no parser, file too big, binary missing, timeout).
 */
export async function checarSintaxe(rel, fonte) {
  if (typeof fonte !== 'string' || !sintaxeChecavel(rel)) return { estado: 'pulado' };
  if (Buffer.byteLength(fonte, 'utf8') > MAX_BYTES) return { estado: 'pulado' };
  if (/\.json$/i.test(rel)) {
    try { JSON.parse(fonte); return { estado: 'ok' }; }
    catch (e) { return { estado: 'erro', erro: String(e.message).slice(0, 300) }; }
  }
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'appsyn-'));
    if (PY.test(rel)) {
      const f = join(dir, 'a.py');
      await writeFile(f, fonte, 'utf8');
      // compile() only parses; it does not import or execute the module.
      const r = await rodar('python3', ['-c', 'import sys;compile(open(sys.argv[1],encoding="utf-8").read(),"x","exec")', f]);
      if (!r.err) return { estado: 'ok' };
      if (r.err.code === 'ENOENT' || r.err.killed) return { estado: 'pulado' };
      return { estado: 'erro', erro: limparErro(r.saida, f, rel) };
    }
    // JS: the same .js can be CommonJS or ESM depending on the app's
    // package.json. Only what fails BOTH reads is an error; this way no
    // valid file gets blocked because of the dialect.
    const cjs = join(dir, 'a.cjs');
    await writeFile(cjs, fonte, 'utf8');
    const r1 = await rodar(process.execPath, ['--check', cjs]);
    if (!r1.err) return { estado: 'ok' };
    if (r1.err.code === 'ENOENT' || r1.err.killed) return { estado: 'pulado' };
    const mjs = join(dir, 'a.mjs');
    await writeFile(mjs, fonte, 'utf8');
    const r2 = await rodar(process.execPath, ['--check', mjs]);
    if (!r2.err) return { estado: 'ok' };
    if (r2.err.killed) return { estado: 'pulado' };
    // Reports the dialect the file appears to use.
    const pareceEsm = /^\s*(import\s|export\s|export\{)/m.test(fonte);
    return { estado: 'erro', erro: pareceEsm ? limparErro(r2.saida, mjs, rel) : limparErro(r1.saida, cjs, rel) };
  } catch {
    return { estado: 'pulado' };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Write gate: only blocks when the edit BREAKS a file that was intact.
 * Returns null to allow, or { erro } to refuse.
 */
export async function pioraSintaxe(rel, fonteAntes, fonteDepois) {
  if (!sintaxeChecavel(rel)) return null;
  const depois = await checarSintaxe(rel, fonteDepois);
  if (depois.estado !== 'erro') return null;
  const antes = await checarSintaxe(rel, fonteAntes);
  if (antes.estado !== 'ok') return null;
  return { erro: depois.erro };
}
