// GitHub issue labels, assignees, type, issue fields and Projects, against a fake
// GitHub. Incident 23/10/2026: asked for Type, Size, Effort and a project, the
// assistant created three new labels ("Type -> Feature"...) and said it had set
// assignees the tool could not set. Run with: node --test tests/github-issue-fields.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { githubTools } from '../web/connectors-ext.mjs';
import { PROJECT_SCOPE_MSG } from '../web/github-issue-meta.mjs';
import { describe } from '../web/confirm.mjs';
import { actionEvidenceFor } from '../web/action-evidence.mjs';
net.Socket.prototype.connect = tls.connect = () => { throw Error('Real network forbidden'); };

const REPO_META = { repository: {
  issueTypes: { nodes: [{ id: 'IT_feature', name: 'Feature', isEnabled: true }, { id: 'IT_bug', name: 'Bug', isEnabled: true }] },
  issueFields: { nodes: [
    { __typename: 'IssueFieldSingleSelect', id: 'IF_effort', name: 'Effort', options: [{ id: 'O_med', name: 'Medium' }, { id: 'O_low', name: 'Low' }] },
    { __typename: 'IssueFieldDate', id: 'IF_target', name: 'Target date' },
  ] },
} };
const PROJECTS = { repositoryOwner: { projectsV2: { nodes: [
  { id: 'PVT_board', number: 1, title: 'Board', closed: false, url: 'https://github.com/orgs/acme/projects/1', fields: { nodes: [
    { __typename: 'ProjectV2SingleSelectField', id: 'F_size', name: 'Size', dataType: 'SINGLE_SELECT', options: [{ id: 'S_m', name: 'M' }] },
    { __typename: 'ProjectV2SingleSelectField', id: 'F_effort', name: 'Effort', dataType: 'SINGLE_SELECT', options: [] },
    { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' },
  ] } },
  { id: 'PVT_old', number: 3, title: 'Old', closed: true, fields: { nodes: [] } },
] } } };

// `issue` = what GitHub answers to the write (it drops what the token cannot set).
function fakeGithub({ issue = {}, current = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || 'GET', path, body });
    const json = (j, status = 200) => new Response(status === 204 ? null : JSON.stringify(j), { status });
    if (path === '/graphql') {
      if (/setIssueFieldValue|updateProjectV2ItemFieldValue/.test(body.query)) return json({ data: {} });
      if (/addProjectV2ItemById/.test(body.query)) return json({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } });
      if (/projectsV2/.test(body.query)) return json({ data: PROJECTS });
      return json({ data: REPO_META });
    }
    if (path.startsWith('/repos/acme/web/labels')) return json([{ name: 'backend' }, { name: 'Bug' }]);
    if (path.startsWith('/repos/acme/web/assignees/')) return path.endsWith('/ana') ? json(null, 204) : json({ message: 'Not Found' }, 404);
    if (path === '/repos/acme/web/issues' && init.method === 'POST') return json({ id: 41, node_id: 'I_41', number: 7, html_url: 'https://github.com/acme/web/issues/7', ...issue });
    if (path === '/repos/acme/web/issues/7' && init.method === 'PATCH') return json({ id: 41, node_id: 'I_41', number: 7, ...issue });
    if (path === '/repos/acme/web/issues/7') return json({ id: 41, node_id: 'I_41', number: 7, html_url: 'https://github.com/acme/web/issues/7', labels: [{ name: 'backend' }, { name: 'Bug' }], assignees: [{ login: 'bia' }], ...current });
    return json({ message: 'unexpected ' + path }, 500);
  };
  return calls;
}
const tool = (name, scopes = 'repo,read:org,project') => githubTools({ token: async () => 'synthetic', scopes }).find((t) => t.name === name);

test('a plain issue still costs one request and has no preflight', async () => {
  const calls = fakeGithub();
  assert.equal(await tool('github_create_issue').preflight({ owner: 'acme', repo: 'web', title: 'T' }), undefined);
  const out = JSON.parse(await tool('github_create_issue').run({ owner: 'acme', repo: 'web', title: 'T' }));
  assert.equal(out.id, 41);
  assert.equal(calls.length, 1);
});

test('unknown labels, logins, types and fields are refused before anything is written', async () => {
  const calls = fakeGithub();
  const args = { owner: 'acme', repo: 'web', title: 'T', labels: ['Size -> M'], assignees: ['Gustavo Merli'], type: 'Epic', fields: [{ name: 'Size', value: 'M' }, { name: 'Effort', value: 'Huge' }] };
  const pre = await tool('github_create_issue').preflight(args);
  for (const why of [/"Size -> M" do not exist.*backend, Bug/, /"Gustavo Merli" cannot be assigned/, /"Epic" is not an issue type.*Feature, Bug/, /"Size" is not an issue field.*github_add_to_project/, /"Huge" is not an option of the field Effort/]) assert.match(pre.erro, why);
  const out = JSON.parse(await tool('github_create_issue').run(args));
  assert.equal(out.ok, false);
  assert.equal(calls.filter((c) => c.method !== 'GET' && c.path !== '/graphql').length, 0, 'no issue was created');
  assert.equal(actionEvidenceFor('github_create_issue', args, out).state, 'failed');
});

test('create sends the real names, sets the fields and reports what GitHub kept', async () => {
  // The token cannot assign: GitHub drops the assignee without an error.
  const calls = fakeGithub({ issue: { labels: [{ name: 'backend' }], assignees: [], type: { name: 'Feature' } } });
  const args = { owner: 'acme', repo: 'web', title: 'T', labels: ['BACKEND'], assignees: ['@ana'], type: 'feature', fields: [{ name: 'effort', value: 'medium' }, { name: 'Target date', value: '2026-11-30' }] };
  const out = JSON.parse(await tool('github_create_issue').run(args));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues');
  assert.deepEqual(post.body, { title: 'T', labels: ['backend'], assignees: ['ana'], type: 'Feature' });
  const set = calls.find((c) => c.path === '/graphql' && /setIssueFieldValue/.test(c.body.query));
  assert.deepEqual(set.body.variables.input, { issueId: 'I_41', issueFields: [{ fieldId: 'IF_effort', singleSelectOptionId: 'O_med' }, { fieldId: 'IF_target', dateValue: '2026-11-30' }] });
  assert.deepEqual(out.labels, ['backend']);
  assert.deepEqual(out.assignees, []);
  assert.deepEqual(out.not_applied, ['assignee ana']);
  assert.equal(actionEvidenceFor('github_create_issue', args, out).state, 'partial');
});

test('update keeps the other labels and assignees and clears a field', async () => {
  const calls = fakeGithub({ issue: { labels: [{ name: 'backend' }], assignees: [{ login: 'bia' }, { login: 'ana' }], type: { name: 'Feature' } } });
  const args = { owner: 'acme', repo: 'web', number: 7, remove_labels: ['bug'], add_assignees: ['ana'], type: 'Feature', fields: [{ name: 'Effort', value: '' }] };
  assert.equal(await tool('github_update_issue').preflight(args), undefined);
  const out = JSON.parse(await tool('github_update_issue').run(args));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { labels: ['backend'], assignees: ['bia', 'ana'], type: 'Feature' });
  const set = calls.find((c) => c.path === '/graphql' && /setIssueFieldValue/.test(c.body.query));
  assert.deepEqual(set.body.variables.input.issueFields, [{ fieldId: 'IF_effort', delete: true }]);
  assert.equal(out.not_applied, undefined);
  assert.equal(actionEvidenceFor('github_update_issue', args, out).state, 'updated');
  assert.match((await tool('github_update_issue').preflight({ owner: 'acme', repo: 'web', number: 7 })).erro, /Nothing to change/);
});

test('projects: needs the project scope, resolves columns and adds the item', async () => {
  let calls = fakeGithub();
  const args = { owner: 'acme', repo: 'web', number: 7, project: 'board', fields: [{ name: 'size', value: 'm' }] };
  assert.equal((await tool('github_add_to_project', 'repo,read:org').preflight(args)).erro, PROJECT_SCOPE_MSG);
  assert.equal(calls.length, 0, 'an old connection is answered without calling GitHub');
  assert.match((await tool('github_add_to_project').preflight({ ...args, fields: [{ name: 'Effort', value: 'Medium' }] })).erro, /mirrors the issue field/);
  assert.match((await tool('github_add_to_project').preflight({ ...args, project: 'Old' })).erro, /no open project "Old".*Board \(#1\)/);
  calls = fakeGithub();
  const out = JSON.parse(await tool('github_add_to_project').run(args));
  const add = calls.find((c) => c.path === '/graphql' && /addProjectV2ItemById/.test(c.body.query));
  assert.deepEqual(add.body.variables, { projectId: 'PVT_board', contentId: 'I_41' });
  const col = calls.find((c) => c.path === '/graphql' && /updateProjectV2ItemFieldValue/.test(c.body.query));
  assert.deepEqual(col.body.variables.input, { projectId: 'PVT_board', itemId: 'PVTI_1', fieldId: 'F_size', value: { singleSelectOptionId: 'S_m' } });
  assert.deepEqual(out.fields, ['Size = M']);
  assert.equal(actionEvidenceFor('github_add_to_project', args, out).state, 'updated');
});

test('the confirmation card shows every label, assignee, type, field and column', () => {
  const create = describe('github_create_issue', { owner: 'acme', repo: 'web', title: 'T', labels: ['backend'], assignees: ['ana'], type: 'Feature', fields: [{ name: 'Effort', value: 'Medium' }] }, 'en');
  assert.equal(create, 'create an issue on GitHub in web: "T" with labels backend; assignees ana; type Feature; fields Effort = Medium');
  assert.match(describe('github_update_issue', { owner: 'acme', repo: 'web', number: 7, remove_labels: ['Size -> M'], fields: [{ name: 'Effort', value: '' }] }, 'en'), /acme\/web#7.*labels removed: Size -> M; fields Effort cleared/);
  assert.match(describe('github_add_to_project', { owner: 'acme', repo: 'web', number: 7, project: 'Board', fields: [{ name: 'Size', value: 'M' }] }, 'en'), /acme\/web#7 to the GitHub project "Board" with Size = M/);
});
