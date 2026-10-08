// ── Spreadsheet editing BY CODE (WRITE path) ──
//
// Why this module exists. Until now the spreadsheet only had the "rewrite
// from scratch" write path: `gerar_documento` received the WHOLE TABLE in markdown
// in a tool argument and built the .xlsx. In a real conversation on 2026-09-09 the
// user's matrix passed 99 thousand characters, hit the recent-window blob
// cap (core-proto/core.mjs, capRecentBlob, TURN_RECENT_MAX) and, on the
// next regeneration, the model rebuilt the file from its OWN already-truncated
// previous call: the spreadsheet dropped from 62 rows / 18 sources to
// 21 rows, and the truncation marker was written as a DATA ROW inside the
// xlsx. Raising the cap's ceiling only postpones this.
//
// The fix is structural: the spreadsheet content never again passes through the
// model's context to be edited. The canonical spreadsheet comes from the
// library (S3), is written to the user's sandbox, a SUB-AGENT mutates it with openpyxl
// (raw data dies in the worker) and the bytes come back via `sandboxReadBytes`. The main agent
// only sees a summary of what changed.
//
// Three invariants this module has to preserve:
//  1. Each generation is a NEW ASSET in S3, never an overwrite. It was exactly
//     this property that allowed recovering the user's 13 versions after the
//     incident. The new version keeps the canonical name; the one that was canonical is
//     RENAMED to `name_yyyymmddhhmmss.ext` (only the caption in the database changes — the
//     bytes of no version are touched).
//  2. Atomicity: a script that fails (or a file that comes back corrupted) does not generate
//     an asset and does not touch Drive. The error goes back to the model to decide. When the
//     error is SILENT (valid xlsx, but lost content), the edit is REDONE
//     from the original bytes — a bad file is never delivered nor is the
//     user told to "look at the previous version": either the change comes out right, or nothing changes.
//  3. Serialization per user: overlapping turns ("add 4 rows" and, before
//     finishing, "fix the year on ART-07") would run two sub-agents against the
//     SAME file, and the second would reload the S3 copy on top of the first's
//     work — silent loss of an edit. The queue below solves this.

import { sheetSandboxPath } from './planilha.mjs';

// ── Pure logic (testable offline, without a database or sandbox) ──

// Marker that capRecentBlob injects in the middle of a truncated blob. If it appears
// in content the model is sending to WRITE, the model is copying its
// own truncated call — this was the mechanism of the 2026-09-09 incident.
export const CUT_MARKER_RE = /…\[cortado: ?\d+ chars\]…/;

export function hasCutMarker(s) {
  return typeof s === 'string' && CUT_MARKER_RE.test(s);
}

// Sub-agent attempts per edit. 2 = the original plus one redone with the
// diagnosis of what went wrong. Only the 2nd costs tokens, and only when the 1st failed.
const MAX_TENTATIVAS = 2;

const SHEET_EXT_RE = /\.(xlsx|xlsm)$/i;
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);

export function isSheetAsset(a) {
  if (!a) return false;
  if (SHEET_MIMES.has(String(a.mime || '').toLowerCase())) return true;
  return SHEET_EXT_RE.test(String(a.caption || ''));
}

// Picks WHICH asset to edit. Without an explicit id, the newest spreadsheet:
// older ones are version history (decided 09/09/2026).
// `assets` comes from listMediaAssets, already ordered by created_at DESC.
export function pickSheetAsset(assets, { id = null } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  if (id != null && String(id).trim() !== '') {
    const found = list.find((a) => String(a.id) === String(id));
    if (!found) return { error: 'Não achei esse arquivo na biblioteca.' };
    if (!isSheetAsset(found)) return { error: `O arquivo ${id} ("${found.caption || 'sem nome'}") não é uma planilha .xlsx.` };
    return { asset: found };
  }
  const found = list.find(isSheetAsset);
  if (!found) return { error: 'Não achei nenhuma planilha na biblioteca deste usuário. Gere a planilha primeiro (gerar_documento com formato xlsx) e depois edite.' };
  return { asset: found };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Name of the ARCHIVED version: `name_yyyymmddhhmmss.ext`, with the creation
// timestamp of that version itself (not the current one) — this way the history stays
// sortable and the name tells when that content was born. Without a usable date, it falls back to `_v` + id.
export function versionedCaption(caption, createdAt, { id = null } = {}) {
  const raw = String(caption || 'planilha.xlsx');
  const m = raw.match(SHEET_EXT_RE);
  const ext = m ? m[0] : '';
  const base = ext ? raw.slice(0, -ext.length) : raw;
  const d = createdAt instanceof Date ? createdAt : (createdAt ? new Date(createdAt) : null);
  if (!d || Number.isNaN(d.getTime())) return `${base}_v${id ?? 'antiga'}${ext}`;
  const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return `${base}_${stamp}${ext}`;
}

// Queue by key: guarantees that two edits of the same user never run
// overlapped. Each call waits for the previous one to FINISH (even when it
// fails) and only then runs — this is what makes "always reload from S3" correct,
// because the second edit already picks up the asset the first one just wrote.
const chains = new Map(); // key -> Promise of the last queued operation

export function withKeyLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // runs even if the previous one rejected
  // Keeps the chain alive but without leaking a rejection out of the queueing.
  const tail = next.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

// Deterministic summary of what changed in the file's DIMENSIONS (rows/sheets). It is
// counted from the bytes, not from the sub-agent's narrative: if it says "I added
// 4 rows" and the file lost 40, this shows it.
export function describeDelta(before, after) {
  const parts = [];
  const b = before || {}, a = after || {};
  if (a.rows != null && b.rows != null && a.rows !== b.rows) {
    const d = a.rows - b.rows;
    parts.push(`linhas ${b.rows} → ${a.rows} (${d > 0 ? '+' : ''}${d})`);
  } else if (a.rows != null) {
    parts.push(`linhas ${a.rows} (sem mudança na contagem)`);
  }
  if (a.sheets != null && b.sheets != null && a.sheets !== b.sheets) {
    parts.push(`abas ${b.sheets} → ${a.sheets}`);
  } else if (a.sheets != null) {
    parts.push(`${a.sheets} aba(s)`);
  }
  return parts.join(', ');
}

// Word the sub-agent writes in the summary to confirm that the spreadsheet
// shrank ON PURPOSE (the instruction asked for removal). Without it, a large
// shrink is treated as an error and the edit is redone.
export const DECLARACAO_REMOCAO = 'REMOCAO_INTENCIONAL';

export function declarouRemocao(resumo) {
  const s = String(resumo || '').toUpperCase();
  return s.includes('REMOCAO_INTENCIONAL') || s.includes('REMOÇÃO_INTENCIONAL');
}

// ── Round-trip fidelity: the file's internal PARTS ──
//
// An .xlsx is a ZIP. Chart, image, pivot table and macro are separate
// PARTS (xl/charts/, xl/media/, xl/pivotCache/, xl/vbaProject.bin). When a
// script recreates the file — or when the lib doesn't understand the part — it simply
// DISAPPEARS from the zip, with no error at all. Comparing the list of parts before/after catches
// this whole class of damage, including features I can't
// test here (pivot table, macro, slicer), without needing to predict each one.
//
// The policy has two levels because a single level would break the tool:
//  • lost CONTENT part = ERROR (redo; if it persists, don't save). Measured:
//    without Pillow installed, openpyxl deletes xl/drawings/* and xl/media/* IN
//    SILENCE — this is exactly that case.
//  • lost ACCESSORY part = just a WARNING. Measured on a real .xlsx from Excel: the
//    round-trip loses customXml/* (9 parts), docMetadata/LabelInfo.xml (sensitivity
//    label) and xl/sharedStrings.xml (openpyxl writes inline strings —
//    not a content loss). Treating this as an error would make any spreadsheet
//    coming from Excel impossible to edit.
const PECA_ACESSORIA_RE = new RegExp([
  '^customxml/',                            // XML customizado do Office
  '^docmetadata/',                          // sensitivity label (MIP)
  '^docprops/',                             // author, title, editing time
  '^xl/sharedstrings\\.xml$',               // openpyxl grava string inline
  '^xl/calcchain\\.xml$',                   // calculation chain cache (Excel rebuilds it)
  '^xl/metadata\\.xml$',
  '^xl/richdata/', '^xl/rdrichvalue',       // tipos de dado ricos
  '^xl/threadedcomments/', '^xl/persons/',  // comment with thread
  '^xl/revisions/', '^xl/usernames\\.xml$',
].join('|'), 'i');

// Parts that existed in the original and do not exist in the saved file, separated by
// severity. Without a list of parts on both sides, it offers no opinion.
export function pecasPerdidas(before, after) {
  const b = Array.isArray(before?.parts) ? before.parts : null;
  const a = Array.isArray(after?.parts) ? after.parts : null;
  if (!b || !a) return { conteudo: [], acessorias: [] };
  const tem = new Set(a.map((n) => String(n).toLowerCase()));
  const conteudo = [], acessorias = [];
  for (const n of b) {
    if (tem.has(String(n).toLowerCase())) continue;
    (PECA_ACESSORIA_RE.test(String(n)) ? acessorias : conteudo).push(n);
  }
  return { conteudo, acessorias };
}

// SILENT failure: the script ran with no error and saved a VALID xlsx, and
// still the result is wrong (recreated the file instead of editing, saved to
// another path, wrote truncated content). No technical check catches
// this — the only defense is to measure the file and compare it with the one before.
// Returns null when it's good, or { motivo, instrucao } to REDO the edit.
export function detectarProblema({ before, after, resumo, identical = false }) {
  if (identical) {
    return {
      motivo: 'o arquivo voltou byte a byte idêntico ao original: nada foi alterado',
      instrucao: 'Você salvou no MESMO caminho que recebeu? Reabra o arquivo, aplique a mudança e salve exatamente nesse caminho.',
    };
  }
  if (hasCutMarker(after?.text)) {
    return {
      motivo: 'a planilha contém o marcador de corte "…[cortado: N chars]…" como DADO dentro de uma célula',
      instrucao: 'Isso é texto truncado escrito na planilha. Apague essas células/linhas e aplique a mudança sobre o conteúdo real do arquivo.',
    };
  }
  const perdidas = pecasPerdidas(before, after);
  if (perdidas.conteudo.length) {
    return {
      motivo: `o arquivo salvo perdeu ${perdidas.conteudo.length} peça(s) interna(s) que existiam no original: ${perdidas.conteudo.slice(0, 6).join(', ')}`,
      instrucao: 'Isso é gráfico, imagem, tabela dinâmica ou macro que DESAPARECEU do arquivo — sinal de que ele foi recriado em vez de editado, ou de que faltou uma dependência da lib. Instale Pillow junto do openpyxl (sem Pillow o openpyxl apaga as imagens em silêncio), abra o original com load_workbook SEM data_only, mude só o que a instrução pede e salve no mesmo caminho. Planilha .xlsm com macro: use keep_vba=True.',
    };
  }
  const bf = Number(before?.formulas), af = Number(after?.formulas);
  if (Number.isFinite(bf) && Number.isFinite(af) && bf >= 5 && af < bf * 0.7 && !declarouRemocao(resumo)) {
    return {
      motivo: `as fórmulas da planilha viraram valores estáticos (${bf} → ${af} fórmulas)`,
      instrucao: 'Você abriu a planilha com load_workbook(..., data_only=True). Isso descarta TODAS as fórmulas e grava só o último valor que o Excel havia calculado. Abra SEM data_only e refaça. Se precisar do valor calculado pra alguma conta, abra uma SEGUNDA cópia com data_only=True só pra ler, e salve sempre a primeira.',
    };
  }
  const b = Number(before?.rows) || 0, a = Number(after?.rows) || 0;
  if (b >= 10 && a < b * 0.7 && !declarouRemocao(resumo)) {
    return {
      motivo: `a planilha encolheu de ${b} para ${a} linhas`,
      instrucao: `A instrução não pedia remoção em massa — você provavelmente recriou o arquivo em vez de editá-lo no lugar. Refaça preservando TODAS as ${b} linhas que já existiam. Se a remoção REALMENTE era o que a instrução pedia, escreva a palavra ${DECLARACAO_REMOCAO} no seu resumo pra confirmar que foi de propósito.`,
    };
  }
  return null;
}

// ── Question channel: the sub-agent can ask instead of guessing ──
//
// "Update the status column" in a spreadsheet with three sheets and two similar
// columns is ambiguous. Guessing the wrong interpretation generates a new,
// plausible and WRONG version — the worst possible outcome, because the user has no way to
// know. With this sentinel the sub-agent returns the QUESTION, nothing is saved and
// the user is the one who decides.
export const SENTINELA_CLARIFICACAO = 'PRECISO_DE_CLARIFICACAO';

export function pedeClarificacao(resumo) {
  const m = String(resumo || '').match(/PRECISO[_ ]DE[_ ]CLARIFICA[CÇ][AÃ]O\s*:?\s*([\s\S]*)/i);
  if (!m) return null;
  const pergunta = String(m[1] || '').split(/\r?\n\s*\r?\n/)[0].trim();
  return pergunta || 'O editor precisou de mais detalhes pra aplicar a mudança, mas não disse quais.';
}

// ── Cell evidence: content verification, from the outside ──
//
// The checks above are dimensional (rows, sheets, parts, formulas): they catch
// a destroyed file, not a change made in the wrong place. So the sub-agent
// DECLARES the cells it changed ("EVIDENCIA: Artigos!C8=2019") and the orchestrator
// re-reads exactly those cells from the SAVED bytes to confirm. Costs almost no
// tokens (only the refs go back into context, never the spreadsheet) and turns "the
// sub-agent said it did it" into "it's in the file."
const MAX_EVIDENCIAS = 20;
const REF_A1_RE = /^(?:'?[^!']+'?!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$/;

export function parseEvidencia(resumo, { max = MAX_EVIDENCIAS } = {}) {
  const out = [];
  for (const linha of String(resumo || '').split(/\r?\n/)) {
    const m = linha.match(/^\s*[-•*]?\s*EVID[EÊ]NCIAS?\s*:\s*(.+)$/i);
    if (!m) continue;
    for (const item of m[1].split(/\s*[;|]\s*/)) {
      const p = item.match(/^([^=]+?)\s*=\s*([\s\S]*)$/);
      if (!p) continue;
      const ref = p[1].trim().replace(/^[`"']+|[`"']+$/g, '');
      if (!REF_A1_RE.test(ref)) continue;
      const esperado = p[2].trim().replace(/^[`"“]+|[`"”]+$/g, '');
      out.push({ ref, esperado });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function normTexto(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Numeric candidates for a value declared in Portuguese ("1.234,56", "R$ 80",
// "15%"). Percentage returns two candidates because there's no way to know whether the
// declared value is the stored fraction (0.15) or the formatted appearance (15%).
function numerosDe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? [v] : [];
  let s = String(v ?? '').trim();
  if (!s) return [];
  const pct = /%$/.test(s);
  s = s.replace(/^(r\$|us\$|\$|€|£)\s*/i, '').replace(/%$/, '').trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/\s/g, '');
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return [];
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return [];
  return pct ? [n / 100, n] : [n];
}

function pareceData(s) {
  return /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/.test(String(s || ''))
    || /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/i.test(String(s || ''));
}

// Compares what the sub-agent declared with what's recorded. Deliberately
// conservative: only flags an error when the cell is clearly different, doesn't exist,
// or is on a nonexistent sheet. A doubtful case (date became a serial number, cell
// is a formula not yet calculated) goes into `naoVerificaveis` — becomes a warning, not a
// reason to discard a probably correct edit.
export function conferirEvidencia(evidencias, lidas) {
  const porRef = new Map((lidas || []).map((c) => [String(c.ref), c]));
  const erros = [], naoVerificaveis = [];
  let conferidas = 0;
  for (const ev of evidencias || []) {
    const cel = porRef.get(ev.ref);
    if (!cel || cel.invalid) { naoVerificaveis.push(`${ev.ref} (não consegui reler essa referência)`); continue; }
    if (cel.noSheet) { erros.push(`${ev.ref}: essa aba não existe no arquivo salvo`); continue; }
    if (!cel.exists) { erros.push(`${ev.ref}: célula VAZIA no arquivo salvo, mas você declarou "${ev.esperado}"`); continue; }

    // Declared formula: openpyxl doesn't recalculate, so the value stays empty —
    // what's checked is the formula's TEXT.
    if (/^=/.test(ev.esperado)) {
      const gravada = cel.formula ? `=${cel.formula}` : '';
      if (normTexto(gravada.replace(/\s+/g, '')) === normTexto(ev.esperado.replace(/\s+/g, ''))) conferidas++;
      else if (!cel.formula) erros.push(`${ev.ref}: você declarou a fórmula ${ev.esperado}, mas a célula salva não tem fórmula`);
      else erros.push(`${ev.ref}: a fórmula salva é =${cel.formula}, você declarou ${ev.esperado}`);
      continue;
    }
    if (cel.formula && !String(cel.value || '')) {
      naoVerificaveis.push(`${ev.ref} (é fórmula: o valor só existe depois de o Excel recalcular)`);
      continue;
    }

    const esp = numerosDe(ev.esperado), got = numerosDe(cel.value);
    if (esp.length && got.length) {
      const bate = esp.some((x) => got.some((y) => Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-9)));
      if (bate) conferidas++;
      else erros.push(`${ev.ref}: valor salvo ${cel.value}, você declarou ${ev.esperado}`);
      continue;
    }
    // Date stored as an Excel serial number vs. declared as text (or the
    // other way around): correct, but not comparable here.
    if (esp.length !== got.length && (pareceData(ev.esperado) || pareceData(cel.value))) {
      naoVerificaveis.push(`${ev.ref} (data: declarada "${ev.esperado}", gravada como "${cel.value}")`);
      continue;
    }
    const a = normTexto(ev.esperado), b = normTexto(cel.value);
    if (a === b || (a && b && (b.includes(a) || a.includes(b)))) conferidas++;
    else erros.push(`${ev.ref}: valor salvo "${cel.value}", você declarou "${ev.esperado}"`);
  }
  return { total: (evidencias || []).length, conferidas, erros, naoVerificaveis };
}

// ── Prompt do sub-agente EDITOR ──

export const SHEET_EDITOR_SYSTEM = `You are a SPREADSHEET EDITOR sub-agent. You receive ONE Excel spreadsheet ALREADY SAVED at a path in the /workspace of the isolated environment and a change instruction in natural language. Your task is to APPLY the change to the file, with CODE, and return only a SUMMARY of what changed.

Rules (follow them strictly):
• EDIT THE FILE IN PLACE. Open it with openpyxl, change it and save it to THE SAME PATH you received. NEVER rebuild the spreadsheet from scratch and NEVER write to a new file: the sheets, rows, formulas and formatting the instruction does not mention must stay exactly as they are. The spreadsheet belongs to the USER and may have charts, images, formulas, conditional formatting, validation, filters and frozen panes; all of that must survive.
• If openpyxl is missing: sandbox_shell "pip install --break-system-packages --target=/workspace/.pylibs openpyxl Pillow" and, in python, sys.path.insert(0, '/workspace/.pylibs') before the import. ALWAYS install Pillow too: without it openpyxl silently DELETES the spreadsheet's images, and the edit is rejected for lost content. (The rootfs is read-only; installing system-wide does not work.)
• NEVER open with load_workbook(..., data_only=True) to save: that erases ALL formulas and stores only the last calculated value. If you need the calculated value for a calculation, open a SECOND copy with data_only=True only to READ, and always save the first one. .xlsm file: load_workbook(..., keep_vba=True), otherwise the macro dies.
• BEFORE changing anything, INSPECT: list the sheets (wb.sheetnames), the header and the row count of each one (ws.max_row), and locate with CODE the row/column the instruction points to (search by the cell value; do not count rows "by eye"). Print what you found.
• CELL FORMAT: a new row starts with the "General" format. When adding rows, COPY the number_format (and alignment, if any) from the equivalent cell of the last existing row, column by column; otherwise the column becomes mixed and sums/sorting break. Dates: write a datetime object, not a string. Money/percentages: write a number (0.15, not "15%") and let number_format handle the appearance.
• AFTER saving, REOPEN the file and print the check: sheets, ws.max_row per sheet, and the rows you touched. If the row count dropped without the instruction asking for removal, you made a mistake: fix it before answering.
• If the instruction ASKED for removal and the spreadsheet shrank on purpose, write the word REMOCAO_INTENCIONAL in your summary. Without it, a large shrink is treated as an error and the edit is redone from scratch.
• Do NOT calculate in your head. Any total, count or average comes from code.
• If the instruction is ambiguous but ONE interpretation is clearly the most reasonable, follow it and STATE the assumption you made. If the ambiguity is real (two sheets fit, it is unclear which column, the value matches nothing in the file), do NOT guess and do NOT save: answer with the line "${SENTINELA_CLARIFICACAO}: <the question that resolves it>" and stop. Same if it is impossible (sheet/column does not exist, unreadable file): say objectively what was missing.
• EVIDENCE (required): in the summary, declare the cells you changed and the value now in them, one per line, in this exact format:
EVIDENCIA: Sheet!C8=1234.50
Use at most 20 (the most representative ones if you changed a lot). Formula: declare the formula text, starting with = (e.g. EVIDENCIA: Summary!D2==SUM(B2:B10)). These cells are RE-READ from the saved file by code: if what you declared is not there, the edit is redone. Do not invent evidence; declare only what you checked by reopening the file.
• FINAL ANSWER: only the SUMMARY of the change: what changed, in which sheet, how many rows were affected, the assumptions and the EVIDENCIA lines. Do NOT paste the spreadsheet content, do NOT list all the rows, do NOT return a table: the spreadsheet content must not go back to the main agent. At most ~10 lines of text besides the evidence.`;

// ── Orchestration ──
//
// All dependencies come in via parameter (`deps`) so this flow can be
// tested offline, without a database, S3 or sandbox — which includes the
// paths that matter: script failure (no asset written) and overlapping edits
// (the second part of the file the first one wrote).
//
// deps:
//   listAssets(userId, { limit })   -> [asset]
//   getAsset(userId, id)            -> asset | null
//   fetchBytes(s3Key)               -> { buffer, contentType }
//   loadIntoSandbox(userId, buffer, filename) -> { ok, path, filename, sheets, rows }
//   readBytes(userId, path)         -> { ok, buffer } | { ok:false, error }
//   inspect(buffer)                 -> { sheets, rows, text, parts?, formulas? }  (throws if corrupted)
//   readCells(buffer, refs)         -> [{ ref, exists, value, formula, ... }]  (optional)
//   runEditor({ objetivo, path, filename, sheets, rows, tentativa }) -> string
//   saveAsset({ buffer, ext, mime, caption }) -> { url, key, assetId }
//   renameAsset(userId, id, caption) -> boolean
export async function editSpreadsheet({ userId, objetivo, id = null, deps }) {
  if (!objetivo || !String(objetivo).trim()) return { ok: false, error: 'objetivo vazio.' };
  // Serializes by USER (not by file): the asset choice happens INSIDE
  // the lock, so the second edit sees the version the first one saved.
  return withKeyLock(`sheet:${userId}`, () => editOnce({ userId, objetivo, id, deps }));
}

async function editOnce({ userId, objetivo, id, deps }) {
  const assets = id != null && String(id).trim() !== ''
    ? [await deps.getAsset(userId, id)].filter(Boolean)
    : await deps.listAssets(userId, { limit: 40 });
  const pick = pickSheetAsset(assets, { id });
  if (pick.error) return { ok: false, error: pick.error };
  const asset = pick.asset;

  // Always reloads from S3: the loaded-spreadsheets registry is an in-process
  // in-memory Map with a 6h TTL (planilha.mjs), so it's empty after
  // every service restart — and a spreadsheet GENERATED by gerar_documento never went
  // through the sandbox. Reloading is cheap and guarantees the sub-agent edits the
  // canonical version, not a stale copy left in /workspace.
  let src;
  try { src = await deps.fetchBytes(asset.s3_key); } catch (e) { src = null; }
  if (!src || !src.buffer) return { ok: false, error: 'Não consegui ler os bytes da planilha na biblioteca.' };

  let before;
  try { before = deps.inspect(src.buffer); }
  catch (e) { return { ok: false, error: `A planilha da biblioteca não abriu (${e?.message ?? e}).` }; }

  // Redoes the edit when the result comes out wrong WITHOUT a technical error (recreated
  // the file, saved to another path, wrote truncated content). Returning "look at
  // the previous version" would dump the problem on the user, who asked for a
  // change and would be left without it. Each attempt starts from the ORIGINAL bytes: the
  // loadIntoSandbox overwrites the broken file from the previous attempt.
  const filename = asset.caption || 'planilha.xlsx';
  const podeConferir = typeof deps.readCells === 'function';
  let out = null, after = null, resumo = null, problema = null, tentativas = 0;
  let evid = null, clarificacao = null, semProva = true, motivoSemProva = null;
  for (let t = 1; t <= MAX_TENTATIVAS; t++) {
    tentativas = t;
    const load = await deps.loadIntoSandbox(userId, src.buffer, filename);
    if (!load?.ok) return { ok: false, error: `Não consegui carregar a planilha no ambiente: ${load?.error || 'erro'}.` };
    const path = load.path || sheetSandboxPath(filename);

    const correcao = problema
      ? `\n\nATENÇÃO — a sua tentativa anterior deu errado: ${problema.motivo}. O arquivo foi RESTAURADO pro estado original (${before.rows} linhas, ${before.sheets} aba(s)); comece de novo dele. ${problema.instrucao}`
      : '';
    try {
      resumo = await deps.runEditor({
        objetivo: objetivo + correcao, path, filename: load.filename || filename,
        sheets: before.sheets, rows: before.rows, tentativa: t,
      });
    } catch (e) {
      return { ok: false, error: `O editor falhou: ${e?.message ?? e}. Nada foi gravado; a planilha da biblioteca está intacta.` };
    }

    // Real ambiguity: the editor returns the QUESTION instead of guessing. It doesn't save
    // anything and doesn't repeat the attempt — insisting with the same ambiguous instruction would only
    // spend tokens to reach the same place. The main agent asks the
    // user and calls the tool again with the resolved instruction.
    clarificacao = pedeClarificacao(resumo);
    if (clarificacao) {
      return {
        ok: false, tentativas, clarificacao,
        error: `A instrução ficou ambígua pro editor e ele preferiu perguntar em vez de adivinhar. NÃO gravei nada — a planilha do usuário continua íntegra e com o mesmo nome. Pergunte ao usuário: ${clarificacao}`,
      };
    }

    out = await deps.readBytes(userId, path);
    if (!out?.ok || !out.buffer?.length) {
      return { ok: false, error: `Não consegui reler a planilha editada do ambiente (${out?.error || 'arquivo vazio'}). Nada foi gravado: a planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
    }
    try { after = deps.inspect(out.buffer); }
    catch (e) {
      return { ok: false, error: `A planilha editada saiu corrompida (${e?.message ?? e}). NÃO gravei nada: a planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
    }

    problema = detectarProblema({ before, after, resumo, identical: out.buffer.equals(src.buffer) });

    // Evidence check: the editor declares the cells it changed and we
    // RE-READ exactly those cells from the saved bytes. It's the only way to catch
    // the error that no count catches — the spreadsheet stayed intact, the right
    // size, and the value was written in the wrong place (or not written at all). The
    // comparison is deliberately loose (number by value, text by content,
    // formula by text) because a false positive here would throw a good edit away.
    // Each attempt needs its own proof: previous success/error proves
    // nothing about this attempt's bytes. Lack of a read never becomes a success.
    evid = null;
    semProva = true;
    motivoSemProva = 'A conferência das células não está disponível nesta execução.';
    if (!problema && podeConferir) {
      motivoSemProva = 'Não consegui reler as células declaradas para conferir a alteração.';
      const declaradas = parseEvidencia(resumo);
      if (declaradas.length) {
        let lidas = null;
        try { lidas = await deps.readCells(out.buffer, declaradas.map((e) => e.ref)); }
        catch { lidas = null; }
        if (Array.isArray(lidas)) {
          evid = conferirEvidencia(declaradas, lidas);
          semProva = evid.total === 0 || evid.conferidas !== evid.total || evid.erros.length > 0 || evid.naoVerificaveis.length > 0;
          motivoSemProva = 'Não foi possível conferir todas as células declaradas.';
          if (evid.erros.length) {
            problema = {
              motivo: `as células que você disse ter mudado não conferem no arquivo salvo: ${evid.erros.slice(0, 4).join('; ')}`,
              instrucao: 'Ou você escreveu no lugar errado, ou salvou num caminho diferente do que recebeu, ou declarou uma evidência que não conferiu. Reabra o arquivo ORIGINAL, localize a célula por código (procurando o valor, não contando linhas), escreva, salve no MESMO caminho, REABRA e leia de volta as células antes de declarar EVIDENCIA.',
            };
          }
        }
      } else {
        // Without evidence there's nothing to check. A second pass asking for it is worth
        // it, but refusing the edit at the end is not: delivering with a caveat is
        // better than spending the user's tokens and delivering nothing. That's why
        // semEvidencia only becomes a `problema` (= redo) while attempts remain; on the
        // last one it's kept only as a flag and the edit is saved with a warning.
        semProva = true;
        motivoSemProva = 'O editor não declarou as células que mudou.';
        if (t < MAX_TENTATIVAS) {
          problema = {
            motivo: 'você não declarou nenhuma célula no formato EVIDENCIA: Aba!C8=valor, então não tive como conferir se a mudança foi pro lugar certo',
            instrucao: 'Refaça a partir do original e, no resumo, inclua uma linha "EVIDENCIA: Aba!Celula=valor" por célula que você mudou (até 20), com o valor lido DEPOIS de reabrir o arquivo salvo.',
          };
        }
      }
    }
    if (!problema) break;
  }
  // Ran out of attempts: saves nothing. The user's spreadsheet stays exactly
  // as it was, with the same name — there is no "previous version" for them to hunt down,
  // and the model has a concrete reason to explain what didn't work out.
  // Exception: lack of evidence is not a defect in the spreadsheet, it's a lack of proof. The
  // file passed all the objective checks (wasn't recreated, didn't
  // shrink, didn't lose a part, has no truncation marker). In this case it saves and
  // warns that the change wasn't checked cell by cell.
  if (problema) {
    return {
      ok: false, tentativas,
      error: `Tentei ${tentativas}x e não consegui aplicar a mudança: ${problema.motivo}. NÃO gravei nada — a planilha do usuário continua íntegra e com o mesmo nome. Explique pro usuário que a mudança não foi aplicada (não ofereça "versão anterior": a atual já é a boa) e, se der, peça a mudança em partes menores ou mais específica. Último relato do editor: ${resumo}`,
    };
  }

  // Saves the NEW version first (with the canonical name) and only then archives
  // the previous one. In this order, a rename failure leaves two rows with the same
  // name — recoverable, and the newest one keeps winning by created_at DESC.
  // In the reverse order, a save failure would lose the canonical name.
  const caption = filename;
  const ext = (String(caption).match(SHEET_EXT_RE)?.[0] || '.xlsx').slice(1).toLowerCase();
  let saved;
  try {
    saved = await deps.saveAsset({
      buffer: out.buffer, ext,
      mime: asset.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      caption,
    });
  } catch (e) {
    return { ok: false, error: `Não consegui salvar a planilha editada na biblioteca (${e?.message ?? e}). A planilha do usuário continua íntegra e com o mesmo nome, só não recebeu a mudança.` };
  }
  let arquivada = null;
  try {
    arquivada = versionedCaption(caption, asset.created_at, { id: asset.id });
    await deps.renameAsset(userId, asset.id, arquivada);
  } catch (e) { arquivada = null; }

  const avisos = [];
  if (declarouRemocao(resumo) && (Number(after.rows) || 0) < (Number(before.rows) || 0)) {
    avisos.push(`O editor removeu linhas de propósito (${before.rows} → ${after.rows}), por entender que a instrução pedia isso. Confirme com o usuário se era essa a intenção.`);
  }
  if (tentativas > 1) {
    avisos.push(`Precisei de ${tentativas} tentativas: a primeira saiu errada e foi refeita a partir do arquivo original.`);
  }
  const acessorias = pecasPerdidas(before, after).acessorias;
  if (acessorias.length) {
    avisos.push(`A regravação descartou metadado interno do Excel (${acessorias.slice(0, 4).join(', ')}). Não afeta dados, fórmulas nem formatação — o Excel recria na próxima vez que salvar.`);
  }
  if (semProva) {
    avisos.push(`${motivoSemProva} NÃO consegui conferir célula a célula toda a alteração. O arquivo passou nas verificações estruturais disponíveis, mas isso não comprova a correção de todo o conteúdo. Informe essa limitação ao usuário; não apresente o resultado como integralmente conferido.`);
  }
  if (evid && evid.erros.length === 0 && evid.conferidas > 0) {
    avisos.push(`Conferido por código: reli ${evid.conferidas} de ${evid.total} célula(s) declarada(s) direto do arquivo salvo e os valores batem segundo os critérios do verificador. Isso não valida células não declaradas nem a autenticidade das fontes.`);
  }
  if (evid && evid.naoVerificaveis.length) {
    avisos.push(`Não deu pra conferir por código: ${evid.naoVerificaveis.slice(0, 3).join('; ')}.`);
  }
  return {
    ok: true, tentativas,
    asset: { id: saved.assetId ?? null, key: saved.key, url: saved.url, caption, mime: asset.mime, ext },
    before, after,
    delta: describeDelta(before, after),
    evidencia: evid,
    avisos,
    arquivada,
    resumo,
  };
}

export default {
  editSpreadsheet, pickSheetAsset, versionedCaption, hasCutMarker, describeDelta,
  detectarProblema, declarouRemocao, withKeyLock, isSheetAsset,
  pecasPerdidas, pedeClarificacao, parseEvidencia, conferirEvidencia, SENTINELA_CLARIFICACAO,
};
