// What each public assistant's panel shows: which menu items (modules) are on and,
// inside them, which templates. The installation's administrator turns them on and
// off per assistant on /admin/settings (public-support-admin.mjs); the owner and the
// client area's members only see the result. A module with no row is on, so a panel
// nobody configured keeps today's menu; a template with no row is off. Settings is
// not a module: it is always there.
export const PANEL_MODULES = Object.freeze(['dashboard', 'conversations', 'agent', 'crm', 'whatsapp']);

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

// templates() → the registered templates, [{id, module, agentIds?}]: agentIds lists the
// only assistants a template fits (one client's); without it, it fits every assistant.
export function createPanelStore(pool, { S = 'mtr_harness', templates = () => [] } = {}) {
  const fits = (tpl, agentId) => !tpl.agentIds?.length || tpl.agentIds.includes(agentId);
  const effective = (agentId, rows) => {
    const set = new Map(rows.map((r) => [r.kind + ':' + r.item, r.enabled]));
    const modules = Object.fromEntries(PANEL_MODULES.map((m) => [m, set.get('module:' + m) ?? true]));
    const tpls = Object.fromEntries(templates().filter((x) => fits(x, agentId)).map((x) => [x.id, set.get('template:' + x.id) ?? false]));
    return { modules, templates: tpls };
  };
  const rowsOf = async (ids) => {
    const { rows } = await pool.query(`SELECT agent_id, kind, item, enabled FROM ${S}.public_panel_items WHERE agent_id = ANY($1::uuid[])`, [ids]);
    return rows;
  };
  return {
    catalog: () => templates().map(({ id, module, label, agentIds }) => ({ id, module, label: label ?? id, agentIds: agentIds ?? null })),

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

    // → false when the assistant has no public settings or the item is not in the
    // catalog (or the template does not fit this assistant).
    async set(agentId, kind, item, enabled) {
      const known = kind === 'module' ? PANEL_MODULES.includes(item)
        : kind === 'template' && templates().some((x) => x.id === item && fits(x, agentId));
      if (!known || typeof enabled !== 'boolean') return false;
      const { rowCount } = await pool.query(`INSERT INTO ${S}.public_panel_items (agent_id, kind, item, enabled)
        SELECT agent_id, $2, $3, $4 FROM ${S}.public_agents WHERE agent_id = $1
        ON CONFLICT (agent_id, kind, item) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [agentId, kind, item, enabled]);
      return rowCount > 0;
    },
  };
}
