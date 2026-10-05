// ── Planilha sempre via pandas (sandbox), nunca como texto pro modelo ────────
// Toda planilha que chega (anexo no chat, Drive, OneDrive, Gmail, ler_arquivo)
// é gravada no /workspace do container isolado do usuário, aberta com pandas e
// REGISTRADA aqui. O modelo recebe só a ESTRUTURA (abas, linhas, nomes das
// colunas), nunca as células; qualquer pergunta sobre o conteúdo passa pela
// meta-tool `analisar_planilha` (server.mjs), que lê o arquivo INTEIRO por
// código e devolve só a síntese.
//
// Por quê (01/10/2026): a prévia em CSV (12k-40k caracteres) que ia junto
// cortava planilhas grandes, e o modelo respondia "de cabeça" a partir do pedaço
// que viu, inclusive dizendo que algo não existia quando estava nas linhas
// cortadas. Por isso não existe mais caminho de volta pro texto: se o ambiente
// de análise falhar, a nota diz que a planilha não pôde ser lida.
import { sandboxEnabled, sandboxShell, sandboxWriteBytes } from './sandbox.mjs';

const TTL_MS = 6 * 60 * 60 * 1000; // 6h: dá pra fazer perguntas de acompanhamento
const MAX_PER_USER = 10;
const loaded = new Map(); // userId -> [{ path, filename, sheets, rows, ts }]

function prune(list) {
  const now = Date.now();
  return list.filter((e) => now - e.ts < TTL_MS).slice(-MAX_PER_USER);
}

export function registerLoadedSheet(userId, entry) {
  const list = prune(loaded.get(userId) || []);
  // Mesma planilha recarregada (mesmo path): substitui em vez de duplicar.
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

// Caminho canônico da planilha dentro do sandbox do usuário. Exportado porque a
// EDIÇÃO (planilha-edit.mjs) precisa do mesmo caminho que o carregamento usa —
// se os dois divergirem, o sub-agente edita um arquivo e a gente lê outro.
export function sheetSandboxPath(filename) {
  return `/workspace/planilhas/${safeName(filename)}`;
}

// Tipo de planilha pelo nome e pelo mime: 'excel' (xlsx/xlsm/xls), 'csv', 'tsv'
// ou null quando não é planilha. A extensão manda: o Windows costuma mandar CSV
// com mime de Excel (application/vnd.ms-excel), e abrir um CSV como Excel falha.
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

// Nome com a extensão que bate com o tipo: o pandas do sandbox e o sub-agente
// precisam saber pelo nome se é CSV ou Excel (export do Google Sheets, anexo
// sem extensão).
function nomeComExtensao(filename, tipo) {
  const limpo = safeName(filename);
  if (tipoPlanilha(limpo) === tipo) return limpo;
  return `${limpo}.${tipo === 'excel' ? 'xlsx' : tipo}`;
}

// Script que roda no sandbox: abre a planilha inteira com pandas e imprime só
// a estrutura em JSON. Nomes de coluna e de aba são cortados pra caberem numa
// nota curta; as células nunca saem daqui.
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

// Nota de falha. Não existe plano B em texto, de propósito (ver topo do arquivo).
export function notaPlanilhaIlegivel(filename, motivo) {
  return `⚠️ A planilha "${filename}" não pôde ser aberta no ambiente de análise (${motivo}). O conteúdo dela NÃO está disponível por nenhum outro caminho: diga ao usuário que não conseguiu ler a planilha agora e não descreva, cite nem suponha nada do que ela contém.`;
}

// Grava os bytes no sandbox e registra pra análise, SEM ler a estrutura. É o
// caminho da edição (planilha-edit.mjs), que tem a própria conferência e não
// mostra a planilha ao modelo.
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

// Carrega uma planilha pra conversa: grava no sandbox, abre com pandas e
// devolve a nota que vai pro modelo, só com a estrutura. Sempre devolve `note`
// (também na falha), pra quem chama não ter tentação de mandar o texto.
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

// Pros conectores (Drive, OneDrive, Gmail): carrega pelo onSheetLoad que o
// server injeta e devolve a nota que vai no campo "analise" do resultado. Sem
// onSheetLoad, ou se ele falhar, a nota é a de falha; nunca o texto.
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
