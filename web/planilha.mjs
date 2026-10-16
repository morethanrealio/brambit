// ── Spreadsheet always via pandas (sandbox), never as text to the model ────────
// Every spreadsheet that arrives (chat attachment, Drive, OneDrive, Gmail, ler_arquivo)
// is written to the isolated container's /workspace for that user, opened with pandas and
// REGISTERED here. The model receives only the STRUCTURE (sheets, rows, column
// names), never the cells; any question about the content goes through the
// `analisar_planilha` meta-tool (server.mjs), which reads the WHOLE file by
// code and returns only the synthesis.
//
// Why (2026-10-01): the CSV preview (12k-40k characters) that used to be sent along
// truncated large spreadsheets, and the model answered "from memory" based on the part it
// saw, including saying something didn't exist when it was in the
// truncated rows. Because of that there is no longer any path back to text: if the
// analysis environment fails, the note says the spreadsheet couldn't be read.
import { sandboxEnabled, sandboxShell, sandboxWriteBytes } from './sandbox.mjs';

const TTL_MS = 6 * 60 * 60 * 1000; // 6h: allows follow-up questions
const MAX_PER_USER = 10;
const loaded = new Map(); // userId -> [{ path, filename, sheets, rows, ts }]

function prune(list) {
  const now = Date.now();
  return list.filter((e) => now - e.ts < TTL_MS).slice(-MAX_PER_USER);
}

export function registerLoadedSheet(userId, entry) {
  const list = prune(loaded.get(userId) || []);
  // Same spreadsheet reloaded (same path): replaces instead of duplicating.
  const filtered = list.filter((e) => e.path !== entry.path);
  filtered.push({ ...entry, ts: Date.now() });
  loaded.set(userId, filtered.slice(-MAX_PER_USER));
}

export function getLoadedSheets(userId) {
  const list = prune(loaded.get(userId) || []);
  loaded.set(userId, list);
  return list;
}

export function safeName(name) {
  const base = String(name || 'planilha')
    .replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return base || 'planilha';
}

// Canonical path of the spreadsheet inside the user's sandbox. Exported because
// EDITING (planilha-edit.mjs) needs the same path that loading uses —
// if the two diverge, the sub-agent edits one file and we read another.
export function sheetSandboxPath(filename) {
  return `/workspace/planilhas/${safeName(filename)}`;
}

// Spreadsheet type by name and by mime: 'excel' (xlsx/xlsm/xls), 'csv', 'tsv'
// or null when it's not a spreadsheet. The extension rules: Windows often sends CSV
// with Excel's mime (application/vnd.ms-excel), and opening a CSV as Excel fails.
const MIME_EXCEL = /officedocument\.spreadsheetml|ms-excel|google-apps\.spreadsheet/i;
export function tipoPlanilha(name = '', mime = '') {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return 'excel';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv') return 'tsv';
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m === 'text/csv' || m === 'application/csv') return 'csv';
  if (m === 'text/tab-separated-values') return 'tsv';
  if (MIME_EXCEL.test(m)) return 'excel';
  return null;
}

// Name with the extension matching the type: the sandbox's pandas and the sub-agent
// need to know from the name whether it's CSV or Excel (Google Sheets export, attachment
// without an extension).
function nomeComExtensao(filename, tipo) {
  const limpo = safeName(filename);
  if (tipoPlanilha(limpo) === tipo) return limpo;
  return `${limpo}.${tipo === 'excel' ? 'xlsx' : tipo}`;
}

// Script that runs in the sandbox: opens the whole spreadsheet with pandas and
// prints only the structure in JSON. Column and sheet names are truncated so
// they fit a short note; the cells never leave here.
const SONDA_PY = String.raw`
import sys, json, csv
import pandas as pd
caminho, tipo = sys.argv[1], sys.argv[2]
def ler_texto(sep):
    ultimo = None
    for enc in ('utf-8-sig', 'latin-1'):
        try:
            if sep is None:
                try:
                    return pd.read_csv(caminho, sep=None, engine='python', encoding=enc, dtype=str)
                except csv.Error:
                    return pd.read_csv(caminho, encoding=enc, dtype=str)
            return pd.read_csv(caminho, sep=sep, encoding=enc, dtype=str)
        except UnicodeDecodeError as e:
            ultimo = e
    raise ultimo
try:
    if tipo == 'csv':
        abas = {'(csv)': ler_texto(None)}
    elif tipo == 'tsv':
        abas = {'(tsv)': ler_texto('\t')}
    else:
        abas = pd.read_excel(caminho, sheet_name=None, dtype=object)
    saida = []
    for nome, df in abas.items():
        colunas = [str(c)[:60] for c in df.columns]
        saida.append({'nome': str(nome)[:60], 'linhas': int(len(df)), 'colunas': len(colunas), 'nomes': colunas[:50]})
    print(json.dumps({'ok': True, 'abas': saida}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'erro': (type(e).__name__ + ': ' + str(e))[:200]}, ensure_ascii=False))
`;

const aspas = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Roda a sonda no sandbox. Devolve { ok, abas } ou { ok:false, error }.
async function lerEstrutura(userId, path, tipo) {
  let res;
  try {
    res = await sandboxShell(userId, `python3 - ${aspas(path)} ${tipo} <<'SONDA_PY'\n${SONDA_PY}\nSONDA_PY`, 100_000);
  } catch (e) {
    return { ok: false, error: `ambiente de análise não respondeu (${e?.message || e})` };
  }
  if (res?.timedOut) return { ok: false, error: 'a leitura passou do tempo limite' };
  const linha = String(res?.stdout || '').trim().split('\n').at(-1) || '';
  let out;
  try { out = JSON.parse(linha); } catch { return { ok: false, error: (res?.stderr || 'resposta inválida da leitura').slice(0, 200) }; }
  if (!out.ok) return { ok: false, error: out.erro || 'erro ao abrir' };
  return { ok: true, abas: Array.isArray(out.abas) ? out.abas : [] };
}

function descreverAbas(abas) {
  return abas.map((a) => {
    const cols = a.nomes.length ? `: ${a.nomes.map((n) => `"${n}"`).join(', ')}${a.colunas > a.nomes.length ? `, e mais ${a.colunas - a.nomes.length}` : ''}` : '';
    return `- aba "${a.nome}": ${a.linhas} linha(s) de dados, ${a.colunas} coluna(s)${cols}`;
  }).join('\n');
}

// Failure note. There's no text fallback, on purpose (see top of the file).
export function notaPlanilhaIlegivel(filename, motivo) {
  return `⚠️ A planilha "${filename}" não pôde ser aberta no ambiente de análise (${motivo}). O conteúdo dela NÃO está disponível por nenhum outro caminho: diga ao usuário que não conseguiu ler a planilha agora e não descreva, cite nem suponha nada do que ela contém.`;
}

// Writes the bytes to the sandbox and registers them for analysis, WITHOUT reading the
// structure. This is the edit path (planilha-edit.mjs), which has its own
// verification and doesn't show the spreadsheet to the model.
export async function gravarPlanilhaNoSandbox(userId, buffer, filename) {
  if (!sandboxEnabled()) return { ok: false, error: 'ambiente de análise desligado' };
  const clean = safeName(filename);
  const path = sheetSandboxPath(clean);
  let w;
  try { w = await sandboxWriteBytes(userId, path, buffer); }
  catch (e) { return { ok: false, error: `ambiente de análise não respondeu (${e?.message || e})` }; }
  if (!w.ok) return { ok: false, error: w.error || 'falha ao gravar no ambiente' };
  registerLoadedSheet(userId, { path, filename: clean, sheets: null, rows: null });
  return { ok: true, path, filename: clean };
}

// Loads a spreadsheet for the conversation: writes it to the sandbox, opens it with pandas and
// returns the note that goes to the model, with only the structure. Always returns `note`
// (even on failure), so the caller isn't tempted to send the text.
// { ok, path, filename, sheets, rows, abas, note } | { ok:false, error, note }
export async function loadSpreadsheetIntoSandbox(userId, buffer, filename, { tipo = null, mime = '' } = {}) {
  const t = tipo || tipoPlanilha(filename, mime) || 'excel';
  const nome = nomeComExtensao(filename, t);
  const falha = (error) => ({ ok: false, error, filename: nome, note: notaPlanilhaIlegivel(nome, error) });
  const g = await gravarPlanilhaNoSandbox(userId, buffer, nome);
  if (!g.ok) return falha(g.error);
  const e = await lerEstrutura(userId, g.path, t);
  if (!e.ok) return falha(e.error);
  const sheets = e.abas.length;
  const rows = e.abas.reduce((s, a) => s + (Number(a.linhas) || 0), 0);
  registerLoadedSheet(userId, { path: g.path, filename: g.filename, sheets, rows });
  return {
    ok: true, path: g.path, filename: g.filename, sheets, rows, abas: e.abas,
    note: `📊 Planilha "${g.filename}" aberta no ambiente de análise. Estrutura:\n${descreverAbas(e.abas)}\nO conteúdo das células NÃO é mostrado aqui. Para qualquer pergunta sobre os dados desta planilha (buscar, listar, contar, somar, conferir um valor, resumir, comparar), use a tool analisar_planilha, que lê o arquivo inteiro por código. Não responda sobre o conteúdo sem ela.`,
  };
}

// For connectors (Drive, OneDrive, Gmail): loads via the onSheetLoad that the
// server injects and returns the note that goes in the result's "analise" field. Without
// onSheetLoad, or if it fails, the note is the failure one; never the text.
export async function analisePlanilhaConector(onSheetLoad, buffer, filename, mime = '') {
  if (typeof onSheetLoad !== 'function') return notaPlanilhaIlegivel(filename, 'ambiente de análise indisponível');
  try {
    const lr = await onSheetLoad(buffer, filename, mime);
    return lr?.note || notaPlanilhaIlegivel(filename, lr?.error || 'erro ao abrir');
  } catch (e) {
    return notaPlanilhaIlegivel(filename, String(e?.message ?? e).slice(0, 160));
  }
}

export default { registerLoadedSheet, getLoadedSheets, loadSpreadsheetIntoSandbox, gravarPlanilhaNoSandbox, notaPlanilhaIlegivel, analisePlanilhaConector, tipoPlanilha, sheetSandboxPath, safeName };
