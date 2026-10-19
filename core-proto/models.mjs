// ── Providers and models per task (models.yaml) ──
// Whoever installs Brambit picks, in a commented file, WHICH providers to use
// and WHICH model each task uses (with an optional fallback model). A
// provider is data, not code: name + base URL + the .env variable holding the key.
// Any service speaking the OpenAI protocol (/chat/completions) fits this way;
// Gemini has its own protocol and comes in with `type: gemini`.
//
// Without the file, everything returns null and the server follows the usual
// built-in routing (which is the case for our production today). The example model, with each field
// explained, is in models.example.yaml at the root of the repo.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { makeOpenAI } from './providers/openai.mjs';
import { makeGemini } from './providers/gemini.mjs';
import { throwIfAttemptControl } from './provider-attempt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = new Set(['openai', 'gemini']);

// A task without a line in the file uses its parent task's; `default` is the root of all of them.
export const TASKS = {
  default: { parent: null, about: 'everything that has no line of its own' },
  chat: { parent: 'default', about: 'assistant turn with the user (needs to call tools)' },
  image: { parent: 'chat', about: 'turn where the user sent a photo (needs to see images)' },
  image_reading: { parent: 'image', about: 'describe or read the text of a stored image or attachment' },
  research: { parent: 'default', about: 'reading sub-agents: web, Google, connectors, home summary' },
  coding: { parent: 'default', about: 'writing code, building apps, spreadsheets' },
  memory: { parent: 'default', about: 'keeping the profile and the conversation summary' },
  classification: { parent: 'default', about: 'short label/JSON tasks: topics, moderation, app risk, routine offers' },
};

export function modelsFilePath(env = { BRAMBIT_MODELS_FILE: process.env.BRAMBIT_MODELS_FILE }) {
  return env.BRAMBIT_MODELS_FILE ? path.resolve(env.BRAMBIT_MODELS_FILE) : path.join(ROOT, 'models.yaml');
}

// Reads and validates. A typo in the file brings down the boot with the
// problem's line, instead of turning into a mysterious "service unavailable" in the chat.
export function parseModels(text, source = 'models.yaml') {
  const fail = (msg) => { throw new Error(`${source}: ${msg}`); };
  let doc;
  try { doc = parse(text) ?? {}; } catch (e) { fail(`could not read the file (${e.message})`); }
  if (typeof doc !== 'object' || Array.isArray(doc)) fail('the file needs the providers and tasks sections');
  const providers = {};
  for (const [name, p] of Object.entries(doc.providers ?? {})) {
    if (!p || typeof p !== 'object') fail(`provider "${name}" needs fields (base_url, api_key_env)`);
    const type = p.type ?? 'openai';
    if (!TYPES.has(type)) fail(`provider "${name}": type "${type}" does not exist (use openai or gemini)`);
    if (type === 'openai' && !p.base_url) fail(`provider "${name}": base_url is missing (e.g. https://api.together.xyz/v1)`);
    if (type === 'gemini' && !p.api_key_env) fail(`provider "${name}": Gemini needs api_key_env`);
    if (p.api_key_env != null && !/^[A-Z][A-Z0-9_]*$/.test(String(p.api_key_env))) {
      fail(`provider "${name}": api_key_env is the NAME of the .env variable (e.g. TOGETHER_API_KEY), not the key itself`);
    }
    providers[name] = { name, type, baseUrl: p.base_url ? String(p.base_url).replace(/\/+$/, '') : null, keyEnv: p.api_key_env ?? null };
  }
  const target = (value, where) => {
    const v = typeof value === 'string' ? { model: value } : value;
    if (!v?.model) fail(`${where}: model is missing (format provider/model)`);
    const s = String(v.model), i = s.indexOf('/');
    if (i <= 0 || i === s.length - 1) fail(`${where}: "${s}" must be provider/model (e.g. together/deepseek-ai/DeepSeek-V4.1-Flash-1017)`);
    const provider = s.slice(0, i);
    if (!providers[provider]) fail(`${where}: provider "${provider}" is not in the providers section`);
    if (v.options != null && (typeof v.options !== 'object' || Array.isArray(v.options))) fail(`${where}: options must be a list of field: value`);
    return { provider, model: s.slice(i + 1), options: v.options ?? null };
  };
  const tasks = {};
  for (const [name, t] of Object.entries(doc.tasks ?? {})) {
    if (!TASKS[name]) fail(`task "${name}" does not exist (use: ${Object.keys(TASKS).join(', ')})`);
    if (t == null) continue;
    const primary = target(t, `tasks.${name}`);
    const fallback = typeof t === 'object' && t.fallback ? target(t.fallback, `tasks.${name}.fallback`) : null;
    tasks[name] = { primary, fallback };
  }
  if (!tasks.default && !tasks.chat) fail('fill in at least tasks.default (or tasks.chat)');
  const prices = {};
  for (const [model, p] of Object.entries(doc.prices ?? {})) {
    const n = (k) => { const x = Number(p?.[k] ?? 0); if (!Number.isFinite(x) || x < 0) fail(`prices.${model}.${k} must be a number`); return x; };
    prices[model] = { in: n('input'), cachedIn: n('cached_input'), out: n('output') };
  }
  return { providers, tasks, prices };
}

let cache;
export function loadModels({ env = process.env, reload = false } = {}) {
  if (cache !== undefined && !reload) return cache;
  const file = modelsFilePath(env);
  cache = existsSync(file) ? parseModels(readFileSync(file, 'utf8'), path.basename(file)) : null;
  return cache;
}

// Resolves the inheritance: { task, from, primary, fallback } or null.
export function choiceFor(task, cfg = loadModels()) {
  if (!cfg) return null;
  for (let t = task; t; t = TASKS[t]?.parent) {
    if (cfg.tasks[t]) return { task, from: t, ...cfg.tasks[t] };
  }
  return null;
}

export function buildModel(target, { maxTokens = 8192, cfg = loadModels(), env = process.env } = {}) {
  const p = cfg.providers[target.provider];
  const apiKey = p.keyEnv ? (env[p.keyEnv] || '') : null;
  if (p.type === 'gemini') {
    // search:false: search comes in through the buscar_web tool, same as the others.
    return makeGemini({ model: target.model, search: false, maxOutputTokens: maxTokens, apiKey, ...(target.options?.thinkingBudget != null ? { thinkingBudget: target.options.thinkingBudget } : {}) });
  }
  return makeOpenAI({
    model: target.model, maxTokens, url: `${p.baseUrl}/chat/completions`, apiKey, provider: p.name,
    ...(target.options ? { extras: target.options } : {}),
  });
}

// Simple fallback for auxiliary modules; the server passes its own (withFallback),
// which also handles billing when the primary fails mid-turn.
function simpleFallback(primary, fallback, tag) {
  let usePrimary = true;
  return {
    name: `${primary.name}->fallback:${fallback.name}`,
    async complete(args) {
      if (usePrimary) {
        try { return await primary.complete(args); }
        catch (e) {
          throwIfAttemptControl(e);
          usePrimary = false;
          console.error(`[${tag}] ${primary.name} failed, falling back to ${fallback.name}: ${e?.message ?? e}`);
        }
      }
      return fallback.complete(args);
    },
  };
}

// Provider ready for the task, or null when the file doesn't exist (the usual routing).
export function modelFor(task, { maxTokens = 8192, combine = simpleFallback } = {}) {
  const c = choiceFor(task);
  if (!c) return null;
  const primary = buildModel(c.primary, { maxTokens });
  return c.fallback ? combine(primary, buildModel(c.fallback, { maxTokens }), `models:${task}`) : primary;
}

// Rows of the "task → model" table from boot and from `npm run models`.
export function describeModels({ cfg = loadModels(), env = process.env } = {}) {
  if (!cfg) return null;
  const label = (t) => {
    if (!t) return '-';
    const p = cfg.providers[t.provider];
    return `${t.provider}/${t.model}${p.keyEnv && !env[p.keyEnv] ? ` (NO KEY: ${p.keyEnv} is empty in .env)` : ''}`;
  };
  return Object.keys(TASKS).map((task) => {
    const c = choiceFor(task, cfg);
    return { task, primary: label(c?.primary), fallback: label(c?.fallback), inheritedFrom: c && c.from !== task ? c.from : null, missingKey: [c?.primary, c?.fallback].some((t) => t && cfg.providers[t.provider].keyEnv && !env[cfg.providers[t.provider].keyEnv]) };
  });
}

export function modelsTable(opts) {
  const rows = describeModels(opts);
  if (!rows) return null;
  const w = Math.max(...rows.map((r) => r.task.length));
  return rows.map((r) => `  ${r.task.padEnd(w)}  ${r.primary}${r.fallback !== '-' ? `  | fallback: ${r.fallback}` : ''}${r.inheritedFrom ? `  (inherited from ${r.inheritedFrom})` : ''}`).join('\n');
}
