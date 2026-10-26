// Editable texts of public support (public-support.mjs), with their history.
//
// Three kinds of text:
//  installation: the rules every public assistant of this installation follows,
//   one text for the whole installation, edited by the admin.
//  written, spoken: one assistant's instructions for typed and for voice turns,
//   edited by its owner on /public-support.
// Each save is a new version: the newest is the current text, and only the last
// PROMPT_VERSIONS_KEPT of each text are kept. An empty text means "use the
// default" (the core's for installation, the plugin's for written and spoken),
// so going back to the default is saving an empty text, and it stays in the history.
export const PROMPT_KINDS = ['installation', 'written', 'spoken'];
export const AGENT_PROMPT_KINDS = ['written', 'spoken'];
export const PROMPT_MAX = 40000;
export const PROMPT_VERSIONS_KEPT = 20;

export const promptSchema = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.public_prompt_versions (
   id bigserial PRIMARY KEY,
   agent_id uuid REFERENCES ${S}.agents(id) ON DELETE CASCADE,
   kind text NOT NULL CHECK (kind IN ('installation','written','spoken')),
   content text NOT NULL,
   created_by uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
   created_at timestamptz NOT NULL DEFAULT now(),
   CHECK ((agent_id IS NULL) = (kind = 'installation')));
 CREATE INDEX IF NOT EXISTS public_prompt_versions_key_idx ON ${S}.public_prompt_versions(agent_id, kind, id DESC);
`;

const clean = (v) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, PROMPT_MAX);
// installation has no agent; written and spoken always have one.
const validKey = (agentId, kind) => (kind === 'installation' ? agentId == null : AGENT_PROMPT_KINDS.includes(kind) && !!agentId);

// The installation's text has no owner: whoever calls checks that the user is an
// admin. An assistant's texts are checked here, in the SQL (agents.user_id), and
// another account's assistant behaves as one that doesn't exist (null).
export function createPromptStore(pool, { S = 'mtr_harness' } = {}) {
  const VERSION_COLUMNS = 'id, kind, content, created_at';
  const sameKey = `agent_id IS NOT DISTINCT FROM $1::uuid AND kind = $2`;
  const prune = (agentId, kind) => pool.query(
    `DELETE FROM ${S}.public_prompt_versions WHERE ${sameKey}
        AND id <= (SELECT id FROM ${S}.public_prompt_versions WHERE ${sameKey} ORDER BY id DESC OFFSET ${PROMPT_VERSIONS_KEPT} LIMIT 1)`,
    [agentId, kind]);
  const owns = async (agentId, userId) => !!(await pool.query(
    `SELECT 1 FROM ${S}.agents WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, [agentId, userId])).rows[0];

  async function save({ agentId = null, kind, content, userId }) {
    if (!validKey(agentId, kind)) return null;
    const { rows } = agentId == null
      ? await pool.query(`INSERT INTO ${S}.public_prompt_versions (agent_id, kind, content, created_by)
           VALUES (NULL, 'installation', $1, $2) RETURNING ${VERSION_COLUMNS}`, [clean(content), userId ?? null])
      : await pool.query(`INSERT INTO ${S}.public_prompt_versions (agent_id, kind, content, created_by)
           SELECT a.id, $2, $3, a.user_id FROM ${S}.agents a WHERE a.id = $1 AND a.user_id = $4 AND a.archived_at IS NULL
           RETURNING ${VERSION_COLUMNS}`, [agentId, kind, clean(content), userId]);
    if (rows[0]) await prune(agentId, kind);
    return rows[0] || null;
  }

  // Newest first. null = another account's assistant.
  async function versions({ agentId = null, kind, userId }) {
    if (!validKey(agentId, kind) || (agentId != null && !(await owns(agentId, userId)))) return null;
    return (await pool.query(`SELECT ${VERSION_COLUMNS} FROM ${S}.public_prompt_versions WHERE ${sameKey} ORDER BY id DESC`,
      [agentId, kind])).rows;
  }

  return {
    init: () => pool.query(promptSchema(S)),
    save,
    versions,

    // Restoring = saving an old version's text again as the newest one.
    async restore({ agentId = null, kind, versionId, userId }) {
      if (!/^\d{1,18}$/.test(String(versionId ?? ''))) return null;
      const old = (await versions({ agentId, kind, userId }))?.find((v) => String(v.id) === String(versionId));
      return old ? save({ agentId, kind, content: old.content, userId }) : null;
    },

    // Current texts for a turn: {installation, written, spoken}, '' = default.
    async current(agentId = null) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (kind) kind, content FROM ${S}.public_prompt_versions
          WHERE (agent_id IS NULL AND kind = 'installation') OR agent_id = $1::uuid
          ORDER BY kind, id DESC`, [agentId]);
      const r = { installation: '', written: '', spoken: '' };
      for (const x of rows) r[x.kind] = x.content;
      return r;
    },
  };
}

// What a save stores: the default itself counts as no edit, so a later change of
// the default still reaches that text.
export const asEdit = (content, defaultText) => (String(content ?? '').trim() === String(defaultText ?? '').trim() ? '' : String(content ?? ''));

// One text as its editor on screen sees it: content '' = the default is in use.
// null = another account's assistant.
export async function textState(prompts, { agentId = null, kind, userId }, defaultText) {
  const versions = await prompts.versions({ agentId, kind, userId });
  if (!versions) return null;
  return {
    content: versions[0]?.content ?? '', default: defaultText ?? '', max: PROMPT_MAX,
    versions: versions.map((v) => ({ id: String(v.id), content: v.content, createdAt: new Date(v.created_at).toISOString() })),
  };
}
