// models.yaml: what protects production (no file = the usual routing),
// inheritance between tasks, and the guard against a key pasted into the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModels, choiceFor, parseModels } from '../core-proto/models.mjs';

test('with no models.yaml, no task is configured', () => {
  const cfg = loadModels({ env: { BRAMBIT_MODELS_FILE: '/does/not/exist/models.yaml' }, reload: true });
  assert.equal(cfg, null);
  assert.equal(choiceFor('chat', cfg), null);
});

test('a task with no entry inherits from the parent; the repo example is valid', () => {
  const cfg = parseModels(readFileSync(new URL('../models.example.yaml', import.meta.url), 'utf8'));
  const own = parseModels(`
providers:
  a: { base_url: https://a/v1 }
  b: { base_url: https://b/v1 }
tasks:
  default: a/m1
  chat: { model: b/m2, fallback: a/m1 }
`);
  assert.equal(choiceFor('image_reading', own).from, 'chat');
  assert.equal(choiceFor('image_reading', own).fallback.model, 'm1');
  assert.equal(choiceFor('memory', own).from, 'default');
  assert.equal(choiceFor('chat', cfg).primary.model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
});

test('a key pasted in place of the variable name is rejected', () => {
  assert.throws(() => parseModels('providers:\n  a: { base_url: https://a/v1, api_key_env: sk-123abc }\ntasks:\n  default: a/m'),
    /NAME of the \.env variable/);
});

test('a live edit applies, and a broken edit keeps the last good file', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startModelsWatch, stopModelsWatch } = await import('../web/models-live.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'brambit-models-')), 'models.yaml');
  const yaml = (m) => `providers:\n  a: { base_url: https://a/v1 }\ntasks:\n  default: a/${m}\n`;
  writeFileSync(file, yaml('m1'));
  const prev = process.env.BRAMBIT_MODELS_FILE;
  process.env.BRAMBIT_MODELS_FILE = file;
  loadModels({ reload: true });
  t.after(() => { stopModelsWatch(); if (prev === undefined) delete process.env.BRAMBIT_MODELS_FILE; else process.env.BRAMBIT_MODELS_FILE = prev; loadModels({ reload: true }); });
  startModelsWatch({ intervalMs: 20, log: { log() {}, error() {} } });
  const model = () => choiceFor('chat', loadModels())?.primary.model;
  const until = async (want, rewrite) => {
    for (let i = 0, end = Date.now() + 3000; Date.now() < end; i++, await new Promise((r) => setTimeout(r, 20))) {
      if (model() === want) return;
      // The watcher takes its first look at the file asynchronously: an edit before that look counts as the start.
      if (rewrite && i % 10 === 0) writeFileSync(file, rewrite);
    }
    assert.equal(model(), want);
  };
  await until('m2-longer', yaml('m2-longer'));
  writeFileSync(file, 'tasks:\n  default: nowhere/m3\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(model(), 'm2-longer');
  rmSync(file);
  await until(undefined);
});
