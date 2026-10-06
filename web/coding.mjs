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

// Máximo de bytes que aceitamos escrever/editar num arquivo remoto (o conteúdo
// vai base64 dentro do comando SSH; arquivos de código cabem folgado).
const MAX_FILE = 512 * 1024;
const effect=(state,operation)=>({version:1,state,operation});
const result=(body,state,operation)=>JSON.stringify({...body,effect:effect(state,operation)});

// codingTools opera em dois modos, transparentes pras tools:
//  • SEM projeto ativo: alvo é o servidor DO USUÁRIO, via sshExec (chave do
//    cofre, a partir do sandbox SP). Precisa sandbox + cofre.
//  • COM projeto ativo ({ project }): alvo é o WORKSPACE do projeto no host de
//    dev, via devExec (runner). cwd = /work (a raiz do repo clonado), então os
//    caminhos podem ser relativos. host/usuario são ignorados nesse modo.
// `transport(cmd, {host,usuario,timeout,token})` esconde a diferença: os dois
// backends devolvem o MESMO formato { ok, exit, saida, stderr, error }.
export function codingTools(userId, { project = null, getGithubToken = null } = {}) {
  if (project) { if (!devexecEnabled()) return []; }
  else if (!sandboxEnabled() || !vaultEnabled()) return [];

  async function transport(cmd, { host, usuario, timeout, token } = {}) {
    if (project) {
      return devExec({ user: project.ownerUserId, proj: project.nome, cmd, token, timeout: Math.ceil((timeout || 90_000) / 1000) });
    }
    return sshExec(userId, cmd, { host, usuario, timeout });
  }

  // Efeito de um comando que muda estado. Se o transporte devolveu código de
  // saída, o comando RODOU até o fim (mesmo com erro): o resultado é conhecido e a
  // tarefa segue. "unknown" fica só pra quando não dá pra saber se terminou:
  // sem código (conexão caiu), 124/137 (timeout/kill) e 255 no SSH (falha do ssh).
  function commandEffect(r) {
    if (r?.ok) return 'applied';
    const e = r?.exit;
    if (!Number.isInteger(e) || e === 124 || e === 137 || (!project && e === 255)) return 'unknown';
    return 'applied';
  }

  // Token do GitHub (só no modo projeto, pra push autenticado). Falha silenciosa
  // vira null: o push então tenta sem credencial (repo público / remote já auth).
  async function githubToken() {
    if (!project || !getGithubToken) return null;
    try { return await getGithubToken(); } catch { return null; }
  }

  return [
    // ---------- LEITURA (inline, sem confirmação) ----------
    {
      name: 'ler_arquivo',
      description: 'Lê um arquivo de texto num servidor do usuário (via SSH). Devolve o conteúdo com número de linha. Use ANTES de editar. Leitura é livre, não precisa de confirmação.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'caminho absoluto do arquivo no servidor (ex: /home/ubuntu/app/server.js)' },
          inicio: { type: 'number', description: 'linha inicial (padrão 1)' },
          linhas: { type: 'number', description: 'quantas linhas ler (padrão 400, máx 2000)' },
          host: { type: 'string', description: 'host do servidor (IP/domínio). Opcional se só há uma chave.' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
      description: 'Lista arquivos/pastas num servidor do usuário (via SSH). Sem padrão: mostra o conteúdo da pasta (ls -la). Com padrão: busca por nome (find). Leitura livre, sem confirmação.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'pasta a listar/buscar (ex: /home/ubuntu/app)' },
          padrao: { type: 'string', description: 'padrão de nome pra buscar recursivamente (ex: *.js). Opcional.' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
      description: 'Busca um texto/padrão dentro dos arquivos de um servidor do usuário (grep recursivo, ignora node_modules e .git). Devolve arquivo:linha:trecho. Leitura livre, sem confirmação.',
      parameters: {
        type: 'object',
        properties: {
          padrao: { type: 'string', description: 'texto ou regex a procurar' },
          caminho: { type: 'string', description: 'pasta onde buscar (padrão: pasta atual do login)' },
          tipo: { type: 'string', description: 'extensão pra filtrar, ex: js, py, mjs (opcional)' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
      description: 'Inspeção livre usando um único utilitário: pwd, ls, cat, head, tail, wc, du, df, uname ou stat, com argumentos literais (aspas aceitas). Para ler arquivos/listar/buscar, prefira as tools dedicadas. Outros comandos, git, testes, scripts, pipelines e expansões usam rodar_comando com confirmação.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'comando shell de leitura a rodar no servidor' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
      description: 'Edita um arquivo num servidor do usuário trocando um trecho EXATO por outro (como o Edit do Claude Code). O trecho "busca" tem que existir e ser ÚNICO no arquivo (inclua contexto suficiente). Leia o arquivo antes (ler_arquivo). AÇÃO DE ESCRITA: só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'caminho absoluto do arquivo' },
          busca: { type: 'string', description: 'o trecho exato a ser substituído (único no arquivo)' },
          troca: { type: 'string', description: 'o texto que entra no lugar' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
        // Troca LITERAL. Com string de substituicao o replace interpreta $$, $& e afins,
        // o que gravaria um arquivo diferente do que o usuario pediu (achado #20).
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
      description: 'Cria ou SOBRESCREVE um arquivo inteiro num servidor do usuário (como o Write do Claude Code). Cria as pastas se não existirem. Para mudar só um trecho, prefira editar_arquivo. AÇÃO DE ESCRITA: só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'caminho absoluto do arquivo' },
          conteudo: { type: 'string', description: 'conteúdo completo do arquivo' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
        },
        required: ['caminho', 'conteudo'],
      },
      async run({ caminho, conteudo, host, usuario }) {
        if (Buffer.byteLength(String(conteudo), 'utf8') > MAX_FILE) return result({ ok: false, error: 'Conteúdo grande demais (>512KB).' },'not_applied','file_write');
        const b64 = Buffer.from(String(conteudo), 'utf8').toString('base64');
        // Pasta do arquivo: se o caminho tem barra, tudo antes da última barra
        // (ou '/' pra caminho na raiz); sem barra (caminho relativo simples), é o
        // diretório atual '.'. Sem isso, um nome solto viraria mkdir do próprio nome.
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
      description: 'Executa um comando shell que ALTERA algo num servidor do usuário (instalar, build, restart de serviço, git commit/push, apagar, mover, etc.) via SSH. Para só ler/inspecionar use rodar_leitura (não pede confirmação). AÇÃO DE ESCRITA: só executa após o usuário confirmar. Nunca apaga nada sem o ok explícito.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'comando shell a rodar no servidor' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
    // Operações que mudam o repo. Leitura de git (status/log/diff/branch/show)
    // continua livre por rodar_leitura. Todas rodam via git -C <diretorio>.
    {
      name: 'git_commit',
      description: 'Faz um commit no repositório git de um diretório (via SSH). Por padrão dá "git add -A" antes (adicionar_tudo=false para commitar só o que já está no stage). AÇÃO DE ESCRITA: só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'caminho do repositório (raiz ou subpasta do git)' },
          mensagem: { type: 'string', description: 'mensagem do commit' },
          adicionar_tudo: { type: 'boolean', description: 'dar git add -A antes do commit (padrão true)' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
        },
        required: ['mensagem'],
      },
      async run({ diretorio, mensagem, adicionar_tudo, host, usuario }) {
        if (!String(mensagem || '').trim()) return result({ ok: false, error: 'mensagem do commit vazia.' },'not_applied','git_commit');
        const D = shq(diretorio || '.');
        const add = adicionar_tudo === false ? '' : `git -C ${D} add -A && `;
        // Identidade só como FALLBACK: -c não sobrescreve config já existente do repo? Na verdade
        // -c tem prioridade; por isso só usamos quando o repo não tem user.name/email definidos.
        const ident = `NAME="$(git -C ${D} config user.name || echo ${shq(marca().nome)})"; EMAIL="$(git -C ${D} config user.email || echo ${shq(`dev@${new URL(siteDaMarca()).hostname}`)})";`;
        const cmd = `${ident} ${add}git -C ${D} -c user.name="$NAME" -c user.email="$EMAIL" commit -m ${shq(mensagem)} && git -C ${D} log -1 --oneline`;
        const r = await transport(cmd, { host, usuario, timeout: 60_000 });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 4000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_commit');
      },
    },
    {
      name: 'git_push',
      description: 'Envia commits para o remote (git push). Sem branch, empurra a branch atual. AÇÃO DE ESCRITA que sai pro remote: só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'caminho do repositório' },
          branch: { type: 'string', description: 'branch a empurrar (opcional; padrão = branch atual)' },
          remote: { type: 'string', description: 'nome do remote (padrão origin)' },
          set_upstream: { type: 'boolean', description: 'usar -u para setar upstream (útil no 1º push da branch)' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
        },
        required: [],
      },
      async run({ diretorio, branch, remote, set_upstream, host, usuario }) {
        const D = shq(diretorio || '.');
        const rem = shq(remote || 'origin');
        const br = branch ? shq(branch) : `"$(git -C ${D} rev-parse --abbrev-ref HEAD)"`;
        const u = set_upstream ? '-u ' : '';
        // Modo projeto: push autenticado com o token do GitHub do usuário. O token
        // vai pro container via GH_TOKEN (env, fora do argv); o credential helper
        // injeta user/senha só em memória, sem gravar no .git/config.
        const token = await githubToken();
        const cred = token ? `-c credential.helper='!f(){ echo username=x-access-token; echo password=${'$'}{GH_TOKEN}; };f' ` : '';
        const cmd = `git -C ${D} ${cred}push ${u}${rem} ${br} 2>&1`;
        const r = await transport(cmd, { host, usuario, timeout: 120_000, token });
        return result({ ok: r.ok, host: r.host, exit: r.exit, saida: maskSecrets((r.saida || '').slice(0, 4000)), stderr: maskSecrets((r.stderr || '').slice(0, 2000)), error: r.error },commandEffect(r),'git_push');
      },
    },
    {
      name: 'git_branch',
      description: 'Cria uma nova branch e já muda pra ela (git checkout -b). AÇÃO DE ESCRITA: só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'caminho do repositório' },
          nome: { type: 'string', description: 'nome da nova branch' },
          base: { type: 'string', description: 'ref base pra criar a branch (opcional; padrão = HEAD atual)' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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
      description: 'Muda pra uma branch/commit/tag existente (git checkout <ref>). Para CRIAR branch nova use git_branch. AÇÃO DE ESCRITA (mexe na working tree): só executa após o usuário confirmar.',
      parameters: {
        type: 'object',
        properties: {
          diretorio: { type: 'string', description: 'caminho do repositório' },
          ref: { type: 'string', description: 'branch, commit ou tag pra qual mudar' },
          host: { type: 'string', description: 'host do servidor (opcional)' },
          usuario: { type: 'string', description: 'usuário de login (opcional)' },
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

// Nomes das tools de ESCRITA deste módulo (para o confirm.mjs marcar como gated).
export const CODING_WRITE_TOOLS = ['editar_arquivo', 'escrever_arquivo', 'rodar_comando', 'git_commit', 'git_push', 'git_branch', 'git_checkout'];
