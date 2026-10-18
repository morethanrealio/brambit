#!/usr/bin/env node
// npm run models: shows which model each task uses, according to models.yaml,
// and warns when a provider's key is empty in .env.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { modelsFilePath, loadModels, modelsTable } from '../core-proto/models.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotenv = path.join(root, '.env');
const env = { ...(existsSync(dotenv) ? parseEnv(readFileSync(dotenv, 'utf8')) : {}), ...process.env };

try {
  const cfg = loadModels({ env });
  if (!cfg) {
    console.log(`Without ${path.relative(root, modelsFilePath(env))}: Brambit uses the built-in routing.\nTo choose provider and model per task: cp models.example.yaml models.yaml`);
  } else {
    console.log(`${path.relative(root, modelsFilePath(env))}\n${modelsTable({ cfg, env })}`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
