#!/usr/bin/env node
// .env.example guard (phase C of the open source plan). Whoever downloads the code copies
// this file to bring up the server, so it has to (1) list every variable that
// the production code reads, (2) not list a variable that nobody reads anymore, and (3) not
// carry any of our own stuff: internal network IP, our infra's host or a secret value.
//
// Usage: node test-support/env-example-guard.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root = folder it runs from (npm/CI run at the root): whoever installs Brambit as a
// package runs the same guard in their own repo, with node node_modules/brambit/....
const root = process.cwd();
export const EXAMPLE = '.env.example';

// Read in the code but that are NOT server configuration.
export const IGNORE = new Map([
  ['TSC_PATH', 'build of the .mts files (*/build.mts)'],
  ['PGLITE_MODULE', 'local panel preview with an in-memory database (engagement/preview.mts)'],
  ['DATA_DIR', 'generated code template for users\' apps (web/hosting.mjs)'],
  ['NOME', 'instruction text for the model ("use process.env.NOME")'],
  ['NAME', 'instruction text for the model ("use process.env.NAME")'],
  ['X', 'comment text ("process.env.X")'],
  ['BRAMBIT_HOME', 'program folder of an installed copy, read by the installer check (installer/install-check.mjs)'],
  ['PATH', 'the system PATH the installer edits (installer/desktop.mjs)'],
  ['XDG_CONFIG_HOME', 'where Linux keeps autostart entries (installer/desktop.mjs)'],
  ['XDG_DATA_HOME', 'where Linux keeps app menu entries (installer/desktop.mjs)'],
]);

// Production code: excludes tests, test support, operations scripts (ops/),
// repository automation (.github/) and what's served to the browser.
export const isProductionSource = (f) => /\.(?:c|m)?(?:j|t)s$/.test(f) && !/\.test\./.test(f)
  && !/^(?:test-support|test-fixtures|ops|dev|\.github|web\/public)\//.test(f);

export function envReads(text) {
  const out = new Set();
  for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) out.add(m[1] || m[2]);
  return out;
}

// Active line "VAR=value" or commented out "# VAR=value".
export function parseExample(text) {
  const entries = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) entries.push({ name: m[2], value: m[3].trim(), active: !m[1], line: i + 1 });
  });
  return entries;
}

const SECRET_NAME = /(?:KEY|SECRET|TOKEN|PASS|PASSWORD)$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const LOOPBACK = new Set(['127.0.0.1', '0.0.0.0']);
const OUR_HOSTS = /mtr\.center|morethanreal|brambs\.com\.br|\.internal\b|\bec2-\d|\bip-\d+-\d+-\d+-\d+/i;

export function check({ example, reads }) {
  const entries = parseExample(example);
  const problems = [];
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.name)) problems.push(`${e.name} aparece duas vezes (linhas ${seen.get(e.name)} e ${e.line})`);
    else seen.set(e.name, e.line);
    if (SECRET_NAME.test(e.name) && e.value) problems.push(`${e.name} (linha ${e.line}) tem valor; segredo fica vazio no exemplo`);
  }
  example.split('\n').forEach((line, i) => {
    for (const ip of line.match(IPV4) || []) if (!LOOPBACK.has(ip)) problems.push(`linha ${i + 1}: IP ${ip}; use localhost ou deixe vazio`);
    if (OUR_HOSTS.test(line)) problems.push(`linha ${i + 1}: endereço da nossa infra (${line.match(OUR_HOSTS)[0]})`);
  });
  const missing = [...reads].filter((v) => !seen.has(v) && !IGNORE.has(v)).sort();
  for (const v of missing) problems.push(`${v} é lida pelo código e falta no ${EXAMPLE}`);
  const dead = [...seen.keys()].filter((v) => !reads.has(v)).sort();
  for (const v of dead) problems.push(`${v} está no ${EXAMPLE} mas nenhum código de produção lê`);
  return problems;
}

function main() {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && isProductionSource(f));
  const reads = new Set();
  for (const f of files) for (const v of envReads(readFileSync(path.join(root, f), 'utf8'))) reads.add(v);
  const problems = check({ example: readFileSync(path.join(root, EXAMPLE), 'utf8'), reads });
  console.log(`[env-example] ${reads.size} variables read across ${files.length} production files`);
  for (const p of problems) console.log(`[env-example] ${p}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
