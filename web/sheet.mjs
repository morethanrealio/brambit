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
// EDITING (sheet-edit.mjs) needs the same path that loading uses —
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
//
// A CSV whose quoting breaks the strict reader (a quote inside a quoted field, as in
// SciELO exports, 2026-11-01) is read tolerantly: first keeping quotes as the
// standard reader does, then, if a quote never closes, taking quotes as text. No
// line is dropped: a line with more fields than the header keeps them in extra
// columns, and those lines are counted. (Dropping them made the analyst, which
// reads the clean copy, contradict the note and miss rows, 2026-11-09.) The
// tolerant result is written back over the sandbox copy as a clean CSV, so the
// analyst's plain read_csv opens it too.
const SONDA_PY = String.raw`
import sys, json, csv, warnings
import pandas as pd
caminho, tipo = sys.argv[1], sys.argv[2]
tolerante = None
def separador(enc):
    with open(caminho, encoding=enc, newline='') as f:
        cabecalho = f.readline()
    try:
        return csv.Sniffer().sniff(cabecalho, delimiters=',;\t|').delimiter
    except csv.Error:
        return ','
def cabecalho_unico(valores):
    nomes, vistos = [], {}
    for i, v in enumerate(valores):
        n = 'Unnamed: %d' % i if v is None or pd.isna(v) or str(v) == '' else str(v)
        if n in vistos:
            vistos[n] += 1
            n = '%s.%d' % (n, vistos[n])
        else:
            vistos[n] = 0
        nomes.append(n)
    return nomes
def ler_tolerante(sep, enc):
    global tolerante
    ultimo = None
    for quoting in (csv.QUOTE_MINIMAL, csv.QUOTE_NONE):
        # Widths counted here, not by pandas: pandas drops longer lines, turns the
        # first column into the index when the first data line is longer, or cuts
        # the extra fields, all without a word.
        with open(caminho, encoding=enc, newline='') as f:
            larguras = [len(l) for l in csv.reader(f, delimiter=sep, quoting=quoting) if l]
        if not larguras:
            break
        largura = max(larguras)
        try:
            with warnings.catch_warnings(record=True) as avisos:
                warnings.simplefilter('always')
                df = pd.read_csv(caminho, sep=sep, encoding=enc, dtype=str, quoting=quoting, header=None, names=range(largura), on_bad_lines='warn')
        except pd.errors.ParserError as e:
            ultimo = e
            continue
        if not len(df):
            break
        cab = larguras[0]
        df.columns = cabecalho_unico(list(df.iloc[0])[:cab]) + ['extra_%d' % i for i in range(1, largura - cab + 1)]
        df = df.iloc[1:].reset_index(drop=True)
        df.to_csv(caminho, index=False, sep=sep, encoding='utf-8')
        tolerante = {'longas': sum(1 for w in larguras[1:] if w > cab), 'puladas': sum(str(a.message).count('Skipping line') for a in avisos)}
        return df
    if ultimo:
        raise ultimo
    raise pd.errors.EmptyDataError('No columns to parse from file')
def ler_texto(sep):
    ultimo = None
    for enc in ('utf-8-sig', 'latin-1'):
        try:
            try:
                if sep is None:
                    try:
                        return pd.read_csv(caminho, sep=None, engine='python', encoding=enc, dtype=str)
                    except csv.Error:
                        return pd.read_csv(caminho, encoding=enc, dtype=str)
                return pd.read_csv(caminho, sep=sep, encoding=enc, dtype=str)
            except (pd.errors.ParserError, csv.Error):
                return ler_tolerante(sep or separador(enc), enc)
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
    print(json.dumps({'ok': True, 'abas': saida, 'tolerante': tolerante}, ensure_ascii=False))
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
  return { ok: true, abas: Array.isArray(out.abas) ? out.abas : [], tolerant: out.tolerante ? { long: Number(out.tolerante.longas) || 0, skipped: Number(out.tolerante.puladas) || 0 } : null };
}

function descreverAbas(abas) {
  return abas.map((a) => {
    const cols = a.nomes.length ? `: ${a.nomes.map((n) => `"${n}"`).join(', ')}${a.colunas > a.nomes.length ? `, e mais ${a.colunas - a.nomes.length}` : ''}` : '';
    return `- aba "${a.nome}": ${a.linhas} linha(s) de dados, ${a.colunas} coluna(s)${cols}`;
  }).join('\n');
}

// The reason in words the user understands; pandas' own text ("',' expected after
// '\"'") reached the model and the user got no reason (2026-11-01).
const MOTIVOS = [
  [/ParserError|csv\.Error|expected after|EOF inside string|Expected \d+ fields/i, 'the file has quotes or separators outside the CSV standard, so the columns could not be split'],
  [/UnicodeDecodeError/i, 'the file text is in an encoding that was not recognized'],
  [/EmptyDataError|No columns to parse/i, 'the file is empty'],
  [/BadZipFile|not a zip file|Excel file format cannot be determined|XLRDError/i, 'the file is not a valid spreadsheet: it may be corrupted or another kind of file named like a spreadsheet'],
];
export const motivoSimples = (motivo) => MOTIVOS.find(([re]) => re.test(String(motivo || '')))?.[1] || motivo;

// Failure note. There's no text fallback, on purpose (see top of the file).
export function notaPlanilhaIlegivel(filename, motivo) {
  return `⚠️ The spreadsheet "${filename}" could not be opened in the analysis environment (${motivoSimples(motivo)}). Its content is NOT available through any other path: start the reply by telling the user that the file "${filename}" did not open and why, in simple words, before anything else, and do not describe, quote or guess anything it contains.`;
}

// Writes the bytes to the sandbox and registers them for analysis, WITHOUT reading the
// structure. This is the edit path (sheet-edit.mjs), which has its own
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

// CSV opened only by the tolerant reader (see SONDA_PY). Lines longer than the
// header may have shifted values, so the user hears about them first.
function notaTolerante(t) {
  if (!t) return '';
  const avisos = [];
  if (t.long) avisos.push(`${t.long} line(s) had more columns than the header, and what went past the header is in columns extra_1, extra_2... (the values in those lines may be shifted)`);
  if (t.skipped) avisos.push(`${t.skipped} line(s) could not be read and were left out`);
  if (!avisos.length) return 'The CSV had nonstandard quotes; it was opened in tolerant mode, with no line lost (stray quotes stayed as text in the cells).\n';
  return `The CSV was nonstandard and was opened in tolerant mode: ${avisos.join('; ')}. Start the reply by telling the user this, with the number.\n`;
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
    note: `📊 Planilha "${g.filename}" aberta no ambiente de análise. Estrutura:\n${descreverAbas(e.abas)}\n${notaTolerante(e.tolerant)}O conteúdo das células NÃO é mostrado aqui. Para qualquer pergunta sobre os dados desta planilha (buscar, listar, contar, somar, conferir um valor, resumir, comparar), use a tool analisar_planilha, que lê o arquivo inteiro por código. Não responda sobre o conteúdo sem ela.`,
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
