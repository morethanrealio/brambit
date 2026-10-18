// GitHub on a team ('grupo') assistant reaches only the repositories its owner
// enabled in tool_config.repos. The tools still use the owner's token, so the
// scope is enforced here, on the arguments before anything reaches GitHub and on
// the results before they reach the model. An empty list enables nothing.

const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const NAME = /^[a-z0-9._-]{1,100}$/i;
const MAX_REPOS = 50;

// 'owner/name' in lowercase (GitHub names are case-insensitive), or null when
// either part is not a valid GitHub name. The parts go into URL paths as they
// are, so this is also what keeps '..' and '/' out of them.
export function repoFullName(owner, name) {
  const o = typeof owner === 'string' ? owner.trim() : '';
  const n = typeof name === 'string' ? name.trim() : '';
  if (!OWNER.test(o) || !NAME.test(n) || n === '.' || n === '..') return null;
  return `${o}/${n}`.toLowerCase();
}

// Sanitizes the list saved in tool_config.repos: valid 'owner/name' entries only.
export function normalizeRepoList(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const item of list) {
    const parts = typeof item === 'string' ? item.trim().split('/') : [];
    const full = parts.length === 2 ? repoFullName(parts[0], parts[1]) : null;
    if (full) out.add(full);
    if (out.size >= MAX_REPOS) break;
  }
  return [...out];
}

// 'owner/name' of a repository given as 'owner/name' or as a github.com URL
// (https or ssh form), or null for anything else.
export function githubRepoOf(ref) {
  const s = typeof ref === 'string' ? ref.trim() : '';
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  return m ? repoFullName(m[1], m[2]) : null;
}

// Whether a project's repository is reachable. `repos` undefined = not a team assistant.
export function repoInScope(ref, repos) {
  return repos === undefined || normalizeRepoList(repos).includes(githubRepoOf(ref));
}

// Shell snippet that stops a push unless every push URL of the remote is an enabled
// repository. A remote can have several push URLs and git pushes to all of them, so
// all are checked. `dir` and `remote` come already quoted.
export function pushTargetCheck(repos, dir, remote) {
  const allowed = normalizeRepoList(repos)
    .flatMap((r) => [`https://github.com/${r}`, `git@github.com:${r}`, `ssh://git@github.com/${r}`]).join('|');
  const refuse = `echo 'This remote is not one of the GitHub repositories enabled for this assistant.'; exit 2`;
  if (!allowed) return `${refuse};`;
  return `U="$(git -C ${dir} remote get-url --push --all ${remote})" || exit 2; `
    + `printf '%s\\n' "$U" | while IFS= read -r L; do L="$(printf '%s' "$L" | tr 'A-Z' 'a-z')"; L="\${L%/}"; L="\${L%.git}"; `
    + `case "$L" in ${allowed}) ;; *) ${refuse};; esac; done || exit 2;`;
}

// Tools that name one repository in their arguments.
const REPO_ARG_TOOLS = new Set(['github_read_path', 'github_list_issues', 'github_read_issue', 'github_create_issue', 'github_comment_issue']);
const SEARCH_KEY = { github_search_repos: 'full_name', github_search_issues: 'repo' };

// `repos` undefined = not a team assistant, the tools are returned untouched.
export function scopeGithubTools(tools, repos) {
  if (repos === undefined) return tools;
  const allowed = new Set(normalizeRepoList(repos));
  const noRepos = 'No GitHub repository is enabled for this assistant. The owner picks them in the assistant settings.';
  const refuse = (args = {}) => {
    if (!allowed.size) return noRepos;
    const full = repoFullName(args.owner, args.repo);
    if (!full || !allowed.has(full)) return `The repository ${args.owner}/${args.repo} is not enabled for this assistant. Enabled repositories: ${[...allowed].join(', ')}.`;
    // read_path joins the path into the URL and '..' would climb out of the repository.
    if (args.path !== undefined && (typeof args.path !== 'string' || args.path.split('/').some((s) => s === '.' || s === '..'))) return 'Invalid path: it cannot contain "." or ".." segments.';
    if (args.number !== undefined && !/^\d{1,10}$/.test(String(args.number))) return 'Invalid issue number.';
    return null;
  };
  // Without its own repo: qualifier, a search is limited to the enabled repositories.
  const scopedQuery = (q) => (typeof q === 'string' && !/(^|\s)repo:/i.test(q))
    ? `${q} ${[...allowed].map((r) => `repo:${r}`).join(' ')}` : q;
  return tools.map((tool) => {
    const run = tool.run.bind(tool);
    if (REPO_ARG_TOOLS.has(tool.name)) {
      // preflight lets the confirmation gate refuse create/comment before asking the owner.
      return { ...tool,
        preflight: async (args, ctx) => { const why = refuse(args); return why ? { erro: why } : tool.preflight?.(args, ctx); },
        run: async (args = {}) => refuse(args) ?? run(args) };
    }
    if (tool.name === 'github_list_repos') {
      return { ...tool, run: async (args = {}) => {
        if (!allowed.size) return noRepos;
        const raw = await run({ ...args, max: 100 });
        let listed = [];
        try { listed = JSON.parse(raw); } catch { /* "none found" text */ }
        const byName = new Map((Array.isArray(listed) ? listed : []).map((r) => [String(r?.full_name).toLowerCase(), r]));
        return JSON.stringify([...allowed].map((full) => byName.get(full) || { full_name: full }));
      } };
    }
    if (SEARCH_KEY[tool.name]) {
      return { ...tool, run: async (args = {}) => {
        if (!allowed.size) return noRepos;
        const raw = await run({ ...args, query: scopedQuery(args.query) });
        let res = null;
        try { res = JSON.parse(raw); } catch { /* not a search result */ }
        if (!Array.isArray(res?.items)) return 'Could not read the GitHub search result.';
        const items = res.items.filter((i) => allowed.has(String(i?.[SEARCH_KEY[tool.name]]).toLowerCase()));
        if (items.length !== res.items.length) { res.items = items; res.returned = items.length; delete res.reported_total; }
        return JSON.stringify(res);
      } };
    }
    return tool;
  });
}
