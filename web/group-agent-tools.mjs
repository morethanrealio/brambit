// Toolset of a 'grupo' (team) agent: allow-list per enabled group, host lock for
// SSH tools, and the guard that keeps tools opened later in the turn inside it.
import { PASTA_LEITURA, PASTA_ESCRITA } from './team-drive.mjs';

// ── Agent categories: toolset filter (deny-by-default on the 'grupo' category) ──
// On a 'grupo' agent (multi-person channel), the registry is assembled normally and
// THEN pruned: only tools from a safe conversational base + the
// GROUPS explicitly enabled in tool_config.groups survive. Anything that touches the
// owner's ACCOUNT (Google/Microsoft/connectors/MCP/vault/memory), that reconfigures
// the agent itself, or that pivots to another host/agent is NOT in any group,
// so it falls out for not being on the allow-list. Deny-by-default: an unknown name
// disappears. The shell only shows up if the 'shell' group is enabled.
export const GRUPO_TOOL_GROUPS = {
  // shell/code on the dedicated box (the host target is fixed in tool_config.host).
  shell: new Set([
    'sandbox_python', 'sandbox_read_file', 'sandbox_shell', 'sandbox_write_file',
    'buscar_no_codigo', 'ler_arquivo', 'listar_arquivos', 'rodar_leitura',
    'editar_arquivo', 'escrever_arquivo', 'rodar_comando',
    'git_branch', 'git_checkout', 'git_commit', 'git_push',
    'rodar_no_servidor', 'terminal',
  ]),
  // catalog/products: look up retail items and show product cards (real names
  // verified in the code; does not include owner-account connectors like Nuvemshop).
  produtos: new Set([
    'mostrar_produtos', 'buscar_produtos', 'buscar_produto_por_imagem',
    // Only READING the product page enters the group. montar_carrinho,
    // salvar_perfil_compra and ver_perfil_compra are left out on purpose: they are
    // scoped to the owner and carry their CPF/address, which in a multi-person channel
    // any participant could make show up on screen.
    'analisar_produto',
  ]),
  // manage code project (create/enter/list/deploy in the dev workspace).
  projeto: new Set(['criar_projeto', 'entrar_projeto', 'listar_projetos', 'sair_projeto', 'configurar_deploy']),
  // web: page search and reading.
  web: new Set(['buscar_web', 'abrir_link']),
  drive: new Set([...PASTA_LEITURA, ...PASTA_ESCRITA]), // only the assistant's own Drive folder
  // The owner's GitHub connection, limited to the repositories in tool_config.repos
  // (github-repo-scope.mjs). 'github' is the read sub-agent; the writes keep their confirmation.
  github: new Set([
    'github', 'github_list_repos', 'github_read_path', 'github_search_repos', 'github_search_issues',
    'github_list_issues', 'github_read_issue', 'github_create_issue', 'github_comment_issue',
    'github_create_pull_request', 'github_propose_changes',
  ]),
  // mini-PaaS (publicar/gerir sisteminhas).
  apps: new Set([
    // construir_app is the build gateway (the file tools live INSIDE it,
    // in the sub-agent; see APP_BUILD_TOOLS). The old names stay in the list with no
    // effect: the allow-list only filters what exists in the registry.
    'construir_app',
    'publicar_sistema', 'ler_arquivo_do_app', 'escrever_arquivo_do_app', 'editar_arquivo_do_app',
    'listar_arquivos_do_app', 'remover_arquivo_do_app', 'listar_sistemas', 'chamar_sistema',
    'ver_logs_sistema', 'parar_sistema', 'reiniciar_sistema', 'apagar_sistema', 'ver_historico',
    'ver_diff', 'voltar_versao', 'definir_segredo', 'listar_segredos', 'remover_segredo',
    'definir_visibilidade_sistema', 'replicar_sistema', 'listar_home', 'adicionar_na_home', 'remover_da_home',
  ]),
};
// Base always available on a 'grupo' agent (doesn't touch the owner's account or infra).
const GRUPO_BASE = new Set(['definir_meu_fuso', 'abrir_ferramentas']);
// Self-reconfiguration / pivot tools: REMOVED in 'grupo' (they aren't in any
// group) and also in 'super' (free mode is already the category; the agent doesn't change its
// own mode nor generate a key for a new host on its own). This is the fix for the
// auto-escalation-via-prompt-injection issue.
const SELF_RECONFIG_TOOLS = new Set([
  'definir_modo_permissao', 'permitir_comando', 'revogar_comando', 'gerar_chave_ssh',
]);
// Tools that open SSH to an arbitrary host using the owner's keys. On a
// 'grupo' agent the host is FIXED in tool_config.host (anti-pivot rail): a
// channel participant cannot redirect the shell to another machine.
// The list is EVERY tool that accepts `host` and goes out via sshExec/livreExec, not just
// the terminal: the code tools (coding.mjs) also receive host/usuario, so
// leaving them out would be the same pivot through another door.
const HOST_BOUND_TOOLS = new Set([
  'rodar_no_servidor', 'terminal',
  'ler_arquivo', 'listar_arquivos', 'buscar_no_codigo', 'rodar_leitura',
  'editar_arquivo', 'escrever_arquivo', 'rodar_comando',
  'git_commit', 'git_push', 'git_branch', 'git_checkout',
]);

// Decides, tool by tool, what a 'grupo' agent keeps: null drops the tool, otherwise
// the tool to register (SSH tools come back locked on the configured host).
export function groupToolGuard(cfg) {
  const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
  const allowed = new Set(GRUPO_BASE);
  for (const g of groups) for (const n of (GRUPO_TOOL_GROUPS[g] || [])) allowed.add(n);
  const host = typeof cfg?.host === 'string' ? cfg.host.trim() : '';
  const guard = (tool) => {
    const name = tool?.name;
    if (!name || SELF_RECONFIG_TOOLS.has(name) || !(allowed.has(name) || groups.includes(tool.grupo))) return null;
    // Host guard: an SSH tool only executes on the configured host. Ignores the
    // `host` the model sends and forces tool_config's.
    if (!HOST_BOUND_TOOLS.has(name) || typeof tool.run !== 'function') return tool;
    // WITHOUT a configured host the guard has nothing to lock onto, and before the
    // `if (host)` simply skipped the block: the tool would survive the pruning LOOSE and
    // whoever picks the machine became the channel text (the target falls to the vault
    // key's default, or whatever host the model invents). In a multi-person channel this is
    // shell on the owner's infra at a participant's request. Fail-closed: without a host, the
    // 'shell' group only delivers what runs in the sandbox; no SSH.
    if (!host) return null;
    const orig = tool.run.bind(tool);
    return { ...tool, run: (args = {}) => orig({ ...args, host }) };
  };
  return { guard, host };
}

// Prunes a 'grupo' agent's registry down to the allow-list of enabled groups.
export function podarRegistryGrupo(registry, cfg) {
  const { guard, host } = groupToolGuard(cfg);
  let removidas = 0, travadas = 0;
  for (const [name, tool] of [...registry.map]) {
    const kept = guard(tool);
    if (!kept) { registry.map.delete(name); removidas++; }
    else if (kept !== tool) { registry.map.set(name, kept); travadas++; }
  }
  // Tools added AFTER the pruning go through the same guard. abrir_ferramentas
  // (which is in the base) opens deferred groups in the middle of the turn, and the
  // core reads the registry at every step: without this, opening "cofre", "skills",
  // "espacos" or "codigo" handed the owner's connectors and unlocked SSH tools to
  // the channel, outside the allow-list.
  const add = registry.add.bind(registry);
  registry.add = (tool) => {
    const kept = guard(tool);
    if (kept) add(kept);
    return registry;
  };
  return { mantidas: registry.map.size, removidas, travadas, host: host || null };
}
