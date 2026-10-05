#!/usr/bin/env node
// Trava do .env.example (fase C do plano open source). Quem baixa o código copia
// esse arquivo pra subir o servidor, então ele tem que (1) listar toda variável que
// o código de produção lê, (2) não listar variável que ninguém lê mais e (3) não
// carregar nada nosso: IP de rede interna, host da nossa infra ou valor de segredo.
//
// Uso: node test-support/env-example-guard.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Raiz = pasta de onde roda (npm/CI rodam na raiz): quem instala o Brambit como
// pacote roda a mesma trava no próprio repo, com node node_modules/brambit/....
const root = process.cwd();
export const EXAMPLE = '.env.example';

// Lidas no código mas que NÃO são configuração do servidor.
export const IGNORE = new Map([
  ['TSC_PATH', 'build dos .mts (*/build.mts)'],
  ['PGLITE_MODULE', 'prévia local do painel com banco em memória (engagement/preview.mts)'],
  ['DATA_DIR', 'modelo de código gerado pros apps dos usuários (web/hosting.mjs)'],
  ['NOME', 'texto de instrução pro modelo ("use process.env.NOME")'],
  ['X', 'texto de comentário ("process.env.X")'],
]);

// Código de produção: fica de fora teste, apoio de teste, scripts de operação (ops/),
// automação do repositório (.github/) e o que é servido ao navegador.
export const isProductionSource = (f) => /\.(?:c|m)?(?:j|t)s$/.test(f) && !/\.test\./.test(f)
  && !/^(?:test-support|test-fixtures|ops|dev|\.github|web\/public)\//.test(f);

export function envReads(text) {
  const out = new Set();
  for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) out.add(m[1] || m[2]);
  return out;
}

// Linha ativa "VAR=valor" ou comentada "# VAR=valor".
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
  console.log(`[env-example] ${reads.size} variáveis lidas em ${files.length} arquivos de produção`);
  for (const p of problems) console.log(`[env-example] ${p}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
