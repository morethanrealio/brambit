// ── Snapshot anonymization on PUBLISH-to-library ──
// When an app is made PUBLIC (definir_visibilidade_sistema → público), the CODE
// snapshot that will become copyable goes through a one-time cleanup: a cheap
// model (Gemini Flash Lite) detects owner content (personal name, city, real
// data left over in the source, seed with real records) and returns a list of
// literal SUBSTITUTIONS {file, find, replace} with generic/example equivalents.
// We apply the swaps by EXACT substring match — we never rewrite the whole
// file, so the model has no way to break the syntax: if a `find` does not
// match, the swap is simply skipped.
//
// Runs once, at the moment of publishing to the library (not on every deploy,
// not on every copy). The result is written into the snapshot itself. It's
// best-effort: if the model fails or returns nothing, the original snapshot
// stays intact (it does not block publishing).
//
// Scope: only the snapshot's CODE. Secrets do not live here (vault) and
// runtime data does not travel (/app/data). This handles what's left
// HARDCODED in the source.

import zlib from 'node:zlib';
import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modeloPara } from '../core-proto/modelos.mjs';

const CHEAP_MODEL = 'gemini-3.1-flash-lite';
const TEXT_EXT = /\.(js|mjs|ts|jsx|tsx|html?|css|json|py|txt|md|csv)$/i;
const MAX_FILE_CHARS = 12000;   // trecho por arquivo enviado ao modelo
const MAX_TOTAL_CHARS = 60000;  // teto do prompt inteiro
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function readSnapshot(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('gz1:')) return null;
  try {
    const gz = Buffer.from(blob.slice(4), 'base64');
    return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  } catch { return null; }
}

function buildSnapshot(files) {
  try {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(files), 'utf8'));
    if (gz.length > MAX_SNAPSHOT_BYTES) return null;
    return 'gz1:' + gz.toString('base64');
  } catch { return null; }
}

function parseJsonArray(t) {
  if (!t) return null;
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('['); const j = t.lastIndexOf(']');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

function buildPrompt(textFiles) {
  const blocks = [];
  let total = 0;
  for (const [rel, content] of textFiles) {
    const snippet = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
    if (total + snippet.length > MAX_TOTAL_CHARS) break;
    total += snippet.length;
    blocks.push(`### FILE: ${rel}\n${snippet}`);
  }
  return [
    'This is the SOURCE CODE of an app that will be published in a public library, where other people will COPY the app into their own space.',
    'The copy must not carry anything identifiable or personal from the original owner. Your job is to find, in the source, the content that needs to become generic/example content:',
    '',
    'REPLACE (identifiable or real owner data):',
    '• names of real people (owner, clients, members, players) → generic names in the same language as the surrounding text (e.g. "Jogador 1", "Cliente exemplo" in a Portuguese app) or empty when it is a personal signature/branding;',
    '• personal city/neighborhood/address/phone/e-mail/CPF/OAB/@ handle → generic or empty;',
    '• the owner\'s own business/brand name in title, header, footer → a generic label for the app\'s TYPE (e.g. "Ateliê de Cerâmica", "Lista de Presença");',
    '• seed/examples with REAL records (a list of real names, real items, real accounts) → generic, plausible examples, SAME format and similar quantity ("Item de exemplo", "Conta de exemplo").',
    '',
    'DO NOT TOUCH (it is code structure, it has to keep working):',
    '• names of variables, functions, tables, columns, API routes/paths, JSON keys, imports, CSS/HTML selectors (id/class), file names;',
    '• generic interface text ("Salvar", "Adicionar", "Nome", "Categoria"), technical comments;',
    '• process.env / os.environ / placeholders.',
    '',
    'Reply ONLY with a JSON array of objects {"file","find","replace"}, where:',
    '• "file" = the exact file path (as in the FILE header above);',
    '• "find" = the EXACT, literal substring that is in the file (copy it identically, with accents and punctuation);',
    '• "replace" = the generic text that goes in its place (can be "" to remove).',
    'Every "find" must exist literally in the file. Do not make anything up. If there is nothing to replace, reply [].',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

// Recebe o blob de snapshot (gz1:...) e devolve { blob, changed, applied, error }.
// Em qualquer falha, devolve o blob ORIGINAL com changed=false.
export async function anonymizeSnapshotBlob(blob, { log = () => {} } = {}) {
  const files = readSnapshot(blob);
  if (!files || !Object.keys(files).length) return { blob, changed: false, applied: 0 };
  if (!process.env.GEMINI_API_KEY && !modeloPara('classificacao')) { log('[anon] sem GEMINI_API_KEY, pulando'); return { blob, changed: false, applied: 0 }; }

  // Decodes only the text files.
  const textFiles = [];
  const decoded = {};
  for (const [rel, b64] of Object.entries(files)) {
    if (!TEXT_EXT.test(rel)) continue;
    try {
      const txt = Buffer.from(b64, 'base64').toString('utf8');
      decoded[rel] = txt;
      textFiles.push([rel, txt]);
    } catch { /* skips binary/unreadable */ }
  }
  if (!textFiles.length) return { blob, changed: false, applied: 0 };

  let arr;
  try {
    const r = await (modeloPara('classificacao', { maxTokens: 4096 }) || makeGemini({ model: CHEAP_MODEL, thinkingBudget: 0, maxOutputTokens: 4096 }))
      .complete({
        system: 'You anonymize code for public publication. You reply only with valid JSON, no comments.',
        messages: [{ role: 'user', content: buildPrompt(textFiles) }],
        tools: [],
      });
    arr = parseJsonArray(r.text);
  } catch (e) {
    log('[anon] erro no modelo: ' + (e?.message || e));
    return { blob, changed: false, applied: 0, error: String(e?.message || e) };
  }
  if (!Array.isArray(arr) || !arr.length) return { blob, changed: false, applied: 0 };

  // Applies the swaps by EXACT match. Never breaks syntax: if the find isn't
  // in the file, the swap is skipped. Guards against an empty/too-short find.
  let applied = 0;
  for (const o of arr) {
    if (!o || typeof o.file !== 'string' || typeof o.find !== 'string') continue;
    const rel = o.file.replace(/^\/+/, '');
    const find = o.find;
    const replace = typeof o.replace === 'string' ? o.replace : '';
    if (find.length < 2) continue;
    if (find === replace) continue;
    if (!(rel in decoded)) continue;
    if (!decoded[rel].includes(find)) continue;
    decoded[rel] = decoded[rel].split(find).join(replace);
    applied++;
  }
  if (!applied) return { blob, changed: false, applied: 0 };

  // Rebuilds the snapshot with the updated text files (binaries untouched).
  const out = { ...files };
  for (const rel of Object.keys(decoded)) {
    out[rel] = Buffer.from(decoded[rel], 'utf8').toString('base64');
  }
  const newBlob = buildSnapshot(out);
  if (!newBlob) return { blob, changed: false, applied: 0 };
  log(`[anon] ${applied} troca(s) aplicada(s) no snapshot`);
  return { blob: newBlob, changed: true, applied };
}
