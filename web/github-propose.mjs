// ── github_propose_changes: open a pull request from commits made in a workbench ──
// The assistant codes in the sandbox or in a project workspace, and neither one
// holds a GitHub credential (a package installed there could steal it). This tool
// reads the commits from the workbench and the server recreates them on GitHub
// through the Git Data API, with the user's GitHub connection: blobs, one tree and
// one commit per local commit, a new branch and the pull request.
//
// The first commit is built on the merge base the work started from, not on the
// base branch as it is now, so a conflict shows up in the pull request instead of
// silently overwriting newer work. Each tree GitHub builds must have the same SHA
// as the local one, otherwise nothing is published (the branch is only created at
// the end). An existing branch is never moved.
//
// Workbench output goes through secret masking (devexec.mjs), which would change
// file contents and commit messages, so every byte comes back as lowercase hex,
// which no mask pattern matches, read in chunks under the sandbox output cap.
import { createHash } from 'node:crypto';
import { sandboxEnabled, sandboxUserShell } from './sandbox.mjs';
import { devexecEnabled, devExec } from './devexec.mjs';
import { repoFullName, githubRepoOf } from './github-repo-scope.mjs';
import { productI18n } from './i18n.mjs';

const GH = 'https://api.github.com';
const MAX_COMMITS = 50;
const MAX_CHANGES = 1000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
// The sandbox returns at most 100k characters of stdout and hex doubles the bytes;
// the project workspace has no cap, so it reads in bigger chunks.
const SANDBOX_CHUNK = 45_000;
const PROJECT_CHUNK = 1024 * 1024;
// Text files go inline in the tree request; binary or large ones become blobs first.
const INLINE_MAX = 512 * 1024;
const INLINE_TOTAL = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class ProposeError extends Error {}
const fail = (msg) => { throw new ProposeError(msg); };

async function gh(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(GH + path, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'brambs',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: r.status, ok: r.ok, data, text: text.slice(0, 300) };
}
async function ghOk(token, path, opts, what) {
  const r = await gh(token, path, opts);
  if (!r.ok) fail(`GitHub refused to ${what} (${r.status}: ${r.data?.message || r.text}). Nothing was published.`);
  return r.data;
}

// Branch names GitHub accepts (a subset of git check-ref-format).
export function validBranch(name) {
  const s = String(name ?? '');
  return s.length > 0 && s.length <= 200 && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s) && !s.includes('..')
    && !s.includes('@{') && !s.includes('//') && !/^[-/.]|[/.]$|\.lock$|\/\./.test(s) && s !== '@';
}

// Runs a command in the workbench and returns its stdout as bytes. The output is
// wrapped in markers so noise printed by a login shell does not corrupt it.
async function hexRun(exec, script) {
  const r = await exec(`printf 'BX<'; { ${script}; } 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'; printf '>BX'`);
  const m = /BX<([0-9a-f]*)>BX/.exec(r.out || '');
  if (!m) fail(`Could not read the folder in the workbench (${String(r.err || 'no output').slice(0, 200)}).`);
  return Buffer.from(m[1], 'hex');
}

// Reads a deterministic command's output in chunks. `producer` must print the same
// bytes on every run (it is re-run per chunk instead of leaving a file behind).
async function readStream(exec, producer, limit, what) {
  const size = Number((await hexRun(exec, `{ ${producer}; } | wc -c`)).toString().trim());
  if (!Number.isFinite(size)) fail(`Could not measure the ${what}.`);
  if (size > limit) fail(`The ${what} is too large for one pull request (${size} bytes, limit ${limit}). Split it into smaller pull requests.`);
  const parts = [];
  for (let off = 0; off < size; off += exec.chunk) parts.push(await hexRun(exec, `{ ${producer}; } | tail -c +${off + 1} | head -c ${exec.chunk}`));
  const buf = Buffer.concat(parts);
  if (buf.length !== size) fail(`The ${what} changed while it was being read. Try again.`);
  return buf;
}

// One read-only call: HEAD, branch, uncommitted changes, remotes and, for every
// candidate ref of the base branch, its SHA, the merge base and the commit count.
async function probe(exec, dir, base) {
  const B = shq(base);
  const script = `cd -- ${shq(dir)} || { echo error=nodir; exit 0; }; `
    + `git rev-parse --is-inside-work-tree >/dev/null || { echo error=norepo; exit 0; }; `
    + `H=$(git rev-parse -q --verify 'HEAD^{commit}'); echo "head=$H"; `
    + `echo "headtree=$(git rev-parse -q --verify 'HEAD^{tree}')"; `
    + `echo "branch=$(git symbolic-ref -q --short HEAD)"; `
    + `echo "dirty=$(git status --porcelain --untracked-files=no | wc -l)"; `
    + `echo "untracked=$(git status --porcelain --untracked-files=normal | grep -c '^??')"; `
    + `for r in $(git remote); do echo "remote=$r $(git remote get-url "$r")"; `
    + `S=$(git rev-parse -q --verify "refs/remotes/$r/"${B}'^{commit}') && M=$(git merge-base "$H" "$S") && echo "cand=$r $S $M $(git rev-list --count "$M..$H")"; done; `
    + `S=$(git rev-parse -q --verify "refs/heads/"${B}'^{commit}') && M=$(git merge-base "$H" "$S") && echo "cand=. $S $M $(git rev-list --count "$M..$H")"; true`;
  const out = (await hexRun(exec, script)).toString('utf8');
  const p = { remotes: {}, cands: [] };
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'remote') { const j = v.indexOf(' '); p.remotes[v.slice(0, j)] = v.slice(j + 1); }
    else if (k === 'cand') { const [remote, sha, mergeBase, count] = v.split(' '); p.cands.push({ remote, sha, mergeBase, count: Number(count) || 0 }); }
    else p[k] = v;
  }
  return p;
}

// Picks the base ref: the remote that points at owner/repo first, then the local branch.
function pickBase(p, full) {
  const remote = Object.keys(p.remotes).find((r) => githubRepoOf(p.remotes[r]) === full);
  return p.cands.find((c) => remote && c.remote === remote) || p.cands.find((c) => c.remote === '.') || null;
}

// Parses `git diff-tree -r -z --raw` output, preceded by a "C<sha>" token per commit.
function parseDiffs(buf) {
  const tok = buf.toString('utf8').split('\0');
  const commits = [];
  let cur = null;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    if (t[0] === ':') {
      const [oldMode, newMode, oldSha, newSha, status] = t.slice(1).split(' ');
      cur.changes.push({ oldMode, newMode, oldSha, newSha, status: status[0], path: tok[++i] });
    } else if (t[0] === 'C') {
      cur = { sha: t.slice(1), changes: [] };
      commits.push(cur);
    }
  }
  return commits;
}

// Parses `git cat-file --batch` output and checks every object against its SHA.
function parseObjects(buf) {
  const objects = new Map();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) fail('The workbench returned an incomplete object list.');
    const [sha, type, size] = buf.subarray(at, nl).toString().split(' ');
    if (type === 'missing' || !size) fail(`Object ${sha} is missing from the folder.`);
    const n = Number(size);
    const content = buf.subarray(nl + 1, nl + 1 + n);
    const real = createHash('sha1').update(`${type} ${n}\0`).update(content).digest('hex');
    if (content.length !== n || real !== sha) fail(`Object ${sha} came back damaged from the workbench. Nothing was published.`);
    objects.set(sha, { type, content });
    at = nl + 1 + n + 1;
  }
  return objects;
}

// "Name <email> 1700000000 -0300" -> GitHub's { name, email, date }.
function person(line) {
  const m = /^(.*) <([^>]*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(line || '');
  if (!m) return undefined;
  const offset = (m[4] === '-' ? -1 : 1) * (Number(m[5]) * 60 + Number(m[6]));
  const local = new Date((Number(m[3]) + offset * 60) * 1000).toISOString().slice(0, 19);
  return { name: m[1], email: m[2], date: `${local}${m[4]}${m[5]}:${m[6]}` };
}

function parseCommit(content) {
  const text = content.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  const c = { parents: [], message: end < 0 ? '' : text.slice(end + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of gpgsig/mergetag
    const i = line.indexOf(' ');
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'tree') c.tree = v;
    else if (k === 'parent') c.parents.push(v);
    else if (k === 'author') c.author = person(v);
    else if (k === 'committer') c.committer = person(v);
  }
  return c;
}

const isInlineText = (buf) => buf.length <= INLINE_MAX && !buf.includes(0)
  && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);

export function githubProposeTools({ userId, token, sandbox = false, project = null }) {
  const benches = {};
  if (sandbox && sandboxEnabled()) {
    benches.sandbox = Object.assign(async (cmd) => {
      const r = await sandboxUserShell(userId, cmd, 90_000).catch((e) => fail(`The sandbox did not answer (${e.message}).`));
      return { out: r.stdout || '', err: r.stderr || (r.timedOut ? 'timeout' : '') };
    }, { chunk: SANDBOX_CHUNK });
  }
  if (project && devexecEnabled()) {
    benches.project = Object.assign(async (cmd) => {
      const r = await devExec({ user: project.ownerUserId, proj: project.nome, cmd, timeout: 90 }).catch((e) => fail(`The project workspace did not answer (${e.message}).`));
      return { out: r.saida || '', err: r.stderr || r.error || '' };
    }, { chunk: PROJECT_CHUNK });
  }
  const names = Object.keys(benches);
  if (!names.length) return [];

  const benchOf = (args) => {
    if (args.where && !benches[args.where]) fail(`There is no ${args.where} workbench in this conversation. Available: ${names.join(', ')}.`);
    if (args.where) return args.where;
    if (names.length === 1) return names[0];
    return String(args.dir || '').startsWith('/workspace') ? 'sandbox' : 'project';
  };

  // Everything that can be checked without writing; preflight and run share it.
  async function inspect(args) {
    const full = repoFullName(args.owner, args.repo);
    if (!full) fail('Invalid repository owner or name.');
    if (!args.title || !String(args.title).trim()) fail('The pull request needs a title.');
    if (!args.dir || !String(args.dir).trim()) fail('Say which folder holds the repository (dir).');
    const where = benchOf(args);
    const exec = benches[where];
    const repoRes = await gh(token, `/repos/${full}`);
    if (repoRes.status === 401) fail('The GitHub connection is no longer valid. Ask the person to reconnect GitHub in Connections.');
    if (repoRes.status === 404) fail(`The repository ${full} was not found, or the GitHub connection cannot see it.`);
    if (!repoRes.ok) fail(`GitHub did not answer about ${full} (${repoRes.status}).`);
    const repo = repoRes.data;
    if (!repo?.permissions?.push) fail(`The connected GitHub account cannot write to ${full}. Opening a pull request from a fork is not supported yet.`);
    const base = args.base ? String(args.base) : repo.default_branch;
    if (!validBranch(base)) fail('Invalid base branch name.');
    const p = await probe(exec, String(args.dir), base);
    if (p.error === 'nodir') fail(`The folder ${args.dir} does not exist in the ${where} workbench.`);
    if (p.error === 'norepo') fail(`The folder ${args.dir} is not a git repository.`);
    if (!SHA.test(p.head || '')) fail('The repository has no commits yet.');
    if (Number(p.dirty) > 0) fail('The folder has uncommitted changes. Commit them first (git add + git commit), then call again.');
    const cand = pickBase(p, full);
    if (!cand || !SHA.test(cand.mergeBase || '')) fail(`The folder does not know the base branch ${base}. Run git fetch on the remote that points at ${full}, then call again.`);
    if (cand.mergeBase === p.head) fail(`There are no commits after ${base} in this folder. Commit the changes first.`);
    if (cand.count > MAX_COMMITS) fail(`Too many commits for one pull request (${cand.count}, limit ${MAX_COMMITS}). Squash or split them.`);
    const branch = args.branch ? String(args.branch) : p.branch;
    if (!branch) fail('The folder is not on a branch. Pass the branch name to create on GitHub.');
    if (!validBranch(branch)) fail('Invalid branch name.');
    if (branch === base || branch === repo.default_branch) fail(`The branch cannot be ${branch}: choose a new branch name for the pull request.`);
    const baseCommit = await gh(token, `/repos/${full}/git/commits/${cand.mergeBase}`);
    if (baseCommit.status === 404) fail(`The commit this work started from (${cand.mergeBase.slice(0, 7)}) is not on GitHub. Fetch ${base}, rebase onto it, then call again.`);
    if (!baseCommit.ok) fail(`GitHub did not answer about the base commit (${baseCommit.status}).`);
    const existing = await gh(token, `/repos/${full}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    let reuse = null;
    if (existing.ok && existing.data?.object?.sha) {
      const at = await ghOk(token, `/repos/${full}/git/commits/${existing.data.object.sha}`, {}, 'read the existing branch');
      if (at.tree?.sha !== p.headtree) fail(`A branch named ${branch} already exists on ${full} with other content. Choose another branch name.`);
      reuse = existing.data.object.sha;
    }
    return { full, where, exec, base, branch, head: p.head, mergeBase: cand.mergeBase, count: cand.count, baseTree: baseCommit.data.tree.sha, untracked: Number(p.untracked) || 0, reuse };
  }

  async function publish(args) {
    const s = await inspect(args);
    let tip = s.reuse;
    let commits = [];
    let files = new Set();
    if (!tip) {
      const diffs = parseDiffs(await readStream(s.exec,
        `cd -- ${shq(args.dir)} && for c in $(git rev-list --reverse --topo-order ${s.mergeBase}..${s.head}); do printf 'C%s\\000' "$c"; git diff-tree -r -z --no-renames --no-commit-id --raw "$c"; done`,
        MAX_DIFF_BYTES, 'list of changes'));
      if (!diffs.length) fail('There are no commits to send.');
      if (diffs.length > MAX_COMMITS) fail(`Too many commits for one pull request (${diffs.length}, limit ${MAX_COMMITS}). Squash or split them.`);
      const changes = diffs.flatMap((d) => d.changes);
      if (changes.length > MAX_CHANGES) fail(`Too many file changes for one pull request (${changes.length}, limit ${MAX_CHANGES}).`);
      const wanted = [...new Set([...diffs.map((d) => d.sha),
        ...changes.filter((c) => c.status !== 'D' && c.newMode !== '160000').map((c) => c.newSha)])];
      if (!wanted.every((w) => SHA.test(w))) fail('The workbench returned an unexpected object name.');
      const objects = parseObjects(await readStream(s.exec,
        `cd -- ${shq(args.dir)} && printf '%s\\n' ${wanted.join(' ')} | git cat-file --batch`,
        MAX_OBJECT_BYTES, 'content of the changes'));
      // One commit after the other from the merge base: a merge would need its other side too.
      let parent = s.mergeBase;
      for (const d of diffs) {
        const c = parseCommit(objects.get(d.sha)?.content || Buffer.alloc(0));
        if (c.parents.length !== 1 || c.parents[0] !== parent) fail('The commits are not a straight line from the base branch (there is a merge). Rebase onto the base branch, then call again.');
        commits.push({ ...c, sha: d.sha, changes: d.changes });
        parent = d.sha;
      }

      const blobs = new Map();
      const blobSha = async (sha) => {
        if (!blobs.has(sha)) {
          const b = await ghOk(token, `/repos/${s.full}/git/blobs`, { method: 'POST', body: { content: objects.get(sha).content.toString('base64'), encoding: 'base64' } }, 'store a file');
          if (b.sha !== sha) fail('GitHub stored a file with different content. Nothing was published.');
          blobs.set(sha, sha);
        }
        return sha;
      };
      let tree = s.baseTree;
      parent = s.mergeBase;
      for (const c of commits) {
        const entries = [];
        let inline = 0;
        for (const ch of c.changes) {
          files.add(ch.path);
          if (ch.status === 'D') { entries.push({ path: ch.path, mode: ch.oldMode, type: 'blob', sha: null }); continue; }
          if (ch.newMode === '160000') { entries.push({ path: ch.path, mode: ch.newMode, type: 'commit', sha: ch.newSha }); continue; }
          const content = objects.get(ch.newSha).content;
          if (isInlineText(content) && inline + content.length <= INLINE_TOTAL) {
            inline += content.length;
            entries.push({ path: ch.path, mode: ch.newMode, type: 'blob', content: content.toString('utf8') });
          } else entries.push({ path: ch.path, mode: ch.newMode, type: 'blob', sha: await blobSha(ch.newSha) });
        }
        if (entries.length) {
          const t = await ghOk(token, `/repos/${s.full}/git/trees`, { method: 'POST', body: { base_tree: tree, tree: entries } }, 'build the files of a commit');
          tree = t.sha;
        }
        if (tree !== c.tree) fail(`GitHub built different content for commit ${c.sha.slice(0, 7)}. Nothing was published.`);
        const made = await ghOk(token, `/repos/${s.full}/git/commits`, { method: 'POST', body: {
          message: c.message, tree, parents: [parent],
          ...(c.author ? { author: c.author } : {}), ...(c.committer ? { committer: c.committer } : {}),
        } }, 'create a commit');
        parent = made.sha;
      }
      tip = parent;
      const ref = await gh(token, `/repos/${s.full}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${s.branch}`, sha: tip } });
      if (!ref.ok) fail(ref.status === 422 ? `A branch named ${s.branch} was created on ${s.full} in the meantime. Choose another branch name.` : `GitHub refused to create the branch (${ref.status}: ${ref.data?.message || ref.text}). Nothing was published.`);
    }

    const payload = { title: String(args.title), head: s.branch, base: s.base };
    if (args.body) payload.body = String(args.body);
    if (args.draft) payload.draft = true;
    let pr = await gh(token, `/repos/${s.full}/pulls`, { method: 'POST', body: payload });
    if (pr.status === 422 && /already exists/i.test(pr.text)) {
      const open = await ghOk(token, `/repos/${s.full}/pulls?state=open&head=${encodeURIComponent(`${s.full.split('/')[0]}:${s.branch}`)}`, {}, 'find the open pull request');
      if (Array.isArray(open) && open[0]) pr = { ok: true, data: open[0], existed: true };
    }
    if (!pr.ok) fail(`The branch ${s.branch} is on GitHub, but the pull request was not opened (${pr.status}: ${pr.data?.message || pr.text}).`);
    const notes = [pr.existed ? 'A pull request for this branch was already open; nothing new was created.' : 'Pull request opened.'];
    if (s.reuse) notes.push(`The branch ${s.branch} was already on GitHub with this content, so no commit was sent again.`);
    if (s.untracked) notes.push(`${s.untracked} file(s) in the folder were never added to git and are not in the pull request.`);
    return JSON.stringify({ ok: true, id: pr.data.id, number: pr.data.number, url: pr.data.html_url, branch: s.branch, base: s.base,
      commits: s.reuse ? undefined : commits.length, files: s.reuse ? undefined : files.size, note: notes.join(' ') });
  }

  const guard = (fn) => async (args = {}) => {
    try { return await fn(args); } catch (e) { if (e instanceof ProposeError) return e.message; throw e; }
  };

  return [{
    name: 'github_propose_changes',
    description: 'Opens a pull request on the user\'s GitHub with the commits made in a repository folder of the sandbox or of the project workspace. There is no GitHub credential where code runs, on purpose, so git push from there fails: commit the work locally (git add + git commit, on a new branch), then call this. The server reads the commits from the folder and recreates them on GitHub with the user\'s connection: same files, messages and authors, starting from the commit the work was based on, so conflicts show in the pull request instead of overwriting anything. It never changes an existing branch. Show the user the repository, branch, base and title before calling, and never ask anyone for a GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the GitHub repository (user or organization).' },
        repo: { type: 'string', description: 'Name of the GitHub repository.' },
        dir: { type: 'string', description: 'Folder of the local repository: an absolute path in the sandbox (e.g. /workspace/app) or "." for the active project.' },
        where: { type: 'string', enum: ['sandbox', 'project'], description: 'Which workbench holds the folder. Optional: inferred from dir.' },
        branch: { type: 'string', description: 'Name of the new branch on GitHub. Default: the folder\'s current branch.' },
        base: { type: 'string', description: 'Branch to merge into. Default: the repository\'s default branch.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Description of the pull request (Markdown).' },
        draft: { type: 'boolean', description: 'Open as a draft.' },
      },
      required: ['owner', 'repo', 'dir', 'title'],
    },
    // Read-only: refuses before the confirmation card what would fail anyway, and
    // tells the owner what is about to be sent.
    async preflight(args, { language } = {}) {
      try {
        const s = await inspect(args);
        const t = (key, vars) => productI18n().t(`confirm.github_propose_changes.${key}`, language, vars);
        const notes = [t('notice', { commits: s.count, branch: s.branch, base: s.base })];
        if (s.untracked) notes.push(t('untracked', { count: s.untracked }));
        return { aviso: notes.join('. ') };
      } catch (e) { if (e instanceof ProposeError) return { erro: e.message }; throw e; }
    },
    run: guard(publish),
  }];
}
