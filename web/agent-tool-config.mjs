// Tool configuration of a 'grupo' (team) agent, saved in agents.tool_config.
import { normalizeRepoList } from './github-repo-scope.mjs';

// Tool groups that can be enabled on a 'grupo' agent (allow-list in tool_config.groups).
// 'shell' = shell/code on the dedicated box; 'produtos' = scrape + RAG/catalog;
// 'projeto' = create/manage project; 'web' = search/open link; 'apps' = mini-PaaS; 'drive' = own Drive folder;
// 'github' = read code, issues and PRs and open/comment issues, only in tool_config.repos.
export const AGENT_TOOL_GROUPS = ['shell', 'produtos', 'projeto', 'web', 'apps', 'drive', 'github'];

// Sanitizes the tool_config coming from the UI: only known groups, short host string,
// valid 'owner/name' repositories.
export function normalizeToolConfig(tc) {
  const o = (tc && typeof tc === 'object') ? tc : {};
  const groups = Array.isArray(o.groups)
    ? o.groups.filter((g) => AGENT_TOOL_GROUPS.includes(g))
    : [];
  const host = typeof o.host === 'string' ? o.host.trim().slice(0, 200) : '';
  return { groups: [...new Set(groups)], host, repos: normalizeRepoList(o.repos) };
}
