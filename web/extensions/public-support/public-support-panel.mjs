// What each public assistant's panel shows: which menu items (modules) are on and,
// inside them, which templates. The installation's administrator turns them on and
// off per assistant on /admin/settings (public-support-admin.mjs); the owner and the
// client area's members only see the result. A core module with no row is on, so a
// panel nobody configured keeps today's menu; a plugin's module or a template with no
// row is off. Settings is not a module: it is always there.
export const PANEL_MODULES = Object.freeze(['dashboard', 'conversations', 'agent', 'crm', 'whatsapp']);
// A plugin's module or template id: short, lowercase, safe in a URL and a CSS selector.
export const PANEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
// A request body a template's api gets, at most (a spreadsheet upload).
export const TEMPLATE_BODY_MAX = 10 * 1024 * 1024;

// Inside esquemaDoAtendimento, after public_agents.
export const panelSchema = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.public_panel_items (
   agent_id uuid NOT NULL REFERENCES ${S}.public_agents(agent_id) ON DELETE CASCADE,
   kind text NOT NULL CHECK (kind IN ('module', 'template')),
   item text NOT NULL,
   enabled boolean NOT NULL,
   updated_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY (agent_id, kind, item));
`;

// A label is a text or one text per language ({'pt-BR': ..., en: ..., es: ...}); the page picks.
const validLabel = (l) => (typeof l === 'string' && l.trim() ? true
  : !!l && typeof l === 'object' && !Array.isArray(l) && Object.values(l).length > 0 && Object.values(l).every((v) => typeof v === 'string' && v.trim()));
// A template's script is a same-origin file the plugin serves (its `publico` folders).
const validScript = (s) => typeof s === 'string' && /^\/[^/\\][^\\?#]*\.js$/.test(s) && !s.includes('..');

// The plugin's panelCatalog() hook (public-support.mjs) → {modules, templates}, keeping
// only the entries that are well formed; each one dropped goes to the log.
//  modules: [{id, label}]: new menu items, after the core's.
//  templates: [{id, module, label, script, agentIds?, api?, wide?}]: a piece of a module's view.
//   module is a core module or one of the plugin's; agentIds lists the only assistants it
//   fits (one client's), without it, it fits every assistant; script is the file that draws
//   it (window.publicSupportTemplates, see public-support.html); api(ctx) answers its
//   requests (TEMPLATE_API_PATH in public-support-owner.mjs); wide: true lets the view use the
//   whole window width (wide tables) while it is open.
export function readPanelCatalog(raw, log = console) {
  const drop = (what, x) => { log.warn?.(`[public-support] panel ${what} ignored: ${String(x?.id ?? '?').slice(0, 40)}`); return false; };
  const modules = [], templates = [], ids = new Set(['settings', ...PANEL_MODULES]);
  for (const m of Array.isArray(raw?.modules) ? raw.modules : []) {
    if (!PANEL_ID.test(String(m?.id)) || ids.has(m.id) || !validLabel(m.label)) { drop('module', m); continue; }
    ids.add(m.id); modules.push({ id: m.id, label: m.label });
  }
  const tplIds = new Set();
  for (const x of Array.isArray(raw?.templates) ? raw.templates : []) {
    const agentIds = x?.agentIds ?? null;
    if (!PANEL_ID.test(String(x?.id)) || tplIds.has(x.id) || !ids.has(x.module) || x.module === 'settings' || !validLabel(x.label) || !validScript(x.script)
      || (agentIds !== null && !(Array.isArray(agentIds) && agentIds.every((a) => typeof a === 'string')))
      || (x.api != null && typeof x.api !== 'function')) { drop('template', x); continue; }
    tplIds.add(x.id);
    templates.push({ id: x.id, module: x.module, label: x.label, script: x.script, agentIds: agentIds?.length ? agentIds : null, api: x.api ?? null, wide: x.wide === true });
  }
  return { modules, templates };
}

// catalog() → the plugin's panelCatalog() as it comes; read once, on first use.
export function createPanelStore(pool, { S = 'mtr_harness', catalog = () => null, log = console } = {}) {
  let read = null;
  const cat = () => (read ??= readPanelCatalog((() => { try { return catalog(); } catch (e) { log.error?.('[public-support] panel catalog failed:', e?.message ?? e); return null; } })(), log));
  const moduleIds = () => [...PANEL_MODULES, ...cat().modules.map((m) => m.id)];
  const fits = (tpl, agentId) => !tpl.agentIds || tpl.agentIds.includes(agentId);
  const effective = (agentId, rows) => {
    const set = new Map(rows.map((r) => [r.kind + ':' + r.item, r.enabled]));
    const modules = Object.fromEntries(moduleIds().map((m) => [m, set.get('module:' + m) ?? PANEL_MODULES.includes(m)]));
    const tpls = Object.fromEntries(cat().templates.filter((x) => fits(x, agentId)).map((x) => [x.id, set.get('template:' + x.id) ?? false]));
    return { modules, templates: tpls };
  };
  const rowsOf = async (ids) => {
    const { rows } = await pool.query(`SELECT agent_id, kind, item, enabled FROM ${S}.public_panel_items WHERE agent_id = ANY($1::uuid[])`, [ids]);
    return rows;
  };
  return {
    // The menu items, the core's (label null: the page has their names) then the plugin's.
    modules: () => [...PANEL_MODULES.map((id) => ({ id, label: null })), ...cat().modules],
    catalog: () => cat().templates.map(({ id, module, label, agentIds }) => ({ id, module, label, agentIds })),
    // The template with its api, or null.
    template: (id) => cat().templates.find((x) => x.id === id) ?? null,

    // Every assistant with public settings, its name, its owner's name and its panel.
    async agents() {
      const { rows } = await pool.query(`SELECT p.agent_id AS id, a.name, u.name AS owner FROM ${S}.public_agents p
        JOIN ${S}.agents a ON a.id = p.agent_id LEFT JOIN ${S}.users u ON u.id = p.user_id
        WHERE a.archived_at IS NULL ORDER BY a.name, p.agent_id`, []);
      const items = await rowsOf(rows.map((r) => r.id));
      return rows.map((r) => ({ id: r.id, name: r.name ?? '', owner: r.owner ?? '', ...effective(r.id, items.filter((i) => i.agent_id === r.id)) }));
    },

    // One assistant's panel → {modules, templates}, each {name: on}.
    async items(agentId) {
      return effective(agentId, await rowsOf([agentId]));
    },

    // What the page draws for one assistant: items() plus the plugin's modules that are on
    // (custom: [{id, label}]) and the templates that are on (mounts: [{id, module, label, script, wide?}]),
    // each inside a module that is on.
    async page(agentId) {
      const on = await this.items(agentId);
      return { ...on, custom: cat().modules.filter((m) => on.modules[m.id]),
        mounts: cat().templates.filter((x) => on.templates[x.id] && on.modules[x.module]).map(({ id, module, label, script, wide }) => ({ id, module, label, script, ...(wide ? { wide } : {}) })) };
    },

    // → false when the assistant has no public settings or the item is not in the
    // catalog (or the template does not fit this assistant).
    async set(agentId, kind, item, enabled) {
      const known = kind === 'module' ? moduleIds().includes(item)
        : kind === 'template' && cat().templates.some((x) => x.id === item && fits(x, agentId));
      if (!known || typeof enabled !== 'boolean') return false;
      const { rowCount } = await pool.query(`INSERT INTO ${S}.public_panel_items (agent_id, kind, item, enabled)
        SELECT agent_id, $2, $3, $4 FROM ${S}.public_agents WHERE agent_id = $1
        ON CONFLICT (agent_id, kind, item) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [agentId, kind, item, enabled]);
      return rowCount > 0;
    },
  };
}
