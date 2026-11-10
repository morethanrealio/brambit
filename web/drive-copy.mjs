// ── enviar_para_drive: a library file copied to the user's Google Drive ──
//
// The OPTIONAL export path: the file was already delivered in the chat and saved
// in the library; this puts a copy in the assistant's folder in Drive when the
// user asks. No id = the most recent file in the library (the one just generated).
// Gated: the server registers it with addGated, so it confirms before uploading.
//
// A spreadsheet may instead become a native Google Sheets file LINKED to the
// library spreadsheet (sheet-google.mjs): from then on every read and edit syncs
// with it. Only then can the link be opened to anyone who has it, and only when
// the user asks, since that publishes the spreadsheet.
//
// No db connection/import here: the server injects everything and tests pass fakes.

import { isSheetAsset, isMacroSheet, familyKey } from './sheet-edit.mjs';
import { currentVersion } from './sheet-library.mjs';
import { versionIds } from './sheet-sync.mjs';

const SHARE_ROLES = { editar: 'writer', ler: 'reader' };
const cleanName = (s) => String(s || '').replace(/[/\\:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'arquivo';
const sheetTitle = (s) => cleanName(s).replace(/\.(xlsx|xlsm|xls)$/i, '') || 'Planilha';

// deps: userId, folderName, getMediaAsset, listMediaAssets, fetchMedia, token,
// ensureFolder(token, name), upload({ token, name, buffer, mimeType, folderId }),
// and for Google Sheets: listSheets, googleEmail, links (createSheetLinks),
// createSheet, sheetVersion, shareByLink (sheet-google.mjs).
export function driveCopyTool(deps) {
  const { userId, folderName, getMediaAsset, listMediaAssets, fetchMedia, token } = deps;
  const pickAsset = async (id) => (id != null ? getMediaAsset(userId, id) : (await listMediaAssets(userId, { limit: 1 }))[0]);
  const sheetsFor = async () => { try { return await deps.listSheets(userId); } catch { return []; } };

  async function toGoogleSheets(asset, { compartilhar }) {
    const family = familyKey(asset);
    const role = SHARE_ROLES[compartilhar] || null;
    let linked = await deps.links.get(userId, family, versionIds(asset, await sheetsFor()));
    if (linked) {
      try { if ((await deps.sheetVersion(token, linked.file_id)).trashed) linked = null; }
      catch (e) { if (e?.status === 404) linked = null; else throw e; }
    }
    let file, sincronizada = true;
    if (linked) file = { id: linked.file_id, webViewLink: linked.link };
    else {
      let bytes;
      try { bytes = await fetchMedia(asset.s3_key); } catch { bytes = null; }
      if (!bytes) return { ok: false, error: 'Não consegui ler os bytes da planilha na biblioteca.' };
      const folderId = await deps.ensureFolder(token, folderName);
      file = await deps.createSheet(token, { name: sheetTitle(asset.caption), buffer: bytes.buffer, folderId });
      const version = Number(file.version) || (await deps.sheetVersion(token, file.id)).version;
      sincronizada = await deps.links.link(userId, { family, googleEmail: deps.googleEmail || null, fileId: file.id, link: file.webViewLink, version, baseAssetId: asset.id });
    }
    let shareError = null;
    if (role) { try { await deps.shareByLink(token, file.id, role); } catch (e) { shareError = e?.message ?? String(e); } }
    const notes = [linked
      ? `This spreadsheet was already in Google Sheets, synced with the library one: same file, same link.`
      : `Created the Google Sheets file "${sheetTitle(asset.caption)}" in the "${folderName}" Drive folder.`];
    if (!linked && sincronizada) notes.push('It stays synced with the library spreadsheet: what changes there comes in before every read or edit, and every edit you make goes there.');
    if (!sincronizada) notes.push('Sync with the library is NOT on in this server: it is a copy, and changes on one side do not reach the other. Tell the user.');
    if (role && !shareError) notes.push(`Anyone with the link can ${compartilhar === 'editar' ? 'edit' : 'view'} it.`);
    if (shareError) notes.push(`Could NOT open the link to anyone (${shareError}); the Google account may not allow it. The link opens only for the user, who can share it from Sheets.`);
    return { ok: true, id: file.id, name: sheetTitle(asset.caption), link: file.webViewLink, planilha_google: true, sincronizada, compartilhada: role && !shareError ? compartilhar : null, note: notes.join(' ') };
  }

  return {
    name: 'enviar_para_drive',
    description: `Uploads to the user's Google Drive a copy of a file that is ALREADY in their private library (a document you generated with gerar_documento, or received media). The file goes to the assistant's folder ("${folderName}") in Drive. Use it ONLY when the user explicitly asks to save/send the file to their Google Drive or Google Sheets ("salva isso no meu Drive", "manda pro Drive também", "quero no Google Sheets"). If you just generated the document, simply call it without id (it takes the most recent one). Do not use this to deliver the file in the chat (gerar_documento already delivers it); this is only the copy in Drive. UPDATE AT THE SAME LINK: if a file with the SAME name already exists in the folder, this tool rewrites its content and returns the usual same link (atualizado:true). So, when the user wants to keep ONE living file ("atualiza a planilha", "usa o mesmo link"), reuse exactly the same name; only change the name when they really want a separate file. GOOGLE SHEETS: for a spreadsheet the user wants in Google Sheets, or wants to share by link, pass planilha_google=true: it becomes a native Google Sheets file kept in sync with the library spreadsheet (what is typed there comes back before every read or edit, and your edits go there, at the same link).`,
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Id of the file in the library (from listar_midia). Omit it to use the most recent one.' },
      nome: { type: 'string', description: 'File name in Drive. Repeating the name of a file that is already in the folder UPDATES that file (same link). Default: the name it already has.' },
      planilha_google: { type: 'boolean', description: 'Only for a spreadsheet: create it as a Google Sheets file synced with the library one, instead of a plain .xlsx copy.' },
      compartilhar: { type: 'string', enum: ['editar', 'ler'], description: 'Only with planilha_google and only when the user asks to share by link: anyone with the link can edit ("editar") or only view ("ler"). Omit it otherwise: the link then opens only for the user.' },
    }, required: [] },
    async normalizeConfirmationArgs(args = {}) {
      let asset = await pickAsset(args.id);
      if (!asset) return { erro: 'Não achei o arquivo na biblioteca.' };
      const sheets = args.planilha_google === true;
      if (sheets && !isSheetAsset(asset)) return { erro: `"${asset.caption || 'This file'}" is not an .xlsx spreadsheet; only a spreadsheet becomes Google Sheets.` };
      if (sheets && !(await deps.links.available())) return { erro: 'Google Sheets sync is not on in this server. Offer the user the .xlsx copy in Drive (without planilha_google).' };
      if (sheets) asset = currentVersion(asset, await sheetsFor());
      if (sheets && isMacroSheet(asset)) return { erro: `"${asset.caption || 'This file'}" is an .xlsm spreadsheet with macros, and Google Sheets drops Excel macros, so it cannot become a synced Google Sheets file. Offer the user a plain copy of the .xlsm in Drive (without planilha_google).` };
      const share = sheets && SHARE_ROLES[args.compartilhar] ? args.compartilhar : undefined;
      return { args: { ...args, id: asset.id, nome: sheets ? sheetTitle(asset.caption) : (args.nome || asset.caption || 'arquivo'), assetKey: asset.s3_key, planilha_google: sheets || undefined, compartilhar: share } };
    },
    async preflight(args) {
      const asset = await getMediaAsset(userId, args.id);
      if (!asset || asset.s3_key !== args.assetKey) return { erro: 'O arquivo mudou ou não está disponível. Faça uma nova proposta.' };
    },
    async run({ id, nome, assetKey, planilha_google, compartilhar }) {
      const asset = await pickAsset(id);
      if (!asset) return JSON.stringify({ ok: false, error: id != null ? 'Não achei esse arquivo na biblioteca.' : 'A biblioteca está vazia; gere ou receba um arquivo antes.' });
      if (assetKey && asset.s3_key !== assetKey) return JSON.stringify({ ok: false, error: 'O arquivo mudou; não enviei outra versão.' });
      if (planilha_google === true) return JSON.stringify(await toGoogleSheets(asset, { compartilhar }));
      let bytes;
      try { bytes = await fetchMedia(asset.s3_key); } catch { bytes = null; }
      if (!bytes) return JSON.stringify({ ok: false, error: 'Não consegui ler os bytes do arquivo na biblioteca.' });
      const name = cleanName(nome || asset.caption);
      const folderId = await deps.ensureFolder(token, folderName);
      const f = await deps.upload({ token, name, buffer: bytes.buffer, mimeType: asset.mime || bytes.contentType || 'application/octet-stream', folderId });
      return JSON.stringify({
        ok: true, id: f.id, name: f.name, link: f.webViewLink, atualizado: !!f.updated,
        note: f.updated
          ? `Já existia um "${f.name}" na pasta "${folderName}" do Drive: atualizei o conteúdo DELE. O link é o mesmo de antes.`
          : `Cópia enviada ao seu Drive, na pasta "${folderName}".`,
      });
    },
  };
}
