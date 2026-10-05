#!/usr/bin/env node
// Suite inteira em UM comando: `npm test` (ou `node test-support/run-suite.mjs`).
//
// Por que existe: `node --test` cru na raiz pega também os `.test.mts` das áreas
// TypeScript (deepseek, discovery, engagement, onboarding, ...). Esses fontes
// importam irmãos `./x.mjs` que só existem DEPOIS do `<area>:build` (tsc para
// `.<area>-build/`), então falham com ERR_MODULE_NOT_FOUND sem nenhum bug.
// Aqui: (1) roda o build de cada área que tem `build.mts` (o mesmo comando do
// `npm run <area>:build`), (2) monta a lista com os padrões default do
// `node --test`, trocando cada `.test.mts` de área compilada pelo `.mjs`
// compilado, e (3) roda tudo num `node --test` só. Argumentos extras são
// repassados (ex.: `npm test -- --test-concurrency=2`).
//
// `--changed-since <sha>` roda só os testes que a mudança desde <sha> alcança
// (test-support/affected.mjs). É o que o CI faz em cada PR.
//
// Fora da suíte, de propósito: sondas de PRODUÇÃO com sessão real (SID_A/SID_B),
// que não são teste local. E SID_A/SID_B são removidos do ambiente da suíte, para
// nenhum arquivo (ex.: ops/tenancy-runner-test.mjs) sair batendo em produção.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedTests } from './affected.mjs';

// Raiz = pasta de onde roda (npm/CI rodam na raiz): quem instala o Brambit como
// pacote roda a mesma trava no próprio repo, com node node_modules/brambit/....
const root = process.cwd();

const PRODUCTION_PROBES = {
  'ops/tenancy-test.mjs': 'sonda HTTP com cookies reais SID_A/SID_B (servidor local por padrão; remoto só com ALLOW_REMOTE=1); rodar à mão: SID_A=… SID_B=… node ops/tenancy-test.mjs',
  'ops/tenancy-write-test.mjs': 'sonda de ESCRITA com cookies reais SID_A/SID_B (servidor local por padrão; remoto só com ALLOW_REMOTE=1); rodar à mão: SID_A=… SID_B=… node ops/tenancy-write-test.mjs',
};

const areaDirs = () => readdirSync(root).filter((d) => !d.startsWith('.') && d !== 'node_modules'
  && statSync(path.join(root, d)).isDirectory() && existsSync(path.join(root, d, 'build.mts'))).sort();

// 2) Lista de arquivos, com os padrões default do node --test.
const EXT = '(?:c|m)?(?:j|t)s';
const PATTERNS = [
  new RegExp(`\\.test\\.${EXT}$`), new RegExp(`-test\\.${EXT}$`), new RegExp(`_test\\.${EXT}$`),
  new RegExp(`(?:^|/)test-[^/]*\\.${EXT}$`), new RegExp(`(?:^|/)test\\.${EXT}$`), new RegExp(`(?:^|/)test/.*\\.${EXT}$`),
];
function walk(dir, out) {
  for (const name of readdirSync(path.join(root, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = dir === '.' ? name : `${dir}/${name}`;
    const st = statSync(path.join(root, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (PATTERNS.some((p) => p.test(rel)) && !rel.endsWith('.d.mts') && !rel.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}
// Cada teste: { source (o que está no git), run (o que o node --test executa) }.
export function listTests() {
  const areas = areaDirs(), out = [];
  for (const rel of walk('.', [])) {
    if (PRODUCTION_PROBES[rel]) continue;
    const [area, ...rest] = rel.split('/');
    const run = areas.includes(area) && /\.m?ts$/.test(rel)
      ? `.${area}-build/${rest.join('/').replace(/\.m?ts$/, '.mjs')}` : rel;
    out.push({ source: rel, run });
  }
  return out;
}

function main(args) {
process.chdir(root);
let selected = listTests();
const i = args.indexOf('--changed-since');
if (i >= 0) {
  const base = args[i + 1];
  if (!base) throw Error('[suite] --changed-since precisa de um sha');
  args = [...args.slice(0, i), ...args.slice(i + 2)];
  const r = affectedTests(base, selected.map((t) => t.source), root);
  for (const f of r.uncovered) process.stderr.write(`[suite] nenhum teste alcança ${f}\n`);
  if (r.all) process.stderr.write('[suite] mudança global (package.json/lock ou runner): suíte inteira\n');
  const keep = new Set(r.tests);
  selected = selected.filter((t) => keep.has(t.source));
  process.stderr.write(`[suite] ${r.changed.length} arquivos mudaram desde ${base.slice(0, 9)}\n`);
  if (!selected.length) { process.stderr.write('[suite] nenhum teste afetado\n'); return 0; }
}

// 1) Build das áreas TypeScript.
const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const before = git(['status', '--porcelain']);
for (const area of areaDirs()) {
  process.stderr.write(`[suite] build ${area}\n`);
  execFileSync(process.execPath, ['--experimental-strip-types', `${area}/build.mts`], { stdio: 'inherit' });
}
const after = git(['status', '--porcelain']);
if (before !== null && before !== after) {
  process.stderr.write('[suite] AVISO: o build mudou arquivos versionados (saída gerada estava desatualizada em relação ao .mts):\n'
    + after.split('\n').filter((l) => l && !before.split('\n').includes(l)).join('\n') + '\n');
}

for (const t of selected) if (!existsSync(t.run)) throw Error(`[suite] ${t.source} não gerou ${t.run} no build da área`);
for (const [rel, why] of Object.entries(PRODUCTION_PROBES)) process.stderr.write(`[suite] fora da suíte: ${rel}: ${why}\n`);
process.stderr.write(`[suite] ${selected.length} arquivos de teste\n`);
const files = selected.map((t) => t.run);

// 3) Um node --test só. Localhost nunca passa pelo proxy do ambiente.
const env = { ...process.env };
delete env.SID_A; delete env.SID_B;
const local = '127.0.0.1,localhost,::1';
env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${local}` : local;
env.no_proxy = env.NO_PROXY;
const r = spawnSync(process.execPath, ['--test', ...args, ...files], { stdio: 'inherit', env });
return r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
