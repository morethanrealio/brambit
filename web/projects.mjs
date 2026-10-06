// ── "Project" primitive (dev mode / advanced tier) ──
//
// A Project ties together: a repo (the user's GitHub) + a real dev workspace (on
// the mini-PaaS host, provisioned via devexec) + a deploy target. "Entering a
// project" = having the repo cloned and an environment ready to code, instead of
// creating an app INSIDE the platform (bug of 08/2026). The coding toolset then
// works in the ACTIVE project's workspace (see coding.mjs + server.mjs).
//
// Transport: devexec.mjs (control channel to the workspace host). The user's
// GitHub token is only used for clone/push, always in memory.
import { devexecEnabled, devCreate, devClone, devExec } from './devexec.mjs';
import {
  createProject, listProjects, getProject, getProjectByName,
  updateProjectFields, setAgentActiveProject, getActiveProjectForAgent,
} from './db.mjs';
import { marca } from './marca.mjs';

// Normaliza o que o usuário deu como "repo" numa URL clonável.
// Aceita URL completa (https/ssh) ou o atalho "owner/repo".
function normalizeRepo(repo) {
  const r = String(repo || '').trim();
  if (!r) return '';
  if (/^https?:\/\//i.test(r) || /^git@/i.test(r)) return r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r.replace(/\.git$/, '')}`;
  return r;
}

// Identidade do workspace no host: (user = id do dono, proj = nome do projeto).
// O devctl.sh sanitiza os dois; container = brambs-dev-<san(user)>-<san(proj)>.
function wsRef(ownerUserId, nome) { return { user: ownerUserId, proj: nome }; }

async function githubTokenSafe(getGithubToken) {
  if (!getGithubToken) return null;
  try { return await getGithubToken(); } catch { return null; }
}

export function projectTools(userId, agentId, { getGithubToken } = {}) {
  if (!devexecEnabled()) return [];

  return [
    {
      name: 'criar_projeto',
      description: `Cria um PROJETO de desenvolvimento de verdade: provisiona um workspace real (com Node, git e ferramentas de build) e clona um repositório do GitHub do usuário nele. Use quando o usuário quer DESENVOLVER código num repo (ex: "cria um projeto do meu repo tal", "quero mexer no meu app React"), NÃO para criar um app dentro do ${marca().nome}. Depois de criar, o projeto já fica ATIVO (as ferramentas de coding passam a operar nele).`,
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'nome curto do projeto (ex: "app-ios", "site-novo")' },
          repo: { type: 'string', description: 'repositório a clonar: URL (https://github.com/dono/repo) ou atalho "dono/repo". Opcional (pode criar vazio).' },
          deploy_target: { type: 'string', enum: ['own_ssh', 'dedicated'], description: 'onde vai publicar depois: "own_ssh" (servidor do próprio usuário, via SSH) ou "dedicated" (nossa infra). Padrão own_ssh.' },
        },
        required: ['nome'],
      },
      async run({ nome, repo, deploy_target }) {
        const created = await createProject(userId, { nome, repoUrl: normalizeRepo(repo), deployTargetType: deploy_target || 'own_ssh' });
        if (created.error === 'nome_vazio') return 'Dá um nome pro projeto.';
        if (created.error === 'ja_existe') return `Você já tem um projeto chamado "${nome}". Use "entrar no projeto ${nome}" ou escolha outro nome.`;
        if (!created.ok) return 'Não consegui criar o projeto.';
        const p = created.project;
        const { user, proj } = wsRef(userId, p.nome);

        const prov = await devCreate({ user, proj });
        if (!prov.ok) {
          return `Criei o registro do projeto mas o workspace não subiu: ${prov.error || prov.stderr || 'erro'}. Tente "entrar no projeto ${p.nome}" pra provisionar de novo.`;
        }

        let cloneMsg = 'workspace vazio (sem repo).';
        const repoUrl = normalizeRepo(repo);
        if (repoUrl) {
          const token = await githubTokenSafe(getGithubToken);
          const cl = await devClone({ user, proj, repo: repoUrl, token });
          if (cl.ok) cloneMsg = `repo clonado: ${repoUrl}`;
          else cloneMsg = `workspace pronto, mas o clone falhou: ${cl.saida || cl.stderr || cl.error || 'erro'}${token ? '' : ' (dica: conecte o GitHub em Conexões se o repo for privado)'}`;
        }

        await updateProjectFields(p.id, userId, { workspaceRef: `${user}/${proj}` });
        await setAgentActiveProject(agentId, userId, p.id);
        return `Projeto "${p.nome}" criado e ATIVO (deploy: ${p.deployTargetType}). ${cloneMsg}\nAgora as ferramentas de coding operam nele; me peça pra listar arquivos, ler ou editar.`;
      },
    },
    {
      name: 'listar_projetos',
      description: 'Lista os projetos de desenvolvimento do usuário e marca qual está ativo agora.',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const list = await listProjects(userId);
        if (!list.length) return 'Você ainda não tem projetos. Crie um com "cria um projeto do repo tal".';
        const active = await getActiveProjectForAgent(agentId);
        const lines = list.map((p) => `• ${p.nome}${active && active.id === p.id ? ' (ATIVO)' : ''} — ${p.repoUrl || 'sem repo'} · deploy ${p.deployTargetType}`);
        return lines.join('\n');
      },
    },
    {
      name: 'entrar_projeto',
      description: 'Entra num projeto existente: garante que o workspace está de pé e passa a operar nele com as ferramentas de coding. Aceita o nome ou o id do projeto.',
      parameters: {
        type: 'object',
        properties: {
          projeto: { type: 'string', description: 'nome ou id do projeto' },
        },
        required: ['projeto'],
      },
      async run({ projeto }) {
        let p = await getProjectByName(userId, projeto);
        if (!p && /^[0-9a-f-]{16,}$/i.test(projeto)) p = await getProject(projeto, userId);
        if (!p) return `Não achei um projeto chamado "${projeto}". Use "listar projetos".`;
        const { user, proj } = wsRef(userId, p.nome);
        const prov = await devCreate({ user, proj });
        if (!prov.ok) return `Não consegui subir o workspace do projeto: ${prov.error || prov.stderr || 'erro'}.`;
        await setAgentActiveProject(agentId, userId, p.id);
        let branch = '';
        const b = await devExec({ user, proj, cmd: 'git rev-parse --abbrev-ref HEAD 2>/dev/null || echo -', timeout: 20 });
        if (b.ok) branch = (b.saida || '').trim();
        return `Entrei no projeto "${p.nome}"${branch && branch !== '-' ? ` (branch ${branch})` : ''}. As ferramentas de coding agora operam nele.`;
      },
    },
    {
      name: 'sair_projeto',
      description: 'Sai do projeto ativo. Depois disso as ferramentas de coding voltam a exigir host explícito (servidor do usuário).',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const active = await getActiveProjectForAgent(agentId);
        if (!active) return 'Você não está dentro de nenhum projeto.';
        await setAgentActiveProject(agentId, userId, null);
        return `Saí do projeto "${active.nome}".`;
      },
    },
    {
      name: 'configurar_deploy',
      description: 'Configura o alvo de deploy do projeto ativo: "own_ssh" (servidor do próprio usuário via SSH) ou "dedicated" (nossa infra). Opcionalmente guarda detalhes (host, branch, comando de publish) em config.',
      parameters: {
        type: 'object',
        properties: {
          deploy_target: { type: 'string', enum: ['own_ssh', 'dedicated'], description: 'alvo de deploy' },
          host: { type: 'string', description: 'host do servidor do usuário (só own_ssh)' },
          usuario: { type: 'string', description: 'usuário de login no servidor (só own_ssh)' },
          branch: { type: 'string', description: 'branch a publicar' },
          comando: { type: 'string', description: 'comando de publish no servidor (ex: git pull && systemctl restart app)' },
        },
        required: [],
      },
      async run({ deploy_target, host, usuario, branch, comando }) {
        const active = await getActiveProjectForAgent(agentId);
        if (!active) return 'Entre num projeto primeiro ("entrar no projeto tal").';
        const cfg = { ...(active.deployConfig || {}) };
        if (host !== undefined) cfg.host = host;
        if (usuario !== undefined) cfg.usuario = usuario;
        if (branch !== undefined) cfg.branch = branch;
        if (comando !== undefined) cfg.comando = comando;
        const fields = { deployConfig: cfg };
        if (deploy_target) fields.deployTargetType = deploy_target;
        const r = await updateProjectFields(active.id, userId, fields);
        if (!r.ok) return 'Não consegui atualizar o deploy do projeto.';
        const p = r.project;
        return `Deploy do projeto "${p.nome}": alvo ${p.deployTargetType}${cfg.host ? `, host ${cfg.host}` : ''}${cfg.branch ? `, branch ${cfg.branch}` : ''}${cfg.comando ? `, publish "${cfg.comando}"` : ''}.`;
      },
    },
  ];
}
