// Item 16: a team assistant's Drive is only ITS folder in the owner's Drive. Reading or
// exporting a file outside the folder is refused before any content is fetched; listing
// walks only the folder's tree; the folder is the one tagged with this assistant's id.
// Drive is a fake fetch; the tools are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pastaDoAssistenteTools } from '../web/team-drive.mjs';
import { ensureAssistantFolder } from '../web/connectors.mjs';

const PASTA = 'application/vnd.google-apps.folder';
const PAIS = { F1: ['SUB'], SUB: ['ROOT'], FX: ['OUTRA'], OUTRA: [] }; // F1 inside (2 levels), FX outside
const FILHOS = {
  ROOT: [{ id: 'SUB', name: 'Relatórios', mimeType: PASTA }, { id: 'A1', name: 'Proposta.txt', mimeType: 'text/plain' }],
  SUB: [{ id: 'F1', name: 'Meta de Março.txt', mimeType: 'text/plain' }],
};

function driveFalso(t) {
  const chamadas = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const resp = (corpo) => ({ ok: true, status: 200, json: async () => corpo, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    arrayBuffer: async () => new TextEncoder().encode(String(corpo)).buffer });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    chamadas.push(u);
    const q = u.searchParams.get('q') || '';
    if (u.pathname.endsWith('/files') && q.includes('appProperties')) return resp({ files: [{ id: 'ROOT', name: 'Comercial', mimeType: PASTA }] });
    if (u.pathname.endsWith('/files')) return resp({ files: FILHOS[q.match(/^'([^']+)' in parents/)?.[1]] || [] });
    const id = u.pathname.split('/files/')[1];
    if (u.searchParams.get('fields') === 'parents,trashed') return resp({ parents: PAIS[id] });
    if (u.searchParams.get('alt') === 'media') return resp(`conteúdo de ${id}`);
    return resp({ id, name: `${id}.txt`, mimeType: 'text/plain' });
  };
  return chamadas;
}

const ferramentas = (write = true) => pastaDoAssistenteTools({ token: async () => 'tok', caps: { drive: { read: true, write } },
  agentId: 'agent-1', folderName: 'Comercial' });
const tool = (lista, nome) => lista.find((x) => x.name === nome);

test('reads a file inside the assistant folder, at any level', async (t) => {
  const chamadas = driveFalso(t);
  const out = JSON.parse(await tool(ferramentas().leitura, 'drive_read').run({ id: 'F1' }));
  assert.equal(out.text, 'conteúdo de F1');
  assert.ok(chamadas.some((u) => u.searchParams.get('q')?.includes("value='agent-1'")), 'the folder is the one tagged with this assistant');
});

test('a file outside the folder is refused before its content is fetched', async (t) => {
  const chamadas = driveFalso(t);
  const { leitura, escrita } = ferramentas();
  for (const nome of ['drive_read', 'drive_export_pdf']) {
    const out = JSON.parse(await tool([...leitura, ...escrita], nome).run({ id: 'FX' }));
    assert.equal(out.ok, false, nome);
    assert.match(out.error, /não está na pasta deste assistente/);
  }
  assert.ok(!chamadas.some((u) => u.searchParams.get('alt') === 'media' || u.pathname.endsWith('/export')), 'nothing from outside was downloaded');
  const lixo = JSON.parse(await tool(leitura, 'drive_read').run({ id: "x' or '1" }));
  assert.equal(lixo.ok, false);
});

test('pasta_listar lists only the folder tree and filters by name ignoring accents', async (t) => {
  driveFalso(t);
  const listar = tool(ferramentas().leitura, 'pasta_listar');
  assert.deepEqual(JSON.parse(await listar.run({})).arquivos.map((f) => f.id), ['SUB', 'A1', 'F1']);
  assert.deepEqual(JSON.parse(await listar.run({ busca: 'MARCO' })).arquivos.map((f) => f.id), ['F1']);
});

test('without the Drive write permission there are no write tools; without read, nothing', () => {
  assert.deepEqual(ferramentas(false).escrita, []);
  assert.deepEqual(pastaDoAssistenteTools({ token: async () => 'tok', caps: { drive: { write: true } }, agentId: 'agent-1' }), { leitura: [], escrita: [] });
});

test('the folder tag cannot inject into the Drive query', async () => {
  await assert.rejects(ensureAssistantFolder(async () => 'tok', 'X', "x' or name != '"), /Marcador de pasta inválido/);
});
