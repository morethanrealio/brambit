#!/usr/bin/env node
// Growth guard for the two giant files (phase A of the open source plan,
// projetos/arquitetura-open-source-plano.md section 5 rule 6).
//
// web/server.mjs and web/db.mjs can only shrink: new code goes into its own
// module and enters these two files at most as an import/registration, which
// has to be offset by removing lines somewhere else in them.
//
// Usage: node test-support/growth-guard.mjs <sha-base>
// Compares the line count at the base against the working tree's. Exits 1 if either
// of the files grew, unless GROWTH_GUARD_ALLOW=1 (CI turns this on when the
// PR has the `crescimento-autorizado` label).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GUARDED = ['web/server.mjs', 'web/db.mjs'];

export const countLines = (text) => (text.match(/\n/g) || []).length + (text && !text.endsWith('\n') ? 1 : 0);

// base/head: { [file]: lines | null } (null = file doesn't exist on that side).
export function compareGrowth(base, head, files = GUARDED) {
  return files.map((file) => {
    const before = base[file] ?? null, after = head[file] ?? null;
    const grew = before !== null && after !== null && after > before;
    return { file, before, after, delta: before !== null && after !== null ? after - before : null, grew };
  });
}

function linesAt(sha, file, cwd) {
  try { return countLines(execFileSync('git', ['show', `${sha}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 })); }
  catch { return null; }
}

export function run({ baseSha, cwd = process.cwd(), allow = false, log = console.log }) {
  const base = {}, head = {};
  for (const file of GUARDED) {
    base[file] = linesAt(baseSha, file, cwd);
    head[file] = existsSync(`${cwd}/${file}`) ? countLines(readFileSync(`${cwd}/${file}`, 'utf8')) : null;
  }
  const report = compareGrowth(base, head);
  for (const r of report) {
    const d = r.delta === null ? 'n/a' : (r.delta > 0 ? `+${r.delta}` : String(r.delta));
    log(`[crescimento] ${r.file}: ${r.before ?? '-'} -> ${r.after ?? '-'} (${d})${r.grew ? '  CRESCEU' : ''}`);
  }
  const grew = report.filter((r) => r.grew);
  if (!grew.length) { log('[crescimento] ok: nenhum dos arquivos travados cresceu'); return 0; }
  if (allow) { log('[crescimento] cresceu, mas o PR tem o rótulo crescimento-autorizado'); return 0; }
  log([
    '',
    `[crescimento] ${grew.map((r) => r.file).join(' e ')} cresceu nesta mudança.`,
    'Esses dois arquivos estão travados: código novo vai para um módulo próprio (ex.: web/<area>.mjs)',
    'e entra aqui só como import/registro, compensado removendo linhas em outro ponto.',
    'Exceção pontual: rótulo `crescimento-autorizado` no PR, com o motivo na descrição.',
  ].join('\n'));
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseSha = process.argv[2];
  if (!baseSha) { console.error('uso: node test-support/growth-guard.mjs <sha-base>'); process.exit(2); }
  process.exit(run({ baseSha, allow: process.env.GROWTH_GUARD_ALLOW === '1' }));
}
