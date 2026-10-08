import { readOnlyCommand } from './read-only-command.mjs';
import { marca, siteDaMarca } from './marca.mjs';
// ── Coding tools over SSH (from the sandbox) ──
//
// Mirrors the Agent SDK design: a small, sharp, file-oriented toolset instead
// of "make do with a raw shell".
//
//  READ (ler_arquivo, listar_arquivos, buscar_no_codigo, rodar_leitura):
//    NOT gated, run INLINE and return output right away. Explicit product
//    decision: reading/listing/searching is free, no permission asked.
//  WRITE (editar_arquivo, escrever_arquivo, rodar_comando): GATED (see
//    confirm.mjs), run only after explicit user confirmation.
//  DELETE is never silent: it goes through rodar_comando (gated).
//
// Transport: the SAME secure path as ssh.mjs, SSH key from the vault, connection
// from the sandbox (internal VPC network blocked by the host firewall). Reuses
// `sshExec` from ssh.mjs; no new attack surface.

import { sshExec, maskSecrets } from './ssh.mjs';
import { sandboxEnabled } from './sandbox.mjs';
import { vaultEnabled } from './vault.mjs';
import { devexecEnabled, devExec } from './devexec.mjs';

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Maximum bytes we accept writing/editing in a remote file (the content
// goes base64 inside the SSH command; code files fit comfortably).
const MAX_FILE = 512 * 1024;
const effect=(state,operation)=>({version:1,state,operation});
const result=(body,state,operation)=>JSON.stringify({...body,effect:effect(state,operation)});

// codingTools operates in two modes, transparent to the tools:
//  • WITHOUT an active project: the target is the USER's server, via sshExec (vault
//    key, from the SP sandbox). Needs sandbox + vault.
//  • WITH an active project ({ project }): the target is the project's WORKSPACE on the
//    dev host, via devExec (runner). cwd = /work (the cloned repo's root), so
//    paths can be relative. host/usuario are ignored in this mode.
// `transport(cmd, {host,usuario,timeout,token})` hides the difference: both
// backends return the SAME format { ok, exit, saida, stderr, error }.
export function codingTools(userId, { project = null, getGithubToken = null } = {}) {
  if (project) { if (!devexecEnabled()) return []; }
  else if (!sandboxEnabled() || !vaultEnabled()) return [];

  async function transport(cmd, { host, usuario, timeout, token } = {}) {
    if (project) {
      return devExec({ user: project.ownerUserId, proj: project.nome, cmd, token, timeout: Math.ceil((timeout || 90_000) / 1000) });
    }
    return sshExec(userId, cmd, { host, usuario, timeout });
  }

  // Effect of a command that changes state. If the transport returned an exit
  // code, the command RAN to completion (even with an error): the result is known and the
  // task continues. "unknown" is only for when there's no way to know if it finished:
  // no code (connection dropped), 124/137 (timeout/kill) and 255 on SSH (ssh failure).
  function commandEffect(r) {
    if (r?.ok) return 'applied';
    const e = r?.exit;
    if (!Number.isInteger(e) || e === 124 || e === 137 || (!project && e === 255)) return 'unknown';
    return 'applied';
  }

  // GitHub token (only in project mode, for authenticated push). A silent failure
  // becomes null: the push then tries without a credential (public repo / remote already auth'd).
  async function githubToken() {
    if (!project || !getGithubToken) return null;
    try { return await getGithubToken(); } catch { return null; }
  }

  return [
    // ---------- READ (inline, no confirmation) ----------
    {
      name: 'ler_arquivo',
      description: 'Reads a text file on a user\'s server (via SSH). Returns the content with line numbers. Use it BEFORE editing. Reading is free, no confirmation needed.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'absolute path of the file on the server (e.g.: /home/ubuntu/app/server.js)' },
          inicio: { type: 'number', description: 'starting line (default 1)' },
          linhas: { type: 'number', description: 'how many lines to read (default 400, max 2000)' },
          host: { type: 'string', description: 'server host (IP/domain). Optional if there is only one key.' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['caminho'],
      },
      async run({ caminho, inicio, linhas, host, usuario }) {
        const start = Math.max(1, Number(inicio) || 1);
        const count = Math.min(Math.max(1, Number(linhas) || 400), 2000);
        const end = start + count - 1;
        const cmd = `sed -n ${shq(`${start},${end}p`)} ${shq(caminho)} | nl -ba -v ${start} -w1 -s'\t'`;
        const r = await transport(cmd, { host, usuario, timeout: 30_000 });
        if (!r.ok) return `Não consegui ler ${caminho}: ${r.error || r.stderr || 'erro'}`;
        if (!r.saida.trim()) return `(vazio ou arquivo não existe a partir da linha ${start}): ${caminho}`;
        return maskSecrets(r.saida.slice(0, 60_000));
      },
    },
    {
      name: 'listar_arquivos',
      description: 'Lists files/folders on a user\'s server (via SSH). Without a pattern: shows the folder contents (ls -la). With a pattern: searches by name (find). Free read, no confirmation.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'folder to list/search (e.g.: /home/ubuntu/app)' },
          padrao: { type: 'string', description: 'name pattern to search recursively (e.g.: *.js). Optional.' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['caminho'],
      },
      async run({ caminho, padrao, host, usuario }) {
        const cmd = padrao
          ? `find ${shq(caminho)} -name ${shq(padrao)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -300`
          : `ls -la ${shq(caminho)}`;
        const r = await transport(cmd, { host, usuario, timeout: 30_000 });
        if (!r.ok && !r.saida.trim()) return `Não consegui listar ${caminho}: ${r.error || r.stderr || 'erro'}`;
        return maskSecrets((r.saida || '(vazio)').slice(0, 30_000));
      },
    },
    {
      name: 'buscar_no_codigo',
      description: 'Searches for a text/pattern inside the files of a user\'s server (recursive grep, ignores node_modules and .git). Returns file:line:snippet. Free read, no confirmation.',
      parameters: {
        type: 'object',
        properties: {
          padrao: { type: 'string', description: 'text or regex to search for' },
          caminho: { type: 'string', description: 'folder to search in (default: the login\'s current folder)' },
          tipo: { type: 'string', description: 'extension to filter by, e.g.: js, py, mjs (optional)' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['padrao'],
      },
      async run({ padrao, caminho, tipo, host, usuario }) {
        const inc = tipo ? `--include=${shq('*.' + String(tipo).replace(/^\./, ''))}` : '';
        const cmd = `grep -rnI --exclude-dir=node_modules --exclude-dir=.git ${inc} -e ${shq(padrao)} ${shq(caminho || '.')} 2>/dev/null | head -200`;
        const r = await transport(cmd, { host, usuario, timeout: 30_000 });
        if (!r.saida.trim()) return `Nada encontrado para "${padrao}"${caminho ? ` em ${caminho}` : ''}.`;
        return maskSecrets(r.saida.slice(0, 40_000));
      },
    },
    {
      name: 'rodar_leitura',
      description: 'Free inspection using a single utility: pwd, ls, cat, head, tail, wc, du, df, uname or stat, with literal arguments (quotes accepted). To read files/list/search, prefer the dedicated tools. Other commands, git, tests, scripts, pipelines and expansions use rodar_comando with confirmation.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'read-only shell command to run on the server' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['comando'],
      },
      async run({ comando, host, usuario }) {
        if (!comando) return 'Sem comando pra rodar.';
        const safeCommand = readOnlyCommand(comando);
        if (!safeCommand) {
          return 'Esse comando não pertence à lista de leitura permitida. Use ler_arquivo/listar_arquivos/buscar_no_codigo, ou rodar_comando com confirmação para executar outros comandos.';
        }
        const r = await transport(safeCommand, { host, usuario, timeout: 60_000 });
        const out = (r.saida || '').slice(0, 40_000);
        const err = (r.stderr || '').slice(0, 4_000);
        if (!r.ok && !out && !err) return `Falhou (exit ${r.exit}): ${r.error || 'erro'}`;
        let m = out || '(sem saída)';
        if (err) m += `\n\n--- stderr ---\n${err}`;
        return maskSecrets(m);
      },
    },

    // ---------- ESCRITA (GATED — confirm.mjs) ----------
    {
      name: 'editar_arquivo',
      description: 'Edits a file on a user\'s server by replacing an EXACT snippet with another (like Claude Code\'s Edit). The "busca" snippet must exist and be UNIQUE in the file (include enough context). Read the file first (ler_arquivo). WRITE ACTION: only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'absolute file path' },
          busca: { type: 'string', description: 'the exact snippet to be replaced (unique in the file)' },
          troca: { type: 'string', description: 'the text that goes in its place' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['caminho', 'busca', 'troca'],
      },
      async run({ caminho, busca, troca, host, usuario }) {
        if (busca === troca) return result({ ok: false, error: 'busca e troca são iguais; nada a fazer.' },'not_applied','file_edit');
        const cur = await transport(`cat ${shq(caminho)}`, { host, usuario, timeout: 30_000 });
        if (!cur.ok) return result({ ok: false, error: `Não consegui ler o arquivo: ${cur.error || cur.stderr || 'erro'}` },'not_applied','file_edit');
        const content = cur.saida;
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE) return result({ ok: false, error: 'Arquivo grande demais para editar por aqui (>512KB).' },'not_applied','file_edit');
        const occ = content.split(busca).length - 1;
        if (occ === 0) return result({ ok: false, error: 'Não achei o trecho exato ("busca") no arquivo. Confira com ler_arquivo e cole o texto idêntico.' },'not_applied','file_edit');
        if (occ > 1) return result({ ok: false, error: `O trecho aparece ${occ}x no arquivo; deixe-o ÚNICO incluindo mais contexto ao redor.` },'not_applied','file_edit');
        // LITERAL replacement. With a replacement string, replace interprets $$, $& and similar,
        // which would write a file different from what the user asked for (finding #20).
        const novo = content.split(busca).join(troca);
        const b64 = Buffer.from(novo, 'utf8').toString('base64');
        const tmp = `${caminho}.brambs.tmp`;
        const w = await transport(`printf %s ${shq(b64)} | base64 -d > ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(caminho)} && echo OK`, { host, usuario, timeout: 30_000 });
        if (!w.ok) return result({ ok: false, error: `Falha ao gravar: ${w.error || w.stderr || 'erro'}` },'unknown','file_edit');
        const delta = novo.split('\n').length - content.split('\n').length;
        return result({ ok: true, saida: `Editado ${caminho} (1 troca, ${delta >= 0 ? '+' : ''}${delta} linhas).` },'applied','file_edit');
      },
    },
    {
      name: 'escrever_arquivo',
      description: 'Creates or OVERWRITES an entire file on a user\'s server (like Claude Code\'s Write). Creates the folders if they do not exist. To change only a snippet, prefer editar_arquivo. WRITE ACTION: only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'absolute file path' },
          conteudo: { type: 'string', description: 'complete file content' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['caminho', 'conteudo'],
      },
      async run({ caminho, conteudo, host, usuario }) {
        if (Buffer.byteLength(String(conteudo), 'utf8') > MAX_FILE) return result({ ok: false, error: 'Conteúdo grande demais (>512KB).' },'not_applied','file_write');
        const b64 = Buffer.from(String(conteudo), 'utf8').toString('base64');
        // The file's folder: if the path has a slash, everything before the last slash
        // (or '/' for a root path); without a slash (simple relative path), it's the
        // current directory '.'. Without this, a bare name would turn into a mkdir of itself.
        const cp = String(caminho);
        const dir = cp.includes('/') ? (cp.replace(/\/[^/]*$/, '') || '/') : '.';
        const tmp = `${caminho}.brambs.tmp`;
        const cmd = `mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(caminho)} && wc -c < ${shq(caminho)}`;
        const w = await transport(cmd, { host, usuario, timeout: 30_000 });
        if (!w.ok) return result({ ok: false, error: `Falha ao gravar: ${w.error || w.stderr || 'erro'}` },'unknown','file_write');
        return result({ ok: true, saida: `Arquivo gravado: ${caminho} (${(w.saida || '').trim()} bytes).` },'applied','file_write');
      },
    },
    {
      name: 'rodar_comando',
      description: 'Runs a shell command that CHANGES something on a user\'s server (install, build, service restart, git commit/push, delete, move, etc.) via SSH. To only read/inspect use rodar_leitura (does not ask for confirmation). WRITE ACTION: only runs after the user confirms. Never deletes anything without explicit ok.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'shell command to run on the server' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['comando'],
      },
      async run({ comando, host, usuario }) {
        const r = await transport(comando, { host, usuario, timeout: 120_000 });
        return result({
          ok: r.ok,
          host: r.host,
          exit: r.exit,
          saida: maskSecrets((r.saida || '').slice(0, 6000)),
          stderr: maskSecrets((r.stderr || '').slice(0, 2000)),
          error: r.error,
        },commandEffect(r),'shell_command');
      },
    },

    // ---------- GIT (GATED — confirm.mjs) ----------
    // Operations that change the repo. Git reads (status/log/diff/branch/show)
    // remain free via rodar_leitura. All of them run via git -C <diretorio>.
    {
      name: 'git_commit',
      description: 'Makes a commit in the git repository of a directory (via SSH). By default runs "git add -A" first (adicionar_tudo=false to commit only what is already staged). WRITE ACTION: only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'repository path (git root or subfolder)' },
          mensagem: { type: 'string', description: 'commit message' },
          adicionar_tudo: { type: 'boolean', description: 'run git add -A before the commit (default true)' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['mensagem'],
      },
      async run({ diretorio, mensagem, adicionar_tudo, host, usuario }) {
        if (!String(mensagem || '').trim()) return result({ ok: false, error: 'mensagem do commit vazia.' },'not_applied','git_commit');
        const D = shq(diretorio || '.');
        const add = adicionar_tudo === false ? '' : `git -C ${D} add -A && `;
        // Identity only as FALLBACK: doesn't -c override config already set in the repo? Actually
        // -c takes priority; that's why we only use it when the repo doesn't have user.name/email set.
        const ident = `NAME="$(git -C ${D} config user.name || echo ${shq(marca().nome)})"; EMAIL="$(git -C ${D} config user.email || echo ${shq(`dev@${new URL(siteDaMarca()).hostname}`)})";`;
        const cmd = `${ident} ${add}git -C ${D} -c user.name="$NAME" -c user.email="$EMAIL" commit -m ${shq(mensagem)} && git -C ${D} log -1 --oneline`;
        const r = await transport(cmd, { host, usuario, timeout: 60_000 });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 4000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_commit');
      },
    },
    {
      name: 'git_push',
      description: 'Sends commits to the remote (git push). Without a branch, pushes the current branch. WRITE ACTION that goes out to the remote: only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'repository path' },
          branch: { type: 'string', description: 'branch to push (optional; default = current branch)' },
          remote: { type: 'string', description: 'remote name (default origin)' },
          set_upstream: { type: 'boolean', description: 'use -u to set upstream (useful on the branch\'s 1st push)' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: [],
      },
      async run({ diretorio, branch, remote, set_upstream, host, usuario }) {
        const D = shq(diretorio || '.');
        const rem = shq(remote || 'origin');
        const br = branch ? shq(branch) : `"$(git -C ${D} rev-parse --abbrev-ref HEAD)"`;
        const u = set_upstream ? '-u ' : '';
        // Project mode: authenticated push with the user's GitHub token. The token
        // goes to the container via GH_TOKEN (env, outside argv); the credential helper
        // injects user/password only in memory, without writing to .git/config.
        const token = await githubToken();
        const cred = token ? `-c credential.helper='!f(){ echo username=x-access-token; echo password=${'$'}{GH_TOKEN}; };f' ` : '';
        const cmd = `git -C ${D} ${cred}push ${u}${rem} ${br} 2>&1`;
        const r = await transport(cmd, { host, usuario, timeout: 120_000, token });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 4000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_push');
      },
    },
    {
      name: 'git_branch',
      description: 'Creates a new branch and switches to it right away (git checkout -b). WRITE ACTION: only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'repository path' },
          nome: { type: 'string', description: 'name of the new branch' },
          base: { type: 'string', description: 'base ref to create the branch from (optional; default = current HEAD)' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['nome'],
      },
      async run({ diretorio, nome, base, host, usuario }) {
        if (!String(nome || '').trim()) return result({ ok: false, error: 'nome da branch vazio.' },'not_applied','git_branch');
        const D = shq(diretorio || '.');
        const cmd = `git -C ${D} checkout -b ${shq(nome)}${base ? ` ${shq(base)}` : ''} && git -C ${D} rev-parse --abbrev-ref HEAD`;
        const r = await transport(cmd, { host, usuario, timeout: 60_000 });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 2000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_branch');
      },
    },
    {
      name: 'git_checkout',
      description: 'Switches to an existing branch/commit/tag (git checkout <ref>). To CREATE a new branch use git_branch. WRITE ACTION (touches the working tree): only runs after the user confirms.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'repository path' },
          ref: { type: 'string', description: 'branch, commit or tag to switch to' },
          host: { type: 'string', description: 'server host (optional)' },
          usuario: { type: 'string', description: 'login user (optional)' },
        },
        required: ['ref'],
      },
      async run({ diretorio, ref, host, usuario }) {
        if (!String(ref || '').trim()) return result({ ok: false, error: 'ref vazio.' },'not_applied','git_checkout');
        const D = shq(diretorio || '.');
        const cmd = `git -C ${D} checkout ${shq(ref)} 2>&1 && git -C ${D} rev-parse --abbrev-ref HEAD`;
        const r = await transport(cmd, { host, usuario, timeout: 60_000 });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 2000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_checkout');
      },
    },
  ];
}

// Names of this module's WRITE tools (for confirm.mjs to mark as gated).
export const CODING_WRITE_TOOLS = ['editar_arquivo', 'escrever_arquivo', 'rodar_comando', 'git_commit', 'git_push', 'git_branch', 'git_checkout'];
