// ── listar_midia: the user's library as the model sees it ──
//
// Every edit of a spreadsheet saves a new asset and archives the previous one
// as `base_yyyymmddhhmmss.ext` (sheet-edit.mjs), so a plain newest-first list
// fills with old versions of the same spreadsheet, each with its own id, and the
// model picks an archived one (a user's list had 13 versions of one spreadsheet).
// Here a spreadsheet is one line, its current version, with how many versions
// are kept; `versoes_de` lists them when the user asks for an old one. `busca`
// finds a file by name outside the newest window.
//
// No db connection/import here: the server injects the queries and tests pass fakes.

import { isSheetAsset, baseFamily } from './sheet-edit.mjs';
import { currentVersion } from './sheet-library.mjs';

export const LIST_DEFAULT = 20;
export const LIST_MAX = 50;
// Rows read to fill the list: archived versions are skipped, so more than
// `limite` rows may be needed to show `limite` items.
const SCAN_FACTOR = 4;
const SCAN_MAX = 200;
// Captions are a full reading of the file; the list only needs enough to find it.
const CAPTION_MAX = 200;

const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn';
export const normalize = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function createMediaSearch(pool) {
  return {
    // Newest first, matching the caption without case or accents.
    async searchMedia(userId, termo, { limit = SCAN_MAX } = {}) {
      const like = `%${normalize(termo).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const { rows } = await pool.query(
        `SELECT id, agent_id, s3_key, kind, mime, source, caption, created_at
         FROM mtr_harness.media_assets
         WHERE user_id = $1 AND translate(lower(caption), $2, $3) LIKE $4
         ORDER BY created_at DESC LIMIT $5`,
        [userId, ACCENTED, PLAIN, like, Math.min(Math.max(1, limit), SCAN_MAX)],
      );
      return rows;
    },
  };
}

const when = (a, timeZone) => new Date(a.created_at).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
const origin = (a) => (a.source === 'upload' ? 'enviada pelo usuário' : (a.source === 'generated' ? 'gerada por você' : ''));
const caption = (a) => String(a.caption || '').trim().slice(0, CAPTION_MAX);

function line(a, timeZone, extra = '') {
  const o = origin(a), cap = caption(a);
  return `- id=${a.id} · ${a.kind || 'arquivo'} · ${when(a, timeZone)}${o ? ' · ' + o : ''}${cap ? ' · "' + cap + '"' : ''}${extra}`;
}

const versionsOf = (asset, sheets) => {
  const fam = baseFamily(asset.caption);
  return sheets.filter((s) => isSheetAsset(s) && baseFamily(s.caption) === fam);
};

// One line per item, newest first; a spreadsheet appears once, as its current
// version, however many of its versions are in `rows`.
export function formatMediaList(rows, { sheets = [], timeZone, limit = LIST_DEFAULT } = {}) {
  const out = [], seen = new Set(), all = [...sheets, ...rows];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!isSheetAsset(r)) { out.push(line(r, timeZone)); continue; }
    const fam = baseFamily(r.caption);
    if (seen.has(fam)) continue;
    seen.add(fam);
    const atual = currentVersion(r, all);
    const n = new Set(versionsOf(atual, all).map((s) => String(s.id))).size;
    out.push(line(atual, timeZone, n > 1 ? ` · planilha com ${n} versões guardadas; este id é a versão atual (versões antigas: listar_midia com versoes_de=${atual.id})` : ''));
  }
  return out;
}

export function formatVersions(asset, sheets, { timeZone } = {}) {
  const vs = versionsOf(asset, [asset, ...sheets]);
  const uniq = [...new Map(vs.map((v) => [String(v.id), v])).values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const [atual, ...antigas] = uniq;
  return [
    `Versões da planilha "${caption(atual)}", da mais nova para a mais antiga. Use a versão atual para ler e editar; uma versão antiga só quando o usuário pedir o conteúdo de antes.`,
    line(atual, timeZone, ' · VERSÃO ATUAL'),
    ...antigas.map((v) => line(v, timeZone, ' · versão antiga')),
  ].join('\n');
}

export function mediaListTool({ userId, timeZone, listMediaAssets, getMediaAsset, listSheets, searchMedia }) {
  return {
    name: 'listar_midia',
    description: 'Lists the FILES in the user\'s library (images, audio AND documents/spreadsheets: .xlsx/.docx/.pdf/.md/.txt that YOU generated with gerar_documento), from most recent to oldest, each with id, type, when and a DESCRIPTION/name. A spreadsheet shows once, with the id of its current version and how many versions are kept. Use it ALWAYS when they refer to something from before ("aquela imagem", "o .doc que você fez", "cadê o arquivo do plano", "o PDF de ontem"): find it by the name/caption in this list, without reopening anything. If it is not among the most recent, search by name with busca. To resend a document in the chat use reenviar_arquivo with the id from here.',
    parameters: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: `How many items to list (default ${LIST_DEFAULT}, max ${LIST_MAX}).` },
        busca: { type: 'string', description: 'Optional: part of the file name or description to search for (e.g. "gastos", "contrato"), in the whole library.' },
        versoes_de: { type: 'string', description: 'Optional: id of a spreadsheet. Lists all its kept versions, newest first. Only when the user asks for an older version.' },
      },
    },
    run: async ({ limite, busca, versoes_de } = {}) => {
      const limit = Math.min(Math.max(1, Number(limite) || LIST_DEFAULT), LIST_MAX);
      const sheetsOrEmpty = async () => {
        try { return await listSheets(userId); }
        catch (e) { console.error('[listar_midia] planilhas:', e?.message ?? e); return []; }
      };
      if (versoes_de != null && String(versoes_de).trim() !== '') {
        const asset = await getMediaAsset(userId, String(versoes_de).trim());
        if (!asset) return 'ERRO: não achei esse arquivo na biblioteca (id inválido ou de outro usuário). Use listar_midia sem versoes_de pra achar o id.';
        if (!isSheetAsset(asset)) return `O arquivo ${asset.id} ("${caption(asset)}") não é uma planilha .xlsx; só planilhas guardam versões.`;
        return formatVersions(asset, await sheetsOrEmpty(), { timeZone });
      }
      const termo = typeof busca === 'string' ? busca.trim() : '';
      const scan = Math.min(limit * SCAN_FACTOR, SCAN_MAX);
      const rows = termo ? await searchMedia(userId, termo, { limit: scan }) : await listMediaAssets(userId, { limit: scan });
      if (!rows.length) return termo ? `Nenhum arquivo com "${termo}" no nome ou na descrição.` : 'Nenhuma mídia guardada ainda.';
      const sheets = rows.some(isSheetAsset) ? await sheetsOrEmpty() : [];
      return formatMediaList(rows, { sheets, timeZone, limit }).join('\n');
    },
  };
}
