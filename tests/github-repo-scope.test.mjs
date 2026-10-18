// A team assistant uses the owner's GitHub token, so the repository list is the only
// thing between a channel participant and every repository the owner can reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scopeGithubTools, pushTargetCheck, repoInScope } from '../web/github-repo-scope.mjs';

const fake = (name, run) => ({ name, description: name, parameters: { type: 'object' }, run });
const scoped = (repos, overrides = {}) => {
  const calls = [];
  const runs = {
    github_read_path: async (a) => { calls.push(a); return 'file'; },
    github_create_issue: async (a) => { calls.push(a); return 'created'; },
    github_list_repos: async (a) => { calls.push(a); return JSON.stringify([{ full_name: 'Acme/Web', private: true }, { full_name: 'acme/secret' }]); },
    github_search_issues: async (a) => { calls.push(a); return JSON.stringify({ items: [{ repo: 'acme/web' }, { repo: 'acme/secret' }], returned: 2, reported_total: 2 }); },
    ...overrides,
  };
  const tools = scopeGithubTools(Object.entries(runs).map(([n, r]) => fake(n, r)), repos);
  return { calls, tool: (n) => tools.find((t) => t.name === n) };
};

test('repository arguments outside the list, or escaping it, never reach GitHub', async () => {
  const { calls, tool } = scoped(['acme/web']);
  assert.equal(await tool('github_read_path').run({ owner: 'ACME', repo: 'web', path: 'src/a.js' }), 'file');
  for (const args of [
    { owner: 'acme', repo: 'secret', path: 'a' },
    { owner: 'acme', repo: 'web/../secret', path: 'a' },
    { owner: 'acme', repo: 'web', path: '../../secret/contents/a' },
    { owner: 'acme', repo: 'web', path: 'src/./a' },
  ]) assert.doesNotMatch(await tool('github_read_path').run(args), /^file$/);
  assert.equal(calls.length, 1);

  // create/comment are refused by the confirmation gate before the owner is asked.
  const pre = await tool('github_create_issue').preflight({ owner: 'acme', repo: 'secret', title: 't' }, {});
  assert.match(pre.erro, /not enabled/);
  assert.equal(await tool('github_create_issue').preflight({ owner: 'acme', repo: 'web', title: 't' }, {}), undefined);
});

test('listing and searching show only the enabled repositories', async () => {
  const { calls, tool } = scoped(['acme/web', 'acme/docs']);
  const listed = JSON.parse(await tool('github_list_repos').run({}));
  assert.deepEqual(listed, [{ full_name: 'Acme/Web', private: true }, { full_name: 'acme/docs' }]);

  const found = JSON.parse(await tool('github_search_issues').run({ query: 'login bug' }));
  assert.equal(calls.at(-1).query, 'login bug repo:acme/web repo:acme/docs');
  assert.deepEqual(found.items, [{ repo: 'acme/web' }]);
  assert.equal(found.returned, 1);
  assert.equal(found.reported_total, undefined);
});

test('an empty list enables nothing, and non-team assistants are not scoped', async () => {
  const { calls, tool } = scoped([]);
  for (const name of ['github_read_path', 'github_list_repos', 'github_search_issues']) {
    assert.match(await tool(name).run({ owner: 'acme', repo: 'web', path: 'a', query: 'x' }), /No GitHub repository is enabled/);
  }
  assert.equal(calls.length, 0);

  const tools = [fake('github_read_path', async () => 'file')];
  assert.equal(scopeGithubTools(tools, undefined), tools);
});

// git pushes to every push URL of a remote, so one unlisted URL next to a listed one
// is enough to reach a repository outside the list.
test('a push goes only to remotes whose every push URL is enabled', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-scope-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a]);
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Acme/Web.git/');
  const pushes = (repos) => spawnSync('sh', ['-c', `${pushTargetCheck(repos, `'${dir}'`, "'origin'")} echo PUSHED`], { encoding: 'utf8' }).stdout;
  try {
    assert.match(pushes(['acme/web']), /PUSHED/);
    assert.doesNotMatch(pushes(['acme/docs']), /PUSHED/);
    assert.doesNotMatch(pushes([]), /PUSHED/);
    git('remote', 'set-url', '--add', '--push', 'origin', 'git@github.com:acme/web.git');
    assert.match(pushes(['acme/web']), /PUSHED/);
    git('remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/acme/secret');
    assert.doesNotMatch(pushes(['acme/web']), /PUSHED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  assert.equal(repoInScope('https://github.com/ACME/web.git', ['acme/web']), true);
  assert.equal(repoInScope('https://github.com/acme/web/../secret', ['acme/web']), false);
  assert.equal(repoInScope('https://gitlab.com/acme/web', ['acme/web']), false);
});
