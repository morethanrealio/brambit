// Drive of a team assistant (category 'grupo', item 16 of the 10/2026 audit).
// The assistant uses the owner's Google account, but a channel full of people must
// not reach the owner's whole Drive. So it only sees and writes inside ITS OWN folder
// at the root of that Drive (marked with the assistant's id, one per assistant): what
// the owner puts there is what the team gets. Reading checks that the file is inside
// the folder by walking its parents; writing is the Drive tools pointed at the folder.
// They keep the Drive tools' names (drive_read, drive_upload, docs_create,
// drive_export_pdf), registered OVER the account-wide ones, so the confirmation gate,
// its sentences and the receipt (all keyed by name) keep working unchanged.
import { googleTools, ensureAssistantFolder } from './connectors.mjs';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const PROFUNDIDADE = 8; // folder levels walked/listed below the assistant's folder
const MAX_ITENS = 200;

export const PASTA_LEITURA = ['pasta_listar', 'drive_read'];
export const PASTA_ESCRITA = ['drive_upload', 'docs_create', 'drive_export_pdf'];

export function pastaDoAssistenteTools({ token, caps = {}, agentId, folderName, onAccess, onSheetLoad }) {
  if (!caps.drive?.read || !agentId) return { leitura: [], escrita: [] };
  const base = new Map(googleTools({ token, caps: { drive: caps.drive }, folderName, folderTag: agentId, onAccess, onSheetLoad })
    .map((t) => [t.name, t]));
  const pasta = () => ensureAssistantFolder(token, folderName, agentId);
  const get = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  // Is the file inside the assistant's folder (at any level up to PROFUNDIDADE)?
  const dentro = async (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
    const raiz = await pasta();
    let atual = id;
    for (let i = 0; i < PROFUNDIDADE; i++) {
      const f = await get(`${DRIVE}/files/${atual}?fields=parents,trashed&supportsAllDrives=true`);
      if (f.trashed) return false;
      const pai = f.parents?.[0];
      if (!pai) return false;
      if (pai === raiz) return true;
      atual = pai;
    }
    return false;
  };
  const FORA = JSON.stringify({ ok: false, error: 'Esse arquivo não está na pasta deste assistente. Eu só abro o que está nela; quem administra pode colocar o arquivo lá.' });
  const naPasta = (nome, description, guarda) => {
    const t = base.get(nome);
    if (!t) return null;
    return { ...t, description,
      run: async (args = {}) => (guarda && !(await dentro(args.id)) ? FORA : t.run(args)) };
  };

  const leitura = [{
    name: 'pasta_listar',
    description: `Lists the files in this assistant's Drive folder ("${folderName}") and its subfolders: name, id, type, link. It is the only part of Drive you can see. Optional "busca" filters by part of the name.`,
    parameters: { type: 'object', properties: { busca: { type: 'string', description: 'Part of the file name (optional).' } } },
    readOnly: true,
    async run({ busca = '' } = {}) {
      onAccess?.({ tool: 'pasta_listar', resource: 'drive', detail: `busca=${String(busca).slice(0, 80)}` });
      const norm = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const alvo = norm(busca).trim();
      const itens = [];
      let nivel = [await pasta()], chamadas = 0;
      for (let d = 0; d < PROFUNDIDADE && nivel.length && itens.length < MAX_ITENS; d++) {
        const proximo = [];
        for (const pai of nivel) {
          if (++chamadas > 40) break; // a huge tree: what was listed so far is enough
          let pageToken = '';
          do {
            const qs = new URLSearchParams({ q: `'${pai}' in parents and trashed = false`, pageSize: '100',
              fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
            if (pageToken) qs.set('pageToken', pageToken);
            const j = await get(`${DRIVE}/files?${qs}`);
            for (const f of j.files || []) {
              if (f.mimeType === 'application/vnd.google-apps.folder') proximo.push(f.id);
              if (!alvo || norm(f.name).includes(alvo)) itens.push(f);
            }
            pageToken = j.nextPageToken || '';
          } while (pageToken && itens.length < MAX_ITENS);
        }
        nivel = proximo;
      }
      const cortado = itens.length >= MAX_ITENS;
      return JSON.stringify({ ok: true, pasta: folderName, arquivos: itens.slice(0, MAX_ITENS),
        ...(cortado ? { note: `Mostrando só os primeiros ${MAX_ITENS}; use "busca" pra filtrar.` } : {}) });
    },
  }, naPasta('drive_read', 'Reads a file from this assistant\'s Drive folder by id (comes from pasta_listar): Docs, Slides, PDF, text; for a spreadsheet only its structure comes back. Files outside the folder are refused.', true)]
    .filter(Boolean);

  const escrita = !caps.drive?.write ? [] : [
    naPasta('drive_upload', `Creates a text file in this assistant's Drive folder ("${folderName}"). Confirm name and content first.`),
    naPasta('docs_create', `Creates a native Google Doc in this assistant's Drive folder ("${folderName}"). Accepts simple HTML with html=true. Confirm name and content first.`),
    naPasta('drive_export_pdf', 'Exports a Google Doc/Sheet/Slides that is in this assistant\'s folder to PDF and saves the PDF in the same folder.', true),
  ].filter(Boolean);
  return { leitura, escrita };
}
