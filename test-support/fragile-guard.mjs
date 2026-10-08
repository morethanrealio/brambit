#!/usr/bin/env node
// Guard for tests that read the TEXT of the production code (phase A of the open
// source plan). Today about 90 tests open web/server.mjs (or another module) as text:
// they cut out a chunk and run it separately, or just look for a phrase. They break when
// the code moves, with no bug at all.
//
// The test-support/testes-que-leem-codigo.txt list is the backlog of these tests and can
// only shrink: a new test in this style fails the CI, and a test from the list that
// stopped reading the code (was rewritten importing the module) has to come off it.
// In phase E, whoever extracts a module out of server.mjs rewrites, in the same PR, the
// list's tests that used to cut out that chunk.
//
// Usage: node test-support/fragile-guard.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from './affected.mjs';
import { listTests } from './run-suite.mjs';

// Root = folder it runs from (npm/CI run at the root): whoever installs Brambit as a
// package runs the same guard in their own repo, with node node_modules/brambit/....
const root = process.cwd();
export const LIST = 'test-support/testes-que-leem-codigo.txt';

// Production code read as text. Excludes what's served to the browser
// (web/public): browser tests serve the whole folder, and that's legitimate.
export function readsProductionCode(test, deps, tests) {
  const prod = (f) => /\.(?:c|m)?(?:j|t)s$/.test(f) && !tests.has(f) && !f.startsWith('web/public/')
    && !/^(?:test-support|test-fixtures)\//.test(f) && !/\.test\./.test(f);
  return [...(deps.get(test)?.refs || [])].filter(prod);
}

export function check({ tests, deps, listed }) {
  const found = [...tests].filter((t) => readsProductionCode(t, deps, tests).length).sort();
  const news = found.filter((t) => !listed.has(t));
  const gone = [...listed].filter((t) => !found.includes(t)).sort();
  return { found, news, gone };
}

// Whoever installs Brambit as a package: the core's files go into the map with the
// path inside the package, and a test that reads nucleo('web/server.mjs') as text
// still counts. A file with the same name in the installer's repo counts as theirs.
const PACOTE = path.join(root, 'node_modules/brambit');
function arquivosDoPacote(dir = '', out = []) {
  for (const nome of readdirSync(path.join(PACOTE, dir))) {
    if (nome === 'node_modules' || nome === '.git') continue;
    const rel = dir ? `${dir}/${nome}` : nome;
    if (statSync(path.join(PACOTE, rel)).isDirectory()) arquivosDoPacote(rel, out); else out.push(rel);
  }
  return out;
}

function main() {
  const proprios = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => f && existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile());
  const doPacote = existsSync(path.join(PACOTE, 'package.json'))
    ? arquivosDoPacote().filter((f) => !existsSync(path.join(root, f))) : [];
  const files = [...proprios, ...doPacote];
  const deps = buildGraph(files, (f) => readFileSync(path.join(existsSync(path.join(root, f)) ? root : PACOTE, f), 'utf8'));
  const tests = new Set(listTests().map((t) => t.source));
  const listed = new Set(readFileSync(path.join(root, LIST), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const { found, news, gone } = check({ tests, deps, listed });
  console.log(`[frageis] ${found.length} testes leem o texto do código de produção (lista: ${listed.size})`);
  for (const t of news) console.log(`[frageis] NOVO: ${t} lê ${readsProductionCode(t, deps, tests).join(', ')}`);
  for (const t of gone) console.log(`[frageis] ${t} não lê mais o código: tire da lista ${LIST}`);
  if (news.length) console.log('\nTeste novo tem que importar o módulo e chamar a função, não ler o texto do arquivo.\n'
    + 'Se a função está presa dentro do web/server.mjs, extraia para um módulo próprio (web/<area>.mjs) e teste por ele.');
  return news.length || gone.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
