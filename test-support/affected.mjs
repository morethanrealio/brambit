#!/usr/bin/env node
// Quais testes uma mudança afeta (o "teste da área" do PR).
//
// Ninguém mantém lista de áreas à mão: a área de um teste é tudo o que ele
// alcança. Montamos um grafo de dependências do repositório lendo, em cada
// arquivo versionado de código, (a) os imports relativos e (b) qualquer string
// literal que aponte para um arquivo/pasta do repo (é assim que os testes que
// leem o texto do web/server.mjs aparecem no grafo). Um teste é afetado se algum
// arquivo mudado está no fecho dele. Mudou o próprio teste, ele roda.
//
// Import é transitivo (o teste executa o que o módulo importa). Referência por
// string é terminal: quem só LÊ o texto do server.mjs não depende do que o
// server.mjs importa. Exceção: arquivo que sobe processo (spawn/execFile/fork)
// executa o que referencia, então ali a string conta como import.
//
// Conforme o server.mjs for dividido em módulos, os testes passam a importar só
// o módulo da área e a seleção fica mais estreita sozinha.
//
// Uso: npm test -- --changed-since <sha-base>   (roda só os testes afetados)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Mudança nestes arquivos muda como TODO teste roda: roda a suíte inteira.
export const RUN_ALL = ['package.json', 'package-lock.json', 'test-support/run-suite.mjs', 'test-support/affected.mjs'];

const CODE = /\.(?:c|m)?(?:j|t)s$|\.html$/;
const LITERAL = /(['"`])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)\1/g;
const SPAWNS = /\b(?:spawn|fork|execFile)\w*\s*\(/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

// Apelido do "imports" do package.json (#nucleo/web/x.mjs, #regras-provedor) vira o
// caminho na raiz; sem apelido que case, null.
function apelido(ref, imports) {
  for (const [k, v] of Object.entries(imports)) {
    const alvo = k.endsWith('*') ? (ref.startsWith(k.slice(0, -1)) ? v.replace('*', ref.slice(k.length - 1)) : null) : (ref === k ? v : null);
    if (typeof alvo === 'string' && alvo.startsWith('./')) return alvo;
  }
  return null;
}

// Alvos possíveis de uma referência: relativo ao arquivo e relativo à raiz
// (os testes rodam com cwd na raiz, então readFileSync('web/x.mjs') é da raiz).
function targets(from, ref, tracked, dirs, apelidos = {}) {
  if (ref.startsWith('#')) { const a = apelido(ref, apelidos); if (!a) return []; from = 'x'; ref = a; }
  const clean = ref.replace(/[?#].*$/, '');
  const out = [];
  for (const base of [path.posix.dirname(from), '.']) {
    let p = path.posix.normalize(path.posix.join(base, clean)).replace(/\/$/, '');
    if (p.startsWith('..')) continue;
    if (tracked.has(p)) out.push(p);
    else if (p.endsWith('.mjs') && tracked.has(p.replace(/\.mjs$/, '.mts'))) out.push(p.replace(/\.mjs$/, '.mts'));
    else if (p.includes('/') && dirs.has(p)) out.push(...dirs.get(p));
  }
  return out;
}

export function buildGraph(files, read) {
  const tracked = new Set(files), dirs = new Map();
  for (const f of files) {
    for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) {
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(f);
    }
  }
  const deps = new Map();
  let apelidos = {};
  try { apelidos = JSON.parse(read('package.json')).imports || {}; } catch { /* sem package.json */ }
  for (const f of files) {
    if (!CODE.test(f)) continue;
    let src;
    try { src = read(f); } catch { continue; }
    const runs = SPAWNS.test(src);
    const imports = new Set(), refs = new Set();
    for (const [re, kind] of [[IMPORT, imports], [LITERAL, runs ? imports : refs]]) {
      for (const m of src.matchAll(re)) {
        if (!m[2].includes('/') && !m[2].includes('.') && !m[2].startsWith('#')) continue;
        for (const t of targets(f, m[2], tracked, dirs, apelidos)) if (t !== f) kind.add(t);
      }
    }
    for (const t of imports) refs.delete(t);
    deps.set(f, { imports, refs });
  }
  return deps;
}

export function closure(start, deps) {
  const seen = new Set([start]), stack = [start];
  while (stack.length) for (const d of deps.get(stack.pop())?.imports || []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  for (const f of [...seen]) for (const r of deps.get(f)?.refs || []) seen.add(r);
  return seen;
}

// tests: caminhos de fonte dos testes. Devolve { all, tests, uncovered }.
export function selectAffected({ changed, tests, deps }) {
  if (changed.some((f) => RUN_ALL.includes(f))) return { all: true, tests: [...tests], uncovered: [] };
  const want = new Set(changed), picked = [], covered = new Set();
  for (const t of tests) {
    const reach = closure(t, deps);
    const hit = [...want].filter((f) => reach.has(f));
    if (hit.length) { picked.push(t); hit.forEach((f) => covered.add(f)); }
  }
  const uncovered = changed.filter((f) => CODE.test(f) && !covered.has(f) && existsSync(f));
  return { all: false, tests: picked, uncovered };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

export function changedSince(baseSha, cwd = process.cwd()) {
  const committed = git(['diff', '--name-only', `${baseSha}...HEAD`], cwd);
  const local = git(['diff', '--name-only', 'HEAD'], cwd);
  return [...new Set((committed + local).split('\n').filter(Boolean))];
}

export function affectedTests(baseSha, tests, cwd = process.cwd()) {
  const files = git(['ls-files'], cwd).split('\n').filter((f) => f && existsSync(path.join(cwd, f)) && statSync(path.join(cwd, f)).isFile());
  const deps = buildGraph(files, (f) => readFileSync(path.join(cwd, f), 'utf8'));
  const changed = changedSince(baseSha, cwd);
  return { changed, ...selectAffected({ changed, tests, deps }) };
}

