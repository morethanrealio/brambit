#!/usr/bin/env node
// Trava dos testes que leem o TEXTO do código de produção (fase A do plano open
// source). Hoje uns 90 testes abrem web/server.mjs (ou outro módulo) como texto:
// recortam um trecho e executam à parte, ou só procuram uma frase. Quebram quando
// o código muda de lugar, sem bug nenhum.
//
// A lista test-support/testes-que-leem-codigo.txt é o backlog desses testes e só
// pode encolher: teste novo nesse estilo reprova o CI, e teste da lista que
// deixou de ler o código (foi reescrito importando o módulo) tem que sair dela.
// Na fase E, quem extrair um módulo do server.mjs reescreve, no mesmo PR, os
// testes da lista que recortavam aquele trecho.
//
// Uso: node test-support/fragile-guard.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from './affected.mjs';
import { listTests } from './run-suite.mjs';

// Raiz = pasta de onde roda (npm/CI rodam na raiz): quem instala o Brambit como
// pacote roda a mesma trava no próprio repo, com node node_modules/brambit/....
const root = process.cwd();
export const LIST = 'test-support/testes-que-leem-codigo.txt';

// Código de produção lido como texto. Fica de fora o que é servido ao navegador
// (web/public): teste de navegador serve a pasta inteira, e isso é legítimo.
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

// Quem instala o Brambit como pacote: os arquivos do núcleo entram no mapa com o
// caminho de dentro do pacote, e teste que lê nucleo('web/server.mjs') como texto
// continua contando. Arquivo do mesmo nome no repo de quem instala vale o dele.
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
