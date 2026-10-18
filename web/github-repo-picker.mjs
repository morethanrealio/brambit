// GET /api/github/repos: the repositories the owner's GitHub connection reaches,
// so the assistant settings can pick which ones a team assistant may use
// (tool_config.repos, github-repo-scope.mjs). Without a GitHub connection the
// answer is { connected: false } and the screen asks the owner to connect it.
const PAGES = 3; // up to 300 repositories, most recently updated first

export function registerGithubRepoPicker(rotas, { send, fail, tokenFor, fetchFn = fetch }) {
  rotas.registrar('GET', '/api/github/repos', async (req, res, url, ctx) => {
    const user = await ctx.currentUser();
    if (!user) return send(res, 401, { error: 'server.log_in_first' });
    let token = null;
    try { token = await tokenFor(user.id); } catch { /* not connected or expired */ }
    if (!token) return send(res, 200, { connected: false, repos: [] });
    try {
      const repos = [];
      for (let page = 1; page <= PAGES; page++) {
        const r = await fetchFn(`https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'brambit' },
        });
        if (!r.ok) throw new Error(`GitHub ${r.status}`);
        const list = await r.json();
        if (!Array.isArray(list)) break;
        for (const repo of list) if (typeof repo?.full_name === 'string') repos.push({ full_name: repo.full_name.toLowerCase(), private: !!repo.private });
        if (list.length < 100) break;
      }
      return send(res, 200, { connected: true, repos });
    } catch (e) {
      return fail(res, 502, 'server.failed_list_github_repos', e);
    }
  });
}
