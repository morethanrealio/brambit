#!/usr/bin/env node
// npm run modelos: mostra qual modelo cada função usa, segundo o modelos.yaml,
// e avisa quando a chave de um provedor está vazia no .env.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { arquivoModelos, carregarModelos, tabelaModelos } from '../core-proto/modelos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotenv = path.join(root, '.env');
const env = { ...(existsSync(dotenv) ? parseEnv(readFileSync(dotenv, 'utf8')) : {}), ...process.env };

try {
  const cfg = carregarModelos({ env });
  if (!cfg) {
    console.log(`Sem ${path.relative(root, arquivoModelos(env))}: o Brambit usa o roteamento embutido.\nPra escolher provedor e modelo por função: cp modelos.example.yaml modelos.yaml`);
  } else {
    console.log(`${path.relative(root, arquivoModelos(env))}\n${tabelaModelos({ cfg, env })}`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
