// GitHub issue metadata: labels, assignees, the issue type, the organization's
// issue fields (Effort, Priority...) and Projects (the board and its columns).
// Every name the person asks for is checked against what exists in the
// repository BEFORE anything is written: a label that does not exist would be
// created by GitHub, and assignees or a type the token cannot set are silently
// dropped. After writing, the result reports what GitHub actually saved.
// Incident 23/10/2026: asked for Type, Size, Effort and a project, the assistant
// turned them into three new labels and said it had set the assignees, which the
// tool could not do.
//
// The calls arrive injected (`rest`, `gql`) so this file has no token handling
// and can be tested offline.

export const PROJECT_SCOPE_MSG = 'This GitHub connection was made before Projects access existed here, so its token cannot read or change Projects. Tell the person to reconnect GitHub in Connections (connect again; issues keep working the same). Until then, the issue has to be added to the project on GitHub itself.';

// `scopes` = what GitHub granted on this connection ("read:org,read:user,repo").
// null/undefined = unknown (older row): the call is tried and the error is read.
export function hasProjectScope(scopes) {
  if (scopes === null || scopes === undefined) return undefined;
  return String(scopes).split(/[\s,]+/).includes('project');
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [])
  .map((x) => String(x ?? '').trim()).filter(Boolean);
const names = (xs) => xs.map((x) => x.name).join(', ') || '(none)';

function scopeError(e) {
  const m = String(e?.message || '');
  return (e?.types || []).includes('INSUFFICIENT_SCOPES') || /scope/i.test(m);
}

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

const ISSUE_FIELDS = `issueFields(first: 50) { nodes { __typename
  ... on IssueFieldSingleSelect { id name options { id name } }
  ... on IssueFieldMultiSelect { id name options { id name } }
  ... on IssueFieldText { id name } ... on IssueFieldNumber { id name } ... on IssueFieldDate { id name } } }`;
const REPO_META = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  issueTypes(first: 50) { nodes { id name isEnabled } } ${ISSUE_FIELDS} } }`;
const PROJECTS = `query($owner: String!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner {
  projectsV2(first: 50) { nodes { id number title closed url fields(first: 50) { nodes { __typename
    ... on ProjectV2SingleSelectField { id name dataType options { id name } }
    ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate } } }
    ... on ProjectV2Field { id name dataType } } } } } } } }`;

const FIELD_KIND = { IssueFieldSingleSelect: 'single_select', IssueFieldMultiSelect: 'multi_select', IssueFieldText: 'text', IssueFieldNumber: 'number', IssueFieldDate: 'date' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// `fields` comes as [{ name, value }]; an object { name: value } is accepted too.
function fieldPairs(fields) {
  if (Array.isArray(fields)) return fields.filter((f) => f && typeof f === 'object').map((f) => ({ name: String(f.name ?? '').trim(), value: f.value }));
  if (fields && typeof fields === 'object') return Object.entries(fields).map(([name, value]) => ({ name: name.trim(), value }));
  return [];
}
const asText = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function githubIssueMeta({ rest, gql, scopes }) {
  async function repoLabels(owner, repo) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const j = await rest(`/repos/${owner}/${repo}/labels?per_page=100&page=${page}`);
      const got = Array.isArray(j) ? j : [];
      out.push(...got.map((l) => l.name));
      if (got.length < 100) break;
    }
    return out;
  }
  async function assignable(owner, repo, login) {
    try { await rest(`/repos/${owner}/${repo}/assignees/${encodeURIComponent(login)}`); return true; }
    catch (e) { if (/^404\b/.test(String(e?.message))) return false; throw e; }
  }
  async function repoMeta(owner, repo) {
    const d = await gql(REPO_META, { owner, name: repo });
    const r = d?.repository || {};
    return {
      types: (r.issueTypes?.nodes || []).filter((t) => t && t.isEnabled !== false),
      fields: (r.issueFields?.nodes || []).filter((f) => f && f.id && FIELD_KIND[f.__typename]).map((f) => ({ ...f, kind: FIELD_KIND[f.__typename] })),
    };
  }

  // One issue field value -> the input of setIssueFieldValue, or an error.
  function fieldInput(field, raw) {
    const v = asText(raw);
    if (!v) return { input: { fieldId: field.id, delete: true }, shown: `${field.name} = (cleared)` };
    if (field.kind === 'single_select') {
      const o = field.options.find((x) => lower(x.name) === lower(v));
      return o ? { input: { fieldId: field.id, singleSelectOptionId: o.id }, shown: `${field.name} = ${o.name}` }
        : { error: `"${v}" is not an option of the field ${field.name}. Options: ${names(field.options)}.` };
    }
    if (field.kind === 'multi_select') {
      const wanted = v.split(',').map((s) => s.trim()).filter(Boolean);
      const found = wanted.map((w) => field.options.find((x) => lower(x.name) === lower(w)));
      const missing = wanted.filter((w, i) => !found[i]);
      return missing.length ? { error: `${missing.map((m) => `"${m}"`).join(', ')} not options of the field ${field.name}. Options: ${names(field.options)}.` }
        : { input: { fieldId: field.id, multiSelectOptionIds: found.map((o) => o.id) }, shown: `${field.name} = ${found.map((o) => o.name).join(', ')}` };
    }
    if (field.kind === 'number') {
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? { input: { fieldId: field.id, numberValue: n }, shown: `${field.name} = ${n}` } : { error: `The field ${field.name} takes a number.` };
    }
    if (field.kind === 'date') {
      return DATE.test(v) ? { input: { fieldId: field.id, dateValue: v }, shown: `${field.name} = ${v}` } : { error: `The field ${field.name} takes a date as YYYY-MM-DD.` };
    }
    return { input: { fieldId: field.id, textValue: v.slice(0, 1024) }, shown: `${field.name} = ${v.slice(0, 1024)}` };
  }

  // Checks labels, assignees, type and issue fields against the repository.
  // Only what was asked for is looked up, so a plain issue costs no extra call.
  async function resolve(owner, repo, { labels, assignees, type, fields } = {}) {
    const errors = [];
    const out = { labels: undefined, assignees: undefined, type: undefined, fields: [] };
    const wantLabels = labels === undefined ? undefined : list(labels);
    if (wantLabels?.length) {
      const existing = await repoLabels(owner, repo);
      const byName = new Map(existing.map((n) => [lower(n), n]));
      const missing = wantLabels.filter((l) => !byName.has(lower(l)));
      if (missing.length) errors.push(`Label(s) ${missing.map((m) => `"${m}"`).join(', ')} do not exist in ${owner}/${repo}, and new labels are not created here. Existing labels: ${existing.join(', ') || '(none)'}. If the person meant a type, an issue field or a project column, use type, fields or github_add_to_project instead.`);
      out.labels = [...new Set(wantLabels.filter((l) => byName.has(lower(l))).map((l) => byName.get(lower(l))))];
    } else if (wantLabels) out.labels = [];
    const wantAssignees = assignees === undefined ? undefined : list(assignees).map((a) => a.replace(/^@/, ''));
    if (wantAssignees?.length) {
      const bad = wantAssignees.filter((a) => !LOGIN.test(a));
      const checked = await Promise.all(wantAssignees.filter((a) => LOGIN.test(a)).map(async (a) => [a, await assignable(owner, repo, a)]));
      const refused = [...bad, ...checked.filter(([, ok]) => !ok).map(([a]) => a)];
      if (refused.length) errors.push(`${refused.map((a) => `"${a}"`).join(', ')} cannot be assigned in ${owner}/${repo} (assignees are GitHub logins with access to the repository, not names). Use github_issue_options to see the assignable logins, or ask the person for the login.`);
      out.assignees = [...new Set(checked.filter(([, ok]) => ok).map(([a]) => a))];
    } else if (wantAssignees) out.assignees = [];
    const pairs = fieldPairs(fields);
    const wantType = asText(type);
    if (wantType || pairs.length) {
      const meta = await repoMeta(owner, repo);
      if (wantType) {
        const t = meta.types.find((x) => lower(x.name) === lower(wantType));
        if (t) out.type = { id: t.id, name: t.name };
        else errors.push(meta.types.length ? `"${wantType}" is not an issue type of ${owner}/${repo}. Types: ${names(meta.types)}.` : `${owner}/${repo} has no issue types.`);
      }
      for (const p of pairs) {
        const f = meta.fields.find((x) => lower(x.name) === lower(p.name));
        if (!f) { errors.push(meta.fields.length ? `"${p.name}" is not an issue field of ${owner}/${repo}. Issue fields: ${names(meta.fields)}. A project column (like Size or Status) is set with github_add_to_project.` : `${owner}/${repo} has no issue fields. A project column (like Size or Status) is set with github_add_to_project.`); continue; }
        const r = fieldInput(f, p.value);
        if (r.error) errors.push(r.error); else out.fields.push(r);
      }
    }
    return { ...out, error: errors.length ? errors.join(' ') : null };
  }

  async function setFields(issueNodeId, fields) {
    if (!fields.length) return { set: [], failed: null };
    try {
      await gql('mutation($input: SetIssueFieldValueInput!) { setIssueFieldValue(input: $input) { issue { id } } }',
        { input: { issueId: issueNodeId, issueFields: fields.map((f) => f.input) } });
      return { set: fields.map((f) => f.shown), failed: null };
    } catch (e) { return { set: [], failed: `issue fields (${fields.map((f) => f.shown).join('; ')}): ${String(e?.message || e).slice(0, 200)}` }; }
  }

  // Projects of the repository's owner (organization or user).
  async function ownerProjects(owner) {
    if (hasProjectScope(scopes) === false) return { error: PROJECT_SCOPE_MSG };
    try {
      const d = await gql(PROJECTS, { owner });
      return { projects: (d?.repositoryOwner?.projectsV2?.nodes || []).filter(Boolean) };
    } catch (e) { if (scopeError(e)) return { error: PROJECT_SCOPE_MSG }; throw e; }
  }

  // A project column value -> the value of updateProjectV2ItemFieldValue, or an error.
  function projectFieldValue(field, raw) {
    const v = asText(raw);
    if (field.options) {
      if (!field.options.length) return { error: `The column ${field.name} mirrors the issue field of the same name; set it with fields on github_create_issue or github_update_issue.` };
      const o = field.options.find((x) => lower(x.name) === lower(v));
      return o ? { value: { singleSelectOptionId: o.id }, shown: `${field.name} = ${o.name}` } : { error: `"${v}" is not an option of the column ${field.name}. Options: ${names(field.options)}.` };
    }
    if (field.configuration) {
      const its = field.configuration.iterations || [];
      const it = its.find((x) => lower(x.title) === lower(v));
      return it ? { value: { iterationId: it.id }, shown: `${field.name} = ${it.title}` } : { error: `"${v}" is not an iteration of ${field.name}. Iterations: ${its.map((x) => x.title).join(', ') || '(none)'}.` };
    }
    if (field.dataType === 'TEXT') return { value: { text: v.slice(0, 1024) }, shown: `${field.name} = ${v.slice(0, 1024)}` };
    if (field.dataType === 'NUMBER') { const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? { value: { number: n }, shown: `${field.name} = ${n}` } : { error: `The column ${field.name} takes a number.` }; }
    if (field.dataType === 'DATE') return DATE.test(v) ? { value: { date: v }, shown: `${field.name} = ${v}` } : { error: `The column ${field.name} takes a date as YYYY-MM-DD.` };
    return { error: `The column ${field.name} is filled by GitHub itself (assignees, labels, repository...); set it on the issue with github_update_issue.` };
  }

  async function resolveProject(owner, project, fields) {
    const ref = asText(project);
    if (!ref) return { error: 'Say which project (its title or number).' };
    const got = await ownerProjects(owner);
    if (got.error) return { error: got.error };
    const open = got.projects.filter((p) => !p.closed);
    const p = /^\d+$/.test(ref) ? open.find((x) => String(x.number) === ref) : open.find((x) => lower(x.title) === lower(ref));
    if (!p) return { error: `There is no open project "${ref}" in ${owner}. Projects: ${open.map((x) => `${x.title} (#${x.number})`).join(', ') || '(none)'}.` };
    const errors = [], values = [];
    const cols = (p.fields?.nodes || []).filter((f) => f && f.id);
    for (const pair of fieldPairs(fields)) {
      const f = cols.find((x) => lower(x.name) === lower(pair.name));
      if (!f) { errors.push(`"${pair.name}" is not a column of the project ${p.title}. Columns: ${cols.filter((c) => c.options?.length || c.configuration || ['TEXT', 'NUMBER', 'DATE'].includes(c.dataType)).map((c) => c.name).join(', ') || '(none)'}.`); continue; }
      const r = projectFieldValue(f, pair.value);
      if (r.error) errors.push(r.error); else values.push({ fieldId: f.id, ...r });
    }
    return { project: { id: p.id, number: p.number, title: p.title, url: p.url }, values, error: errors.length ? errors.join(' ') : null };
  }

  // What the person can ask for in this repository, to pick real names.
  async function options(owner, repo) {
    const [labels, assignees, meta, projects] = await Promise.all([
      repoLabels(owner, repo),
      rest(`/repos/${owner}/${repo}/assignees?per_page=100`).then((j) => (Array.isArray(j) ? j.map((u) => u.login) : [])),
      repoMeta(owner, repo).catch(() => ({ types: [], fields: [] })),
      ownerProjects(owner).catch((e) => ({ error: String(e?.message || e).slice(0, 200) })),
    ]);
    const column = (f) => (f.options ? { name: f.name, options: f.options.map((o) => o.name) }
      : f.configuration ? { name: f.name, iterations: (f.configuration.iterations || []).map((i) => i.title) }
      : ['TEXT', 'NUMBER', 'DATE'].includes(f.dataType) ? { name: f.name, type: f.dataType.toLowerCase() } : null);
    return {
      labels,
      assignable_logins: assignees,
      issue_types: meta.types.map((t) => t.name),
      issue_fields: meta.fields.map((f) => ({ name: f.name, type: f.kind, ...(f.options ? { options: f.options.map((o) => o.name) } : {}) })),
      ...(projects.error ? { projects_error: projects.error } : {
        projects: projects.projects.filter((p) => !p.closed).map((p) => ({ number: p.number, title: p.title,
          columns: (p.fields?.nodes || []).filter((f) => f && !(f.options && !f.options.length)).map(column).filter(Boolean) })),
      }),
    };
  }

  return { resolve, setFields, resolveProject, options };
}
